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
                        print(f"  {param_type}: {len(value.get('size_table', {}))} buckets (2D: price x inventory)")
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
            size_mape = val_metrics.get('size_mape', 0.0)
            size_p90_ape = val_metrics.get('size_p90_ape', 0.0)
            params[market]['confidence']['size_mape'] = size_mape
            params[market]['confidence']['size_p90_ape'] = size_p90_ape
            
            # Check if size model should be rejected (MdAPE > 30%)
            if size_mape > 30.0:
                print(f"\n⚠️  WARNING: {market} size model needs improvement - MdAPE = {size_mape:.2f}% > 30%")
        
        # Add side_selection_gap from side_selection_params
        if 'side_selection_params' in params[market]:
            ss_params = params[market]['side_selection_params']
            if 'confidence_gap' in ss_params:
                if 'confidence' not in params[market]:
                    params[market]['confidence'] = {}
                params[market]['confidence']['side_selection_gap'] = ss_params['confidence_gap']
    
    # Step 6: Generate reports
    print("\n[6/6] Generating reports...")
    generate_all_reports(tape, trades, params, validation_results, "output")
    
    # Print per-market validation metrics summary
    print("\n" + "=" * 80)
    print("Per-Market Validation Metrics Summary")
    print("=" * 80)
    for market in sorted(params.keys()):
        conf = params[market].get('confidence', {})
        size_params = params[market].get('size_params', {})
        print(f"\n{market}:")
        print(f"  entry_precision: {conf.get('entry_precision', 0):.2%}")
        print(f"  entry_recall: {conf.get('entry_recall', 0):.2%}")
        size_mape = conf.get('size_mape', 0)
        size_p90_ape = conf.get('size_p90_ape', 0)
        print(f"  MdAPE (size error): {size_mape:.2f}% (on matched trades: same market, side, ±2000ms)")
        print(f"  p90 APE: {size_p90_ape:.2f}%")
        if size_mape > 30.0:
            print(f"  ⚠️  WARNING: MdAPE > 30% - size model needs improvement")
        
        # Bucket counts
        n_price = size_params.get('n_price_buckets', 0)
        n_inv = size_params.get('n_inventory_buckets', 0)
        n_vol = len(size_params.get('volatility_buckets', [])) if size_params.get('volatility_buckets') else 0
        print(f"  bucket counts: price={n_price}, inventory={n_inv}" + (f", volatility={n_vol}" if n_vol > 0 else ""))
        
        conditioning_vars = size_params.get('conditioning_vars', [])
        if isinstance(conditioning_vars, list):
            print(f"  conditioning_vars: {', '.join(conditioning_vars)}")
        else:
            conditioning_var = size_params.get('conditioning_var', None)
            if conditioning_var:
                print(f"  conditioning_var: {conditioning_var}")
            else:
                print(f"  conditioning_var: None (⚠️  missing inventory conditioning)")
        
        if 'side_selection_gap' in conf:
            gap = conf.get('side_selection_gap', 0)
            print(f"  side_selection_gap: {gap:.3f}" + (" (mixed mode: inventory-first tie-break)" if gap < 0.1 else ""))
    
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

