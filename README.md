# Polymarket Copy Trading Bot

> Automated copy trading bot for Polymarket that mirrors trades from top performers with intelligent position sizing and real-time execution.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

## Overview

The Polymarket Copy Trading Bot automatically replicates trades from successful Polymarket traders to your wallet. It monitors trader activity 24/7, calculates proportional position sizes based on your capital, and executes matching orders in real-time.

### How It Works
<img width="995" height="691" alt="screenshot" src="https://github.com/user-attachments/assets/79715c7a-de2c-4033-81e6-b2288963ec9b" />

1. **Select Traders** - Choose top performers from [Polymarket leaderboard](https://polymarket.com/leaderboard) or [Predictfolio](https://predictfolio.com)
2. **Monitor Activity** - Bot continuously watches for new positions opened by selected traders using Polymarket Data API
3. **Calculate Size** - Automatically scales trades based on your balance vs. trader's balance
4. **Execute Orders** - Places matching orders on Polymarket using your wallet
5. **Track Performance** - Maintains complete trade history in MongoDB

## Quick Start

### Prerequisites

- Node.js v18+
- MongoDB database ([MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) free tier works)
- Polygon wallet with USDC and POL/MATIC for gas
- RPC endpoint ([Infura](https://infura.io) or [Alchemy](https://www.alchemy.com) free tier)

### Installation

```bash
# Clone repository
git clone https://github.com/vladmeer/polymarket-copy-trading-bot.git
cd polymarket-copy-trading-bot

# Install dependencies
npm install

# Run interactive setup wizard
npm run setup

# Build and start
npm run build
npm run health-check  # Verify configuration
npm start             # Start bot (interactive mode selection)
```

When you run `npm start`, you'll be prompted to select a mode:
- Paper Mode (simulated trading)
- Watcher Mode (monitoring only)
- Trading Mode (real execution)

You can also set modes via environment variables:
```bash
PAPER_MODE=true npm start        # Paper mode
TRACK_ONLY_MODE=true npm start   # Watcher mode
npm start                        # Trading mode (default)
```

**📖 For detailed setup instructions, see [Getting Started Guide](./docs/GETTING_STARTED.md)**
**📖 For quick run instructions, see [Quick Run Guide](./README_RUN.md)**

## Features

- **Three Operating Modes** - Paper trading, Watcher mode, and Live trading
- **Multi-Trader Support** - Track and copy trades from multiple traders simultaneously
- **Smart Position Sizing** - Automatically adjusts trade sizes based on your capital
- **Tiered Multipliers** - Apply different multipliers based on trade size
- **Position Tracking** - Accurately tracks purchases and sells even after balance changes
- **Trade Aggregation** - Combines multiple small trades into larger executable orders
- **Real-time Execution** - Monitors trades every second and executes instantly
- **MongoDB Integration** - Persistent storage of all trades and positions
- **Price Protection** - Built-in slippage checks to avoid unfavorable fills
- **Comprehensive Logging** - CSV logs for trades, PnL, and price streams organized by mode

### Operating Modes

The bot supports three distinct modes that you can select when starting:

1. **📊 Paper Mode** - Independent paper trading simulation
   - Simulates trading without using real money
   - Discovers markets independently using same criteria as watcher
   - Perfect for testing strategies and understanding market behavior
   - Logs saved to `logs/paper/`

2. **👀 Watcher Mode** - Monitor trader activity (read-only)
   - Tracks trader positions from addresses in `USER_ADDRESSES`
   - Displays real-time dashboard with up to 4 markets
   - Shows PnL, positions, and market statistics
   - No trades executed - monitoring only
   - Logs saved to `logs/watcher/`

3. **💰 Trading Mode** - Real trading with automatic execution
   - Monitors traders and automatically copies their trades
   - Executes real trades on Polymarket using your wallet
   - Uses proportional position sizing based on capital
   - **⚠️ Uses real money - trade with caution**

### Monitoring Method

The bot currently uses the **Polymarket Data API** to monitor trader activity and detect new positions. The monitoring system polls trader positions at configurable intervals (default: 1 second) to ensure timely trade detection and execution.

## Configuration

### Easy Wallet Configuration 🎯

**The easiest way to set which wallet to track:** Just edit the `wallet` file!

```bash
# Open the wallet file
nano wallet
# or
code wallet
# or any text editor

# Replace the address with the wallet you want to track
0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d
```

The bot will automatically use the address from the `wallet` file. You can also:
- Add multiple addresses separated by commas: `0xABC..., 0xDEF...`
- Add comments with `#` for notes
- The bot prioritizes: `wallet` file → `USER_ADDRESSES` env var → default

**Priority order:**
1. `wallet` file (easiest - just edit and save!)
2. `USER_ADDRESSES` environment variable
3. Default address (0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d)

### Essential Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `USER_ADDRESSES` | Traders to copy (comma-separated) | `'0xABC..., 0xDEF...'` |
| `PROXY_WALLET` | Your Polygon wallet address | `'0x123...'` |
| `PRIVATE_KEY` | Wallet private key (no 0x prefix) | `'abc123...'` |
| `MONGO_URI` | MongoDB connection string | `'mongodb+srv://...'` |
| `RPC_URL` | Polygon RPC endpoint | `'https://polygon...'` |
| `TRADE_MULTIPLIER` | Position size multiplier (default: 1.0) | `2.0` |
| `FETCH_INTERVAL` | Check interval in seconds (default: 1) | `1` |

### Finding Traders

1. Visit [Polymarket Leaderboard](https://polymarket.com/leaderboard)
2. Look for traders with positive P&L, win rate >55%, and active trading history
3. Verify detailed stats on [Predictfolio](https://predictfolio.com)
4. Add wallet addresses to `USER_ADDRESSES`

**📖 For complete configuration guide, see [Quick Start](./docs/QUICK_START.md)**

## Docker Deployment

Deploy with Docker Compose for a production-ready setup:

```bash
# Configure and start
cp .env.example .env
docker-compose up -d

# View logs
docker-compose logs -f polymarket
```

**📖 [Complete Docker Guide →](./docs/DOCKER.md)**

## Documentation

### Getting Started
- **[🚀 Getting Started Guide](./docs/GETTING_STARTED.md)** - Complete beginner's guide
- **[⚡ Quick Start](./docs/QUICK_START.md)** - Fast setup for experienced users
- **[🏃 Quick Run Guide](./README_RUN.md)** - How to run the bot and select modes

### Advanced Guides
- **[Multi-Trader Guide](./docs/MULTI_TRADER_GUIDE.md)** - Track multiple traders
- **[Simulation Guide](./docs/SIMULATION_GUIDE.md)** - Test strategies with simulations
- **[Position Tracking](./docs/POSITION_TRACKING.md)** - Understand position management
- **[Docker Deployment](./docs/DOCKER.md)** - Production deployment

## License

ISC License - See [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built on [Polymarket CLOB Client](https://github.com/Polymarket/clob-client)
- Uses [Predictfolio](https://predictfolio.com) for trader analytics
- Powered by Polygon network

---

## Advanced version

**🚀 Version 2 Available:** An advanced version with **RTDS (Real-Time Data Stream)** monitoring is now available as a private repository. <br />
Version 2 features the fastest trade detection method with near-instantaneous trade replication, lower latency, and reduced API load. Copy trading works excellently in the advanced version.

<img width="680" height="313" alt="image (19)" src="https://github.com/user-attachments/assets/d868f9f2-a1dd-4bfe-a76e-d8cbdfbd8497" />

## Trading tool

I've also developed a trading bot for Polymarket built with **Rust**.

<img width="1917" height="942" alt="image (21)" src="https://github.com/user-attachments/assets/08a5c962-7f8b-4097-98b6-7a457daa37c9" />
https://www.youtube.com/watch?v=4f6jHT4-DQs

**Disclaimer:** This software is for educational purposes only. Trading involves risk of loss. The developers are not responsible for any financial losses incurred while using this bot.

**Support:** For questions or issues, contact via Telegram: [@Vladmeer](https://t.me/vladmeer67) | Twitter: [@Vladmeer](https://x.com/vladmeer67)
