/**
 * Policy engine implementing inferred WATCH bot parameters
 */
import {
    EntryParams,
    SizeParams,
    InventoryParams,
    CadenceParams,
    MarketParams
} from './paramLoader';

export interface TapeState {
    timestamp: number;
    up_px: number;
    down_px: number;
    market: string;
}

export interface PriceHistory {
    timestamp: number;
    up_px: number;
    down_px: number;
}

export interface Features {
    delta_1s_side_px?: number;
    delta_5s_side_px?: number;
    delta_30s_side_px?: number;
    delta_1s_up_px?: number;
    delta_5s_up_px?: number;
    delta_30s_up_px?: number;
    delta_1s_down_px?: number;
    delta_5s_down_px?: number;
    delta_30s_down_px?: number;
    volatility_5s?: number;
    volatility_30s?: number;
    distance_from_50: number;
}

export interface InventoryState {
    inv_up_shares: number;
    inv_down_shares: number;
    avg_cost_up?: number;
    avg_cost_down?: number;
}

export interface EntrySignal {
    should_trade: boolean;
    side: 'UP' | 'DOWN' | null;
    reason: string;
}

export class PolicyEngine {
    /**
     * Compute features from tape state and history
     */
    computeFeatures(state: TapeState, history: PriceHistory[]): Features {
        const features: Features = {
            distance_from_50: Math.abs(state.up_px - 0.5)
        };

        if (history.length === 0) {
            return features;
        }

        // Sort history by timestamp (oldest first)
        const sortedHistory = [...history].sort((a, b) => a.timestamp - b.timestamp);
        
        // Find historical points at different windows
        const now = state.timestamp;
        const window1s = now - 1000;
        const window5s = now - 5000;
        const window30s = now - 30000;

        // Find closest historical point to each window
        const findClosest = (targetTs: number) => {
            let closest = sortedHistory[0];
            let minDiff = Math.abs(closest.timestamp - targetTs);
            for (const h of sortedHistory) {
                const diff = Math.abs(h.timestamp - targetTs);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = h;
                }
            }
            return closest;
        };

        // Compute deltas
        const current = { timestamp: now, up_px: state.up_px, down_px: state.down_px };
        
        [1, 5, 30].forEach(seconds => {
            const windowTs = now - (seconds * 1000);
            const past = findClosest(windowTs);
            
            if (Math.abs(past.timestamp - windowTs) < seconds * 2000) { // Within 2x window
                const deltaUp = current.up_px - past.up_px;
                const deltaDown = current.down_px - past.down_px;
                
                (features as any)[`delta_${seconds}s_up_px`] = deltaUp;
                (features as any)[`delta_${seconds}s_down_px`] = deltaDown;
                (features as any)[`delta_${seconds}s_side_px`] = deltaUp; // Default to UP, will be overridden by side-specific
            }
        });

        // Compute volatility (rolling std) over windows
        [5, 30].forEach(seconds => {
            const windowTs = now - (seconds * 1000);
            const windowPrices = sortedHistory
                .filter(h => h.timestamp >= windowTs && h.timestamp <= now)
                .map(h => h.up_px);
            
            if (windowPrices.length > 1) {
                const mean = windowPrices.reduce((a, b) => a + b, 0) / windowPrices.length;
                const variance = windowPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / windowPrices.length;
                (features as any)[`volatility_${seconds}s`] = Math.sqrt(variance);
            }
        });

