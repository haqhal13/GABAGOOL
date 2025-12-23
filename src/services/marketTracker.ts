import chalk from 'chalk';
import { ENV } from '../config/env';

interface MarketStats {
    marketKey: string; // e.g., "BTC-15min"
    marketName: string; // Full market name
    sharesUp: number;
    sharesDown: number;
    investedUp: number;
    investedDown: number;
    totalCostUp: number; // Total cost for UP shares (for average calculation)
    totalCostDown: number; // Total cost for DOWN shares (for average calculation)
    tradesUp: number;
    tradesDown: number;
    lastUpdate: number;
    endDate?: number; // Market end date timestamp (if available)
    conditionId?: string; // Condition ID for market lookup
}

class MarketTracker {
    private markets: Map<string, MarketStats> = new Map();
    private lastDisplayTime = 0;
    // Stable dashboard: update every 2s unless new market forces immediate refresh
    private displayInterval = 2000;
    private lastMarketCount = 0;

    /**
     * Extract market key from activity
     * Priority:
     * 1) conditionId (most stable per market)
     * 2) slug / eventSlug
     * 3) title / asset fallback
     */
    private extractMarketKey(activity: any): string {
        if (activity?.conditionId) {
            const slugPart = (activity?.slug || activity?.eventSlug || activity?.title || '').substring(0, 30);
            return `CID-${activity.conditionId}-${slugPart}`;
        }

        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            'Unknown';

        if (!rawTitle) return 'Unknown';
        
        // Try to extract crypto symbol and timeframe
        const titleLower = rawTitle.toLowerCase();
        
        // Check for Bitcoin patterns
        if (titleLower.includes('bitcoin') || titleLower.includes('btc')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `BTC-${match[1]}min`;
            }
            // Check for other timeframes
            const hourMatch = rawTitle.match(/(\d+)\s*h/i);
            if (hourMatch) {
                return `BTC-${hourMatch[1]}h`;
            }
            return 'BTC';
        }
        
