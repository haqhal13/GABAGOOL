# Where to See Graphs and Confidence Scores

## Step 1: Run the Inference Pipeline

```bash
cd EDGEBOTPRO/watch_bot_analyzer
python run.py
```

## Step 2: Check Console Output

While running, you'll see confidence scores printed directly in the terminal:

```
=== Per-Market Summary ===

BTC_15m:
  n_watch_trades: 32166
  entry_rule_precision: 85.23%
  entry_rule_recall: 12.45%
  size_table_bucket_variance: 45.67

ETH_15m:
  n_watch_trades: 13530
  entry_rule_precision: 82.10%
  entry_rule_recall: 10.20%
  size_table_bucket_variance: 38.90

... (and so on for BTC_1h, ETH_1h)
```

Plus validation metrics:
```
=== Per-Market Validation Metrics ===

BTC_15m:
  entry_precision: 75.50%
  entry_recall: 68.30%
  size_MAPE: 12.45%
  matched_count: 24500 / 32166
```

## Step 3: Check Output Files

After running, check: `EDGEBOTPRO/watch_bot_analyzer/output/`

### 📊 Graphs (PNG files):
- `BTC_15m_trades.png` - Trade points over time + size vs price scatter
- `ETH_15m_trades.png` - Same for ETH 15m
- `BTC_1h_trades.png` - Same for BTC 1h
- `ETH_1h_trades.png` - Same for ETH 1h
- `BTC_15m_inter_trade_hist.png` - Inter-trade time distribution
- `ETH_15m_inter_trade_hist.png` - Same for ETH
- `BTC_1h_inter_trade_hist.png` - Same for BTC 1h
- `ETH_1h_inter_trade_hist.png` - Same for ETH 1h

### 📄 JSON with Confidence Scores:
- `params_latest.json` - Contains all parameters AND confidence scores:

```json
{
  "BTC_15m": {
    "entry_params": {...},
    "size_params": {...},
    "inventory_params": {...},
    "cadence_params": {...},
    "confidence": {
      "n_watch_trades": 32166,
      "entry_rule_precision": 0.8523,
      "entry_rule_recall": 0.1245,
      "size_table_bucket_variance": 45.67,
      "entry_precision": 0.7550,
      "entry_recall": 0.6830,
      "size_mape": 12.45
    }
  },
  "ETH_15m": {...},
  "BTC_1h": {...},
  "ETH_1h": {...}
}
```

### 📈 CSV Reports:
- `diff_report.csv` - Detailed WATCH vs PAPER trade comparison
- `diff_summary.csv` - Aggregated summary per market

## Quick Check Commands

```bash
# See all output files
ls -lh EDGEBOTPRO/watch_bot_analyzer/output/

# View confidence scores in JSON
cat EDGEBOTPRO/watch_bot_analyzer/output/params_latest.json | jq '.[] | {market: .market, confidence: .confidence}'

# Open graphs (macOS)
open EDGEBOTPRO/watch_bot_analyzer/output/*.png
```

## Summary

- **Console**: Real-time confidence scores during execution
- **params_latest.json**: All confidence scores in structured format
- **PNG files**: Visual graphs per market
- **CSV files**: Detailed comparison reports
