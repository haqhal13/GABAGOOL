#!/usr/bin/env python3
"""
Analyze WATCH bot strategy from CSV trade data.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'src'))

import pandas as pd
import numpy as np
from load import load_all_csvs, get_trade_rows
from parse import parse_notes, add_trade_features
from features import engineer_features


def analyze_watch_strategy():
    """Analyze WATCH bot trading strategy."""
    print("=" * 80)
    print("WATCH Bot Strategy Analysis")
    print("=" * 80)
    
    # Load data
    print("\n[1/4] Loading data...")
    tape = load_all_csvs("../logs/Live prices")
    trades = get_trade_rows(tape)
    trades, unparsed = parse_notes(trades)
    trades = add_trade_features(trades)
    trades = engineer_features(tape, trades)
    
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    print(f"Total WATCH trades: {len(watch_trades)}")
    
    if len(watch_trades) == 0:
        print("No WATCH trades found!")
        return
    
    # Analyze per market
    print("\n" + "=" * 80)
    print("PER-MARKET ANALYSIS")
    print("=" * 80)
    
    for market in sorted(watch_trades['market'].unique()):
        mt = watch_trades[watch_trades['market'] == market].copy()
        mt = mt.sort_values('Timestamp').reset_index(drop=True)
        
        print(f"\n{'='*80}")
        print(f"MARKET: {market} ({len(mt)} trades)")
        print(f"{'='*80}")
        
        # ===== 1. ENTRY PATTERNS (Price Ranges) =====
        up_trades = mt[mt['side'] == 'UP']
        down_trades = mt[mt['side'] == 'DOWN']
        
        print(f"\n[ENTRY PATTERNS]")
        if len(up_trades) > 0:
            up_prices = up_trades['Price UP ($)'].values
            print(f"  UP side:")
            print(f"    Price range: [{up_prices.min():.4f}, {up_prices.max():.4f}]")
            print(f"    Price percentiles: 25th={np.percentile(up_prices, 25):.4f}, "
                  f"50th={np.percentile(up_prices, 50):.4f}, 75th={np.percentile(up_prices, 75):.4f}")
            print(f"    Count: {len(up_trades)} trades")
        
        if len(down_trades) > 0:
            down_prices = down_trades['Price DOWN ($)'].values
            print(f"  DOWN side:")
            print(f"    Price range: [{down_prices.min():.4f}, {down_prices.max():.4f}]")
            print(f"    Price percentiles: 25th={np.percentile(down_prices, 25):.4f}, "
                  f"50th={np.percentile(down_prices, 50):.4f}, 75th={np.percentile(down_prices, 75):.4f}")
            print(f"    Count: {len(down_trades)} trades")
        
        # ===== 2. INVENTORY MANAGEMENT =====
        print(f"\n[INVENTORY MANAGEMENT]")
        inv_up = 0.0
        inv_down = 0.0
        inventory_history = []
        rebalance_events = []
        
        for idx, trade in mt.iterrows():
            side = trade['side']
            shares = trade['shares']
            side_px = trade.get('side_px_at_trade', 
                               trade.get('Price UP ($)', 0) if side == 'UP' else trade.get('Price DOWN ($)', 0))
            
            # Update inventory
            if side == 'UP':
                inv_up += shares
            else:
                inv_down += shares
            
            total = inv_up + inv_down
            if total > 0:
                inv_ratio_up = inv_up / total
                inv_ratio_down = inv_down / total
                
                # Check for rebalance (buying opposite side when imbalanced)
                if idx > 0:
                    prev_total = inventory_history[-1]['inv_up'] + inventory_history[-1]['inv_down']
                    if prev_total > 0:
                        prev_ratio = inventory_history[-1]['inv_up'] / prev_total
                        # Rebalance: buying opposite side when ratio > 0.7 or < 0.3
                        if prev_ratio > 0.7 and side == 'DOWN':
                            rebalance_events.append({'idx': idx, 'type': 'rebalance_down', 'prev_ratio': prev_ratio})
                        elif prev_ratio < 0.3 and side == 'UP':
                            rebalance_events.append({'idx': idx, 'type': 'rebalance_up', 'prev_ratio': prev_ratio})
                
                inventory_history.append({
                    'idx': idx,
                    'side': side,
                    'shares': shares,
                    'side_px': side_px,
                    'inv_up': inv_up,
                    'inv_down': inv_down,
                    'inv_ratio': inv_ratio_up,
                    'total': total
                })
        
        if len(inventory_history) > 0:
            df_inv = pd.DataFrame(inventory_history)
            
            final_ratio = df_inv['inv_ratio'].iloc[-1]
            avg_ratio = df_inv['inv_ratio'].mean()
            ratio_std = df_inv['inv_ratio'].std()
            min_ratio = df_inv['inv_ratio'].min()
            max_ratio = df_inv['inv_ratio'].max()
            
            print(f"  Final inventory: UP={inv_up:.2f}, DOWN={inv_down:.2f}, Total={inv_up+inv_down:.2f}")
            print(f"  Final ratio (UP/Total): {final_ratio:.2%}")
            print(f"  Ratio stats: avg={avg_ratio:.2%}, std={ratio_std:.2%}, range=[{min_ratio:.2%}, {max_ratio:.2%}]")
            print(f"  Rebalance events: {len(rebalance_events)} ({len(rebalance_events)/len(mt):.1%} of trades)")
            
            # Check if inventory stays balanced
            balanced_count = ((df_inv['inv_ratio'] >= 0.4) & (df_inv['inv_ratio'] <= 0.6)).sum()
            print(f"  Trades while balanced (40-60%): {balanced_count} ({balanced_count/len(df_inv):.1%})")
        
        # ===== 3. SIZE vs INVENTORY RELATIONSHIP =====
        print(f"\n[SIZE vs INVENTORY RELATIONSHIP]")
        if len(inventory_history) > 0:
            df_inv = pd.DataFrame(inventory_history)
            mt_with_inv = mt.copy()
            mt_with_inv['inv_ratio'] = df_inv['inv_ratio'].values
            
            # Size correlation with inventory ratio
            size_inv_corr = mt_with_inv['shares'].corr(mt_with_inv['inv_ratio'])
            print(f"  Size vs inventory ratio correlation: {size_inv_corr:.3f}")
            
            # Size by inventory bucket
            mt_with_inv['inv_bucket'] = pd.cut(mt_with_inv['inv_ratio'], 
                                              bins=[0, 0.3, 0.4, 0.6, 0.7, 1.0], 
                                              labels=['very_low', 'low', 'balanced', 'high', 'very_high'])
            size_by_inv = mt_with_inv.groupby('inv_bucket')['shares'].agg(['mean', 'median', 'count'])
            print(f"  Average size by inventory bucket:")
            for bucket, row in size_by_inv.iterrows():
                if pd.notna(bucket) and row['count'] > 0:
                    print(f"    {bucket}: mean={row['mean']:.2f}, median={row['median']:.2f}, n={int(row['count'])}")
        
        # ===== 4. SIDE SELECTION PATTERNS =====
        print(f"\n[SIDE SELECTION PATTERNS]")
        
        # Alternation
        sides = mt['side'].values
        alternations = sum(1 for i in range(1, len(sides)) if sides[i] != sides[i-1])
        alternation_rate = alternations / (len(sides) - 1) if len(sides) > 1 else 0
        print(f"  Alternation rate: {alternation_rate:.2%} (higher = more alternating)")
        
        # Inventory-driven (buying side with lower inventory)
        inv_driven_count = 0
        if len(inventory_history) > 0:
            df_inv = pd.DataFrame(inventory_history)
            for i in range(len(df_inv)):
                if i > 0:
                    prev_ratio = df_inv['inv_ratio'].iloc[i-1]
                    curr_side = df_inv['side'].iloc[i]
                    # Buying side with lower ratio
                    if prev_ratio < 0.5 and curr_side == 'UP':
                        inv_driven_count += 1
                    elif prev_ratio > 0.5 and curr_side == 'DOWN':
                        inv_driven_count += 1
            
            inv_driven_rate = inv_driven_count / (len(df_inv) - 1) if len(df_inv) > 1 else 0
            print(f"  Inventory-driven rate: {inv_driven_rate:.2%} (buying lower-inventory side)")
        
        # Price-momentum (if delta available)
        if 'delta_5s_side_px' in mt.columns:
            momentum_count = 0
            valid_deltas = 0
            for idx, trade in mt.iterrows():
                delta = trade.get('delta_5s_side_px', np.nan)
                if pd.notna(delta):
                    valid_deltas += 1
                    side = trade['side']
                    # UP trades when UP price rising, DOWN trades when DOWN price rising
                    if (side == 'UP' and delta > 0.001) or (side == 'DOWN' and delta < -0.001):
                        momentum_count += 1
            
            if valid_deltas > 0:
                momentum_rate = momentum_count / valid_deltas
                print(f"  Momentum-driven rate: {momentum_rate:.2%} (buying side with rising price, {valid_deltas} trades with delta data)")
        
        # ===== 5. SIZE vs PRICE RELATIONSHIP =====
        print(f"\n[SIZE vs PRICE RELATIONSHIP]")
        if 'side_px_at_trade' in mt.columns:
            size_price_corr = mt['shares'].corr(mt['side_px_at_trade'])
            print(f"  Size vs price correlation: {size_price_corr:.3f}")
            
            # Size by price buckets
            price_buckets = pd.cut(mt['side_px_at_trade'], bins=10, labels=False)
            mt['price_bucket'] = price_buckets
            size_by_price = mt.groupby('price_bucket')['shares'].agg(['mean', 'median', 'count'])
            print(f"  Average size by price bucket (10 buckets):")
            for bucket, row in size_by_price.head(5).iterrows():
                if pd.notna(bucket) and row['count'] > 0:
                    bucket_min = mt[mt['price_bucket'] == bucket]['side_px_at_trade'].min()
                    bucket_max = mt[mt['price_bucket'] == bucket]['side_px_at_trade'].max()
                    print(f"    [{bucket_min:.3f}-{bucket_max:.3f}]: mean={row['mean']:.2f}, n={int(row['count'])}")
        
        # ===== 6. TRADE TIMING PATTERNS =====
        print(f"\n[TRADE TIMING PATTERNS]")
        if 'time_since_last_trade_ms' in mt.columns:
            inter_trade_times = mt['time_since_last_trade_ms'].dropna() / 1000.0  # seconds
            if len(inter_trade_times) > 0:
                print(f"  Inter-trade time: min={inter_trade_times.min():.1f}s, "
                      f"median={inter_trade_times.median():.1f}s, "
                      f"p95={inter_trade_times.quantile(0.95):.1f}s")
        
        # ===== SUMMARY =====
        print(f"\n[STRATEGY SUMMARY FOR {market}]")
        print(f"  1. Entry: Trades within price ranges (UP: [{up_prices.min():.3f}, {up_prices.max():.3f}], "
              f"DOWN: [{down_prices.min():.3f}, {down_prices.max():.3f}])")
        print(f"  2. Inventory: Maintains balance (avg ratio: {avg_ratio:.1%}, rebalances: {len(rebalance_events)} times)")
        if abs(size_inv_corr) > 0.2:
            print(f"  3. Sizing: {'Positively' if size_inv_corr > 0 else 'Negatively'} correlated with inventory ({size_inv_corr:.3f})")
        else:
            print(f"  3. Sizing: Weak correlation with inventory ({size_inv_corr:.3f})")
        print(f"  4. Side selection: {('Alternating' if alternation_rate > 0.6 else 'Inventory-driven' if inv_driven_rate > 0.6 else 'Mixed')} pattern")


if __name__ == "__main__":
    analyze_watch_strategy()
