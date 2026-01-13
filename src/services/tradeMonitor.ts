import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import publishAppState from './webAppPublisher';
import {
    recordTradeEvent,
    setTraderSnapshots,
    setPortfolioSnapshot,
    setStatusMessage,
    markRunning,
} from './appState';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

interface ActivityRecord {
    proxyWallet?: string;
    timestamp: number;
    conditionId: string;
    type: string;
    size: number;
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: 'BUY' | 'SELL';
    outcomeIndex: number;
    title?: string;
    slug?: string;
    eventSlug?: string;
    outcome?: string;
    name?: string;
    pseudonym?: string;
}

const userModels = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

const processedTrades = new Set<string>();
let isFirstRun = true;
let isRunning = true;

const fetchMyPortfolio = async () => {
    if (ENV.TRACK_ONLY_MODE || !ENV.PROXY_WALLET) {
        setPortfolioSnapshot(undefined);
        return;
    }

    try {
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);
        const getMyBalance = (await import('../utils/getMyBalance')).default;
        const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

        if (Array.isArray(myPositions) && myPositions.length > 0) {
            let totalValue = 0;
            let initialValue = 0;
            let weightedPnl = 0;
            myPositions.forEach((pos: any) => {
                const value = pos.currentValue || 0;
                const initial = pos.initialValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                initialValue += initial;
                weightedPnl += value * pnl;
            });
            const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
            const topPositions = myPositions
                .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET,
                myPositions.length,
                topPositions,
                overallPnl,
                totalValue,
                initialValue,
                currentBalance
            );

            setPortfolioSnapshot({
                wallet: ENV.PROXY_WALLET,
                openPositions: myPositions.length,
                investedValue: initialValue,
                currentValue: totalValue,
                availableCash: currentBalance,
                overallPnl,
                updatedAt: Date.now(),
            });
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
            setPortfolioSnapshot({
                wallet: ENV.PROXY_WALLET,
                openPositions: 0,
                investedValue: 0,
                currentValue: 0,
                availableCash: currentBalance,
                overallPnl: 0,
                updatedAt: Date.now(),
            });
        }
    } catch (error) {
        Logger.error(`Failed to fetch your positions: ${error}`);
    }
};

const fetchTraderPositions = async (): Promise<void> => {
    const isMongoConnected = mongoose.connection.readyState === 1;

    if (!isMongoConnected) {
        setTraderSnapshots([]);
        return;
    }

    const positionCounts: number[] = [];
    const positionDetails: any[][] = [];
    const profitabilities: number[] = [];

    for (const { address, UserPosition } of userModels) {
        const positions = await UserPosition.find().exec();
        positionCounts.push(positions.length);

        let totalValue = 0;
        let weightedPnl = 0;
        positions.forEach((pos) => {
            const value = pos.currentValue || 0;
            const pnl = pos.percentPnl || 0;
            totalValue += value;
            weightedPnl += value * pnl;
        });
        const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
        profitabilities.push(overallPnl);

        const topPositions = positions
            .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
            .slice(0, 3)
            .map((p) => p.toObject());
        positionDetails.push(topPositions);
    }

    Logger.clearLine();
    Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);

    setTraderSnapshots(
        USER_ADDRESSES.map((address, index) => ({
            address,
            positionCount: positionCounts[index] || 0,
            profitability: profitabilities[index],
            topPositions: positionDetails[index]?.map((pos) => ({
                title: pos.title,
                outcome: pos.outcome,
                currentValue: pos.currentValue,
                percentPnl: pos.percentPnl,
            })),
        }))
    );
};

const init = async () => {
    const isMongoConnected = mongoose.connection.readyState === 1;

    if (isMongoConnected) {
        const counts: number[] = [];
        for (const { address, UserActivity } of userModels) {
            const count = await UserActivity.countDocuments();
            counts.push(count);
        }
        Logger.clearLine();
        Logger.dbConnection(USER_ADDRESSES, counts);
    } else {
        Logger.clearLine();
        Logger.info('Running in memory-only mode (MongoDB not connected)');
        Logger.info('Trades will stream to the console and web API only');
    }

    if (!ENV.TRACK_ONLY_MODE && ENV.PROXY_WALLET) {
        await fetchMyPortfolio();
    }

    await fetchTraderPositions();
};

const shouldProcessActivity = (
    activity: ActivityRecord,
    address: string,
    cutoffSeconds: number,
    recentCutoffSeconds: number
): boolean => {
    const isRecent = activity.timestamp >= recentCutoffSeconds;
    const isWithinWindow = activity.timestamp >= cutoffSeconds;

    if (!isRecent && !isWithinWindow) {
        return false;
    }

    if (activity.proxyWallet && activity.proxyWallet.toLowerCase() !== address.toLowerCase()) {
        return false;
    }

    if (activity.proxyWallet == null && activity.proxyWallet !== undefined) {
        return false;
    }

    return true;
};

