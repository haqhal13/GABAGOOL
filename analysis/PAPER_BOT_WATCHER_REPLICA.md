# Paper Bot - Watcher 1:1 Replica (CORRECTED)

## Changes Applied

The Paper Bot has been updated to replicate the exact behavior of the Watcher Bot (gabagool22) based on reverse-engineering analysis.

## CRITICAL CORRECTION (Latest Update)

Initial analysis was WRONG about minority bias. Re-analysis of actual market RESOLUTIONS (not snapshots) revealed:
- Only 12 actual market resolutions in the data (vs 532 unrealized snapshots)
- Watcher has **75% win rate** on RESOLVED markets
- The dominant side at high skew is the LIKELY WINNER
- Paper bot was betting OPPOSITE to the winning side

**Fix Applied**: Now follows DOMINANT side at high skew instead of minority.

## Files Modified

### 1. `dist/paper-trading/config.js`

**Key Changes:**
- `maxCapitalPerMarket`: $300 → **$1500** (matches Watcher's higher capital usage)
- `minTradeSize`: $0.25 → **$0.05** (smaller minimum trades)
- `maxTradeSize`: $12 → **$15** (slightly higher max)
- `minSecondsBetweenTrades`: 1 → **0** (burst trading enabled)
- `minSecondsBetweenSameMarket`: 2 → **0** (multiple trades per second)
- `allocationGapThreshold`: 3% → **1%** (more aggressive trading)
- `decisionInterval`: 1000ms → **500ms** (faster decisions)

**New Configuration Sections:**
```javascript
burstTrading: {
    enabled: true,
    maxTradesPerBurst: 5,
    burstProbability: 0.3
},
dualSideAccumulation: {
    enabled: true,
    minorityBiasPercent: 52,  // Key insight: 52% of trades to minority side
    alwaysBuyBothSides: true
}
```

### 2. `dist/paper-trading/sizingCurve.js`

**Key Changes:**
- **Flipped allocation logic**: Now biases toward MINORITY (cheaper) side instead of dominant
- `minorityBias`: Added 2-5% bias toward cheaper side (increases with skew)
- Removed stability checks to allow trading during volatility
- Minimal throttling for burst trading

**Allocation Logic:**
```
At 50/50: Equal allocation
At 60/40: 52% to minority (cheaper), 48% to dominant
At 80/20: 55% to minority, 45% to dominant
```

### 3. `dist/paper-trading/tradeExecutor.js`

**Key Changes:**
- **Dual-side buying**: Always trades both UP and DOWN
- **52% minority bias**: Randomly selects minority side 52% of the time
- **Burst trading**: Up to 5 trades per decision cycle
- **Fixed sizing**: 10-15 shares base (mean ~12.55 like Watcher)
- **Removed stability check**: Trades regardless of price volatility

### 4. `dist/paper-trading/positionTracker.js`

**Key Changes:**
- Added Average Cost Per Share tracking (matches Watcher CSV format)
- Updated CSV headers to include `Average Cost Per Share UP/DOWN ($)`
- All trades logged as `BUY` (never sells)
- Hold-to-resolution behavior (no early exits)

## Behavior Summary (CORRECTED)

| Behavior | Original Paper Bot | Watcher Replica (CORRECTED) |
|----------|-------------------|-----------------|
| Side Selection | Buy dominant side | **Follow dominant at high skew (65% bias)** |
| Trade Frequency | 1 trade/second max | **Multiple trades/second** |
| Allocation Bias | 95/5 at extreme skew | **60/40 at high skew (follow winner)** |
| Stability Check | Wait for stable skew | **Trade regardless** |
| Position Limits | $300/market | **$1500/market** |
| Hold Strategy | Hold to resolution | **Hold to resolution** |

## Corrected Strategy Logic

```
At neutral (<10% skew): 50/50 allocation
At moderate (10-30% skew): 55% to dominant side
At high (>30% skew): 65% to dominant side (follow the likely winner)
```

## Expected Metrics (based on corrected analysis)

- **Trade Distribution**: Tilts toward dominant side at high skew
- **Mean Trade Size**: ~12.55 shares
- **Win Rate**: ~75% (matching Watcher's actual resolution win rate)
- **Total PnL**: Positive over time (Watcher made $6,780 in 6 hours)

## Testing

Run the paper bot and compare CSV outputs:
1. `Paper Trades_*.csv` should show ~50/50 UP/DOWN split
2. Multiple trades per second during bursts
3. Average cost per share tracking
4. Higher trade frequency than before
