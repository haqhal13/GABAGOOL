#!/bin/bash
# Quick launcher for the Polymarket Copy Trading Bot
# Double-clickable on macOS (ensure it's executable: chmod +x run.command)

cd "$(dirname "$0")" || exit 1
node run.js