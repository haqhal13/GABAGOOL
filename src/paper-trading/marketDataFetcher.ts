/**
 * Market Data Fetcher
 *
 * Fetches live market data from Polymarket APIs for paper trading.
 * Focuses on binary markets (UP/DOWN, YES/NO) with known resolution times.
 */

import axios from 'axios';
import { BinaryMarket, PriceUpdate } from './interfaces';
import { DualSideStrategyConfig, PAPER_CONFIG } from './config';

// Polymarket API endpoints
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';

/**
 * Market response from Gamma API
 */
interface GammaMarketResponse {
    id: string;
    condition_id: string;
    question_id?: string;
    question: string;
    description?: string;
    market_slug: string;
    end_date_iso: string;
    game_start_time?: string;
    seconds_delay?: number;
    minimum_tick_size?: number;
    minimum_order_size?: number;
    active: boolean;
    closed: boolean;
    archived?: boolean;
    accepting_orders: boolean;
    accepting_order_timestamp?: string;
    neg_risk?: boolean;
    neg_risk_market_id?: string;
    neg_risk_request_id?: string;
    enable_order_book?: boolean;
    tokens: {
        token_id: string;
        outcome: string;
        price?: number;
        winner?: boolean;
    }[];
    rewards?: {
        rates: { asset_address: string; rewards_daily_rate: number }[];
        min_size: number;
        max_spread: number;
    };
    is_50_50_outcome?: boolean;
    icon?: string;
    image?: string;
    tags?: string[];
    category?: string;
    volume?: string;
    volume_num?: number;
    liquidity?: string;
    liquidity_num?: number;
    spread?: number;
}

/**
 * Order book response from CLOB API
 */
interface OrderBookResponse {
    market: string;
    asset_id: string;
    hash: string;
    timestamp: string;
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
}

/**
 * Market Data Fetcher class
 */
export class MarketDataFetcher {
    private config: DualSideStrategyConfig;
    private includePatterns: RegExp[];
    private excludePatterns: RegExp[];

    constructor(config: DualSideStrategyConfig = PAPER_CONFIG) {
        this.config = config;

        // Compile regex patterns
        this.includePatterns = config.marketFilter.includePatterns.map(
            p => new RegExp(p, 'i')
        );
        this.excludePatterns = config.marketFilter.excludePatterns.map(
            p => new RegExp(p, 'i')
        );
    }

    /**
     * Fetch a single raw Gamma market by condition_id.
     *
     * Gamma's /markets/{id} endpoint expects a market ID, not a condition_id,
     * so we instead query the markets list and match on condition_id.
     */
    private async fetchRawMarketByConditionId(conditionId: string): Promise<GammaMarketResponse | null> {
        try {
            const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
                params: {
                    active: true,
                    closed: false,
                    limit: 500,
                },
                timeout: 10000,
            });

            if (!Array.isArray(response.data)) {
                return null;
            }

            const raw = (response.data as GammaMarketResponse[]).find(
                m => m.condition_id === conditionId
            );