const handleActivityPersistence = async (
    activity: ActivityRecord,
    address: string,
    UserActivity: ReturnType<typeof getUserActivityModel>,
    isMongoConnected: boolean
): Promise<boolean> => {
    if (isMongoConnected) {
        const existingActivity = await UserActivity.findOne({
            transactionHash: activity.transactionHash,
        }).exec();

        if (existingActivity) {
            return false;
        }

        const newActivity = new UserActivity({
            proxyWallet: activity.proxyWallet,
            timestamp: activity.timestamp,
            conditionId: activity.conditionId,
            type: activity.type,
            size: activity.size,
            usdcSize: activity.usdcSize,
            transactionHash: activity.transactionHash,
            price: activity.price,
            asset: activity.asset,
            side: activity.side,
            outcomeIndex: activity.outcomeIndex,
            title: activity.title,
            slug: activity.slug,
            icon: (activity as any).icon,
            eventSlug: activity.eventSlug,
            outcome: activity.outcome,
            name: activity.name,
            pseudonym: activity.pseudonym,
            bot: false,
            botExcutedTime: 0,
        });

        await newActivity.save();
        return true;
    }

    const tradeKey = `${address}:${activity.transactionHash}`;
    if (processedTrades.has(tradeKey)) {
        return false;
    }
    processedTrades.add(tradeKey);
    return true;
};

const logTrade = (activity: ActivityRecord, traderAddress: string): void => {
    Logger.trade(traderAddress, activity.side, {
        asset: activity.asset,
        side: activity.side,
        amount: activity.usdcSize,
        price: activity.price,
        slug: activity.slug,
        eventSlug: activity.eventSlug,
        transactionHash: activity.transactionHash,
        title: activity.title,
    });

    recordTradeEvent({
        traderAddress,
        traderDisplay: activity.pseudonym || activity.name,
        transactionHash: activity.transactionHash,
        conditionId: activity.conditionId,
        marketName: activity.title,
        marketSlug: activity.slug,
        side: activity.side,
        outcome: activity.outcome,
        asset: activity.asset,
        price: activity.price,
        usdcSize: activity.usdcSize,
        timestamp: activity.timestamp * 1000,
        mode: ENV.TRACK_ONLY_MODE ? 'WATCH' : 'TRADING',
    });
};

const fetchTradeData = async () => {
    const watchModeCutoffHours = ENV.TRACK_ONLY_MODE ? 48 : TOO_OLD_TIMESTAMP;
    const cutoffSeconds = Math.floor(Date.now() / 1000) - watchModeCutoffHours * 60 * 60;
    const recentCutoffSeconds = Math.floor(Date.now() / 1000) - 5 * 60;
    const isMongoConnected = mongoose.connection.readyState === 1;

    for (const { address, UserActivity, UserPosition } of userModels) {
        try {
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=200`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            for (const activity of activities as ActivityRecord[]) {
                if (!shouldProcessActivity(activity, address, cutoffSeconds, recentCutoffSeconds)) {
                    continue;
                }

                const processed = await handleActivityPersistence(
                    activity,
                    address,
                    UserActivity,
                    isMongoConnected
                );

                if (!processed) {
                    continue;
                }

                logTrade(activity, address);
                publishAppState('trade');
            }

            if (isMongoConnected) {
                const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
                const positions = await fetchData(positionsUrl);

                if (Array.isArray(positions) && positions.length > 0) {
                    for (const position of positions) {
                        await UserPosition.findOneAndUpdate(
                            { asset: position.asset, conditionId: position.conditionId },
                            {
                                proxyWallet: position.proxyWallet,
                                asset: position.asset,
                                conditionId: position.conditionId,
                                size: position.size,
                                avgPrice: position.avgPrice,
                                initialValue: position.initialValue,
                                currentValue: position.currentValue,
                                cashPnl: position.cashPnl,
                                percentPnl: position.percentPnl,
                                totalBought: position.totalBought,
                                realizedPnl: position.realizedPnl,
                                percentRealizedPnl: position.percentRealizedPnl,
                                curPrice: position.curPrice,
                                redeemable: position.redeemable,
                                mergeable: position.mergeable,
                                title: position.title,
                                slug: position.slug,
                                icon: position.icon,
                                eventSlug: position.eventSlug,
                                outcome: position.outcome,
                                outcomeIndex: position.outcomeIndex,
                                oppositeOutcome: position.oppositeOutcome,
                                oppositeAsset: position.oppositeAsset,
                                endDate: position.endDate,
                                negativeRisk: position.negativeRisk,
                            },
                            { upsert: true }
                        );
                    }
                }
            }
        } catch (error) {
            Logger.error(
                `Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
            );
        }
    }
};

export const stopTradeMonitor = () => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
    markRunning(false);
};

const tradeMonitor = async () => {
    setStatusMessage('initializing');
    await init();
    markRunning(true);
    Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();

    if (isFirstRun) {
        const isMongoConnected = mongoose.connection.readyState === 1;
        if (isMongoConnected) {
            Logger.info('First run: marking all historical trades as processed...');
            for (const { address, UserActivity } of userModels) {
                const count = await UserActivity.updateMany(
                    { bot: false },
                    { $set: { bot: true, botExcutedTime: 999 } }
                );
                if (count.modifiedCount > 0) {
                    Logger.info(
                        `Marked ${count.modifiedCount} historical trades as processed for ${address.slice(0, 6)}...${address.slice(-4)}`
                    );
                }
            }
            Logger.success('Historical trades processed. Now monitoring for new trades only.');
        } else {
            Logger.info('First run: starting fresh (memory-only mode).');
        }
        isFirstRun = false;
        Logger.separator();
    }

    while (isRunning) {
        setStatusMessage('watching');
        await fetchTradeData();
        await fetchTraderPositions();
        if (!ENV.TRACK_ONLY_MODE) {
            await fetchMyPortfolio();
        }
        publishAppState('heartbeat');
        if (!isRunning) break;
        const pollInterval = ENV.TRACK_ONLY_MODE ? Math.min(FETCH_INTERVAL, 2) : FETCH_INTERVAL;
        await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
