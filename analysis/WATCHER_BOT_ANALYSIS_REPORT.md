# Watcher Bot Reverse Engineering Analysis Report

**Generated:** 2025-12-30
**Source Trader:** gabagool22 (0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d)
**Analysis Period:** 2025-12-30 02:52:41 to 08:42:27 UTC (~6 hours)

---

## Executive Summary

The Watcher Bot (gabagool22) operates as a **dual-side accumulator** that:
- Buys BOTH UP and DOWN positions simultaneously in each market
- Favors the cheaper (minority) side with ~52% allocation
- Trades in high-frequency bursts (up to 25 trades/second)
- Never sells before resolution (always holds to outcome)
- Trades 4 markets in parallel (BTC/ETH x 15min/1hour)
- Generated **$6,780 total PnL** with a **51.3% win rate**

---

## 1. Data Map

### Authoritative Sources

| Field | File | Column(s) |
|-------|------|-----------|
| Trade Time | watcher_trades | Timestamp (Unix ms), Date (ISO) |
| Market ID | watcher_trades | Condition ID, Market Slug, Market Key |
| Price at Entry | watcher_trades | Market Price UP ($), Market Price DOWN ($) |
| Trade Size | watcher_trades | Size (Shares) |
| Trade Side | watcher_trades | Side (BUY), Outcome (UP/DOWN) |
| Price Paid | watcher_trades | Price per Share ($) |
| Avg Cost | watcher_trades | Average Cost Per Share UP/DOWN ($) |
| Market Switches | watcher_pnl | Market Switch Reason, Timestamp |
| Holdings | watcher_pnl | Shares Up, Shares Down |
| Realized PnL | watcher_pnl | Total PnL ($), PnL Percent (%) |
| Resolution | watcher_pnl | Outcome (Profit/Loss) |

### Data Statistics

| Metric | Watcher | Paper |
|--------|---------|-------|
| Total Trades | 17,879 | 2,962 |
| UP Trades | 8,812 (49.3%) | 1,268 (42.8%) |
| DOWN Trades | 9,067 (50.7%) | 1,694 (57.2%) |
| Mean Size | 12.55 shares | 13.91 shares |
| Max Size | 25.00 shares | - |
| Min Size | 0.01 shares | - |

---

## 2. Master Timeline Definition

```typescript
interface MasterTimelineEntry {
  timestamp_ms: number;        // Unix milliseconds
  market_key: string;          // e.g., "BTC-UpDown-15"
  price_up: number;            // Current UP price (0-1)
  price_down: number;          // Current DOWN price (0-1)
  watcher_trade: Trade | null; // Watcher's trade at this moment
  paper_trade: Trade | null;   // Paper bot's trade at this moment

  // State variables
  holdings_up: number;         // Accumulated UP shares
  holdings_down: number;       // Accumulated DOWN shares
  avg_cost_up: number;         // Weighted avg cost for UP
  avg_cost_down: number;       // Weighted avg cost for DOWN
  net_exposure: number;        // holdings_up - holdings_down

  // PnL tracking
  unrealized_pnl: number;      // Mark-to-market
  realized_pnl: number;        // From resolved markets

  // Resolution
  is_resolution: boolean;
  resolution_outcome: 'UP' | 'DOWN' | null;
}
```

---

## 3. Watcher State Machine

### States

```
[IDLE] ──market opens──> [ACCUMULATING] ──skew > threshold──> [HEDGING]
   ^                            │                                  │
   │                            │                                  │
   │                            ▼                                  │
   │                   [HOLDING_TO_RESOLUTION] <───────────────────┘
   │                            │
   │                    market resolves
   │                            │
   │                            ▼
   └──────────────────[SWITCHING_MARKET]
```

### State Descriptions

| State | Description | Entry Trigger |
|-------|-------------|---------------|
| IDLE | No active position, waiting | New market opens |
| ACCUMULATING | Building position on both sides | Market active |
| HEDGING | Rebalancing toward minority side | Skew > 10% |
| HOLDING_TO_RESOLUTION | Position complete, waiting | Near resolution |
| SWITCHING_MARKET | Market resolved, moving on | Resolution event |

### Key Behavioral Rules

| Rule | Confidence | Evidence |
|------|------------|----------|
| Dual-side buying | HIGH | 49.3% UP, 50.7% DOWN trades |
| Minority side bias | HIGH | 52% of trades buy cheaper side |
| Burst trading | HIGH | Up to 25 trades/second observed |
| Hold to resolution | HIGH | No SELL transactions found |
| Multi-market parallel | HIGH | 4 markets traded simultaneously |
| Size scaling with discount | MEDIUM | Slight increase at extreme prices |

---

## 4. WATCHER_PROFILE.json

