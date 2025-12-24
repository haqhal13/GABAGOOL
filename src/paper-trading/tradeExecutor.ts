/**
 * Paper Trade Executor
 *
 * Implements the dual-side accumulation strategy decision-making logic.
 * Makes trade decisions based on:
 * - Current market skew
 * - Target vs current allocation
 * - Market phase (time remaining)
 * - Safety constraints
 */

import {
    BinaryMarket,
    PaperMarketPosition,
    PaperTrade,
    TradeDecision,
    SkewAnalysis,
    AllocationTarget,
    PhaseAnalysis,
} from './interfaces';
import { DualSideStrategyConfig, PAPER_CONFIG } from './config';
import {
    analyzeSkew,
    calculateAllocation,
    analyzePhase,
    calculateTradeAmount,
    calculateShares,
    determineTradeSide,
    shouldThrottle,
    formatSkew,
    formatAllocation,
} from './sizingCurve';
import { PositionTracker } from './positionTracker';

/**
 * Simple UUID generator (if uuid package not available)
 */
function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Paper Trade Executor class
 */
export class TradeExecutor {
    private config: DualSideStrategyConfig;
    private positionTracker: PositionTracker;
    private lastTradeTime: number = 0;
    private lastTradePerMarket: Map<string, number> = new Map();
    private skewHistory: Map<string, { skew: number; time: number }[]> = new Map();

    constructor(
        positionTracker: PositionTracker,
        config: DualSideStrategyConfig = PAPER_CONFIG
    ) {
        this.config = config;
        this.positionTracker = positionTracker;
    }

    /**
     * Make a trade decision for a market
     */
    makeDecision(market: BinaryMarket): TradeDecision {
        const factors: string[] = [];

        // Step 1: Analyze current skew
        const skew = analyzeSkew(market.priceUp, market.priceDown, this.config);
        factors.push(`Skew: ${formatSkew(skew)}`);

        // Step 2: Calculate target allocation
        const targetAllocation = calculateAllocation(skew, this.config);
        factors.push(`Target: ${formatAllocation(targetAllocation)}`);

        // Step 3: Analyze market phase
        const phase = analyzePhase(market, this.config);
        factors.push(`Phase: ${phase.phase} (${phase.reasoning})`);

        // Get or create position
        const position = this.positionTracker.getOrCreatePosition(market);

        // Update target allocations on position
        position.targetAllocationUp = targetAllocation.dominantSide === 'UP'
            ? targetAllocation.dominantSideRatio
            : targetAllocation.minoritySideRatio;
        position.targetAllocationDown = targetAllocation.dominantSide === 'DOWN'
            ? targetAllocation.dominantSideRatio
            : targetAllocation.minoritySideRatio;

        // Step 4: Check if we should trade at all
        if (!phase.shouldTrade) {
            return this.noTradeDecision(skew, targetAllocation, phase, position, 'Phase prohibits trading', factors);
        }

        // Step 5: Check throttling
        const lastSameMarketTrade = this.lastTradePerMarket.get(market.conditionId) || 0;
        const throttleCheck = shouldThrottle(this.lastTradeTime, lastSameMarketTrade, this.config);

        if (throttleCheck.throttle) {
            factors.push(`Throttled: ${throttleCheck.reason}`);
            return this.noTradeDecision(skew, targetAllocation, phase, position, throttleCheck.reason, factors);
        }

        // Step 6: Check skew stability
        const stabilityCheck = this.checkSkewStability(market.conditionId, skew);
        if (!stabilityCheck.stable) {
            factors.push(`Skew unstable: ${stabilityCheck.reason}`);
            return this.noTradeDecision(skew, targetAllocation, phase, position, stabilityCheck.reason, factors);
        }

        // Step 7: Determine which side to trade
        const tradeSide = determineTradeSide(
            position.currentAllocationUp,
            position.currentAllocationDown,
            targetAllocation
        );
        factors.push(`Trade side: ${tradeSide.side} (${tradeSide.reason})`);

        // Step 8: Check if gap is significant enough
        if (tradeSide.gap < this.config.safety.allocationGapThreshold) {
            return this.noTradeDecision(
                skew,
                targetAllocation,
                phase,
                position,
                `Gap too small: ${(tradeSide.gap * 100).toFixed(1)}% < ${(this.config.safety.allocationGapThreshold * 100)}%`,
                factors
            );
        }

        // Step 9: Calculate trade amount
        // Base amount: proportion of remaining market cap based on gap
        const remainingCap = this.config.safety.maxCapitalPerMarket - position.totalInvested;
        const baseAmount = remainingCap * tradeSide.gap * 0.5; // Trade 50% of gap proportion

        const adjustedAmount = calculateTradeAmount(
            baseAmount,
            phase,
            tradeSide.gap,
            this.config
        );

        // Step 10: Check capital constraints
        const capitalCheck = this.positionTracker.canTradeInMarket(market.conditionId, adjustedAmount);

        if (!capitalCheck.canTrade) {
            factors.push(`Capital constraint: ${capitalCheck.reason}`);
            return this.noTradeDecision(skew, targetAllocation, phase, position, capitalCheck.reason, factors);
        }

        // Step 11: Calculate shares
        const price = tradeSide.side === 'UP' ? market.priceUp : market.priceDown;
        const shares = calculateShares(adjustedAmount, price);

        if (shares <= 0) {
            return this.noTradeDecision(skew, targetAllocation, phase, position, 'Zero shares calculated', factors);
        }

        // Build trade decision
        const reason = `${tradeSide.side} ${tradeSide.gap > this.config.safety.rebalanceThreshold ? 'rebalance' : 'accumulate'}: ` +
            `${(tradeSide.gap * 100).toFixed(1)}% gap, $${adjustedAmount.toFixed(2)} @ $${price.toFixed(4)}`;

        factors.push(`Amount: $${adjustedAmount.toFixed(2)}, Shares: ${shares.toFixed(4)}`);

        return {
            shouldTrade: true,
            side: tradeSide.side,
            amount: adjustedAmount,
            shares,
            price,
            skew,
            allocation: targetAllocation,
            phase,
            currentPosition: position,
            reason,
            factors,
        };
    }

