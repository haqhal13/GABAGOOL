#!/bin/bash

# Polymarket Copy Trading Bot - Quick Start Script
# Usage: ./run.sh

cd "$(dirname "$0")"

echo "🚀 Starting Polymarket Copy Trading Bot..."
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Start the bot
npm run dev

