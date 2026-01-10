/**
 * Watcher PnL Tracker - Tracks and generates PnL reports for watcher mode
 *
 * Adapted from FinalEdge01's paperTrader.ts PnL logic
 *
 * Features:
 * - Stores market PnL data in memory
 * - Groups markets by hour window (15-min + 1-hour)
 * - Generates formatted TXT reports
 * - Calculates settled PnL (winner=$1, loser=$0)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getRunId } from '../utils/runId';
import Logger from '../utils/logger';

interface MarketPnLData {
    marketName: string;
    conditionId: string;
    marketKey: string;
    priceUp: number;
    priceDown: number;
    totalPnl: number;
    pnlPercent: number;
    sharesUp: number;
    sharesDown: number;
    totalCostUp: number;
    totalCostDown: number;
    tradesUp: number;
    tradesDown: number;
    timestamp: number;
}

interface MarketData {
    name: string;
    pnl: number;
    pnlPercent: number;
    avgCostUp: number;
    avgCostDown: number;
    avgPriceUp: number;
    avgPriceDown: number;
    sharesUp: number;
    sharesDown: number;
    totalInvested: number;
    outcome: string;
    is15Min: boolean;
    is1Hour: boolean;
    hourWindow: string;
    timeSlot?: string;
    tradesUp: number;
    tradesDown: number;
}

class WatcherPnLTracker {
    private marketPnLData: Map<string, MarketPnLData> = new Map();
    private loggedMarkets: Set<string> = new Set();
    private reportPath: string;

    constructor() {
        const logsDir = path.join(process.cwd(), 'logs');
        const watcherDir = path.join(logsDir, 'watcher');

        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(watcherDir)) {
            fs.mkdirSync(watcherDir, { recursive: true });
        }

        const runId = getRunId();
        this.reportPath = path.join(watcherDir, `Watcher PnL Report_${runId}.txt`);

        // Generate initial empty report
        this.generateFormattedPnLReport();
    }

    /**
     * Log market PnL data when a market closes
     * Called from marketTracker when market is removed/rotated
     */
    logMarketPnL(
        marketName: string,
        conditionId: string,
        marketKey: string,
        sharesUp: number,
        sharesDown: number,
        totalCostUp: number,
        totalCostDown: number,
        priceUp: number,
        priceDown: number,
        tradesUp: number = 0,
        tradesDown: number = 0
    ): void {
        // Prevent duplicate logging
        if (!conditionId || this.loggedMarkets.has(conditionId)) {
            return;
        }

        // Skip if no shares traded
        if (sharesUp === 0 && sharesDown === 0) {
            return;
        }

        try {
            // Calculate PnL
            const totalInvested = totalCostUp + totalCostDown;

            // Determine winner based on which side has higher price
            let settledPriceUp = priceUp;
            let settledPriceDown = priceDown;

            if (priceUp >= 0.99 || priceDown <= 0.01) {
                settledPriceUp = 1.0;
                settledPriceDown = 0.0;
            } else if (priceDown >= 0.99 || priceUp <= 0.01) {
                settledPriceUp = 0.0;
                settledPriceDown = 1.0;
            } else if (priceUp > 0 && priceDown > 0) {
                if (priceUp > priceDown) {
                    settledPriceUp = 1.0;
                    settledPriceDown = 0.0;
                } else if (priceDown > priceUp) {
                    settledPriceUp = 0.0;
                    settledPriceDown = 1.0;
                }
            }

            // Calculate settled PnL
            const settledValueUp = sharesUp * settledPriceUp;
            const settledValueDown = sharesDown * settledPriceDown;
            const settledTotalValue = settledValueUp + settledValueDown;
            const settledPnl = settledTotalValue - totalInvested;
            const settledPnlPercent = totalInvested > 0 ? (settledPnl / totalInvested) * 100 : 0;

            // Store data
            this.marketPnLData.set(conditionId, {
                marketName,
                conditionId,
                marketKey,
                priceUp,
                priceDown,
                totalPnl: settledPnl,
                pnlPercent: settledPnlPercent,
                sharesUp,
                sharesDown,
                totalCostUp,
                totalCostDown,
                tradesUp,
                tradesDown,
                timestamp: Date.now()
            });

            this.loggedMarkets.add(conditionId);

            Logger.info(`📊 Watcher PnL captured: ${marketName} - ${settledPnl >= 0 ? '+' : ''}$${settledPnl.toFixed(2)} (${settledPnlPercent >= 0 ? '+' : ''}${settledPnlPercent.toFixed(1)}%)`);

            // Regenerate report immediately
            this.generateFormattedPnLReport();
        } catch (error) {
            Logger.error(`Failed to log watcher market PnL: ${error}`);
        }
    }

    /**
     * Generate formatted PnL report grouped by hour window
     */
    generateFormattedPnLReport(): void {
        try {
            // Check if we have any data
            if (this.marketPnLData.size === 0) {
                let emptyReport = "=".repeat(100) + "\n";
                emptyReport += "                    WATCHER MODE PNL REPORT\n";
                emptyReport += "=".repeat(100) + "\n\n";
                emptyReport += "  No market data available yet.\n";
                emptyReport += "  Report will be updated as markets close.\n\n";
                emptyReport += "=".repeat(100) + "\n";
                emptyReport += `  Generated: ${new Date().toLocaleString()}\n`;
                emptyReport += "=".repeat(100) + "\n";
                fs.writeFileSync(this.reportPath, emptyReport, 'utf8');
                return;
            }

            const markets: MarketData[] = [];

            // Convert in-memory data to MarketData format
            for (const [conditionId, data] of this.marketPnLData.entries()) {
                const marketName = data.marketName;

                // Calculate avg costs
                const avgCostUp = data.sharesUp > 0 ? data.totalCostUp / data.sharesUp : 0;
                const avgCostDown = data.sharesDown > 0 ? data.totalCostDown / data.sharesDown : 0;

                // Determine market type
                const hasTimeRange = marketName.match(/\d{1,2}:\d{2}(AM|PM)-\d{1,2}:\d{2}(AM|PM)/i);
                const is15Min = hasTimeRange !== null;
                const is1Hour = (marketName.includes("Bitcoin Up or Down") || marketName.includes("Ethereum Up or Down")) &&
                               !is15Min && marketName.match(/\d{1,2}(AM|PM) ET/i) !== null;

                let hourWindow = "";
                let timeSlot = "";

                if (is15Min) {
                    const timeMatch = marketName.match(/(\d{1,2}):\d{2}(AM|PM)-(\d{1,2}):\d{2}(AM|PM)/i);
                    if (timeMatch) {
                        timeSlot = `${timeMatch[1]}:${timeMatch[2]}-${timeMatch[3]}:${timeMatch[4]}`;
                        let startH = parseInt(timeMatch[1]);
                        const startAmpm = timeMatch[2].toUpperCase();
                        let endH = startH + 1;
                        let endAmpm = startAmpm;

                        if (startH === 12 && startAmpm === "PM") { endH = 1; endAmpm = "PM"; }
                        else if (startH === 12 && startAmpm === "AM") { endH = 1; endAmpm = "AM"; }
                        else if (startH === 11 && startAmpm === "PM") { endH = 12; endAmpm = "AM"; }
                        else if (startH === 11 && startAmpm === "AM") { endH = 12; endAmpm = "PM"; }

                        hourWindow = `${startH}:00${startAmpm}-${endH}:00${endAmpm}`;
                    }
                } else if (is1Hour) {
                    const hourMatch = marketName.match(/(\d{1,2})(AM|PM) ET/i);
                    if (hourMatch) {
                        let hour = parseInt(hourMatch[1]);
                        const ampm = hourMatch[2].toUpperCase();
                        let nextHour = hour + 1;
                        let nextAmpm = ampm;

                        if (hour === 12 && ampm === "PM") { nextHour = 1; nextAmpm = "PM"; }
                        else if (hour === 11 && ampm === "PM") { nextHour = 12; nextAmpm = "AM"; }
                        else if (hour === 12 && ampm === "AM") { nextHour = 1; nextAmpm = "AM"; }
                        else if (hour === 11 && ampm === "AM") { nextHour = 12; nextAmpm = "PM"; }

                        hourWindow = `${hour}:00${ampm}-${nextHour}:00${nextAmpm}`;
                    }
                }

                // Determine outcome
                let outcome = "Pending";
                const priceUp = data.priceUp || 0;
                const priceDown = data.priceDown || 0;

                if (priceUp >= 0.99 || priceDown <= 0.01) {
                    outcome = "UP Won";
                } else if (priceDown >= 0.99 || priceUp <= 0.01) {
                    outcome = "DOWN Won";
                } else if (priceUp > 0 && priceDown > 0) {
                    outcome = priceUp > priceDown ? "UP Won" : priceDown > priceUp ? "DOWN Won" : "Tie";
                }

                markets.push({
                    name: marketName,
                    pnl: data.totalPnl,
                    pnlPercent: data.pnlPercent,
                    avgCostUp,
                    avgCostDown,
                    avgPriceUp: priceUp,
                    avgPriceDown: priceDown,
                    sharesUp: data.sharesUp,
                    sharesDown: data.sharesDown,
                    totalInvested: data.totalCostUp + data.totalCostDown,
                    outcome,
                    is15Min,
                    is1Hour,
                    hourWindow,
                    timeSlot,
                    tradesUp: data.tradesUp,
                    tradesDown: data.tradesDown,
                });
            }

            // Group by hour window
            const groupedByHour: Map<string, MarketData[]> = new Map();
            for (const market of markets) {
                if (!market.hourWindow) continue;
                if (!groupedByHour.has(market.hourWindow)) {
                    groupedByHour.set(market.hourWindow, []);
                }
                groupedByHour.get(market.hourWindow)!.push(market);
            }

            // Generate report
            let report = "";
            report += "=".repeat(100) + "\n";
            report += "                    WATCHER MODE PNL REPORT\n";
            report += "=".repeat(100) + "\n\n";

            // Sort hour windows chronologically
            const sortedWindows = Array.from(groupedByHour.keys()).sort((a, b) => {
                const parseHour = (str: string): number => {
                    const match = str.match(/(\d{1,2}):\d{2}(AM|PM)/i);
                    if (!match) return 0;
                    let hour = parseInt(match[1]);
                    if (match[2].toUpperCase() === "PM" && hour !== 12) hour += 12;
                    if (match[2].toUpperCase() === "AM" && hour === 12) hour = 0;
                    return hour;
                };
                return parseHour(a) - parseHour(b);
            });

            let totalPnL = 0;
            let totalInvested = 0;
            let totalTrades = 0;

            for (const hourWindow of sortedWindows) {
                const marketsInWindow = groupedByHour.get(hourWindow)!;

                // Sort: 15-min markets first, then 1-hour
                marketsInWindow.sort((a, b) => {
                    if (a.is15Min && !b.is15Min) return -1;
                    if (!a.is15Min && b.is15Min) return 1;
                    if (a.is15Min && b.is15Min) {
                        return (a.timeSlot || "").localeCompare(b.timeSlot || "");
                    }
                    return 0;
                });

                report += "\n" + "─".repeat(100) + "\n";
                report += `  HOUR WINDOW: ${hourWindow}\n`;
                report += "─".repeat(100) + "\n\n";

                let windowPnL = 0;
                let windowInvested = 0;
                let windowTrades = 0;

                for (const market of marketsInWindow) {
                    const marketType = market.is15Min ? "15-Min" : market.is1Hour ? "1-Hour" : "Other";
                    const pnlSign = market.pnl >= 0 ? "+" : "";

                    report += `  ${"═".repeat(96)}\n`;
                    report += `  ${marketType} Market\n`;
                    report += `  ${"─".repeat(96)}\n`;
                    report += `  Market Name: ${market.name}\n`;
                    report += `  ${"─".repeat(96)}\n`;

                    report += `  Outcome: ${market.outcome}\n`;
                    report += `  Settled PnL: ${pnlSign}$${market.pnl.toFixed(2)} (${pnlSign}${market.pnlPercent.toFixed(2)}%)\n`;
                    report += `  ${"─".repeat(96)}\n`;

                    if (market.sharesUp > 0 || market.sharesDown > 0) {
                        report += `  Shares - UP: ${market.sharesUp.toFixed(2)}  |  DOWN: ${market.sharesDown.toFixed(2)}\n`;
                        if (market.outcome === "UP Won") {
                            const payout = market.sharesUp * 1.0;
                            report += `  Payout: ${market.sharesUp.toFixed(2)} UP × $1.00 = $${payout.toFixed(2)}  |  ${market.sharesDown.toFixed(2)} DOWN × $0.00 = $0.00\n`;
                        } else if (market.outcome === "DOWN Won") {
                            const payout = market.sharesDown * 1.0;
                            report += `  Payout: ${market.sharesUp.toFixed(2)} UP × $0.00 = $0.00  |  ${market.sharesDown.toFixed(2)} DOWN × $1.00 = $${payout.toFixed(2)}\n`;
                        }
                    }

                    if (market.avgPriceUp > 0 || market.avgPriceDown > 0) {
                        report += `  Closing Price - UP: $${market.avgPriceUp.toFixed(4)}  |  DOWN: $${market.avgPriceDown.toFixed(4)}\n`;
                    }

                    if (market.avgCostUp > 0 || market.avgCostDown > 0) {
                        report += `  Avg Cost      - UP: $${market.avgCostUp.toFixed(4)}  |  DOWN: $${market.avgCostDown.toFixed(4)}\n`;
                    }

                    report += `  Total Invested: $${market.totalInvested.toFixed(2)}\n`;
                    report += `  Trades - UP: ${market.tradesUp}  |  DOWN: ${market.tradesDown}  |  Total: ${market.tradesUp + market.tradesDown}\n`;
                    report += `  ${"═".repeat(96)}\n\n`;

                    windowPnL += market.pnl;
                    windowInvested += market.totalInvested;
                    windowTrades += market.tradesUp + market.tradesDown;
                }

                const windowPnLSign = windowPnL >= 0 ? "+" : "";
                const windowPnLPercent = windowInvested > 0 ? (windowPnL / windowInvested) * 100 : 0;
                report += `  ${"─".repeat(88)}\n`;
                report += `  Window Summary:  PnL: ${windowPnLSign}$${windowPnL.toFixed(2)} (${windowPnLSign}${windowPnLPercent.toFixed(2)}%)  |  Invested: $${windowInvested.toFixed(2)}  |  Trades: ${windowTrades}\n`;
                report += `  ${"─".repeat(88)}\n\n`;

                totalPnL += windowPnL;
                totalInvested += windowInvested;
                totalTrades += windowTrades;
            }

            // Overall summary
            report += "\n" + "=".repeat(100) + "\n";
            report += "                              OVERALL SUMMARY\n";
            report += "=".repeat(100) + "\n\n";
            const totalPnLSign = totalPnL >= 0 ? "+" : "";
            const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
            report += `  Total PnL: ${totalPnLSign}$${totalPnL.toFixed(2)} (${totalPnLSign}${totalPnLPercent.toFixed(2)}%)\n`;
            report += `  Total Invested: $${totalInvested.toFixed(2)}\n`;
            report += `  Total Trades: ${totalTrades}\n`;
            report += `  Markets Tracked: ${markets.length}\n`;
            report += `  Hour Windows: ${sortedWindows.length}\n`;
            report += "\n" + "=".repeat(100) + "\n";
            report += `  Generated: ${new Date().toLocaleString()}\n`;
            report += "=".repeat(100) + "\n";

            fs.writeFileSync(this.reportPath, report, 'utf8');
            Logger.info(`📊 Watcher PnL report updated: ${this.reportPath}`);
        } catch (error) {
            Logger.error(`Failed to generate watcher PnL report: ${error}`);
        }
    }

    /**
     * Get summary stats
     */
    getStats(): { totalPnL: number; totalInvested: number; marketsTracked: number } {
        let totalPnL = 0;
        let totalInvested = 0;

        for (const data of this.marketPnLData.values()) {
            totalPnL += data.totalPnl;
            totalInvested += data.totalCostUp + data.totalCostDown;
        }

        return {
            totalPnL,
            totalInvested,
            marketsTracked: this.marketPnLData.size
        };
    }

    /**
     * Clear all data (for testing/reset)
     */
    clear(): void {
        this.marketPnLData.clear();
        this.loggedMarkets.clear();
        this.generateFormattedPnLReport();
    }
}

// Singleton instance
const watcherPnLTracker = new WatcherPnLTracker();
export default watcherPnLTracker;