    /**
     * Execute a trade decision (paper trade)
     */
    executeTrade(market: BinaryMarket, decision: TradeDecision): PaperTrade | null {
        if (!decision.shouldTrade || !decision.side) {
            return null;
        }

        const position = this.positionTracker.getPosition(market.conditionId);

        // Create paper trade
        const trade: PaperTrade = {
            id: generateId(),
            timestamp: Date.now(),
            conditionId: market.conditionId,
            marketSlug: market.slug,
            marketTitle: market.title,
            side: decision.side,
            shares: decision.shares,
            pricePerShare: decision.price,
            totalCost: decision.amount,
            skewAtTrade: decision.skew,
            allocationAtTrade: decision.allocation,
            positionBeforeTrade: position
                ? (decision.side === 'UP' ? { ...position.positionUp } : { ...position.positionDown })
                : null,
            reason: decision.reason,
        };

        // Record the trade
        this.positionTracker.recordTrade(trade);

        // Update timing trackers
        this.lastTradeTime = trade.timestamp;
        this.lastTradePerMarket.set(market.conditionId, trade.timestamp);

        return trade;
    }

    /**
     * Process a market - analyze and potentially execute a trade
     */
    processMarket(market: BinaryMarket): { decision: TradeDecision; trade: PaperTrade | null } {
        // Make decision
        const decision = this.makeDecision(market);

        // Execute if should trade
        let trade: PaperTrade | null = null;
        if (decision.shouldTrade) {
            trade = this.executeTrade(market, decision);
        }

        // Log decision if configured
        if (this.config.logDecisions && !decision.shouldTrade) {
            console.log(`[SKIP] ${market.slug}: ${decision.reason}`);
        }

        return { decision, trade };
    }

    /**
     * Check skew stability (has skew been consistent?)
     */
    private checkSkewStability(conditionId: string, currentSkew: SkewAnalysis): { stable: boolean; reason: string } {
        const { safety } = this.config;
        const now = Date.now();

        // Get or create history
        let history = this.skewHistory.get(conditionId);
        if (!history) {
            history = [];
            this.skewHistory.set(conditionId, history);
        }

        // Add current reading
        history.push({ skew: currentSkew.skewMagnitude, time: now });

        // Remove old readings
        const windowMs = safety.skewStabilityWindow * 1000;
        history = history.filter(h => now - h.time < windowMs);
        this.skewHistory.set(conditionId, history);

        // Need enough history to judge stability
        if (history.length < 3) {
            return { stable: true, reason: 'Insufficient history (assuming stable)' };
        }

        // Check for volatility
        const skews = history.map(h => h.skew);
        const minSkew = Math.min(...skews);
        const maxSkew = Math.max(...skews);
        const volatility = maxSkew - minSkew;

        if (volatility > safety.skewVolatilityThreshold) {
            return {
                stable: false,
                reason: `Skew volatility ${(volatility * 100).toFixed(1)}% > ${(safety.skewVolatilityThreshold * 100)}% threshold`,
            };
        }

        return { stable: true, reason: 'Skew stable' };
    }

    /**
     * Create a no-trade decision
     */
    private noTradeDecision(
        skew: SkewAnalysis,
        allocation: AllocationTarget,
        phase: PhaseAnalysis,
        position: PaperMarketPosition | null,
        reason: string,
        factors: string[]
    ): TradeDecision {
        return {
            shouldTrade: false,
            side: null,
            amount: 0,
            shares: 0,
            price: 0,
            skew,
            allocation,
            phase,
            currentPosition: position,
            reason,
            factors,
        };
    }

    /**
     * Get summary of pending decisions for display
     */
    getDecisionSummary(markets: BinaryMarket[]): string[] {
        const summaries: string[] = [];

        for (const market of markets) {
            const decision = this.makeDecision(market);
            const position = this.positionTracker.getPosition(market.conditionId);

            if (decision.shouldTrade) {
                summaries.push(
                    `[TRADE] ${market.slug}: ${decision.side} $${decision.amount.toFixed(2)} @ $${decision.price.toFixed(4)}`
                );
            } else if (position && position.totalInvested > 0) {
                summaries.push(
                    `[HOLD] ${market.slug}: $${position.totalInvested.toFixed(2)} invested (${decision.reason})`
                );
            }
        }

        return summaries;
    }

    /**
     * Clear skew history for a market (e.g., after resolution)
     */
    clearHistory(conditionId: string): void {
        this.skewHistory.delete(conditionId);
        this.lastTradePerMarket.delete(conditionId);
    }

    /**
     * Reset all state
     */
    reset(): void {
        this.lastTradeTime = 0;
        this.lastTradePerMarket.clear();
        this.skewHistory.clear();
    }
}