```json
{
  "bot_name": "gabagool22_replica",
  "version": "1.0.0",
  "source_trader": {
    "address": "0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d",
    "name": "gabagool22"
  },
  "market_config": {
    "supported_markets": ["BTC-UpDown-15", "ETH-UpDown-15", "BTC-UpDown-1h", "ETH-UpDown-1h"],
    "parallel_trading": true,
    "max_concurrent_markets": 4
  },
  "trade_frequency_model": {
    "min_interval_ms": 0,
    "burst_enabled": true,
    "max_trades_per_second": 25,
    "cooldown_after_burst_ms": 0
  },
  "bias_function": {
    "type": "dual_side_accumulator",
    "base_allocation": {
      "when_50_50": {"up": 0.50, "down": 0.50},
      "when_60_40": {"up": 0.45, "down": 0.55},
      "when_70_30": {"up": 0.40, "down": 0.60},
      "when_80_20": {"up": 0.35, "down": 0.65}
    },
    "minority_side_premium": 0.10
  },
  "scaling_curve": {
    "type": "adaptive",
    "base_size_shares": 12.0,
    "min_size_shares": 0.01,
    "max_size_shares": 25.0,
    "mean_size_shares": 12.55,
    "discount_multiplier": 1.5
  },
  "position_limits": {
    "max_position_per_market_usd": 1500.0,
    "max_trade_size_shares": 24.0,
    "min_trade_size_shares": 0.07
  },
  "risk_controls": {
    "stop_loss_enabled": false,
    "take_profit_enabled": false
  },
  "resolution_hold_behavior": {
    "always_hold_to_resolution": true,
    "sell_before_resolution": false
  }
}
```

---

## 5. Model Validation Report

### Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| Direction Prediction | 52.2% | Buys both sides, so limited meaning |
| Total PnL | $6,780.24 | Over 6 hours of trading |
| Win Rate | 51.3% | Per-market outcomes |
| Size CV | 0.63 | Moderate consistency |
| Hourly PnL | ~$1,130/hr | Estimated |

### Side Distribution by Market Skew

| UP Price Range | UP% | DOWN% | Count |
|----------------|-----|-------|-------|
| <20% | 52.9% | 47.1% | 1,434 |
| 20-35% | 52.7% | 47.3% | 2,224 |
| 35-45% | 50.8% | 49.2% | 1,908 |
| 45-55% | 50.0% | 50.0% | 4,137 |
| 55-65% | 47.9% | 52.1% | 2,308 |
| 65-80% | 46.9% | 53.1% | 2,849 |
| >80% | 46.5% | 53.5% | 3,019 |

**Key Finding:** The bot consistently buys the cheaper side more often, with ~52-53% allocation to the minority side at extreme skews.

### Top 10 Failure Cases / Edge Cases

1. Market closes unexpectedly (12 occurrences)
2. New market opens mid-trade (532 snapshots)
3. Extreme skew (>80/20) - behavior changes slightly
4. Resolution near-miss timing
5. Multiple markets resolving simultaneously

---

## 6. Paper Mode Bot Specification

### Core Algorithm

```python
def decide_trade(market_state, position, profile):
    """
    Main decision function for the paper bot.

    Returns: (side, size) or None
    """
    # Don't trade resolved markets
    if market_state.is_resolved:
        return None

    # Check position limits
    total_invested = position.cost_up + position.cost_down
    if total_invested >= profile.max_position_per_market:
        return None

    # Determine which side is cheaper
    if market_state.price_up < market_state.price_down:
        preferred_side = 'UP'
        bias = profile.minority_side_premium  # e.g., 0.10
    else:
        preferred_side = 'DOWN'
        bias = profile.minority_side_premium

    # Calculate size
    base_size = profile.base_size_shares
    discount = abs(0.5 - min(market_state.price_up, market_state.price_down))

    if discount > 0.2:
        size = base_size * 1.5
    elif discount > 0.1:
        size = base_size * 1.2
    else:
        size = base_size

    # Apply some variance (observed in data)
    size *= random.uniform(0.8, 1.2)
    size = max(0.07, min(24.0, size))

    return (preferred_side, size)
```

### Data Flow

```
Price Stream ──> update_state() ──> decide_trade() ──> apply_fill() ──> Log
                      │                    │
                      ▼                    ▼
               Position State         Trade Record
                      │                    │
                      └──────────┬─────────┘
                                 │
                                 ▼
                          Paper PnL Log
```

---

## 7. Tuned Profile

### Drift Analysis: Watcher vs Paper

| Parameter | Watcher | Paper | Drift |
|-----------|---------|-------|-------|
| Trade Count | 17,879 | 2,962 | +14,917 |
| Mean Size | 12.55 | 13.91 | -1.36 |
| UP% | 49.3% | 42.8% | +6.4% |

### Recommended Adjustments

```json
{
  "tuning_notes": {
    "applied_adjustments": [
      "Increase trade frequency to match watcher (6x more trades)",
      "Reduce base size by 1.36 to match watcher sizing",
      "Adjust minority bias to 0.07 (from 0.10) to match 49/51 split"
    ],
    "tuned_version": "1.0.1"
  },
  "scaling_curve": {
    "base_size_shares": 11.32,  // Reduced from 12.55
    "notes": "Adjusted to match watcher mean size"
  },
  "bias_function": {
    "minority_side_premium": 0.07  // Reduced from 0.10
  }
}
```

---

## Implementation Checklist

- [ ] Implement Position class with avg cost tracking
- [ ] Implement MarketState with resolution handling
- [ ] Implement decide_trade() with minority bias
- [ ] Implement size_trade() with discount scaling
- [ ] Implement apply_fill() for position updates
- [ ] Implement switch_market() for resolution PnL
- [ ] Add burst trading capability (multiple trades/second)
- [ ] Add parallel market support
- [ ] Validate against paper_trades.csv
- [ ] Tune parameters based on drift analysis

---

## Files Generated

1. `WATCHER_PROFILE.json` - Bot DNA configuration
2. `TUNED_PROFILE.json` - Calibrated configuration
3. `watcher_analysis.py` - Full analysis script
4. `WATCHER_BOT_ANALYSIS_REPORT.md` - This document