            return raw ?? null;
        } catch (error) {
            console.error(`Failed to fetch raw market for condition ${conditionId}:`, error);
            return null;
        }
    }

    /**
     * Fetch all active binary markets matching our criteria
     */
    async fetchActiveMarkets(): Promise<BinaryMarket[]> {
        try {
            // Fetch markets from Gamma API
            const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
                params: {
                    active: true,
                    closed: false,
                    limit: 100,
                },
                timeout: 10000,
            });

            const markets: BinaryMarket[] = [];

            for (const raw of response.data) {
                const market = this.parseMarket(raw);
                if (market && this.matchesFilter(market)) {
                    markets.push(market);
                }
            }

            return markets;
        } catch (error) {
            console.error('Failed to fetch markets:', error);
            return [];
        }
    }

    /**
     * Search for markets matching a query
     */
    async searchMarkets(query: string): Promise<BinaryMarket[]> {
        try {
            const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
                params: {
                    active: true,
                    closed: false,
                    limit: 50,
                },
                timeout: 10000,
            });

            const markets: BinaryMarket[] = [];
            const queryLower = query.toLowerCase();

            for (const raw of response.data) {
                const market = this.parseMarket(raw);
                if (market) {
                    const matchesQuery =
                        market.slug.toLowerCase().includes(queryLower) ||
                        market.title.toLowerCase().includes(queryLower);

                    if (matchesQuery && this.matchesFilter(market)) {
                        markets.push(market);
                    }
                }
            }

            return markets;
        } catch (error) {
            console.error('Failed to search markets:', error);
            return [];
        }
    }

    /**
     * Fetch a specific market by condition ID
     */
    async fetchMarket(conditionId: string): Promise<BinaryMarket | null> {
        const raw = await this.fetchRawMarketByConditionId(conditionId);
        if (!raw) {
            console.error(`Failed to fetch market ${conditionId}: no matching condition_id`);
            return null;
        }

        const parsed = this.parseMarket(raw);
        if (!parsed) {
            console.error(`Failed to parse market for condition ${conditionId}`);
            return null;
        }

        return parsed;
    }

    /**
     * Fetch current prices for a list of markets
     */
    async fetchPrices(conditionIds: string[]): Promise<PriceUpdate[]> {
        const updates: PriceUpdate[] = [];

        // Fetch prices in parallel with rate limiting
        const batchSize = 5;
        for (let i = 0; i < conditionIds.length; i += batchSize) {
            const batch = conditionIds.slice(i, i + batchSize);
            const batchPromises = batch.map(id => this.fetchMarketPrice(id));
            const results = await Promise.allSettled(batchPromises);

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    updates.push(result.value);
                }
            }

            // Small delay between batches to avoid rate limiting
            if (i + batchSize < conditionIds.length) {
                await this.sleep(100);
            }
        }

        return updates;
    }

    /**
     * Fetch price for a single market
     */
    async fetchMarketPrice(conditionId: string): Promise<PriceUpdate | null> {
        const raw = await this.fetchRawMarketByConditionId(conditionId);
        if (!raw || !raw.tokens || raw.tokens.length < 2) {
            return null;
        }

        // Find UP and DOWN tokens
        let priceUp = 0.5;
        let priceDown = 0.5;

        for (const token of raw.tokens) {
            const outcome = token.outcome?.toLowerCase() || '';
            const price = parseFloat(String(token.price ?? '0.5')) || 0.5;

            if (this.isUpOutcome(outcome)) {
                priceUp = price;
            } else if (this.isDownOutcome(outcome)) {
                priceDown = price;
            }
        }

        // Normalize prices
        const total = priceUp + priceDown;
        if (total > 0) {
            priceUp = priceUp / total;
            priceDown = priceDown / total;
        }

        return {
            conditionId,
            priceUp,
            priceDown,
            timestamp: Date.now(),
            volume24h: parseFloat(raw.volume ?? '0') || 0,
        };
    }

    /**
     * Fetch order book for a token
     */
    async fetchOrderBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number } | null> {
        try {
            const response = await axios.get(`${CLOB_API_BASE}/book`, {
                params: { token_id: tokenId },
                timeout: 5000,
            });

            const book: OrderBookResponse = response.data;

            const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
            const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;

            return { bestBid, bestAsk };
        } catch (error) {
            return null;
        }
    }

    /**
     * Parse raw API response into BinaryMarket
     */
    private parseMarket(raw: GammaMarketResponse): BinaryMarket | null {
        if (!raw || !raw.condition_id || !raw.tokens || raw.tokens.length < 2) {
            return null;
        }

        // Find UP and DOWN tokens
        let tokenIdUp = '';
        let tokenIdDown = '';
        let priceUp = 0.5;
        let priceDown = 0.5;

        for (const token of raw.tokens) {
            const outcome = token.outcome?.toLowerCase() || '';

            if (this.isUpOutcome(outcome)) {
                tokenIdUp = token.token_id;
                priceUp = token.price ?? 0.5;
            } else if (this.isDownOutcome(outcome)) {
                tokenIdDown = token.token_id;
                priceDown = token.price ?? 0.5;
            }
        }

        // Skip if we couldn't identify both tokens
        if (!tokenIdUp || !tokenIdDown) {
            return null;
        }

        // Parse end date
        let endDate: number;
        try {
            endDate = new Date(raw.end_date_iso).getTime();
        } catch {
            return null;
        }

        // Check if resolved
        const resolved = raw.closed || raw.archived || false;
        let resolutionOutcome: 'UP' | 'DOWN' | null = null;

        for (const token of raw.tokens) {
            if (token.winner) {
                resolutionOutcome = this.isUpOutcome(token.outcome?.toLowerCase() || '') ? 'UP' : 'DOWN';
                break;
            }
        }

        return {
            conditionId: raw.condition_id,
            slug: raw.market_slug,
            title: raw.question,
            description: raw.description,
            tokenIdUp,
            tokenIdDown,
            priceUp,
            priceDown,
            endDate,
            createdAt: undefined, // Not always available
            active: raw.active && raw.accepting_orders && !raw.closed,
            resolved,
            resolutionOutcome,
            category: raw.category,
            volume24h: raw.volume_num,
            liquidity: raw.liquidity_num,
        };
    }

    /**
     * Check if a market matches our filter criteria
     */
    private matchesFilter(market: BinaryMarket): boolean {
        const { marketFilter } = this.config;
        const now = Date.now();

        // Check time constraints
        const timeToResolution = market.endDate - now;

        if (timeToResolution < marketFilter.minTimeToResolution) {
            return false;
        }

        if (timeToResolution > marketFilter.maxTimeToResolution) {
            return false;
        }

        // Check liquidity
        if (market.liquidity !== undefined && market.liquidity < marketFilter.minLiquidity) {
            return false;
        }

        // Check volume
        if (market.volume24h !== undefined && market.volume24h < marketFilter.minVolume24h) {
            return false;
        }

        // Check include patterns
        const searchText = `${market.slug} ${market.title}`;

        if (this.includePatterns.length > 0) {
            const matchesInclude = this.includePatterns.some(p => p.test(searchText));
            if (!matchesInclude) {
                return false;
            }
        }

        // Check exclude patterns
        if (this.excludePatterns.length > 0) {
            const matchesExclude = this.excludePatterns.some(p => p.test(searchText));
            if (matchesExclude) {
                return false;
            }
        }

        // Market must be active and not resolved
        if (!market.active || market.resolved) {
            return false;
        }

        return true;
    }

    /**
     * Check if outcome string indicates UP/YES
     */
    private isUpOutcome(outcome: string): boolean {
        return (
            outcome.includes('up') ||
            outcome.includes('yes') ||
            outcome.includes('higher') ||
            outcome.includes('above') ||
            outcome.includes('over') ||
            outcome === '0' // First outcome index
        );
    }

    /**
     * Check if outcome string indicates DOWN/NO
     */
    private isDownOutcome(outcome: string): boolean {
        return (
            outcome.includes('down') ||
            outcome.includes('no') ||
            outcome.includes('lower') ||
            outcome.includes('below') ||
            outcome.includes('under') ||
            outcome === '1' // Second outcome index
        );
    }

    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fetch markets by specific crypto pattern (e.g., "BTC-UpDown-15")
     */
    async fetchCryptoMarkets(crypto: 'BTC' | 'ETH' | 'SOL', timeframe: string = '15min'): Promise<BinaryMarket[]> {
        try {
            const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
                params: {
                    active: true,
                    closed: false,
                    limit: 50,
                },
                timeout: 10000,
            });

            const markets: BinaryMarket[] = [];
            const cryptoLower = crypto.toLowerCase();
            const cryptoFull = crypto === 'BTC' ? 'bitcoin' : crypto === 'ETH' ? 'ethereum' : 'solana';

            for (const raw of response.data) {
                const market = this.parseMarket(raw);
                if (!market) continue;

                const searchText = `${market.slug} ${market.title}`.toLowerCase();

                // Check if it matches the crypto
                const matchesCrypto =
                    searchText.includes(cryptoLower) ||
                    searchText.includes(cryptoFull);

                // Check if it's an up/down market
                const isUpDown =
                    searchText.includes('up') && searchText.includes('down') ||
                    searchText.includes('updown');

                // Check timeframe
                const matchesTimeframe = searchText.includes(timeframe) ||
                    searchText.includes(timeframe.replace('min', '')) ||
                    searchText.includes('15');

                if (matchesCrypto && isUpDown && matchesTimeframe && market.active && !market.resolved) {
                    markets.push(market);
                }
            }

            return markets;
        } catch (error) {
            console.error(`Failed to fetch ${crypto} markets:`, error);
            return [];
        }
    }

    /**
     * Poll for market updates (returns only changed markets)
     */
    async pollMarkets(knownConditionIds: string[]): Promise<{
        newMarkets: BinaryMarket[];
        resolvedMarkets: string[];
        priceUpdates: PriceUpdate[];
    }> {
        try {
            const [activeMarkets, prices] = await Promise.all([
                this.fetchActiveMarkets(),
                this.fetchPrices(knownConditionIds),
            ]);

            const activeIds = new Set(activeMarkets.map(m => m.conditionId));
            const knownIds = new Set(knownConditionIds);

            // Find new markets
            const newMarkets = activeMarkets.filter(m => !knownIds.has(m.conditionId));

            // Find resolved markets (known but no longer active)
            const resolvedMarkets = knownConditionIds.filter(id => !activeIds.has(id));

            return {
                newMarkets,
                resolvedMarkets,
                priceUpdates: prices,
            };
        } catch (error) {
            console.error('Failed to poll markets:', error);
            return {
                newMarkets: [],
                resolvedMarkets: [],
                priceUpdates: [],
            };
        }
    }
}

// Export singleton instance
export const marketDataFetcher = new MarketDataFetcher();
