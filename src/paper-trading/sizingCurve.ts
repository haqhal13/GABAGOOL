/**
 * Sizing Curve Calculator
 *
 * Implements the sizing curve that translates market skew into target allocations.
 * Key properties:
 * - Continuous: Allocation changes smoothly as prices change
 * - Monotonic: As skew increases, dominant allocation increases
 * - Bounded: Dominant never reaches 100%, minority never reaches 0%
 * - Anchored: At 50/50, outputs 50/50 allocation
 */

import {
    SkewAnalysis,
    AllocationTarget,
    PhaseAnalysis,
    MarketPhase,
    BinaryMarket,
} from './interfaces';
import { DualSideStrategyConfig, PAPER_CONFIG } from './config';

/**
 * Analyze market skew from current prices
 *
 * @param priceUp - Current price for UP outcome (0-1)
 * @param priceDown - Current price for DOWN outcome (0-1)
 * @param config - Strategy configuration
 * @returns Skew analysis
 */
export function analyzeSkew(
    priceUp: number,
    priceDown: number,
    config: DualSideStrategyConfig = PAPER_CONFIG
): SkewAnalysis {
    // Normalize prices to ensure they sum to ~1
    const total = priceUp + priceDown;
    const normalizedUp = total > 0 ? priceUp / total : 0.5;
    const normalizedDown = total > 0 ? priceDown / total : 0.5;

    // Determine dominant side
    const dominantSide: 'UP' | 'DOWN' = normalizedUp >= normalizedDown ? 'UP' : 'DOWN';
    const minoritySide: 'UP' | 'DOWN' = dominantSide === 'UP' ? 'DOWN' : 'UP';

    // Calculate skew magnitude (0 = neutral, 0.5 = extreme)
    // At 50/50, magnitude = 0. At 100/0, magnitude = 0.5
    const skewMagnitude = Math.abs(normalizedUp - 0.5);
    const skewPercent = skewMagnitude * 100;

    // Determine skew zone
    const { neutralThreshold, moderateThreshold } = config.skewZones;
    const isNeutral = skewMagnitude <= neutralThreshold;
    const isModerate = !isNeutral && skewMagnitude <= moderateThreshold;
    const isExtreme = !isNeutral && !isModerate;

    return {
        dominantSide,
        minoritySide,
        skewMagnitude,
        skewPercent,
        priceUp: normalizedUp,
        priceDown: normalizedDown,
        isNeutral,
        isModerate,
        isExtreme,
    };
}

/**
 * Calculate target allocation based on current skew
 *
 * The sizing curve smoothly transitions from neutral to skewed:
 * - At neutral (skewMagnitude = 0): 50/50 allocation
 * - At maximum skew (skewMagnitude = 0.5): maxDominant/minMinority allocation
 *
 * The curve shape is controlled by curveExponent:
 * - 1.0 = linear
 * - < 1.0 = concave (faster initial tilt, slower later)
 * - > 1.0 = convex (slower initial tilt, faster later)
 *
 * @param skew - Skew analysis
 * @param config - Strategy configuration
 * @returns Target allocation
 */
export function calculateAllocation(
    skew: SkewAnalysis,
    config: DualSideStrategyConfig = PAPER_CONFIG
): AllocationTarget {
    const { sizingCurve } = config;
    const {
        neutralAllocation,
        maxDominantAllocation,
        minMinorityAllocation,
        curveExponent,
    } = sizingCurve;

    // Normalize skew to 0-1 range (0 = neutral, 1 = maximum skew)
    // Maximum skew is 0.5 (e.g., 100/0 prices)
    const normalizedSkew = Math.min(1, skew.skewMagnitude / 0.5);

    // Apply curve exponent to control shape
    const curvedSkew = Math.pow(normalizedSkew, curveExponent);

    // Calculate dominant allocation
    // At neutral (curvedSkew = 0): neutralAllocation (0.5)
    // At max skew (curvedSkew = 1): maxDominantAllocation
    const dominantRange = maxDominantAllocation - neutralAllocation;
    let dominantAllocation = neutralAllocation + (dominantRange * curvedSkew);

    // Calculate minority allocation
    let minorityAllocation = 1 - dominantAllocation;

    // Enforce minimum minority allocation
    if (minorityAllocation < minMinorityAllocation) {
        minorityAllocation = minMinorityAllocation;
        dominantAllocation = 1 - minorityAllocation;
    }

    // Build reasoning string
    let reasoning: string;
    if (skew.isNeutral) {
        reasoning = `Neutral zone (${skew.skewPercent.toFixed(1)}% skew): equal allocation`;
    } else if (skew.isModerate) {
        reasoning = `Moderate skew (${skew.skewPercent.toFixed(1)}%): tilting ${(dominantAllocation * 100).toFixed(0)}/${(minorityAllocation * 100).toFixed(0)} toward ${skew.dominantSide}`;
    } else {
        reasoning = `Extreme skew (${skew.skewPercent.toFixed(1)}%): heavy tilt ${(dominantAllocation * 100).toFixed(0)}/${(minorityAllocation * 100).toFixed(0)} toward ${skew.dominantSide}`;
    }

    return {
        dominantSideRatio: dominantAllocation,
        minoritySideRatio: minorityAllocation,
        dominantSide: skew.dominantSide,
        minoritySide: skew.minoritySide,
        reasoning,
    };
}

