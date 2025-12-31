# 🚀 Quick Run Guide

## Easy Ways to Run the Bot

### Option 1: Using npm script (Recommended)
```bash
npm start
```
or
```bash
npm run start-bot
```

### Option 2: Using the run script
```bash
./run.sh
```

### Option 3: Direct command
```bash
npm run dev
```

## Mode Selection

When you start the bot, you'll be prompted to select a mode:

1. **📊 Paper Mode** - Independent paper trading (simulated, no real money)
2. **👀 Watcher Mode** - Monitor trader activity (read-only, no trading)
3. **💰 Trading Mode** - Real trading (executes actual trades)

You can also set the mode via environment variables:
```bash
# Paper mode
PAPER_MODE=true npm start

# Watcher mode
TRACK_ONLY_MODE=true npm start

# Trading mode (default)
npm start
```

## What Each Mode Does

### Paper Mode
- Simulates trading independently
- Discovers markets using same criteria as watcher mode
- Shows real-time PnL, positions, and market statistics
- Logs to `logs/paper/` directory
- **No real money involved**

### Watcher Mode
- Monitors trader activity from addresses in `USER_ADDRESSES`
- Displays dashboard with up to 4 markets
- Shows real-time PnL, positions, and market statistics
- Logs to `logs/watcher/` directory
- **Read-only, no trades executed**

### Trading Mode
- Monitors traders and automatically copies their trades
- Executes real trades on Polymarket
- Uses your wallet balance and private key
- **Real money involved - use with caution**

## Stop the Bot

Press `Ctrl+C` in the terminal where it's running.

## View Logs

Logs are saved in the `logs/` directory organized by mode:
- `logs/watcher/` - Watcher mode logs
- `logs/paper/` - Paper mode logs
- `logs/Live prices/` - Price stream logs (all modes)

View recent logs:
```bash
# Watcher trades
tail -f logs/watcher/Watcher_Trades_*.csv

# Paper trades
tail -f logs/paper/Paper_Trades_*.csv
```

