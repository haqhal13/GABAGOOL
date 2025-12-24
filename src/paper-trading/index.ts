/**
 * Paper Trading Module
 *
 * Dual-side accumulation strategy paper trading system for Polymarket.
 *
 * This module provides:
 * - Live market data fetching from Polymarket APIs
 * - Probability-weighted dual-side position management
 * - Sizing curve calculations for dynamic allocation
 * - Paper trade execution and tracking
 * - P&L calculation and reporting
 *
 * Strategy Overview:
 * - Buys both sides of binary markets at all times
 * - Tilts allocation toward the dominant (higher probability) side
 * - Maintains minimum exposure to minority side even at extreme skews
 * - Holds all positions until market resolution
 * - No prediction, no exits, pure sizing discipline
 */

// Configuration
export { DualSideStrategyConfig, PAPER_CONFIG, parseConfig, validateConfig } from './config';

// Interfaces
export {
    BinaryMarket,
    SkewAnalysis,
    AllocationTarget,
    PaperPosition,
    PaperMarketPosition,
    PaperTrade,
    ResolvedMarket,
    PaperTradingStats,
    BotState,
    PriceUpdate,
    MarketPhase,
    PhaseAnalysis,
    TradeDecision,
    BotEvent,
} from './interfaces';

// Sizing curve
export {
    analyzeSkew,
    calculateAllocation,
    analyzePhase,
    calculateTradeAmount,
    calculateShares,
    calculateAllocationGap,
    determineTradeSide,
    shouldThrottle,
    formatAllocation,
    formatSkew,
} from './sizingCurve';

// Position tracker
export { PositionTracker, positionTracker } from './positionTracker';

// Trade executor
export { TradeExecutor } from './tradeExecutor';

// Market data fetcher
export { MarketDataFetcher, marketDataFetcher } from './marketDataFetcher';

// Main bot
export { PaperTradingBot, getPaperTradingBot } from './paperTradingBot';
