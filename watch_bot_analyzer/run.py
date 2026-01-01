#!/usr/bin/env python3
"""
Main pipeline for WATCH bot parameter inference.
"""
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

from src.load import load_all_csvs, sanity_checks, get_trade_rows
from src.parse import parse_notes, add_trade_features, prepare_tape
from src.features import engineer_features
from src.infer import infer_all_parameters
from src.validate import validate_model
from src.report import generate_all_reports


def main():
    """Main execution pipeline."""
    print("=" * 80)
    print("WATCH Bot Parameter Inference Pipeline")
    print("=" * 80)
    
    # Step 1: Load data
    print("\n[1/6] Loading CSV files...")
    # Try relative path from project root first
    data_dir = "logs/Live prices"
    try:
        tape = load_all_csvs(data_dir)
    except FileNotFoundError:
        # Try from watch_bot_analyzer directory
        data_dir = "../logs/Live prices"
        tape = load_all_csvs(data_dir)
    
    # Sanity checks
    print("\n[1.5/6] Running sanity checks...")
    check_results = sanity_checks(tape)
    print(f"Sanity check results: {check_results}")
    
    # Step 2: Parse trade notes
    print("\n[2/6] Parsing trade notes...")
    tape = prepare_tape(tape)
    trades = get_trade_rows(tape)
    trades, unparsed = parse_notes(trades)
    trades = add_trade_features(trades)
    
    print(f"Total trades: {len(trades)}")
    print(f"WATCH trades: {len(trades[trades['bot'] == 'WATCH'])}")
    print(f"PAPER trades: {len(trades[trades['bot'] == 'PAPER'])}")
    
    # Step 3: Feature engineering
    print("\n[3/6] Engineering features...")
    trades = engineer_features(tape, trades)
    
    # Step 4: Parameter inference
    print("\n[4/6] Inferring parameters...")
    params = infer_all_parameters(tape, trades)
    
    # Print summary (params are now in market-first format)
    print("\n=== Inferred Parameters Summary ===")
    for market in sorted(params.keys()):
        market_params = params[market]
        print(f"\n{market}:")
        for param_type in ['entry_params', 'size_params', 'inventory_params', 'cadence_params', 'confidence']:
            if param_type in market_params:
                value = market_params[param_type]
                if isinstance(value, dict):
                    if param_type == 'size_params' and 'size_table' in value:
                        print(f"  {param_type}: {len(value.get('size_table', {}))} buckets")
                    elif param_type == 'confidence':
                        conf = value
                        print(f"  {param_type}: n_trades={conf.get('n_watch_trades', 0)}, "
                              f"entry_precision={conf.get('entry_rule_precision', 0):.2%}, "
                              f"entry_recall={conf.get('entry_rule_recall', 0):.2%}, "
                              f"size_var={conf.get('size_table_bucket_variance', 0):.2f}")
                    else:
                        print(f"  {param_type}: {len(value)} keys")
                else:
                    print(f"  {param_type}: {value}")
    
    # Step 5: Model validation
    print("\n[5/6] Validating model...")
    validation_results = validate_model(tape, trades, params)
    
    # Merge validation metrics into confidence scores
    per_market_validation = validation_results.get('metrics', {}).get('per_market', {})
    for market in params.keys():
        if market in per_market_validation:
            if 'confidence' not in params[market]:
                params[market]['confidence'] = {}
            # Add validation metrics to confidence
            val_metrics = per_market_validation[market]
            params[market]['confidence']['entry_precision'] = val_metrics.get('precision', 0.0)
            params[market]['confidence']['entry_recall'] = val_metrics.get('recall', 0.0)
            params[market]['confidence']['size_mape'] = val_metrics.get('size_mape', 0.0)
    
    # Step 6: Generate reports
    print("\n[6/6] Generating reports...")
    generate_all_reports(tape, trades, params, validation_results, "output")
    
    print("\n" + "=" * 80)
    print("Pipeline Complete!")
    print("=" * 80)
    print("\nOutput files:")
    print("  - output/params_latest.json")
    print("  - output/params_history.jsonl")
    print("  - output/diff_report.csv")
    print("  - output/diff_summary.csv")
    print("  - output/*_trades.png")
    print("  - output/*_inter_trade_hist.png")


if __name__ == "__main__":
    main()

