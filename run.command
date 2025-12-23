#!/bin/bash
# Quick launcher for the Polymarket Copy Trading Bot
# Double-clickable on macOS (ensure it's executable: chmod +x run.command)

cd "/Users/haq/sidebyside/polymarket-copy-trading-bot" || exit 1

echo "🚀 Starting Polymarket Copy Trading Bot..."
echo

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install || exit 1
  echo
fi

# Run the bot
npm run dev