        return features;
    }

    /**
     * Entry signal decision based on entry parameters
     */
    entrySignal(
        state: TapeState,
        features: Features,
        entryParams: EntryParams | undefined
    ): EntrySignal {
        if (!entryParams) {
            return { should_trade: false, side: null, reason: 'no_entry_params' };
        }

        // Check UP price band
        const upInBand = entryParams.up_price_min !== null && entryParams.up_price_max !== null &&
            state.up_px >= entryParams.up_price_min && state.up_px <= entryParams.up_price_max;

        // Check DOWN price band
        const downInBand = entryParams.down_price_min !== null && entryParams.down_price_max !== null &&
            state.down_px >= entryParams.down_price_min && state.down_px <= entryParams.down_price_max;

        // Check momentum/reversion mode
        const delta5s = features.delta_5s_side_px ?? 0;

        // UP trade signal
        if (upInBand) {
            let upSignal = true;
            let upReason = 'up_price_band';

            if (entryParams.mode === 'momentum') {
                // Momentum: buy UP when UP price is rising
                if (delta5s < entryParams.momentum_threshold) {
                    upSignal = false;
                    upReason = 'momentum_not_met';
                } else {
                    upReason = 'momentum_met';
                }
            } else if (entryParams.mode === 'reversion') {
                // Reversion: buy UP when UP price is falling
                if (delta5s > -entryParams.momentum_threshold) {
                    upSignal = false;
                    upReason = 'reversion_not_met';
                } else {
                    upReason = 'reversion_met';
                }
            }

            if (upSignal) {
                return { should_trade: true, side: 'UP', reason: upReason };
            }
        }

        // DOWN trade signal
        if (downInBand) {
            let downSignal = true;
            let downReason = 'down_price_band';

            // For DOWN, we check DOWN price delta
            const delta5sDown = features.delta_5s_down_px ?? delta5s;

            if (entryParams.mode === 'momentum') {
                // Momentum: buy DOWN when DOWN price is rising (UP falling)
                if (delta5sDown < entryParams.momentum_threshold) {
                    downSignal = false;
                    downReason = 'momentum_not_met';
                } else {
                    downReason = 'momentum_met';
                }
            } else if (entryParams.mode === 'reversion') {
                // Reversion: buy DOWN when DOWN price is falling (UP rising)
                if (delta5sDown > -entryParams.momentum_threshold) {
                    downSignal = false;
                    downReason = 'reversion_not_met';
                } else {
                    downReason = 'reversion_met';
                }
            }

            if (downSignal) {
                return { should_trade: true, side: 'DOWN', reason: downReason };
            }
        }

        return { should_trade: false, side: null, reason: 'no_band_match' };
    }

    /**
     * Check if a specific side should trade (for checking both UP and DOWN independently)
     */
    checkSideEntry(
        state: TapeState,
        features: Features,
        entryParams: EntryParams | undefined,
        side: 'UP' | 'DOWN'
    ): EntrySignal {
        if (!entryParams) {
            return { should_trade: false, side: null, reason: 'no_entry_params' };
        }

        if (side === 'UP') {
            // Check UP price band
            const upInBand = entryParams.up_price_min !== null && entryParams.up_price_max !== null &&
                state.up_px >= entryParams.up_price_min && state.up_px <= entryParams.up_price_max;

            if (!upInBand) {
                return { should_trade: false, side: null, reason: 'up_price_not_in_band' };
            }

            // Check momentum/reversion mode
            const delta5s = features.delta_5s_side_px ?? 0;
            let upSignal = true;
            let upReason = 'up_price_band';

            if (entryParams.mode === 'momentum') {
                if (delta5s < entryParams.momentum_threshold) {
                    upSignal = false;
                    upReason = 'momentum_not_met';
                } else {
                    upReason = 'momentum_met';
                }
            } else if (entryParams.mode === 'reversion') {
                if (delta5s > -entryParams.momentum_threshold) {
                    upSignal = false;
                    upReason = 'reversion_not_met';
                } else {
                    upReason = 'reversion_met';
                }
            }

            return { should_trade: upSignal, side: upSignal ? 'UP' : null, reason: upReason };
        } else {
            // Check DOWN price band
            const downInBand = entryParams.down_price_min !== null && entryParams.down_price_max !== null &&
                state.down_px >= entryParams.down_price_min && state.down_px <= entryParams.down_price_max;

            if (!downInBand) {
                return { should_trade: false, side: null, reason: 'down_price_not_in_band' };
            }

            // Check momentum/reversion mode
            const delta5s = features.delta_5s_side_px ?? 0;
            const delta5sDown = features.delta_5s_down_px ?? delta5s;
            let downSignal = true;
            let downReason = 'down_price_band';

            if (entryParams.mode === 'momentum') {
                if (delta5sDown < entryParams.momentum_threshold) {
                    downSignal = false;
                    downReason = 'momentum_not_met';
                } else {
                    downReason = 'momentum_met';
                }
            } else if (entryParams.mode === 'reversion') {
                if (delta5sDown > -entryParams.momentum_threshold) {
                    downSignal = false;
                    downReason = 'reversion_not_met';
                } else {
                    downReason = 'reversion_met';
                }
            }

            return { should_trade: downSignal, side: downSignal ? 'DOWN' : null, reason: downReason };
        }
    }

    /**
     * Get trade size based on size parameters
     * Now includes price-ratio-based multiplier: trade more on winning side as ratio moves from 50:50
     */
    sizeForTrade(
        state: TapeState,
        features: Features,
        sizeParams: SizeParams | undefined,
        side: 'UP' | 'DOWN'
    ): number {
        if (!sizeParams || !sizeParams.size_table || Object.keys(sizeParams.size_table).length === 0) {
            return 1.0; // Default size
        }

        const sidePx = side === 'UP' ? state.up_px : state.down_px;
        const binEdges = sizeParams.bin_edges || [];

        // Find bucket containing sidePx
        let bucketIndex = -1;
        for (let i = 0; i < binEdges.length - 1; i++) {
            if (sidePx >= binEdges[i] && sidePx <= binEdges[i + 1]) {
                bucketIndex = i;
                break;
            }
        }

        if (bucketIndex === -1) {
            // Outside range, use nearest bucket
            if (sidePx < binEdges[0]) bucketIndex = 0;
            else bucketIndex = binEdges.length - 2;
        }

        // Construct bucket key (format matches pandas Interval string representation)
        const bucketKey = `(${binEdges[bucketIndex]}, ${binEdges[bucketIndex + 1]}]`;

        // Get base size from table
        let baseSize: number;
        if (sizeParams.size_table[bucketKey] !== undefined) {
            baseSize = parseFloat(sizeParams.size_table[bucketKey].toFixed(4));
        } else {
            // Fallback: use median of all sizes
            const allSizes = Object.values(sizeParams.size_table);
            if (allSizes.length > 0) {
                const sorted = allSizes.sort((a, b) => a - b);
                baseSize = sorted[Math.floor(sorted.length / 2)];
            } else {
                return 1.0; // Final fallback
            }
        }

        // ==========================================================================
        // PRICE-RATIO-BASED MULTIPLIER: Trade more on winning side as ratio moves from 50:50
        // 55:45 → 1.1x (slightly more)
        // 60:40 → 1.3x (more)
        // 70:30 → 1.6x (heavier)
        // 80:20 → 2.0x (even heavier)
        // Still trade the other side (base size) for safety
        // ==========================================================================
        const upRatio = state.up_px;
        const downRatio = state.down_px;
        
        // Determine which side is "winning" (further from 50%)
        const isWinningSide = (side === 'UP' && upRatio > 0.5) || (side === 'DOWN' && downRatio > 0.5);
        
        if (isWinningSide) {
            // Calculate how far from 50:50 (0.0 = 50:50, 0.5 = 100:0)
            const distanceFrom50 = Math.abs((side === 'UP' ? upRatio : downRatio) - 0.5);
            
            // Multiplier increases as we move away from 50:50
            // At 55:45 (distance = 0.05) → 1.1x
            // At 60:40 (distance = 0.10) → 1.3x
            // At 70:30 (distance = 0.20) → 1.6x
            // At 80:20 (distance = 0.30) → 2.0x
            // Linear interpolation between these points
            let multiplier = 1.0;
            if (distanceFrom50 <= 0.05) {
                // 50:50 to 55:45: 1.0x to 1.1x
                multiplier = 1.0 + (distanceFrom50 / 0.05) * 0.1;
            } else if (distanceFrom50 <= 0.10) {
                // 55:45 to 60:40: 1.1x to 1.3x
                multiplier = 1.1 + ((distanceFrom50 - 0.05) / 0.05) * 0.2;
            } else if (distanceFrom50 <= 0.20) {
                // 60:40 to 70:30: 1.3x to 1.6x
                multiplier = 1.3 + ((distanceFrom50 - 0.10) / 0.10) * 0.3;
            } else {
                // 70:30 to 80:20+: 1.6x to 2.0x (max)
                multiplier = Math.min(2.0, 1.6 + ((distanceFrom50 - 0.20) / 0.10) * 0.4);
            }
            
            return parseFloat((baseSize * multiplier).toFixed(4));
        } else {
            // Losing side: use base size (still trade for safety, but smaller)
            return baseSize;
        }
    }

    /**
     * Check inventory and apply rebalance logic
     * Now uses order book prices to determine winning side (based on PnL)
     */
    inventoryOkAndRebalance(
        inventory: InventoryState,
        inventoryParams: InventoryParams | undefined,
        proposedSide: 'UP' | 'DOWN',
        currentPriceUp?: number,  // Current order book ASK price (execution price for buying UP)
        currentPriceDown?: number, // Current order book ASK price (execution price for buying DOWN)
        avgCostUp?: number,        // Average entry price for UP
        avgCostDown?: number       // Average entry price for DOWN
    ): 'UP' | 'DOWN' | null {
        if (!inventoryParams) {
            return proposedSide; // No inventory constraints
        }

        const total = inventory.inv_up_shares + inventory.inv_down_shares;
        const eps = 1e-6;

        // Check max total
        if (total >= inventoryParams.max_total_shares) {
            return null; // At max total
        }

        // Check side-specific limits
        if (proposedSide === 'UP' && inventory.inv_up_shares >= inventoryParams.max_up_shares) {
            return null; // At max UP
        }
        if (proposedSide === 'DOWN' && inventory.inv_down_shares >= inventoryParams.max_down_shares) {
            return null; // At max DOWN
        }

        // Rebalance logic: Favor the WINNING side based on order book prices (PnL)
        // Watch mode shows: when UP is winning (positive PnL), it has MORE UP shares (55.9% UP)
        // So we should ALLOW accumulation on the winning side, not prevent it
        const R = inventoryParams.rebalance_ratio_R;
        
        // Calculate which side is winning based on order book prices vs entry prices
        let winningSide: 'UP' | 'DOWN' | null = null;
        if (currentPriceUp && currentPriceDown && avgCostUp && avgCostDown && 
            inventory.inv_up_shares > eps && inventory.inv_down_shares > eps) {
            // Calculate PnL for each side (using order book ASK prices - execution prices)
            const upPnL = (currentPriceUp - avgCostUp) * inventory.inv_up_shares;
            const downPnL = (currentPriceDown - avgCostDown) * inventory.inv_down_shares;
            
            // Determine winning side (positive PnL)
            if (upPnL > downPnL && upPnL > 0) {
                winningSide = 'UP';
            } else if (downPnL > upPnL && downPnL > 0) {
                winningSide = 'DOWN';
            }
        }
        
        if (inventory.inv_up_shares > eps && inventory.inv_down_shares > eps) {
            const ratio = inventory.inv_up_shares / (inventory.inv_up_shares + inventory.inv_down_shares);
            const extremeThreshold = R + 0.1; // Allow up to R, only rebalance if way beyond
            
            // If we have price data and know the winning side, favor it
            if (winningSide && proposedSide === winningSide) {
                // We want to buy the winning side - allow it even if ratio is high (up to extreme threshold)
                if (ratio < extremeThreshold) {
                    return proposedSide; // Allow accumulation on winning side
                }
                // If ratio is extreme but we're buying winning side, still allow if under max
                if (inventory.inv_up_shares < inventoryParams.max_up_shares && 
                    inventory.inv_down_shares < inventoryParams.max_down_shares) {
                    return proposedSide;
                }
            }
            
            // If UP ratio is EXTREME (> R + 0.1) and we're trying to buy UP, switch to DOWN
            if (ratio > extremeThreshold && proposedSide === 'UP') {
                // Unless UP is winning - then allow it
                if (winningSide === 'UP' && inventory.inv_up_shares < inventoryParams.max_up_shares) {
                    return 'UP';
                }
                // Check if we can buy DOWN instead
                if (inventory.inv_down_shares < inventoryParams.max_down_shares && total < inventoryParams.max_total_shares) {
                    return 'DOWN';
                }
                // If we can't buy DOWN, still allow UP if under max
                if (inventory.inv_up_shares < inventoryParams.max_up_shares) {
                    return 'UP';
                }
                return null; // At max
            }
            
            // If DOWN ratio is EXTREME (UP ratio < 1-R-0.1) and we're trying to buy DOWN, switch to UP
            if (ratio < (1 - extremeThreshold) && proposedSide === 'DOWN') {
                // Unless DOWN is winning - then allow it
                if (winningSide === 'DOWN' && inventory.inv_down_shares < inventoryParams.max_down_shares) {
                    return 'DOWN';
                }
                // Check if we can buy UP instead
                if (inventory.inv_up_shares < inventoryParams.max_up_shares && total < inventoryParams.max_total_shares) {
                    return 'UP';
                }
                // If we can't buy UP, still allow DOWN if under max
                if (inventory.inv_down_shares < inventoryParams.max_down_shares) {
                    return 'DOWN';
                }
                return null; // At max
            }
        }

        return proposedSide; // No rebalance needed - allow accumulation on either side
    }

    /**
     * Check if cadence allows trading
     */
    cadenceOk(
        lastTradeTs: number | null,
        recentTradeTimes: number[],
        cadenceParams: CadenceParams | undefined,
        currentTs: number
    ): boolean {
        if (!cadenceParams) {
            return true; // No cadence constraints
        }

        // Check minimum inter-trade time
        if (lastTradeTs !== null) {
            const timeSinceLast = currentTs - lastTradeTs;
            if (timeSinceLast < cadenceParams.min_inter_trade_ms) {
                return false;
            }
        }

        // Check max trades per second (rolling 1s window)
        const window1sStart = currentTs - 1000;
        const trades1s = recentTradeTimes.filter(ts => ts >= window1sStart && ts <= currentTs).length;
        if (trades1s >= cadenceParams.max_trades_per_sec) {
            return false;
        }

        // Check max trades per minute (rolling 60s window)
        const window60sStart = currentTs - 60000;
        const trades60s = recentTradeTimes.filter(ts => ts >= window60sStart && ts <= currentTs).length;
        if (trades60s >= cadenceParams.max_trades_per_min) {
            return false;
        }

        return true;
    }
}

// Singleton instance
export const policyEngine = new PolicyEngine();