/**
 * Analyze market phase based on time remaining
 *
 * @param market - Binary market with timing info
 * @param config - Strategy configuration
 * @returns Phase analysis
 */
export function analyzePhase(
    market: BinaryMarket,
    config: DualSideStrategyConfig = PAPER_CONFIG
): PhaseAnalysis {
    const now = Date.now();
    const timeRemaining = market.endDate - now;

    // Handle resolved or past markets
    if (timeRemaining <= 0 || market.resolved) {
        return {
            phase: 'FINAL',
            timeRemaining: 0,
            percentTimeRemaining: 0,
            buyIntensityMultiplier: 0,
            shouldTrade: false,
            reasoning: 'Market has ended or resolved',
        };
    }

    // Calculate total market duration (if we have creation time)
    // Otherwise, use a reasonable estimate
    const createdAt = market.createdAt || (market.endDate - 24 * 60 * 60 * 1000);
    const totalDuration = market.endDate - createdAt;
    const elapsed = now - createdAt;
    const percentTimeRemaining = Math.max(0, Math.min(100, (timeRemaining / totalDuration) * 100));

    const { time } = config;
    const timeRatio = timeRemaining / totalDuration;

    // Determine phase
    let phase: MarketPhase;
    let buyIntensityMultiplier: number;
    let reasoning: string;

    if (timeRemaining < time.minTimeBeforeResolution) {
        phase = 'FINAL';
        buyIntensityMultiplier = time.finalIntensity;
        reasoning = `Final phase: ${(timeRemaining / 1000).toFixed(0)}s remaining, no new trades`;
    } else if (timeRatio > time.earlyPhaseThreshold) {
        phase = 'EARLY';
        buyIntensityMultiplier = time.earlyIntensity;
        reasoning = `Early phase: ${percentTimeRemaining.toFixed(0)}% time remaining, reduced intensity`;
    } else if (timeRatio > time.midPhaseThreshold) {
        phase = 'MID';
        buyIntensityMultiplier = time.midIntensity;
        reasoning = `Mid phase: ${percentTimeRemaining.toFixed(0)}% time remaining, full intensity`;
    } else if (timeRatio > time.latePhaseThreshold) {
        phase = 'LATE';
        buyIntensityMultiplier = time.lateIntensity;
        reasoning = `Late phase: ${percentTimeRemaining.toFixed(0)}% time remaining, increased intensity`;
    } else {
        phase = 'FINAL';
        buyIntensityMultiplier = time.finalIntensity;
        reasoning = `Final phase: ${percentTimeRemaining.toFixed(0)}% time remaining, winding down`;
    }

    // Check minimum duration
    if (totalDuration < time.minMarketDuration) {
        return {
            phase,
            timeRemaining,
            percentTimeRemaining,
            buyIntensityMultiplier: 0,
            shouldTrade: false,
            reasoning: `Market too short (${(totalDuration / 1000 / 60).toFixed(1)} min < ${(time.minMarketDuration / 1000 / 60).toFixed(1)} min minimum)`,
        };
    }

    const shouldTrade = buyIntensityMultiplier > 0 && timeRemaining > time.minTimeBeforeResolution;

    return {
        phase,
        timeRemaining,
        percentTimeRemaining,
        buyIntensityMultiplier,
        shouldTrade,
        reasoning,
    };
}

/**
 * Calculate the trade amount for a given side
 *
 * @param targetAmount - Base amount to trade
 * @param phase - Current market phase
 * @param gapFromTarget - How far current allocation is from target (0-1)
 * @param config - Strategy configuration
 * @returns Adjusted trade amount
 */
export function calculateTradeAmount(
    targetAmount: number,
    phase: PhaseAnalysis,
    gapFromTarget: number,
    config: DualSideStrategyConfig = PAPER_CONFIG
): number {
    const { safety } = config;

    // Start with target amount
    let amount = targetAmount;

    // Apply phase intensity multiplier
    amount *= phase.buyIntensityMultiplier;

    // Scale by gap from target (larger gap = more aggressive)
    // If gap is small, reduce trade size
    const gapMultiplier = Math.min(1, gapFromTarget / safety.rebalanceThreshold);
    amount *= Math.max(0.5, gapMultiplier); // At least 50% of intended amount

    // Apply safety limits
    amount = Math.max(safety.minTradeSize, amount);
    amount = Math.min(safety.maxTradeSize, amount);

    return amount;
}

