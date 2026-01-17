import axios from 'axios';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { AppStateSnapshot, emitStateSnapshot, subscribeToState } from './appState';
import watchlistManager from './watchlistManager';

const MIN_INTERVAL_MS = parseInt(process.env.WEBAPP_PUSH_INTERVAL_MS || '2000', 10);
let lastPushedAt = 0;
let pendingTimer: NodeJS.Timeout | null = null;

const formatUsd = (value?: number | null): string | undefined => {
    if (value === undefined || value === null || Number.isNaN(value)) {
        return undefined;
    }
    return `$${value.toFixed(2)}`;
};

const mapTrades = (trades: AppStateSnapshot['trades'] = []) =>
    trades.map((trade) => {
        const timestampMs = trade.timestamp || Date.now();
        const marketUrl = trade.marketSlug
            ? `https://polymarket.com/event/${trade.marketSlug}`
            : trade.marketName || '';
        return {
            trader: trade.traderAddress,
            action: trade.side,
            asset: trade.asset || trade.marketSlug || trade.marketName,
            side: trade.side,
            amount: formatUsd(trade.usdcSize),
            price: trade.price,
            market: marketUrl,
            tx: trade.transactionHash ? `https://polygonscan.com/tx/${trade.transactionHash}` : undefined,
            timestamp: timestampMs,
        };
    });

const mapTraders = (traders: AppStateSnapshot['traders'] = []) => {
    const watchlistEntries = watchlistManager.getAllAddresses();
    return traders.map((trader) => {
        const watchEntry = watchlistEntries.find(
            (w) => w.address.toLowerCase() === trader.address.toLowerCase()
        );
        return {
            address: trader.address,
            alias: watchEntry?.alias,
            enabled: watchEntry?.enabled ?? true,
            notes: trader.positionCount ? `${trader.positionCount} positions` : undefined,
        };
    });
};

const mapWatchlist = () =>
    watchlistManager.getAllAddresses().map((entry) => ({
        address: entry.address,
        alias: entry.alias,
        enabled: entry.enabled,
        addedAt: entry.addedAt,
    }));

const mapPortfolio = (snapshot: AppStateSnapshot) => {
    const portfolio = snapshot.myPortfolio;
    const balance = portfolio?.availableCash ?? 0;
    const invested = portfolio?.investedValue ?? 0;
    const currentValue = portfolio?.currentValue ?? 0;
    const pnl = portfolio?.totalPnL ?? (currentValue - invested);
    const pnlPercent = portfolio?.totalPnLPercent ?? (invested > 0 ? (pnl / invested) * 100 : 0);

    return {
        // WEBAPP required fields
        availableCash: balance,
        investedValue: invested,
        currentValue: currentValue,
        totalPnL: pnl,
        totalPnLPercent: pnlPercent,
        openPositions: portfolio?.openPositions ?? (snapshot.marketSummaries?.length ?? 0),
        totalTrades: portfolio?.totalTrades ?? (snapshot.trades?.length ?? 0),
        // Optional wallet
        wallet: portfolio?.wallet,
        // Time-windowed PnL metrics
        pnl5m: portfolio?.pnl5m,
        pnl5mPercent: portfolio?.pnl5mPercent,
        trades5m: portfolio?.trades5m,
        pnl15m: portfolio?.pnl15m,
        pnl15mPercent: portfolio?.pnl15mPercent,
        trades15m: portfolio?.trades15m,
        pnl1h: portfolio?.pnl1h,
        pnl1hPercent: portfolio?.pnl1hPercent,
        trades1h: portfolio?.trades1h,
    };
};

const mapPnlHistory = (pnlHistory: AppStateSnapshot['pnlHistory'] = []) =>
    pnlHistory.map((entry) => {
        // Map internal outcome format to WEBAPP format
        // Internal uses 'UP'/'DOWN', WEBAPP expects 'WIN'/'LOSS'/'UNKNOWN'
        let outcome: 'WIN' | 'LOSS' | 'UNKNOWN' = 'UNKNOWN';
        if (entry.outcome === 'UP' || entry.outcome === 'DOWN') {
            // Determine WIN/LOSS based on PnL
            outcome = entry.totalPnL >= 0 ? 'WIN' : 'LOSS';
        } else if ((entry.outcome as string) === 'WIN' || (entry.outcome as string) === 'LOSS') {
            outcome = entry.outcome as 'WIN' | 'LOSS';
        }

        return {
            marketName: entry.marketName,
            conditionId: entry.conditionId || '',
            // WEBAPP schema uses lowercase 'l' in totalPnl
            totalPnl: entry.totalPnL,
            pnlPercent: entry.pnlPercent,
            // Include price data for WEBAPP display
            priceUp: (entry as any).priceUp ?? 0,
            priceDown: (entry as any).priceDown ?? 0,
            // Include shares data
            sharesUp: (entry as any).sharesUp ?? 0,
            sharesDown: (entry as any).sharesDown ?? 0,
            timestamp: entry.timestamp,
            outcome,
            marketType: entry.marketType,
        };
    });