        // Check for Ethereum patterns
        if (titleLower.includes('ethereum') || titleLower.includes('eth')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `ETH-${match[1]}min`;
            }
            const hourMatch = rawTitle.match(/(\d+)\s*h/i);
            if (hourMatch) {
                return `ETH-${hourMatch[1]}h`;
            }
            return 'ETH';
        }
        
        // Check for Solana
        if (titleLower.includes('solana') || titleLower.includes('sol')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `SOL-${match[1]}min`;
            }
            return 'SOL';
        }
        
        // Check for generic crypto patterns: "CRYPTO 15min" or "CRYPTO/USD 15min"
        const cryptoMatch = rawTitle.match(/([A-Z]{2,5})\s*\/?\s*USD?\s*(\d+)\s*min/i);
        if (cryptoMatch) {
            return `${cryptoMatch[1].toUpperCase()}-${cryptoMatch[2]}min`;
        }
        
        // Check for standalone crypto symbols with timeframes
        const symbolMatch = rawTitle.match(/\b([A-Z]{2,5})\b.*?(\d+)\s*min/i);
        if (symbolMatch) {
            return `${symbolMatch[1].toUpperCase()}-${symbolMatch[2]}min`;
        }

        // If slug contains date/time segments, keep more of it for uniqueness
        if (activity?.slug) {
            const slugParts = activity.slug.split('-');
            if (slugParts.length >= 3) {
                return slugParts.slice(0, 4).join('-').substring(0, 40);
            }
            return activity.slug.substring(0, 40);
        }
        if (activity?.eventSlug) {
            const slugParts = activity.eventSlug.split('-');
            if (slugParts.length >= 3) {
                return slugParts.slice(0, 4).join('-').substring(0, 40);
            }
            return activity.eventSlug.substring(0, 40);
        }
        
        // Fallback: use first meaningful words (limit to 25 chars)
        const parts = rawTitle.split(/\s+/).filter((p: string) => p.length > 0);
        if (parts.length >= 2) {
            return `${parts[0].substring(0, 10)}-${parts[1].substring(0, 10)}`.substring(0, 25);
        }
        if (parts.length > 0) {
            return parts[0].substring(0, 25);
        }
        
        return 'Unknown';
    }

    /**
     * Determine if outcome is UP or DOWN
     */
    private isUpOutcome(activity: any): boolean {
        // Primary method: use outcomeIndex (0 = UP/YES, 1 = DOWN/NO typically)
        if (activity.outcomeIndex !== undefined) {
            return activity.outcomeIndex === 0;
        }
        
        // Fallback: check outcome and asset strings
        const outcome = (activity.outcome || '').toLowerCase();
        const asset = (activity.asset || '').toLowerCase();
        
        // Check for UP indicators
        if (outcome.includes('up') || 
            outcome.includes('higher') ||
            outcome.includes('above') ||
            outcome.includes('yes') ||
            asset.includes('yes') ||
            asset.includes('up')) {
            return true;
        }
        
        // Check for DOWN indicators
        if (outcome.includes('down') ||
            outcome.includes('lower') ||
            outcome.includes('below') ||
            outcome.includes('no') ||
            asset.includes('no') ||
            asset.includes('down')) {
            return false;
        }
        
        // Default: assume first outcome is UP
        return true;
    }

    /**
     * Process a new trade
     */
    processTrade(activity: any): void {
        const marketKey = this.extractMarketKey(activity);
        const isUp = this.isUpOutcome(activity);
        const shares = parseFloat(activity.size || '0');
        const invested = parseFloat(activity.usdcSize || '0');
        const side = activity.side?.toUpperCase() || 'BUY';

        const isNewMarket = !this.markets.has(marketKey);
        let market = this.markets.get(marketKey);
        
        if (!market) {
            market = {
                marketKey,
                marketName: activity.title || activity.slug || marketKey,
                sharesUp: 0,
                sharesDown: 0,
                investedUp: 0,
                investedDown: 0,
                totalCostUp: 0,
                totalCostDown: 0,
                tradesUp: 0,
                tradesDown: 0,
                lastUpdate: Date.now(),
                endDate: activity.endDate ? activity.endDate * 1000 : undefined, // Convert to milliseconds
                conditionId: activity.conditionId,
            };
            this.markets.set(marketKey, market);
            
            // Force immediate display update for new markets
            if (isNewMarket) {
                this.lastDisplayTime = 0; // Force display on next call
            }

            // If the first trade is SELL, still register the market but don't accumulate
            if (side !== 'BUY') {
                return;
            }
        } else {
            // Update endDate and conditionId if available and not already set
            if (activity.endDate && !market.endDate) {
                market.endDate = activity.endDate * 1000; // Convert to milliseconds
            }
            if (activity.conditionId && !market.conditionId) {
                market.conditionId = activity.conditionId;
            }
        }

        const price = parseFloat(activity.price || '0');
        const cost = shares * price; // Total cost for this trade

        // Only accumulate on BUY; SELL just registers market presence
        if (side === 'BUY') {
            if (isUp) {
                market.sharesUp += shares;
                market.investedUp += invested;
                market.totalCostUp += cost;
                market.tradesUp += 1;
            } else {
                market.sharesDown += shares;
                market.investedDown += invested;
                market.totalCostDown += cost;
                market.tradesDown += 1;
            }
        }

        market.lastUpdate = Date.now();
    }

    /**
     * Display market statistics
     */
    displayStats(): void {
        const now = Date.now();
        const timeSinceLastDisplay = now - this.lastDisplayTime;
        
        // Always update if new market detected, otherwise respect interval
        const hasNewMarket = this.markets.size !== this.lastMarketCount;
        if (!hasNewMarket && timeSinceLastDisplay < this.displayInterval) {
            return;
        }
        
        this.lastDisplayTime = now;
        this.lastMarketCount = this.markets.size;

        if (this.markets.size === 0) {
            return;
        }

        // Filter out closed markets (where endDate has passed)
        // Keep markets stable - only remove if they're actually closed
        // Fallback: if market hasn't been updated in 7 days, consider it stale/closed
        const STALE_MARKET_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        
        const activeMarkets = Array.from(this.markets.values()).filter((m) => {
            // If market has an endDate and it has passed, consider it closed
            if (m.endDate && now > m.endDate) {
                return false; // Market is closed
            }
            // Fallback: if market hasn't been updated in a very long time, consider it stale
            if (now - m.lastUpdate > STALE_MARKET_THRESHOLD) {
                return false; // Market is stale/closed
            }
            // Keep all other markets (stable dashboard)
            return true;
        });

        // Remove closed/stale markets from tracking
        for (const [key, value] of this.markets.entries()) {
            const isClosed = value.endDate && now > value.endDate;
            const isStale = now - value.lastUpdate > STALE_MARKET_THRESHOLD;
            if (isClosed || isStale) {
                this.markets.delete(key);
            }
        }

        if (activeMarkets.length === 0) {
            return;
        }

        // Stable dashboard: clear screen and redraw
        console.clear();

        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(''); // Empty line

        // Sort markets by total invested (descending)
        const sortedMarkets = activeMarkets
            .sort((a, b) => {
                const totalA = a.investedUp + a.investedDown;
                const totalB = b.investedUp + b.investedDown;
                return totalB - totalA;
            });

        for (const market of sortedMarkets) {
            const totalInvested = market.investedUp + market.investedDown;
            const upPercent = totalInvested > 0 ? (market.investedUp / totalInvested) * 100 : 0;
            const downPercent = totalInvested > 0 ? (market.investedDown / totalInvested) * 100 : 0;

        console.log(chalk.yellow.bold(`${market.marketKey}`));
        console.log(chalk.gray(`  Market: ${market.marketName.substring(0, 60)}`));
            
            // Calculate average prices
            const avgPriceUp = market.sharesUp > 0 ? market.totalCostUp / market.sharesUp : 0;
            const avgPriceDown = market.sharesDown > 0 ? market.totalCostDown / market.sharesDown : 0;
            
            // UP stats
        console.log(chalk.green(`  📈 UP:`));
        console.log(chalk.green(`     Shares: ${market.sharesUp.toFixed(4)}`));
        console.log(chalk.green(`     Invested: $${market.investedUp.toFixed(2)}`));
        console.log(chalk.green(`     Avg Price: $${avgPriceUp.toFixed(4)}`));
        console.log(chalk.green(`     Trades: ${market.tradesUp}`));
            
            // DOWN stats
        console.log(chalk.red(`  📉 DOWN:`));
        console.log(chalk.red(`     Shares: ${market.sharesDown.toFixed(4)}`));
        console.log(chalk.red(`     Invested: $${market.investedDown.toFixed(2)}`));
        console.log(chalk.red(`     Avg Price: $${avgPriceDown.toFixed(4)}`));
        console.log(chalk.red(`     Trades: ${market.tradesDown}`));
            
            // Summary
        console.log(chalk.cyan(`  💰 Total Invested: $${totalInvested.toFixed(2)}`));
        console.log(chalk.cyan(`  📊 Split: ${upPercent.toFixed(1)}% UP / ${downPercent.toFixed(1)}% DOWN`));
            
            // Visual bar
            const barLength = 40;
            const upBars = Math.round((upPercent / 100) * barLength);
            const downBars = barLength - upBars;
            const upBar = chalk.green('█'.repeat(upBars));
            const downBar = chalk.red('█'.repeat(downBars));
        console.log(chalk.gray(`  [${upBar}${downBar}]`));
        console.log(''); // Empty line between markets
        }

        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(''); // Empty line at end
    }

    /**
     * Get all market stats (for external use)
     */
    getStats(): MarketStats[] {
        return Array.from(this.markets.values());
    }

    /**
     * Clear all stats
     */
    clear(): void {
        this.markets.clear();
    }
}

export default new MarketTracker();

