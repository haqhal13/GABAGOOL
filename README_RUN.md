# 🚀 Quick Run Guide

## Easy Ways to Run the Bot

### Option 1: Using npm script (Recommended)
```bash
npm run
```
or
```bash
npm start-bot
```

### Option 2: Using the run script
```bash
./run.sh
```

### Option 3: Direct command
```bash
npm run dev
```

## What the Bot Does

- **Tracks** wallet: `0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d`
- **Mode**: Track-only (monitoring, no trading)
- **Updates**: Every 0.5 seconds
- **Shows**: Market tracking with UP/DOWN stats, average prices, and investment splits

## Stop the Bot

Press `Ctrl+C` in the terminal where it's running.

## View Logs

Logs are saved in the `logs/` directory:
```bash
tail -f logs/bot-$(date +%Y-%m-%d).log
```