/**
 * Calculate how many shares can be purchased
 *
 * @param amountUSD - Amount in USD to spend
 * @param pricePerShare - Current price per share (0-1)
 * @returns Number of shares
 */
export function calculateShares(amountUSD: number, pricePerShare: number): number {
    if (pricePerShare <= 0 || pricePerShare >= 1) {
        return 0;
    }
    return amountUSD / pricePerShare;
}

/**
 * Calculate the gap between current and target allocation
 *
 * @param currentAllocation - Current allocation ratio (0-1)
 * @param targetAllocation - Target allocation ratio (0-1)
 * @returns Gap magnitude and direction
 */
export function calculateAllocationGap(
    currentAllocation: number,
    targetAllocation: number
): { gap: number; needsMore: boolean } {
    const gap = targetAllocation - currentAllocation;
    return {
        gap: Math.abs(gap),
        needsMore: gap > 0,
    };
}

/**
 * Determine which side needs more allocation and by how much
 *
 * @param currentUp - Current allocation to UP (0-1)
 * @param currentDown - Current allocation to DOWN (0-1)
 * @param targetAllocation - Target allocation from sizing curve
 * @returns Which side to trade and the gap
 */
export function determineTradeSide(
    currentUp: number,
    currentDown: number,
    targetAllocation: AllocationTarget
): { side: 'UP' | 'DOWN'; gap: number; reason: string } {
    // Calculate target allocations for each side
    const targetUp = targetAllocation.dominantSide === 'UP'
        ? targetAllocation.dominantSideRatio
        : targetAllocation.minoritySideRatio;

    const targetDown = targetAllocation.dominantSide === 'DOWN'
        ? targetAllocation.dominantSideRatio
        : targetAllocation.minoritySideRatio;

    // Calculate gaps
    const gapUp = targetUp - currentUp;
    const gapDown = targetDown - currentDown;

    // Trade the side with the larger positive gap
    if (gapUp > gapDown && gapUp > 0) {
        return {
            side: 'UP',
            gap: gapUp,
            reason: `UP allocation ${(currentUp * 100).toFixed(1)}% below target ${(targetUp * 100).toFixed(1)}%`,
        };
    } else if (gapDown > 0) {
        return {
            side: 'DOWN',
            gap: gapDown,
            reason: `DOWN allocation ${(currentDown * 100).toFixed(1)}% below target ${(targetDown * 100).toFixed(1)}%`,
        };
    } else {
        // No gap - already at target
        return {
            side: currentUp <= currentDown ? 'UP' : 'DOWN',
            gap: 0,
            reason: 'Already at target allocation',
        };
    }
}

/**
 * Check if a trade should be throttled based on recent activity
 *
 * @param lastTradeTime - Timestamp of last trade (ms)
 * @param lastSameMarketTradeTime - Timestamp of last trade in same market (ms)
 * @param config - Strategy configuration
 * @returns Whether to throttle and reason
 */
export function shouldThrottle(
    lastTradeTime: number,
    lastSameMarketTradeTime: number,
    config: DualSideStrategyConfig = PAPER_CONFIG
): { throttle: boolean; reason: string } {
    const now = Date.now();
    const { safety } = config;

    const timeSinceLastTrade = (now - lastTradeTime) / 1000;
    const timeSinceLastSameMarket = (now - lastSameMarketTradeTime) / 1000;

    if (timeSinceLastTrade < safety.minSecondsBetweenTrades) {
        return {
            throttle: true,
            reason: `Only ${timeSinceLastTrade.toFixed(1)}s since last trade (min: ${safety.minSecondsBetweenTrades}s)`,
        };
    }

    if (timeSinceLastSameMarket < safety.minSecondsBetweenSameMarket) {
        return {
            throttle: true,
            reason: `Only ${timeSinceLastSameMarket.toFixed(1)}s since last trade in this market (min: ${safety.minSecondsBetweenSameMarket}s)`,
        };
    }

    return { throttle: false, reason: '' };
}

/**
 * Format allocation for display
 *
 * @param allocation - Allocation target
 * @returns Formatted string
 */
export function formatAllocation(allocation: AllocationTarget): string {
    const dom = (allocation.dominantSideRatio * 100).toFixed(0);
    const min = (allocation.minoritySideRatio * 100).toFixed(0);
    return `${allocation.dominantSide}:${dom}% / ${allocation.minoritySide}:${min}%`;
}

/**
 * Format skew for display
 *
 * @param skew - Skew analysis
 * @returns Formatted string
 */
export function formatSkew(skew: SkewAnalysis): string {
    const zone = skew.isNeutral ? 'NEUTRAL' : skew.isModerate ? 'MODERATE' : 'EXTREME';
    return `${zone} (UP:${(skew.priceUp * 100).toFixed(1)}% / DOWN:${(skew.priceDown * 100).toFixed(1)}%)`;
}
