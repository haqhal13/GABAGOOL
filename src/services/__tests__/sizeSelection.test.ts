/**
 * Unit test for size selection with inventory conditioning
 */
import { PolicyEngine, TapeState, Features, InventoryState } from '../policyEngine';
import { SizeParams } from '../paramLoader';

describe('Size Selection with Inventory Conditioning', () => {
    const engine = new PolicyEngine();

    describe('1D size table (no conditioning)', () => {
        it('should use size_table_1d when conditioning_var is null', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.5, 1.0],
                size_table: {}, // Empty 2D table
                size_table_1d: {
                    '(0, 0.5]': 10.0,
                    '(0.5, 1]': 20.0
                },
                conditioning_var: null
            };

            const state: TapeState = {
                timestamp: 1000,
                up_px: 0.3,
                down_px: 0.7,
                market: 'BTC_15m'
            };

            const features: Features = { distance_from_50: 0.2 };
            const inventory: InventoryState = { inv_up_shares: 100, inv_down_shares: 50 };

            const size = engine.sizeForTrade(state, features, sizeParams, 'UP', inventory);
            expect(size).toBe(10.0); // Should use size_table_1d
        });
    });

    describe('2D size table (inventory conditioning)', () => {
        it('should use 2D table when conditioning_var is inventory_imbalance_ratio', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.5, 1.0],
                size_table: {
                    '(0, 0.5]|bucket_0': 5.0,
                    '(0, 0.5]|bucket_1': 15.0,
                    '(0.5, 1]|bucket_0': 10.0,
                    '(0.5, 1]|bucket_1': 20.0
                },
                size_table_1d: {
                    '(0, 0.5]': 12.0,
                    '(0.5, 1]': 18.0
                },
                conditioning_var: 'inventory_imbalance_ratio',
                inventory_bucket_thresholds: [0.0, 1.0, 2.0],
                inventory_buckets: ['bucket_0', 'bucket_1']
            };

            const state: TapeState = {
                timestamp: 1000,
                up_px: 0.3,
                down_px: 0.7,
                market: 'BTC_15m'
            };

            const features: Features = { distance_from_50: 0.2 };

            // Test bucket_0 (imbalance ratio < 1.0)
            const inventoryLow: InventoryState = { inv_up_shares: 50, inv_down_shares: 100 };
            const sizeLow = engine.sizeForTrade(state, features, sizeParams, 'UP', inventoryLow);
            expect(sizeLow).toBe(5.0); // bucket_0

            // Test bucket_1 (imbalance ratio >= 1.0)
            const inventoryHigh: InventoryState = { inv_up_shares: 100, inv_down_shares: 50 };
            const sizeHigh = engine.sizeForTrade(state, features, sizeParams, 'UP', inventoryHigh);
            expect(sizeHigh).toBe(15.0); // bucket_1
        });

        it('should fallback to size_table_1d if 2D key is missing', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.5, 1.0],
                size_table: {
                    '(0, 0.5]|bucket_1': 15.0, // Missing bucket_0
                    '(0.5, 1]|bucket_0': 10.0
                },
                size_table_1d: {
                    '(0, 0.5]': 12.0,
                    '(0.5, 1]': 18.0
                },
                conditioning_var: 'inventory_imbalance_ratio',
                inventory_bucket_thresholds: [0.0, 1.0, 2.0],
                inventory_buckets: ['bucket_0', 'bucket_1']
            };

            const state: TapeState = {
                timestamp: 1000,
                up_px: 0.3,
                down_px: 0.7,
                market: 'BTC_15m'
            };

            const features: Features = { distance_from_50: 0.2 };

            // Test bucket_0 (should fallback to 1D since 2D key missing)
            const inventoryLow: InventoryState = { inv_up_shares: 50, inv_down_shares: 100 };
            const size = engine.sizeForTrade(state, features, sizeParams, 'UP', inventoryLow);
            expect(size).toBe(12.0); // Fallback to size_table_1d
        });

        it('should compute inventory ratio correctly: inv_up / max(inv_down, eps)', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 1.0],
                size_table: {
                    '(0, 1]|bucket_0': 5.0,  // ratio < 0.5
                    '(0, 1]|bucket_1': 10.0, // ratio 0.5-1.0
                    '(0, 1]|bucket_2': 15.0  // ratio > 1.0
                },
                size_table_1d: {
                    '(0, 1]': 10.0
                },
                conditioning_var: 'inventory_imbalance_ratio',
                inventory_bucket_thresholds: [0.0, 0.5, 1.0, 2.0],
                inventory_buckets: ['bucket_0', 'bucket_1', 'bucket_2']
            };

            const state: TapeState = {
                timestamp: 1000,
                up_px: 0.5,
                down_px: 0.5,
                market: 'BTC_15m'
            };

            const features: Features = { distance_from_50: 0.0 };

            // Test ratio = 0.25 (inv_up=25, inv_down=100) -> bucket_0
            const inv1: InventoryState = { inv_up_shares: 25, inv_down_shares: 100 };
            const size1 = engine.sizeForTrade(state, features, sizeParams, 'UP', inv1);
            expect(size1).toBe(5.0);

            // Test ratio = 1.0 (inv_up=100, inv_down=100) -> bucket_1
            const inv2: InventoryState = { inv_up_shares: 100, inv_down_shares: 100 };
            const size2 = engine.sizeForTrade(state, features, sizeParams, 'UP', inv2);
            expect(size2).toBe(10.0);

            // Test ratio = 2.0 (inv_up=100, inv_down=50) -> bucket_2
            const inv3: InventoryState = { inv_up_shares: 100, inv_down_shares: 50 };
            const size3 = engine.sizeForTrade(state, features, sizeParams, 'UP', inv3);
            expect(size3).toBe(15.0);
        });
    });

    describe('Bucket selection', () => {
        it('should correctly identify price bucket from bin_edges', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
                size_table: {},
                size_table_1d: {
                    '(-0.001, 0.1]': 1.0,
                    '(0.1, 0.2]': 2.0,
                    '(0.2, 0.3]': 3.0,
                    '(0.3, 0.4]': 4.0,
                    '(0.4, 0.5]': 5.0,
                    '(0.5, 0.6]': 6.0,
                    '(0.6, 0.7]': 7.0,
                    '(0.7, 0.8]': 8.0,
                    '(0.8, 0.9]': 9.0,
                    '(0.9, 1.0]': 10.0
                },
                conditioning_var: null
            };

            const features: Features = { distance_from_50: 0.0 };
            const inventory: InventoryState = { inv_up_shares: 0, inv_down_shares: 0 };

            // Test various prices
            const testCases = [
                { price: 0.05, expectedBucket: '(-0.001, 0.1]', expectedSize: 1.0 },
                { price: 0.15, expectedBucket: '(0.1, 0.2]', expectedSize: 2.0 },
                { price: 0.25, expectedBucket: '(0.2, 0.3]', expectedSize: 3.0 },
                { price: 0.75, expectedBucket: '(0.7, 0.8]', expectedSize: 8.0 },
                { price: 0.95, expectedBucket: '(0.9, 1.0]', expectedSize: 10.0 }
            ];

            for (const testCase of testCases) {
                const state: TapeState = {
                    timestamp: 1000,
                    up_px: testCase.price,
                    down_px: 1.0 - testCase.price,
                    market: 'BTC_15m'
                };

                const size = engine.sizeForTrade(state, features, sizeParams, 'UP', inventory);
                expect(size).toBe(testCase.expectedSize);
            }
        });
    });
});
