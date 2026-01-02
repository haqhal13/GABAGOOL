/**
 * Policy engine implementing inferred WATCH bot parameters
 */
import {
    EntryParams,
    SizeParams,
    InventoryParams,
    CadenceParams,
    SideSelectionParams,
    ExecutionParams,
    CooldownParams,
    RiskParams,
    UnwindParams,
    ResetParams,
    QualityFilterParams,
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

// For paper mode we want to trade across the full price range rather than
// using tight inferred bands. This flag effectively disables band checks
// in the entry logic so that behavior is driven by sizing + inventory.
const IGNORE_ENTRY_BANDS = true;

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
        const upInBand = IGNORE_ENTRY_BANDS ||
            (entryParams.up_price_min !== null && entryParams.up_price_max !== null &&
                state.up_px >= entryParams.up_price_min && state.up_px <= entryParams.up_price_max);

        // Check DOWN price band
        const downInBand = IGNORE_ENTRY_BANDS ||
            (entryParams.down_price_min !== null && entryParams.down_price_max !== null &&
                state.down_px >= entryParams.down_price_min && state.down_px <= entryParams.down_price_max);

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
     * Exact implementation:
     * - Price bucket selection using size_params.bin_edges (20 buckets)
     * - If conditioning_var is null: use size_table_1d
     * - If conditioning_var == "inventory_imbalance_ratio":
     *   * compute current imbalance ratio identically to watch mode
     *   * bucket it using inventory_bucket_thresholds
     *   * select size_table["(price_bin]|bucket_k"] keys
     *   * fall back to size_table_1d only if the 2D key is missing
     */
    sizeForTrade(
        state: TapeState,
        features: Features,
        sizeParams: SizeParams | undefined,
        side: 'UP' | 'DOWN',
        inventory: InventoryState
    ): number {
        if (!sizeParams) {
            return 1.0; // Default size
        }

        const sidePx = side === 'UP' ? state.up_px : state.down_px;
        const binEdges = sizeParams.bin_edges || [];

        // Validate bin_edges are strictly increasing
        if (binEdges.length < 2) {
            return 1.0;
        }

        // Find price bucket containing sidePx
        let priceBucketIndex = -1;
        for (let i = 0; i < binEdges.length - 1; i++) {
            // Handle edge cases: first bucket includes left edge
            const leftEdge = i === 0 ? -0.001 : binEdges[i];
            const rightEdge = binEdges[i + 1];
            if (sidePx > leftEdge && sidePx <= rightEdge) {
                priceBucketIndex = i;
                break;
            }
        }

        if (priceBucketIndex === -1) {
            // Outside range, clamp to nearest bucket
            if (sidePx <= binEdges[0]) priceBucketIndex = 0;
            else priceBucketIndex = binEdges.length - 2;
        }

        // Construct price bucket key (format: "(left, right]")
        const priceBucketKey = priceBucketIndex === 0 
            ? `(-0.001, ${binEdges[1]}]`
            : `(${binEdges[priceBucketIndex]}, ${binEdges[priceBucketIndex + 1]}]`;

        // Check if conditioning_var is null -> use 1D table
        const conditioningVar = sizeParams.conditioning_var;
        if (!conditioningVar || conditioningVar === null) {
            // Use size_table_1d
            const sizeTable1d = sizeParams.size_table_1d || {};
            if (sizeTable1d[priceBucketKey] !== undefined) {
                return sizeTable1d[priceBucketKey];
            }
            // Fallback: try size_table as 1D (if keys don't contain "|")
            const sizeTable = sizeParams.size_table || {};
            if (sizeTable[priceBucketKey] !== undefined) {
                return sizeTable[priceBucketKey];
            }
            // Final fallback: median of all sizes
            const allSizes = Object.values(sizeTable);
            if (allSizes.length > 0) {
                const sorted = allSizes.sort((a, b) => a - b);
                return sorted[Math.floor(sorted.length / 2)];
            }
            return 1.0;
        }

        // Conditioning on inventory_imbalance_ratio
        if (conditioningVar === 'inventory_imbalance_ratio') {
            // Compute inventory imbalance ratio: inv_up / max(inv_down, eps)
            const eps = 1e-6;
            const invUp = inventory.inv_up_shares;
            const invDown = inventory.inv_down_shares;
            const imbalanceRatio = invUp / Math.max(invDown, eps);

            // Bucket using inventory_bucket_thresholds
            const thresholds = sizeParams.inventory_bucket_thresholds || [];
            if (thresholds.length < 2) {
                // No thresholds, fall back to 1D
                const sizeTable1d = sizeParams.size_table_1d || {};
                return sizeTable1d[priceBucketKey] || 1.0;
            }

            // Find inventory bucket index
            let invBucketIndex = 0;
            for (let i = 0; i < thresholds.length - 1; i++) {
                if (imbalanceRatio <= thresholds[i + 1]) {
                    invBucketIndex = i;
                    break;
                }
            }
            if (imbalanceRatio > thresholds[thresholds.length - 1]) {
                invBucketIndex = thresholds.length - 2; // Last bucket
            }

            // Construct 2D key: "price_bucket|inventory_bucket"
            const inventoryBucketLabel = sizeParams.inventory_buckets?.[invBucketIndex] || `bucket_${invBucketIndex}`;
            const key2d = `${priceBucketKey}|${inventoryBucketLabel}`;

            // Look up in size_table (2D table)
            const sizeTable = sizeParams.size_table || {};
            if (sizeTable[key2d] !== undefined) {
                return sizeTable[key2d];
            }

            // Fallback 1: Try other inventory buckets for same price bucket
            const inventoryBuckets = sizeParams.inventory_buckets || [];
            for (const invBucket of inventoryBuckets) {
                const fallbackKey = `${priceBucketKey}|${invBucket}`;
                if (sizeTable[fallbackKey] !== undefined) {
                    return sizeTable[fallbackKey];
                }
            }

            // Fallback 2: Use size_table_1d
            const sizeTable1d = sizeParams.size_table_1d || {};
            if (sizeTable1d[priceBucketKey] !== undefined) {
                return sizeTable1d[priceBucketKey];
            }

            // Fallback 3: Use median of all sizes
            const allSizes = Object.values(sizeTable);
            if (allSizes.length > 0) {
                const sorted = allSizes.sort((a, b) => a - b);
                return sorted[Math.floor(sorted.length / 2)];
            }

            return 1.0;
        }

        // Unknown conditioning_var, fall back to 1D
        const sizeTable1d = sizeParams.size_table_1d || {};
        return sizeTable1d[priceBucketKey] || 1.0;
    }

    /**
     * Check inventory and apply simple rebalance gating.
     *
     * This version:
     * - Enforces max_up_shares / max_down_shares / max_total_shares
     * - Uses rebalance_ratio_R symmetrically (R, 1-R) to define
     *   “extreme” imbalance thresholds near 0 and 1.
     * - Prevents adding more to the currently dominant side once
     *   the imbalance is beyond those extremes.
     * - NEVER flips the side; it only blocks trades.
     */
    inventoryOkAndRebalance(
        inventory: InventoryState,
        inventoryParams: InventoryParams | undefined,
        proposedSide: 'UP' | 'DOWN',
        _currentPriceUp?: number,
        _currentPriceDown?: number,
        _avgCostUp?: number,
        _avgCostDown?: number
    ): 'UP' | 'DOWN' | null {
        if (!inventoryParams) {
            return proposedSide;
        }

        const total = inventory.inv_up_shares + inventory.inv_down_shares;
        const eps = 1e-6;

        // Hard caps on total and per-side exposure
        if (total >= inventoryParams.max_total_shares) {
            return null;
        }

        if (proposedSide === 'UP' && inventory.inv_up_shares >= inventoryParams.max_up_shares) {
            return null;
        }
        if (proposedSide === 'DOWN' && inventory.inv_down_shares >= inventoryParams.max_down_shares) {
            return null;
        }

        return proposedSide;
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

        // Check minimum inter-trade time (directly from inferred params)
        if (lastTradeTs !== null && cadenceParams.min_inter_trade_ms > 0) {
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

    /**
     * Select side when both UP and DOWN satisfy entry conditions
     */
    selectSideWhenBothValid(
        state: TapeState,
        features: Features,
        inventory: InventoryState,
        sideSelectionParams: SideSelectionParams | undefined,
        entrySignalUp: boolean,
        entrySignalDown: boolean
    ): 'UP' | 'DOWN' | null {
        if (!entrySignalUp && !entrySignalDown) {
            return null;
        }
        if (entrySignalUp && !entrySignalDown) {
            return 'UP';
        }
        if (entrySignalDown && !entrySignalUp) {
            return 'DOWN';
        }

        // Both are valid - apply side selection logic
        if (!sideSelectionParams) {
            // Default: inventory-first tie-break (reduce imbalance toward 1.0)
            return this.inventoryFirstTieBreak(state, inventory);
        }

        const mode = sideSelectionParams.mode;

        // If mode is "mixed" (confidence_gap < 0.10), use inventory-first tie-break
        if (mode === 'mixed' || (sideSelectionParams.confidence_gap !== undefined && sideSelectionParams.confidence_gap < 0.10)) {
            return this.inventoryFirstTieBreak(state, inventory);
        }

        if (mode === 'inventory_driven') {
            return this.inventoryFirstTieBreak(state, inventory);
        } else if (mode === 'edge_driven') {
            // Choose side with better edge (further from 0.5 = higher edge)
            const upDistance = Math.abs(state.up_px - 0.5);
            const downDistance = Math.abs(state.down_px - 0.5);
            return upDistance > downDistance ? 'UP' : 'DOWN';
        } else if (mode === 'momentum_driven') {
            // Choose side with rising price (positive momentum)
            const delta5s = features.delta_5s_side_px ?? 0;
            if (delta5s > 0.001) return 'UP'; // UP price rising
            if (delta5s < -0.001) return 'DOWN'; // DOWN price rising (UP falling)
            // Fallback to inventory-first if no clear momentum
            return this.inventoryFirstTieBreak(state, inventory);
        } else if (mode === 'alternating') {
            // Simple alternating - would need trade history to implement properly
            // For now, default to inventory-first
            return this.inventoryFirstTieBreak(state, inventory);
        } else if (mode === 'fixed_preference') {
            return sideSelectionParams.preferred_side || 'UP';
        }

        // Fallback to inventory-first
        return this.inventoryFirstTieBreak(state, inventory);
    }

    /**
     * Inventory-first tie-break: choose side that reduces imbalance toward 1.0 (50/50)
     * If balanced, choose side with higher edge (further from 0.5)
     */
    private inventoryFirstTieBreak(state: TapeState, inventory: InventoryState): 'UP' | 'DOWN' {
        const total = inventory.inv_up_shares + inventory.inv_down_shares;
        const eps = 1e-6;

        if (total < eps) {
            // No inventory - choose side with higher edge (further from 0.5)
            const upDistance = Math.abs(state.up_px - 0.5);
            const downDistance = Math.abs(state.down_px - 0.5);
            return upDistance > downDistance ? 'UP' : 'DOWN';
        }

        // Compute imbalance ratio: inv_up / max(inv_down, eps)
        const imbalanceRatio = inventory.inv_up_shares / Math.max(inventory.inv_down_shares, eps);
        
        // Target ratio is 1.0 (balanced: inv_up = inv_down)
        // Choose side that reduces imbalance toward 1.0
        if (imbalanceRatio > 1.0) {
            // UP is higher - choose DOWN to reduce imbalance
            return 'DOWN';
        } else if (imbalanceRatio < 1.0) {
            // DOWN is higher - choose UP to reduce imbalance
            return 'UP';
        } else {
            // Balanced - choose side with higher edge (further from 0.5)
            const upDistance = Math.abs(state.up_px - 0.5);
            const downDistance = Math.abs(state.down_px - 0.5);
            return upDistance > downDistance ? 'UP' : 'DOWN';
        }
    }

    /**
     * Simulate fill price based on execution model
     */
    simulateFillPrice(
        side: 'UP' | 'DOWN',
        snapshotSidePx: number,
        executionParams: ExecutionParams | undefined
    ): number {
        if (!executionParams) {
            return snapshotSidePx; // Default: at snapshot price
        }

        const modelType = executionParams.model_type;

        if (modelType === 'snapshot_price') {
            return snapshotSidePx;
        } else if (modelType === 'fixed_slippage') {
            return snapshotSidePx + executionParams.slippage_offset;
        } else if (modelType === 'mid_price') {
            // Mid price would require bid/ask, default to snapshot + small offset
            return snapshotSidePx + (executionParams.fill_bias_median || 0);
        } else if (modelType === 'worst_case') {
            // Worst case: use p75 bias (conservative)
            const bias = executionParams.fill_bias_p75 || executionParams.fill_bias_median || 0;
            return snapshotSidePx + bias;
        }

        return snapshotSidePx;
    }

    /**
     * Check cooldown/lockout rules
     */
    checkCooldown(
        lastTradeTs: number | null,
        currentTs: number,
        features: Features,
        inventory: InventoryState,
        cooldownParams: CooldownParams | undefined
    ): boolean {
        if (!cooldownParams) {
            return true; // No cooldown
        }

        // Time-based cooldown
        if (cooldownParams.has_time_cooldown && lastTradeTs !== null) {
            const timeSinceLast = (currentTs - lastTradeTs) / 1000; // seconds
            if (timeSinceLast < cooldownParams.time_cooldown_seconds) {
                return false;
            }
        }

        // Price move-based cooldown
        if (cooldownParams.price_move_threshold !== null && lastTradeTs !== null) {
            const timeSinceLast = (currentTs - lastTradeTs) / 1000;
            if (timeSinceLast < 5.0) { // Check only within 5s window
                const priceMove = Math.abs(features.delta_5s_side_px || 0);
                if (priceMove < cooldownParams.price_move_threshold) {
                    return false; // Need more price movement
                }
            }
        }

        // Inventory-based lockout
        if (cooldownParams.has_inventory_lockout && cooldownParams.inventory_lockout_threshold !== null) {
            const total = inventory.inv_up_shares + inventory.inv_down_shares;
            if (total > 0) {
                const maxRatio = Math.max(
                    inventory.inv_up_shares / total,
                    inventory.inv_down_shares / total
                );
                if (maxRatio > cooldownParams.inventory_lockout_threshold) {
                    return false; // Too extreme imbalance
                }
            }
        }

        return true;
    }

    /**
     * Check risk & exposure limits
     */
    checkRiskLimits(
        tradesThisSession: number,
        inventory: InventoryState,
        riskParams: RiskParams | undefined
    ): boolean {
        if (!riskParams) {
            return true; // No risk limits
        }

        // Max trades per session
        if (riskParams.max_trades_per_session !== null) {
            if (tradesThisSession >= riskParams.max_trades_per_session) {
                return false;
            }
        }

        // Max imbalance ratio
        const total = inventory.inv_up_shares + inventory.inv_down_shares;
        if (total > 0) {
            const imbalanceRatio = Math.max(
                inventory.inv_up_shares / total,
                inventory.inv_down_shares / total
            );
            if (imbalanceRatio > riskParams.max_imbalance_ratio) {
                return false;
            }
        }

        // Max exposure per side
        if (inventory.inv_up_shares > riskParams.max_exposure_up_shares) {
            return false;
        }
        if (inventory.inv_down_shares > riskParams.max_exposure_down_shares) {
            return false;
        }

        return true;
    }

    /**
     * Check data quality filters
     */
    checkDataQuality(
        state: TapeState,
        lastPriceState: { up_px: number; down_px: number; timestamp: number } | null,
        qualityFilterParams: QualityFilterParams | undefined
    ): boolean {
        if (!qualityFilterParams) {
            return true; // No filters
        }

        // Check UP + DOWN ≈ 1.0
        const priceSum = state.up_px + state.down_px;
        const deviation = Math.abs(priceSum - 1.0);
        if (deviation > qualityFilterParams.max_price_sum_deviation) {
            return false;
        }

        // Check timestamp jump
        if (lastPriceState !== null) {
            const timeDiff = (state.timestamp - lastPriceState.timestamp) / 1000; // seconds
            if (timeDiff > qualityFilterParams.timestamp_jump_threshold_seconds) {
                return false;
            }

            // Check price gap
            const upGap = Math.abs(state.up_px - lastPriceState.up_px);
            const downGap = Math.abs(state.down_px - lastPriceState.down_px);
            const maxGap = Math.max(upGap, downGap);
            if (maxGap > qualityFilterParams.price_gap_threshold) {
                return false;
            }
        }

        return true;
    }

    /**
     * Check if inventory should be reset (market switch/inactivity)
     */
    shouldResetInventory(
        lastActivityTs: number | null,
        currentTs: number,
        resetParams: ResetParams | undefined
    ): boolean {
        if (!resetParams) {
            return false; // Default: don't reset
        }

        if (lastActivityTs === null) {
            return resetParams.resets_on_market_switch; // New market
        }

        if (resetParams.resets_on_inactivity) {
            const hoursSinceActivity = (currentTs - lastActivityTs) / (1000 * 60 * 60);
            if (hoursSinceActivity > resetParams.inactivity_threshold_hours) {
                return true;
            }
        }

        return false;
    }
}

// Singleton instance
export const policyEngine = new PolicyEngine();
