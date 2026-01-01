/**
 * Integrates policy engine into PAPER bot trading loop
 */
import { getParamLoader, MarketParams } from './paramLoader';
import { policyEngine, TapeState, PriceHistory, InventoryState, EntrySignal } from './policyEngine';
import Logger from '../utils/logger';

export interface PolicyState {
    // Price history per market (keep last N entries for feature computation)
    priceHistory: Map<string, PriceHistory[]>;
    // Inventory state per market
    inventory: Map<string, InventoryState>;
    // Last trade time per market
    lastTradeTime: Map<string, number>;
    // Recent trade times per market (for cadence)
    recentTradeTimes: Map<string, number[]>;
    // Decision ID counter (for tracing)
    decisionIdCounter: number;
}

class PolicyIntegrator {
    private policyState: PolicyState;
    private maxHistoryLength = 1000; // Keep last 1000 price points per market
    private maxRecentTrades = 100; // Keep last 100 trade timestamps per market
    // Track session trade counts per market (reset on market switch)
    private tradesPerSession: Map<string, number> = new Map();
    // Track last price state for data quality checks
    private lastPriceState: Map<string, { up_px: number; down_px: number; timestamp: number }> = new Map();

    constructor() {
        this.policyState = {
            priceHistory: new Map(),
            inventory: new Map(),
            lastTradeTime: new Map(),
            recentTradeTimes: new Map(),
            decisionIdCounter: 0
        };
    }

    /**
     * Update price history for a market
     */
    updatePriceHistory(market: string, timestamp: number, upPx: number, downPx: number): void {
        if (!this.policyState.priceHistory.has(market)) {
            this.policyState.priceHistory.set(market, []);
        }

        const history = this.policyState.priceHistory.get(market)!;
        history.push({ timestamp, up_px: upPx, down_px: downPx });

        // Trim to max length
        if (history.length > this.maxHistoryLength) {
            history.shift();
        }
    }

    /**
     * Get or initialize inventory state for a market
     */
    private getInventory(market: string): InventoryState {
        if (!this.policyState.inventory.has(market)) {
            this.policyState.inventory.set(market, {
                inv_up_shares: 0,
                inv_down_shares: 0
            });
        }
        return this.policyState.inventory.get(market)!;
    }

    /**
     * Update inventory after a trade
     */
    updateInventory(market: string, side: 'UP' | 'DOWN', shares: number, cost: number): void {
        const inventory = this.getInventory(market);
        
        if (side === 'UP') {
            const oldCost = (inventory.avg_cost_up || 0) * inventory.inv_up_shares;
            inventory.inv_up_shares += shares;
            inventory.avg_cost_up = (oldCost + cost) / inventory.inv_up_shares;
        } else {
            const oldCost = (inventory.avg_cost_down || 0) * inventory.inv_down_shares;
            inventory.inv_down_shares += shares;
            inventory.avg_cost_down = (oldCost + cost) / inventory.inv_down_shares;
        }
    }

    /**
     * Record trade time for cadence tracking
     */
    private recordTradeTime(market: string, timestamp: number): void {
        if (!this.policyState.recentTradeTimes.has(market)) {
            this.policyState.recentTradeTimes.set(market, []);
        }

        const recent = this.policyState.recentTradeTimes.get(market)!;
        recent.push(timestamp);
        this.policyState.lastTradeTime.set(market, timestamp);

        // Trim to max length
        if (recent.length > this.maxRecentTrades) {
            recent.shift();
        }
    }

