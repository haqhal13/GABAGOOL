# Pure Parameter-Based Trading Mode

## All Hardcoded Logic Removed ✅

Paper mode now runs **purely on parameters** from `params_latest.json`. All hardcoded values, biases, timing patterns, and fallback logic have been removed.

## What Was Removed

### ❌ **Removed Hardcoded Constants:**
- `PAPER_BTC_MAX_PER_MARKET`, `PAPER_ETH_MAX_PER_MARKET` - Now uses `inventory_params.max_*_shares`
- `BTC_15M_SHARE_AMOUNTS`, `ETH_15M_SHARE_AMOUNTS` - Now uses `size_params.size_table`
- `BATCH_INTERVAL_MS`, `BASE_GAP_MS` - Now uses `cadence_params`
- `BTC_UP_BIAS`, `ETH_UP_BIAS`, `UP_BIAS` - Now uses `inventory_params.rebalance_ratio_R`
- `SAME_SIDE_PROBABILITY`, `AVG_STREAK_LENGTH` - Removed (not in parameters)
- `MOMENTUM_CHASE_FACTOR` - Removed (not in parameters)
- `CLEAR_OUTCOME_THRESHOLD`, `MAX_LOSER_PRICE`, `MIN_LOSER_PRICE` - Removed
- `PAPER_MIN_TRADE`, `PAPER_MEDIAN_TRADE`, `PAPER_MAX_TRADE` - Removed
- `MIN_SHARES` - Removed (no hardcoded minimum)

### ❌ **Removed Hardcoded Logic:**
- Hardcoded position initialization (targets, capital ratios) - Now uses `inventory_params`
- Hardcoded timing gaps (`nextTradeTime`) - Now uses `cadence_params`
- Hardcoded target completion checks - Now uses `inventory_params` limits
- Hardcoded 1h market skip rate - Removed
- Hardcoded arbitrage logic - Removed (parameter-based only)
- Fallback hardcoded trading logic - Removed (no params = no trading)

## What's Now Parameter-Based

### ✅ **Entry Decisions:**
- Uses `entry_params`:
  - `up_price_min`, `up_price_max` - Price bands for UP trades
  - `down_price_min`, `down_price_max` - Price bands for DOWN trades
  - `momentum_window_s`, `momentum_threshold`, `mode` - Momentum/reversion logic

### ✅ **Trade Sizing:**
- Uses `size_params`:
  - `bin_edges` - Price buckets
  - `size_table` - Base shares per price bucket
  - **NEW: Price-ratio multiplier** - Scales winning side based on distance from 50:50:
    - 55:45 → 1.1x (slightly more)
    - 60:40 → 1.3x (more)
    - 70:30 → 1.6x (heavier)
    - 80:20 → 2.0x (even heavier)
    - Losing side: base size (still trades for safety)

### ✅ **Position Limits:**
- Uses `inventory_params`:
  - `max_up_shares`, `max_down_shares` - Per-side limits
  - `max_total_shares` - Total position limit
  - `rebalance_ratio_R` - Maximum ratio before rebalancing

### ✅ **Timing:**
- Uses `cadence_params`:
  - `min_inter_trade_ms` - Minimum gap (0.0 = no minimum)
  - `p50_inter_trade_ms`, `p95_inter_trade_ms` - Percentile gaps
  - `max_trades_per_sec`, `max_trades_per_min` - Rate limits

### ✅ **Rebalancing:**
- Uses order book ASK prices (execution prices)
- Compares current prices to average entry prices
- Calculates PnL for each side
- Favors winning side (positive PnL) up to `rebalance_ratio_R` (0.75)

## Price-Ratio-Based Trading

**How it works:**
1. Get base size from `size_params.size_table` based on current price
2. If trading the **winning side** (further from 50%):
   - Calculate distance from 50:50
   - Apply multiplier: 1.1x (55:45) → 1.3x (60:40) → 1.6x (70:30) → 2.0x (80:20+)
   - Trade more on winning side as ratio moves away from 50:50
3. If trading the **losing side** (closer to 50%):
   - Use base size (still trades for safety/hedging)

**Example:**
- Prices: UP = 0.70, DOWN = 0.30 (70:30)
- UP trade: base size (e.g., 8.0) × 1.6 = **12.8 shares** (heavier)
- DOWN trade: base size (e.g., 8.0) = **8.0 shares** (base, for safety)

## Trading Flow

1. **Market Discovery** - Finds markets from watcher trades
2. **Price Updates** - Fetches order book ASK prices (execution prices)
3. **Parameter Check** - Loads `entry_params`, `size_params`, `inventory_params`, `cadence_params`
4. **Cadence Check** - Uses `cadence_params` to determine if trade is allowed
5. **Entry Check** - Uses `entry_params` to check if price is in band
6. **Size Calculation** - Uses `size_params` + price-ratio multiplier
7. **Inventory Check** - Uses `inventory_params` to check limits and rebalance
8. **Trade Execution** - Executes at order book ASK prices

## No Fallbacks

- **No parameters = No trading** - If parameters aren't loaded, paper mode won't trade
- **No hardcoded defaults** - Everything must come from parameters
- **No legacy logic** - All old hardcoded patterns removed

## Expected Behavior

After restart, paper mode should:
- ✅ Trade based purely on parameters
- ✅ Scale trade sizes based on price ratios (more on winning side)
- ✅ Still trade both sides (winning side larger, losing side base size)
- ✅ Use order book ASK prices for all decisions
- ✅ Rebalance based on actual PnL from order book prices
- ✅ Respect all parameter limits (entry, size, inventory, cadence)
