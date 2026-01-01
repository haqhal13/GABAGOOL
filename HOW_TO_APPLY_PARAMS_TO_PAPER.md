# How to Apply Inferred Parameters to Paper Mode

## Overview

The inference pipeline generates `params_latest.json` with per-market parameters. To use these in paper mode, you need to integrate the `policyIntegrator` which uses the `policyEngine` to make trading decisions.

## Current Status

✅ **Already Implemented:**
- `paramLoader.ts` - Loads parameters from `params_latest.json` (supports both old and new format)
- `policyEngine.ts` - Implements entry rules, sizing, inventory, and cadence logic
- `policyIntegrator.ts` - Integrates policy engine into trading loop

❌ **Not Yet Integrated:**
- `paperTradeMonitor.ts` - Currently uses hardcoded parameters, needs to use `policyIntegrator`

## Quick Integration Steps

### Option 1: Enable Policy-Based Trading (Recommended)

Add this to your `.env` file:
```bash
USE_POLICY_PARAMS=true
```

Then modify `paperTradeMonitor.ts` to check this flag and use `policyIntegrator` when enabled.

### Option 2: Manual Integration

1. **Import the policy integrator** at the top of `paperTradeMonitor.ts`:
```typescript
import { policyIntegrator } from './policyIntegrator';
import { getParamLoader } from './paramLoader';
```

2. **Initialize parameter loader** (add near top of file):
```typescript
const paramLoader = getParamLoader('watch_bot_analyzer/output/params_latest.json');
paramLoader.startHotReload(3000); // Reload params every 3 seconds
```

3. **Replace trade decision logic** in `buildPositionIncrementally` function:

Find where it decides to trade (around line 1399) and replace with:

```typescript
// Get market key (e.g., "BTC_15m", "ETH_15m", "BTC_1h", "ETH_1h")
const marketKey = getMarketKey(market); // You'll need to implement this function

// Get parameters for this market
const marketParams = paramLoader.getMarketParams(marketKey);

// Use policy integrator to decide if we should trade
const decision = policyIntegrator.shouldTrade(
    marketKey,
    Date.now(),
    market.priceUp || 0.5,
    market.priceDown || 0.5,
    marketParams
);

if (decision.shouldTrade && decision.side && decision.shares > 0) {
    // Execute trade using decision.side and decision.shares
    // Record execution:
    policyIntegrator.recordTradeExecution(
        marketKey,
        Date.now(),
        decision.side,
        decision.shares,
        cost
    );
}
```

4. **Add helper function to convert market to key**:
```typescript
function getMarketKey(market: any): string {
    const slug = market.slug || '';
    const isBTC = slug.toLowerCase().includes('btc') || slug.toLowerCase().includes('bitcoin');
    const isETH = slug.toLowerCase().includes('eth') || slug.toLowerCase().includes('ethereum');
    const is15m = slug.includes('15m') || slug.includes('15-min');
    const is1h = slug.includes('1h') || slug.includes('1-hour') || slug.includes('hourly');
    
    if (isBTC && is15m) return 'BTC_15m';
    if (isETH && is15m) return 'ETH_15m';
    if (isBTC && is1h) return 'BTC_1h';
    if (isETH && is1h) return 'ETH_1h';
    
    // Fallback
    return 'BTC_15m';
}
```

## What This Does

When enabled, paper mode will:
1. ✅ Load parameters from `params_latest.json` automatically
2. ✅ Use inferred entry rules (price bands, momentum/reversion)
3. ✅ Use inferred sizing function (shares per price bucket)
4. ✅ Respect inventory limits and rebalance ratios
5. ✅ Follow cadence rules (inter-trade times, max trades per window)
6. ✅ Hot-reload parameters when you regenerate them (no restart needed)

## Testing

1. Run the inference pipeline to generate `params_latest.json`
2. Start paper mode: `PAPER_MODE=true npm start`
3. Watch the logs - you should see policy decisions like:
   ```
   [Policy Decision 1] BTC_15m: UP 12.5000 shares @ 0.2300 (up_price_band)
   ```

## Fallback Behavior

If `params_latest.json` doesn't exist or a market has no parameters:
- Paper mode falls back to hardcoded behavior (current implementation)
- No errors, just uses defaults

## Next Steps

Would you like me to:
1. ✅ Implement the full integration in `paperTradeMonitor.ts`?
2. ✅ Add the `USE_POLICY_PARAMS` environment variable flag?
3. ✅ Create a test to verify it works?

Let me know and I'll implement it!