    /**
     * Main decision function - determines if we should trade
     * Now includes all new behavioral parameters
     */
    shouldTrade(
        market: string,
        timestamp: number,
        upPx: number,
        downPx: number,
        marketParams: MarketParams
    ): { shouldTrade: boolean; side: 'UP' | 'DOWN' | null; shares: number; reason: string; decisionId: number; fillPrice?: number } {
        const decisionId = ++this.policyState.decisionIdCounter;

        // Check if inventory should be reset (market switch/inactivity)
        const lastActivityTs = this.policyState.lastTradeTime.get(market) || null;
        if (marketParams.reset_params && 
            policyEngine.shouldResetInventory(lastActivityTs, timestamp, marketParams.reset_params)) {
            // Reset inventory and session counters
            this.policyState.inventory.delete(market);
            this.tradesPerSession.delete(market);
        }

        // Update price history
        this.updatePriceHistory(market, timestamp, upPx, downPx);

        // Check data quality filters FIRST (before any trading logic)
        const lastPrice = this.lastPriceState.get(market) || null;
        if (marketParams.quality_filter_params && 
            !policyEngine.checkDataQuality(
                { timestamp, up_px: upPx, down_px: downPx, market },
                lastPrice,
                marketParams.quality_filter_params
            )) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: 'data_quality_filter_failed',
                decisionId
            };
        }

        // Update last price state
        this.lastPriceState.set(market, { up_px: upPx, down_px: downPx, timestamp });

        // Get current state
        const state: TapeState = {
            timestamp,
            up_px: upPx,
            down_px: downPx,
            market
        };

        const history = this.policyState.priceHistory.get(market) || [];

        // Compute features
        const features = policyEngine.computeFeatures(state, history);

        // Check cooldown rules (after data quality, before cadence)
        const lastTradeTs = this.policyState.lastTradeTime.get(market) || null;
        const inventory = this.getInventory(market);
        
        if (marketParams.cooldown_params && 
            !policyEngine.checkCooldown(lastTradeTs, timestamp, features, inventory, marketParams.cooldown_params)) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: 'cooldown_blocked',
                decisionId
            };
        }

        // Check cadence
        const recentTrades = this.policyState.recentTradeTimes.get(market) || [];
        if (!policyEngine.cadenceOk(lastTradeTs, recentTrades, marketParams.cadence_params, timestamp)) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: `cadence_blocked`,
                decisionId
            };
        }

        // Check if both sides are valid (for side selection logic)
        // Check price bands directly (simpler than calling entrySignal multiple times)
        const actualUpSignal = marketParams.entry_params &&
                               marketParams.entry_params.up_price_min !== null &&
                               marketParams.entry_params.up_price_max !== null &&
                               state.up_px >= marketParams.entry_params.up_price_min &&
                               state.up_px <= marketParams.entry_params.up_price_max;
        
        const actualDownSignal = marketParams.entry_params &&
                                marketParams.entry_params.down_price_min !== null &&
                                marketParams.entry_params.down_price_max !== null &&
                                state.down_px >= marketParams.entry_params.down_price_min &&
                                state.down_px <= marketParams.entry_params.down_price_max;
        
        // Get entry signal (for momentum/reversion checks and other logic)
        const entrySignal: EntrySignal = policyEngine.entrySignal(state, features, marketParams.entry_params);

        // Apply side selection if both are valid
        let selectedSide: 'UP' | 'DOWN' | null = null;
        if (actualUpSignal && actualDownSignal && marketParams.side_selection_params) {
            selectedSide = policyEngine.selectSideWhenBothValid(
                state,
                features,
                inventory,
                marketParams.side_selection_params,
                actualUpSignal,
                actualDownSignal
            );
        } else if (actualUpSignal) {
            selectedSide = 'UP';
        } else if (actualDownSignal) {
            selectedSide = 'DOWN';
        } else {
            selectedSide = entrySignal.side; // Fallback to entry signal
        }

        if (!entrySignal.should_trade || !selectedSide) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: entrySignal.reason || 'no_entry_signal',
                decisionId
            };
        }

        // Check risk limits
        const tradesThisSession = this.tradesPerSession.get(market) || 0;
        if (marketParams.risk_params && 
            !policyEngine.checkRiskLimits(tradesThisSession, inventory, marketParams.risk_params)) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: 'risk_limit_exceeded',
                decisionId
            };
        }

        // Get size
        const shares = policyEngine.sizeForTrade(state, features, marketParams.size_params, selectedSide);

        // Check inventory and rebalance
        const finalSide = policyEngine.inventoryOkAndRebalance(
            inventory,
            marketParams.inventory_params,
            selectedSide
        );

        if (!finalSide) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: 'inventory_limit_exceeded',
                decisionId
            };
        }

        // Simulate fill price using execution model
        const snapshotSidePx = finalSide === 'UP' ? upPx : downPx;
        const fillPrice = policyEngine.simulateFillPrice(
            finalSide,
            snapshotSidePx,
            marketParams.execution_params
        );

        // Log decision
        Logger.info(`[Policy Decision ${decisionId}] ${market}: ${finalSide} ${shares.toFixed(4)} shares @ ${fillPrice.toFixed(4)} (fill: ${snapshotSidePx.toFixed(4)} + ${(fillPrice - snapshotSidePx).toFixed(4)}, reason: ${entrySignal.reason})`);

        return {
            shouldTrade: true,
            side: finalSide,
            shares,
            reason: entrySignal.reason,
            decisionId,
            fillPrice
        };
    }

    /**
     * Record that a trade was executed
     */
    recordTradeExecution(
        market: string,
        timestamp: number,
        side: 'UP' | 'DOWN',
        shares: number,
        cost: number
    ): void {
        this.updateInventory(market, side, shares, cost);
        this.recordTradeTime(market, timestamp);
        
        // Update session trade count
        const currentCount = this.tradesPerSession.get(market) || 0;
        this.tradesPerSession.set(market, currentCount + 1);
    }

    /**
     * Get current inventory state for a market (public accessor)
     */
    getInventoryState(market: string): InventoryState {
        return this.getInventory(market);
    }

    /**
     * Get cadence info for a market (public accessor)
     */
    getCadenceInfo(market: string): { lastTradeTime: number | null; recentTradeTimes: number[] } {
        return {
            lastTradeTime: this.policyState.lastTradeTime.get(market) || null,
            recentTradeTimes: this.policyState.recentTradeTimes.get(market) || []
        };
    }

    /**
     * Get price history for a market (public accessor for feature computation)
     */
    getPriceHistory(market: string): PriceHistory[] {
        return this.policyState.priceHistory.get(market) || [];
    }

    /**
     * Reset inventory (for testing or manual reset)
     */
    resetInventory(market?: string): void {
        if (market) {
            this.policyState.inventory.delete(market);
            this.policyState.lastTradeTime.delete(market);
            this.policyState.recentTradeTimes.delete(market);
        } else {
            this.policyState.inventory.clear();
            this.policyState.lastTradeTime.clear();
            this.policyState.recentTradeTimes.clear();
        }
    }
}

// Singleton instance
export const policyIntegrator = new PolicyIntegrator();

