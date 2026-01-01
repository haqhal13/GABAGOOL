# Paper Mode Parameter Usage Fixes

## Issues Found and Fixed

### ❌ **Issue 1: Hardcoded Neutral Zone Filter (BLOCKING TRADES)**
**Problem:** Paper mode had a hardcoded filter that only allowed trades when prices were between 0.35-0.65, but parameters show much wider bands (0.01-0.995).

**Location:** Line 1506
```typescript
// OLD (BLOCKING):
const isNeutral = market.priceUp >= 0.35 && market.priceUp <= 0.65;
if (!isNeutral) {
    return; // Blocked trades outside 0.35-0.65!
}
```

**Fix:** ✅ Removed - Now uses `entry_params` price bands from parameters (0.01-0.995)

---

### ❌ **Issue 2: Position Completion Checks Blocking Trades**
**Problem:** Paper mode stopped trading when positions reached 98% of targets, even if policy wanted to trade more.

**Location:** Lines 1622-1623, 1692, 1696
```typescript
// OLD (BLOCKING):
const upComplete = buildState.investedUp >= buildState.targetUp * 0.98;
if (!upComplete) { // Only trade if not complete
    // ... policy check
}
```

**Fix:** ✅ Removed completion checks from blocking trades - Policy's `inventory_params` (max_up_shares, max_down_shares) now handles position limits

---

### ❌ **Issue 3: Hardcoded 1h Market Skip Rate**
**Problem:** Paper mode randomly skipped 30% of 1h market trades, not from parameters.

**Location:** Line 1631
```typescript
// OLD (BLOCKING):
if (is1hMarket && Math.random() < 0.30) {
    return; // Skip 30% of 1h trades
}
```

**Fix:** ✅ Removed - Now uses `cadence_params` from parameters for rate limiting

---

### ❌ **Issue 4: Target-Based Trade Capping**
**Problem:** Trades were capped to remaining targets, limiting continuous trading.

**Location:** Lines 1740-1751
```typescript
// OLD (LIMITING):
if (tradeUp > remainingUp) {
    tradeUp = remainingUp; // Cap to target
}
```

**Fix:** ✅ Removed target capping - Policy's inventory limits handle position sizing

---

### ❌ **Issue 5: UP-First Bias in Policy Engine**
**Problem:** `entrySignal()` checked UP first and returned immediately, never checking DOWN when both were valid.

**Fix:** ✅ Added `checkSideEntry()` method to check specific sides independently
- Now checks UP and DOWN separately
- Both sides can trade when their price bands are met

---

### ❌ **Issue 6: Empty Price History for Features**
**Problem:** Price history was being updated but not used for feature computation (deltas, volatility).

**Fix:** ✅ Now retrieves actual price history from policy integrator for proper feature computation

---

## What's Now Working

✅ **All parameters are being used:**
- `entry_params` - Price bands (0.01-0.995, not 0.35-0.65)
- `size_params` - Shares per price bucket
- `inventory_params` - Max shares, rebalance ratios
- `cadence_params` - Inter-trade times, max trades per window

✅ **Both UP and DOWN sides trade:**
- Checks both sides independently
- No UP-first bias

✅ **Continuous trading:**
- No hardcoded target limits
- Policy's inventory limits control position sizing
- Can trade continuously like watcher

✅ **Proper feature computation:**
- Uses actual price history for deltas/volatility
- Features build up over time

## Remaining Differences (Expected)

Some differences are **expected** and **normal**:

1. **Different time windows**: Paper mode discovers markets independently, so timing may differ slightly
2. **Different prices**: Prices update in real-time, so slight differences are normal
3. **Market discovery timing**: Paper mode may discover markets at slightly different times than watcher trades on them

## Testing

After restarting paper mode, you should see:
- ✅ More trades (especially DOWN trades)
- ✅ Trades at wider price ranges (not just 0.35-0.65)
- ✅ Continuous trading (not stopping at targets)
- ✅ Both UP and DOWN trades
- ✅ `[Policy UP]` and `[Policy DOWN]` logs

## Next Steps

If trades still don't match exactly:
1. Check if parameters need regeneration with more data
2. Verify market discovery is finding the same markets
3. Check if cadence params are too restrictive (min_inter_trade_ms)
4. Verify inventory limits aren't too low
