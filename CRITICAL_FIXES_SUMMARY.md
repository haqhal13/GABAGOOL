# Critical Fixes for Parameter-Based Trading

## Issues Found and Fixed

### ❌ **Issue 1: Hardcoded Timing Logic Blocking Trades**
**Problem:** `nextTradeTime` check was blocking trades with hardcoded 2-3 second gaps, even though parameters show `min_inter_trade_ms: 0.0` (no minimum gap).

**Location:** Line 1614
```typescript
// OLD (BLOCKING):
if (now < buildState.nextTradeTime) {
    return; // Wait until next trade time - BLOCKING!
}
```

**Fix:** ✅ Removed - Now cadence_params handles ALL timing via `cadenceOk()` check

---

### ❌ **Issue 2: Hardcoded Gap Calculation**
**Problem:** After each trade, hardcoded gap calculation was setting `nextTradeTime`, creating artificial delays.

**Location:** Lines 1930-1950
```typescript
// OLD (HARDCODED):
const gap = 2000 + Math.random() * 1000; // 2-3s (61%)
buildState.nextTradeTime = now + gap;
```

**Fix:** ✅ Removed - cadence_params handles timing, no hardcoded gaps

---

### ❌ **Issue 3: Using Mid-Market Prices Instead of Order Book ASK**
**Problem:** Price updates were using mid-market prices `(bid+ask)/2` instead of actual ASK prices (execution prices).

**Location:** Line 1369-1372
```typescript
// OLD (WRONG):
const [priceUp, priceDown] = await Promise.all([
    getOrderBookPrice(assetUpToUse),  // Returns mid-market!
    getOrderBookPrice(assetDownToUse)
]);
```

**Fix:** ✅ Changed to use `getOrderBookExecutionPrices()` which returns ASK prices (execution prices)

---

### ❌ **Issue 4: Rebalancing Not Using Order Book Prices**
**Problem:** Rebalancing logic wasn't using actual order book prices to determine winning side.

**Fix:** ✅ Now passes `execPriceUp`, `execPriceDown`, `avgCostUp`, `avgCostDown` to rebalancing function

---

## What Should Work Now

✅ **All parameters are being used:**
- `entry_params` - Price bands, momentum/reversion mode
- `size_params` - Shares per price bucket
- `inventory_params` - Max shares, rebalance ratios (with order book prices)
- `cadence_params` - Inter-trade times (min_inter_trade_ms: 0.0 = no blocking!)

✅ **No hardcoded overrides:**
- No hardcoded timing gaps
- No hardcoded price filters
- No hardcoded skip rates
- No hardcoded target limits

✅ **Order book prices:**
- Uses ASK prices (execution prices) for all decisions
- Rebalancing based on actual PnL from order book prices

## Debugging

Check `logs/paper_debug.log` for:
- `[Policy Check]` - Are parameters loading?
- `[Policy UP Check]` / `[Policy DOWN Check]` - Are entry signals passing?
- `[Policy] Cadence blocked` - Is cadence blocking (shouldn't with min_inter_trade_ms: 0.0)?
- `[Policy UP]` / `[Policy DOWN]` - Are trades executing?
- `💰 PRICE UPDATE [ASK]` - Are prices using order book ASK?

## Expected Behavior

After restart, paper mode should:
1. ✅ Trade immediately when entry conditions are met (no timing blocks)
2. ✅ Use exact share sizes from size_params
3. ✅ Respect inventory limits from inventory_params
4. ✅ Use cadence_params for rate limiting (but min_inter_trade_ms: 0.0 means no minimum gap)
5. ✅ Rebalance based on order book prices (favor winning side)
6. ✅ Trade both UP and DOWN sides independently

## If Still Not Working

1. **Check if parameters are loading:**
   - Look for `[Param Load]` in debug log
   - Should show `entry=true, size=true, inv=true, cadence=true`

2. **Check if entry signals are passing:**
   - Look for `should_trade=true` in `[Policy UP Check]` / `[Policy DOWN Check]`
   - If `false`, check the reason (price not in band, momentum not met, etc.)

3. **Check if cadence is blocking:**
   - Look for `Cadence blocked` messages
   - With `min_inter_trade_ms: 0.0`, should rarely block

4. **Check if inventory is blocking:**
   - Look for `Blocked (finalSide=null)` messages
   - Check if `max_up_shares` / `max_down_shares` are too low

5. **Check price updates:**
   - Look for `💰 PRICE UPDATE [ASK]` messages
   - Should show ASK prices, not MID