const mapMarketSummaries = (markets: AppStateSnapshot['marketSummaries'] = []) =>
    markets.map((m) => ({
        marketKey: m.marketKey,
        marketName: m.marketName,
        category: m.category,
        endDate: m.endDate,
        timeRemaining: m.timeRemaining,
        isExpired: m.isExpired,
        priceUp: m.priceUp,
        priceDown: m.priceDown,
        sharesUp: m.sharesUp,
        sharesDown: m.sharesDown,
        investedUp: m.investedUp,
        investedDown: m.investedDown,
        currentValueUp: m.currentValueUp,
        currentValueDown: m.currentValueDown,
        pnlUp: m.pnlUp,
        pnlDown: m.pnlDown,
        pnlUpPercent: m.pnlUpPercent,
        pnlDownPercent: m.pnlDownPercent,
        totalPnL: m.totalPnL,
        totalPnLPercent: m.totalPnLPercent,
        tradesUp: m.tradesUp,
        tradesDown: m.tradesDown,
        upPercent: m.upPercent,
        downPercent: m.downPercent,
    }));

const buildPayload = (snapshot: AppStateSnapshot) => ({
    botName: 'EdgeBotPro',
    version: 'v2-pnlfix',
    updatedAt: snapshot.updatedAt,
    myPortfolio: mapPortfolio(snapshot),
    traders: mapTraders(snapshot.traders),
    trades: mapTrades(snapshot.trades),
    executions: snapshot.executions ?? [],
    health: snapshot.health ?? {},
    watchlist: mapWatchlist(),
    watchlistCount: watchlistManager.getCount(),
    pnlHistory: mapPnlHistory(snapshot.pnlHistory),
    marketSummaries: mapMarketSummaries(snapshot.marketSummaries),
});

/**
 * Map internal mode to WEBAPP runtimeMode
 * Internal: 'TRACK_ONLY' | 'TRADING'
 * WEBAPP expects: 'TRADING' | 'PAPER' | 'WATCHER'
 */
const mapRuntimeMode = (internalMode: string): 'TRADING' | 'PAPER' | 'WATCHER' => {
    // Check if PAPER_MODE is enabled
    if (ENV.PAPER_MODE) {
        return 'PAPER';
    }
    // Map TRACK_ONLY to WATCHER
    if (internalMode === 'TRACK_ONLY') {
        return 'WATCHER';
    }
    // Default to TRADING
    return 'TRADING';
};

const sendPayload = async (reason: string, snapshot: AppStateSnapshot): Promise<void> => {
    const url = ENV.WEBAPP_PUSH_URL;
    if (!url) {
        return;
    }

    lastPushedAt = Date.now();
    pendingTimer = null;

    try {
        // Use BOT_ID env var if set, otherwise default to 'edgebotpro'
        const botId = process.env.BOT_ID || 'edgebotpro';
        const botName = process.env.BOT_NAME || 'EdgeBotPro';
        const requestBody = {
            botId,
            reason,
            runtimeMode: mapRuntimeMode(snapshot.mode),
            payload: { ...buildPayload(snapshot), botName },
        };

        const response = await axios.post(
            url,
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(ENV.WEBAPP_API_KEY ? { Authorization: `Bearer ${ENV.WEBAPP_API_KEY}` } : {}),
                },
                timeout: ENV.WEBAPP_PUSH_TIMEOUT_MS,
            }
        );
        Logger.info(`[WEBAPP] Push success: ${response.status} - botId=${botId}, reason=${reason}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warning(`[WEBAPP] Failed to push update: ${message}`);
    }
};

export const publishAppState = (reason: string): void => {
    const snapshot = emitStateSnapshot(reason);

    if (!ENV.WEBAPP_PUSH_URL) {
        return;
    }

    const now = Date.now();
    const elapsed = now - lastPushedAt;

    if (elapsed >= MIN_INTERVAL_MS) {
        void sendPayload(reason, snapshot);
        return;
    }

    if (pendingTimer) {
        return;
    }

    pendingTimer = setTimeout(() => {
        const debouncedSnapshot = emitStateSnapshot(`${reason}-debounced`);
        void sendPayload(`${reason}-debounced`, debouncedSnapshot);
    }, MIN_INTERVAL_MS - elapsed);
};

let isInitialized = false;

/**
 * Initialize the web app publisher to automatically push updates
 * when state changes. Call this once at startup.
 */
export const initWebAppPublisher = (): void => {
    if (isInitialized) {
        return;
    }

    if (!ENV.WEBAPP_PUSH_URL) {
        Logger.info('Web app publisher not configured (no WEBAPP_PUSH_URL)');
        return;
    }

    Logger.info(`Web app publisher initialized, pushing to ${ENV.WEBAPP_PUSH_URL}`);
    isInitialized = true;

    // Send initial state
    const initialSnapshot = emitStateSnapshot('init');
    void sendPayload('init', initialSnapshot);

    // Subscribe to state changes and publish updates automatically
    subscribeToState((_snapshot, reason) => {
        publishAppState(reason);
    });

    // Also send heartbeat every 1.5 seconds to keep bot visible on dashboard
    setInterval(() => {
        publishAppState('heartbeat');
    }, 1500);
};

export default publishAppState;
