/**
 * Paper Trading Interfaces
 *
 * Type definitions for the dual-side accumulation paper trading system.
 * This strategy buys both sides of binary markets, tilting allocation
 * based on probability skew while maintaining minority-side exposure.
 */

/**
 * Represents a binary market from Polymarket
 */
export interface BinaryMarket {
    conditionId: string;
    slug: string;
    title: string;
    description?: string;

    // Token information
    tokenIdUp: string;      // YES/UP token ID
    tokenIdDown: string;    // NO/DOWN token ID

    // Current prices (probability representation)
    priceUp: number;        // Current price for UP outcome (0-1)
    priceDown: number;      // Current price for DOWN outcome (0-1)

    // Market timing
    endDate: number;        // Unix timestamp when market resolves
    createdAt?: number;     // When market was created

    // Market state
    active: boolean;        // Whether market is still tradeable
    resolved: boolean;      // Whether market has resolved
    resolutionOutcome?: 'UP' | 'DOWN' | null;  // Which side won after resolution

    // Metadata
    category?: string;
    volume24h?: number;
    liquidity?: number;
}

/**
 * Market skew analysis - determines dominant vs minority side
 */
export interface SkewAnalysis {
    dominantSide: 'UP' | 'DOWN';
    minoritySide: 'UP' | 'DOWN';
    skewMagnitude: number;      // 0-0.5, where 0 = neutral, 0.5 = extreme (100/0)
    skewPercent: number;        // Human-readable: 0-50%
    priceUp: number;
    priceDown: number;
    isNeutral: boolean;         // True if within neutral zone
    isModerate: boolean;        // Moderate skew zone
    isExtreme: boolean;         // Extreme skew zone
}

/**
 * Target allocation based on current skew
 */
export interface AllocationTarget {
    dominantSideRatio: number;  // 0.5-0.95 (never 1.0)
    minoritySideRatio: number;  // 0.05-0.5 (never 0.0)
    dominantSide: 'UP' | 'DOWN';
    minoritySide: 'UP' | 'DOWN';
    reasoning: string;
}

/**
 * Paper position on one side of a market
 */
export interface PaperPosition {
    side: 'UP' | 'DOWN';
    shares: number;
    totalCost: number;          // Total USD spent
    averagePrice: number;       // Average cost per share
    tradeCount: number;         // Number of trades
    firstTradeTime: number;     // Unix timestamp
    lastTradeTime: number;      // Unix timestamp
}

/**
 * Complete paper position for a market (both sides)
 */
export interface PaperMarketPosition {
    market: BinaryMarket;
    positionUp: PaperPosition;
    positionDown: PaperPosition;

    // Allocation tracking
    currentAllocationUp: number;    // Current % in UP (0-1)
    currentAllocationDown: number;  // Current % in DOWN (0-1)
    targetAllocationUp: number;     // Target % in UP
    targetAllocationDown: number;   // Target % in DOWN

    // Timing
    firstTradeTime: number;
    lastTradeTime: number;

    // Computed values
    totalInvested: number;          // Total USD deployed
    currentValue: number;           // Current market value
    unrealizedPnL: number;          // Current unrealized P&L
    unrealizedPnLPercent: number;   // P&L as percentage
}

/**
 * Paper trade record
 */
export interface PaperTrade {
    id: string;
    timestamp: number;

    // Market info
    conditionId: string;
    marketSlug: string;
    marketTitle: string;

    // Trade details
    side: 'UP' | 'DOWN';
    shares: number;
    pricePerShare: number;
    totalCost: number;

    // Context at time of trade
    skewAtTrade: SkewAnalysis;
    allocationAtTrade: AllocationTarget;
    positionBeforeTrade: PaperPosition | null;

    // Reasoning
    reason: string;
}

/**
 * Resolved market outcome
 */
export interface ResolvedMarket {
    market: BinaryMarket;
    position: PaperMarketPosition;

    // Resolution details
    resolutionTime: number;
    winningOutcome: 'UP' | 'DOWN';

    // P&L calculation
    investedUp: number;
    investedDown: number;
    totalInvested: number;

    sharesUp: number;
    sharesDown: number;

    payout: number;             // Total payout received
    realizedPnL: number;        // Final P&L
    realizedPnLPercent: number; // P&L as percentage

    // Analysis
    winningSideSharesHeld: number;
    losingSideSharesHeld: number;
    winningSideInvested: number;
    losingSideInvested: number;
}

/**
 * Aggregate statistics across all paper trades
 */
export interface PaperTradingStats {
    // Overall
    totalMarketsTraded: number;
    activeMarkets: number;
    resolvedMarkets: number;

    // Capital
    totalCapitalDeployed: number;
    currentCapitalInMarkets: number;
    availableCapital: number;

    // P&L
    totalRealizedPnL: number;
    totalUnrealizedPnL: number;
    winRate: number;                // % of markets with positive P&L

    // Trade counts
    totalTrades: number;
    tradesUp: number;
    tradesDown: number;

    // Time-based
    startTime: number;
    lastTradeTime: number;

    // Per-market averages
    avgInvestmentPerMarket: number;
    avgPnLPerMarket: number;
    avgTradesPerMarket: number;
}

/**
 * Bot internal state
 */
export interface BotState {
    // Configuration
    startingCapital: number;
    currentCapital: number;
    maxCapitalPerMarket: number;

    // Active positions
    positions: Map<string, PaperMarketPosition>;  // conditionId -> position

    // Trade history
    trades: PaperTrade[];

    // Resolved markets
    resolvedMarkets: ResolvedMarket[];

    // Stats
    stats: PaperTradingStats;

    // Timing
    lastPriceUpdate: number;
    lastTradeCheck: number;

    // Status
    isRunning: boolean;
    isPaused: boolean;
}

/**
 * Market price update from live data
 */
export interface PriceUpdate {
    conditionId: string;
    priceUp: number;
    priceDown: number;
    timestamp: number;
    volume24h?: number;
}

/**
 * Time-based behavior phase
 */
export type MarketPhase = 'EARLY' | 'MID' | 'LATE' | 'FINAL';

/**
 * Market phase analysis
 */
export interface PhaseAnalysis {
    phase: MarketPhase;
    timeRemaining: number;          // Milliseconds until resolution
    percentTimeRemaining: number;   // 0-100%
    buyIntensityMultiplier: number; // 0-1, how aggressive to buy
    shouldTrade: boolean;           // Whether to execute trades in this phase
    reasoning: string;
}

/**
 * Decision to execute a trade
 */
export interface TradeDecision {
    shouldTrade: boolean;
    side: 'UP' | 'DOWN' | null;
    amount: number;
    shares: number;
    price: number;

    // Context
    skew: SkewAnalysis;
    allocation: AllocationTarget;
    phase: PhaseAnalysis;
    currentPosition: PaperMarketPosition | null;

    // Reasoning
    reason: string;
    factors: string[];
}

/**
 * Events emitted by the paper trading bot
 */
export type BotEvent =
    | { type: 'TRADE_EXECUTED'; trade: PaperTrade }
    | { type: 'MARKET_RESOLVED'; resolved: ResolvedMarket }
    | { type: 'PRICE_UPDATE'; update: PriceUpdate }
    | { type: 'NEW_MARKET'; market: BinaryMarket }
    | { type: 'MARKET_CLOSED'; conditionId: string }
    | { type: 'ERROR'; error: Error; context: string }
    | { type: 'STATS_UPDATE'; stats: PaperTradingStats };
