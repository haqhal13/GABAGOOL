/**
 * Parity Debug Logger
 * Logs detailed decision information for each tick to enable parity debugging
 */
import * as fs from 'fs';
import * as path from 'path';
import { TapeState, InventoryState } from './policyEngine';
import { MarketParams, SizeParams } from './paramLoader';

export interface ParityDebugLogEntry {
    decisionId: number;
    timestamp: number;
    market: string;
    priceRef: {
        up_px: number;
        down_px: number;
        price_source: string; // "mid" | "mark" | "last"
    };
    bucketInfo: {
        price_bucket_id: number;
        price_bucket_key: string;
        conditioning_bucket?: string;
        inventory_ratio?: number;
    };
    sideSelection: {
        chosen_side: 'UP' | 'DOWN' | null;
        reason: string;
        entry_signal_up: boolean;
        entry_signal_down: boolean;
    };
    sizeInfo: {
        raw_size: number;
        capped_size: number;
        size_table_key?: string;
    };
    inventoryState: {
        inv_up_shares: number;
        inv_down_shares: number;
        inv_total: number;
        inv_ratio: number;
    };
    fillModel: {
        model_type: string;
        snapshot_side_px: number;
        computed_fill_price: number;
        fill_bias: number;
        slippage_offset?: number;
    };
}

class ParityDebugLogger {
    private logPath: string;
    private logEntries: ParityDebugLogEntry[] = [];
    private enabled: boolean;

    constructor(enabled: boolean = false, logPath?: string) {
        this.enabled = enabled;
        if (!logPath) {
            this.logPath = path.join(process.cwd(), 'logs', 'parity_debug.jsonl');
        } else {
            this.logPath = logPath;
        }

        // Ensure log directory exists
        if (this.enabled) {
            const logDir = path.dirname(this.logPath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }
    }

    /**
     * Log a decision tick
     */
    logDecision(
        decisionId: number,
        timestamp: number,
        market: string,
        state: TapeState,
        marketParams: MarketParams,
        bucketInfo: {
            priceBucketId: number;
            priceBucketKey: string;
            conditioningBucket?: string;
            inventoryRatio?: number;
        },
        sideSelection: {
            chosenSide: 'UP' | 'DOWN' | null;
            reason: string;
            entrySignalUp: boolean;
            entrySignalDown: boolean;
        },
        sizeInfo: {
            rawSize: number;
            cappedSize: number;
            sizeTableKey?: string;
        },
        inventory: InventoryState,
        fillModel: {
            modelType: string;
            snapshotSidePx: number;
            computedFillPrice: number;
            fillBias: number;
            slippageOffset?: number;
        }
    ): void {
        if (!this.enabled) {
            return;
        }

        const entry: ParityDebugLogEntry = {
            decisionId,
            timestamp,
            market,
            priceRef: {
                up_px: state.up_px,
                down_px: state.down_px,
                price_source: 'mid' // TODO: Determine actual price source from execution_params
            },
            bucketInfo: {
                price_bucket_id: bucketInfo.priceBucketId,
                price_bucket_key: bucketInfo.priceBucketKey,
                conditioning_bucket: bucketInfo.conditioningBucket,
                inventory_ratio: bucketInfo.inventoryRatio
            },
            sideSelection: {
                chosen_side: sideSelection.chosenSide,
                reason: sideSelection.reason,
                entry_signal_up: sideSelection.entrySignalUp,
                entry_signal_down: sideSelection.entrySignalDown
            },
            sizeInfo: {
                raw_size: sizeInfo.rawSize,
                capped_size: sizeInfo.cappedSize,
                size_table_key: sizeInfo.sizeTableKey
            },
            inventoryState: {
                inv_up_shares: inventory.inv_up_shares,
                inv_down_shares: inventory.inv_down_shares,
                inv_total: inventory.inv_up_shares + inventory.inv_down_shares,
                inv_ratio: inventory.inv_up_shares / Math.max(inventory.inv_down_shares + inventory.inv_up_shares, 1e-6)
            },
            fillModel: {
                model_type: fillModel.modelType,
                snapshot_side_px: fillModel.snapshotSidePx,
                computed_fill_price: fillModel.computedFillPrice,
                fill_bias: fillModel.fillBias,
                slippage_offset: fillModel.slippageOffset
            }
        };

        this.logEntries.push(entry);

        // Write to JSONL file (append mode)
        try {
            fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (error) {
            // Silently fail - debug logging shouldn't break the bot
            console.error('Failed to write parity debug log:', error);
        }
    }

    /**
     * Get all log entries (for testing/analysis)
     */
    getLogEntries(): ParityDebugLogEntry[] {
        return [...this.logEntries];
    }

    /**
     * Clear log entries
     */
    clear(): void {
        this.logEntries = [];
        if (fs.existsSync(this.logPath)) {
            fs.unlinkSync(this.logPath);
        }
    }

    /**
     * Enable/disable logging
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }
}

// Singleton instance
let loggerInstance: ParityDebugLogger | null = null;

export function getParityDebugLogger(enabled: boolean = false): ParityDebugLogger {
    if (!loggerInstance) {
        loggerInstance = new ParityDebugLogger(enabled);
    }
    return loggerInstance;
}
