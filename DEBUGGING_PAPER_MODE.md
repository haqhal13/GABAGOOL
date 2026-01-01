# Debugging Paper Mode Trading Issues

## Changes Made

### 1. **Added Comprehensive Debug Logging**
   - Logs parameter loading for each market
   - Logs entry signal checks (UP and DOWN separately)
   - Logs price bands vs current prices
   - Logs cadence checks
   - Logs inventory checks
   - Logs when trades are blocked and why

### 2. **Debug Log Location**
   - File: `logs/paper_debug.log`
   - This file accumulates all debug messages
   - Check this file to see why trades aren't happening

## How to Debug

### Step 1: Check if Parameters are Loading
Look for lines like:
```
[Param Load] BTC-UpDown-15 -> BTC_15m: entry=true, size=true, inv=true, cadence=true
```

If you see `entry=false` or `size=false`, parameters aren't loading correctly.

### Step 2: Check Entry Signal Checks
Look for lines like:
```
[Policy UP Check] BTC-UpDown-15: should_trade=true, reason="up_price_band", price=0.450 (min=0.01, max=0.995)
[Policy DOWN Check] BTC-UpDown-15: should_trade=true, reason="down_price_band", price=0.550 (min=0.01, max=0.995)
```

If `should_trade=false`, check the reason:
- `up_price_not_in_band` or `down_price_not_in_band` → Price is outside the allowed range
- `momentum_not_met` or `reversion_not_met` → Momentum/reversion conditions not met
- `no_entry_params` → Parameters not loaded

### Step 3: Check Cadence Blocks
Look for:
```
[Policy] BTC-UpDown-15: Cadence blocked (lastTrade=..., recent=...)
```

If cadence is blocking, check:
- `min_inter_trade_ms` in cadence_params might be too high
- `max_trades_per_sec` or `max_trades_per_min` might be too low

### Step 4: Check Inventory Blocks
Look for:
```
[Policy UP] BTC-UpDown-15: ❌ Blocked (finalSide=null, shares=0)
```

If inventory is blocking:
- Check `max_up_shares` and `max_down_shares` in inventory_params
- Check if `rebalance_ratio_R` is preventing trades

### Step 5: Check Market Discovery
Look for:
```
🎯 PROACTIVE DISCOVERY: BTC-UpDown-15 | btc-updown-15m-... | ...m left
```

If markets aren't being discovered:
- Check if `discoveredMarkets` has entries
- Check if assets (assetUp, assetDown) are being fetched

## Common Issues

### Issue 1: Parameters Not Loading
**Symptom:** `[Fallback] ... No policy params!`
**Fix:** 
- Check if `params_latest.json` exists at the correct path
- Check if file format is correct (should have BTC_15m, ETH_15m, etc. as top-level keys)
- Check console for parameter loading errors

### Issue 2: Entry Conditions Too Strict
**Symptom:** `should_trade=false` with `up_price_not_in_band`
**Fix:**
- Check if current prices are within `up_price_min`/`up_price_max` and `down_price_min`/`down_price_max`
- Parameters show 0.01-0.995, so almost any price should work
- If prices are outside this range, there's a data issue

### Issue 3: Cadence Blocking All Trades
**Symptom:** `Cadence blocked` on every check
**Fix:**
- Check `min_inter_trade_ms` - if it's too high, trades will be blocked
- Check `max_trades_per_sec` and `max_trades_per_min` - if too low, trades will be rate-limited
- For initial trades, `min_inter_trade_ms` should be 0 or very low

### Issue 4: Inventory Limits Too Low
**Symptom:** `finalSide=null` even when entry signal is true
**Fix:**
- Check `max_up_shares` and `max_down_shares` in inventory_params
- These should be high enough to allow multiple trades
- Check `rebalance_ratio_R` - if too strict, it might prevent trades

### Issue 5: Markets Not Discovered
**Symptom:** No `PROACTIVE DISCOVERY` logs
**Fix:**
- Check if markets are being discovered from watcher trades
- Check if `discoveredMarkets` has entries
- Check if assets are being fetched correctly

## Next Steps

1. **Restart paper mode** and let it run for a few minutes
2. **Check `logs/paper_debug.log`** to see what's happening
3. **Look for patterns:**
   - Are parameters loading? (search for `[Param Load]`)
   - Are entry signals passing? (search for `should_trade=true`)
   - Is cadence blocking? (search for `Cadence blocked`)
   - Is inventory blocking? (search for `Blocked`)
4. **Share the relevant log lines** so we can identify the exact issue

## Quick Test

To quickly test if parameters are working:
1. Check `logs/paper_debug.log` for `[Param Load]` lines
2. If parameters are loading, check for `[Policy UP Check]` and `[Policy DOWN Check]` lines
3. If entry signals are passing but no trades, check for `Cadence blocked` or `Blocked` lines
