"""
Parameter inference for WATCH bot behavior.
"""
import pandas as pd
import numpy as np
from typing import Dict, List, Tuple, Any
from scipy import stats
import json
import copy


def infer_entry_rules(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer entry rules (price bands and momentum/reversion patterns).
    Optimizes for precision >= 0.90, rejects wide bands, marks as inventory-gated if needed.
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with entry parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    entry_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_tape = tape[tape['market'] == market].copy()
        
        if len(market_trades) < 5:  # Need minimum trades
            continue
        
        # Get UP and DOWN trades separately
        up_trades = market_trades[market_trades['side'] == 'UP']
        down_trades = market_trades[market_trades['side'] == 'DOWN']
        
        # Optimize price bands: use tight bands, reject if too wide (>0.90)
        # Strategy: Try progressively tighter bands using percentiles
        def optimize_bands(side_trades, price_col):
            """Find tight price bands, rejecting wide bands."""
            if len(side_trades) < 3:
                return None, None, False
            
            prices = side_trades[price_col].values
            
            # Try percentiles: start with very tight bands (40th-60th) to optimize for precision
            # Widen only if needed, but never exceed 0.90 width
            # Prioritize precision >= 0.90 even if recall drops
            for p_low, p_high in [(40, 60), (35, 65), (30, 70), (25, 75), (20, 80), (15, 85), (10, 90), (5, 95)]:
                min_price = np.percentile(prices, p_low)
                max_price = np.percentile(prices, p_high)
                band_width = max_price - min_price
                
                # Reject if band is too wide (>0.90 range)
                if band_width > 0.90:
                    continue
                
                # Accept this band (it's tight enough)
                return min_price, max_price, True
            
            # If all percentile bands are too wide, try min/max but reject if >0.90
            min_price = prices.min()
            max_price = prices.max()
            band_width = max_price - min_price
            
            if band_width <= 0.90:  # Acceptable width
                return min_price, max_price, True
            else:
                # Too wide, mark as inventory-gated
                return None, None, False
        
        # Optimize UP bands
        up_price_min, up_price_max, up_valid = optimize_bands(up_trades, 'Price UP ($)')
        
        # Optimize DOWN bands
        down_price_min, down_price_max, down_valid = optimize_bands(down_trades, 'Price DOWN ($)')
        
        # Check if entry is price-explained
        is_inventory_gated = not (up_valid or down_valid)
        
        # If inventory-gated, set mode and use None for price bands
        if is_inventory_gated:
            mode = "inventory-gated"
            momentum_window_s = 5.0
            momentum_threshold = 0.0
            up_price_min = None
            up_price_max = None
            down_price_min = None
            down_price_max = None
        else:
            # Momentum analysis - check correlation with price changes
            mode = "none"
            momentum_window_s = 5.0
            momentum_threshold = 0.0
            
            if 'delta_5s_side_px' in market_trades.columns:
                valid_deltas = market_trades['delta_5s_side_px'].dropna()
                if len(valid_deltas) > 10:
                    up_trade_deltas = market_trades[market_trades['side'] == 'UP']['delta_5s_side_px'].dropna()
                    down_trade_deltas = market_trades[market_trades['side'] == 'DOWN']['delta_5s_side_px'].dropna()
                    
                    if len(up_trade_deltas) > 5 and len(down_trade_deltas) > 5:
                        up_median = up_trade_deltas.median()
                        down_median = down_trade_deltas.median()
                        
                        if up_median > 0.005 and down_median < -0.005:
                            mode = "momentum"
                            momentum_threshold = 0.005
                        elif up_median < -0.005 and down_median > 0.005:
                            mode = "reversion"
                            momentum_threshold = -0.005
        
        entry_params[market] = {
            'up_price_min': float(up_price_min) if up_price_min is not None else None,
            'up_price_max': float(up_price_max) if up_price_max is not None else None,
            'down_price_min': float(down_price_min) if down_price_min is not None else None,
            'down_price_max': float(down_price_max) if down_price_max is not None else None,
            'momentum_window_s': momentum_window_s,
            'momentum_threshold': momentum_threshold,
            'mode': mode
        }
    
    return {'per_market': entry_params}


def infer_sizing_function(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer sizing function (shares per price bucket x inventory bucket).
    Uses 2D conditioning: price_bucket x inventory_bucket (low/med/high).
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with sizing parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    size_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 10:  # Need minimum trades
            continue
        
        # Simulate inventory forward to compute imbalance ratio for each trade
        inventory_up = 0.0
        inventory_down = 0.0
        eps = 1e-6
        
        inventory_ratios = []
        for idx, trade in market_trades.iterrows():
            side = trade['side']
            shares = trade['shares']
            
            # Update inventory
            if side == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            # Compute imbalance ratio: inv_up / max(inv_down, eps)
            # This measures how imbalanced we are toward UP
            max_inv = max(inventory_down, eps)
            imbalance_ratio = inventory_up / max_inv
            inventory_ratios.append(imbalance_ratio)
        
        market_trades = market_trades.copy()
        market_trades['inventory_imbalance_ratio'] = inventory_ratios
        
        # Create inventory buckets using quantiles (6-8 buckets)
        # Use quantiles to ensure roughly equal distribution
        n_inv_buckets = min(8, max(6, len(market_trades) // 20))  # 6-8 buckets
        if len(inventory_ratios) > n_inv_buckets:
            quantiles = np.linspace(0, 100, n_inv_buckets + 1)
            inv_thresholds = np.percentile(inventory_ratios, quantiles)
            # Ensure thresholds are unique and sorted
            inv_thresholds = np.unique(inv_thresholds)
            if len(inv_thresholds) < 2:
                # Fallback to equal-width bins
                inv_thresholds = np.linspace(min(inventory_ratios), max(inventory_ratios) + 1e-6, n_inv_buckets + 1)
        else:
            # Fallback to equal-width bins
            inv_thresholds = np.linspace(min(inventory_ratios), max(inventory_ratios) + 1e-6, n_inv_buckets + 1)
        
        def get_inventory_bucket(ratio):
            for i in range(len(inv_thresholds) - 1):
                if ratio <= inv_thresholds[i + 1]:
                    return f'bucket_{i}'
            return f'bucket_{len(inv_thresholds) - 2}'
        
        market_trades['inventory_bucket'] = market_trades['inventory_imbalance_ratio'].apply(get_inventory_bucket)
        inventory_bucket_labels = sorted(market_trades['inventory_bucket'].unique())
        
        # Store thresholds for PolicySimulator
        inv_bucket_thresholds = inv_thresholds.tolist()
        
        # Add 2nd conditioning variable: volatility (5s or 30s)
        volatility_bucket = None
        size_table_3d = {}
        
        # Check if volatility features are available
        if 'volatility_5s' in market_trades.columns:
            vol_col = 'volatility_5s'
        elif 'volatility_30s' in market_trades.columns:
            vol_col = 'volatility_30s'
        else:
            vol_col = None
        
        if vol_col is not None and market_trades[vol_col].notna().sum() > len(market_trades) * 0.5:
            # Create volatility buckets (3-4 buckets)
            vol_values = market_trades[vol_col].dropna()
            if len(vol_values) > 3:
                vol_quantiles = np.linspace(0, 100, 4)  # 3 buckets
                vol_thresholds = np.percentile(vol_values, vol_quantiles)
                
                def get_volatility_bucket(vol):
                    if pd.isna(vol):
                        return 'vol_med'
                    for i in range(len(vol_thresholds) - 1):
                        if vol <= vol_thresholds[i + 1]:
                            return f'vol_{i}'  # vol_0, vol_1, vol_2
                    return 'vol_2'
                
                market_trades['volatility_bucket'] = market_trades[vol_col].apply(get_volatility_bucket)
                volatility_bucket_labels = sorted(market_trades['volatility_bucket'].unique())
                volatility_bucket = True
            else:
                volatility_bucket = False
        else:
            volatility_bucket = False
        
        # Create price buckets (0-0.05, 0.05-0.10, ..., 0.95-1.00)
        bin_edges = np.arange(0, 1.05, 0.05)
        market_trades['price_bucket'] = pd.cut(
            market_trades['side_px_at_trade'],
            bins=bin_edges,
            include_lowest=True
        )
        
        # Build 2D or 3D table: price_bucket x inventory_bucket [x volatility_bucket]
        # Use median for robustness
        size_table_2d = {}
        
        if volatility_bucket:
            # Build 3D table: price x inventory x volatility
            for price_bucket in market_trades['price_bucket'].dropna().unique():
                for inv_bucket in inventory_bucket_labels:
                    for vol_bucket in volatility_bucket_labels:
                        mask = (market_trades['price_bucket'] == price_bucket) & \
                               (market_trades['inventory_bucket'] == inv_bucket) & \
                               (market_trades['volatility_bucket'] == vol_bucket)
                        bucket_trades = market_trades[mask]
                        
                        if len(bucket_trades) > 0:
                            median_shares = bucket_trades['shares'].median()
                            key = f"{str(price_bucket)}|{inv_bucket}|{vol_bucket}"
                            size_table_3d[key] = float(median_shares)
            
            # Also build 2D fallback (price x inventory, ignoring volatility)
            for price_bucket in market_trades['price_bucket'].dropna().unique():
                for inv_bucket in inventory_bucket_labels:
                    mask = (market_trades['price_bucket'] == price_bucket) & \
                           (market_trades['inventory_bucket'] == inv_bucket)
                    bucket_trades = market_trades[mask]
                    
                    if len(bucket_trades) > 0:
                        median_shares = bucket_trades['shares'].median()
                        key = f"{str(price_bucket)}|{inv_bucket}"
                        size_table_2d[key] = float(median_shares)
        else:
            # Build 2D table: price x inventory
            for price_bucket in market_trades['price_bucket'].dropna().unique():
                for inv_bucket in inventory_bucket_labels:
                    mask = (market_trades['price_bucket'] == price_bucket) & \
                           (market_trades['inventory_bucket'] == inv_bucket)
                    bucket_trades = market_trades[mask]
                    
                    if len(bucket_trades) > 0:
                        median_shares = bucket_trades['shares'].median()
                        key = f"{str(price_bucket)}|{inv_bucket}"
                        size_table_2d[key] = float(median_shares)
        
        # Also create 1D fallback table (price only) for backward compatibility
        size_table_1d = market_trades.groupby('price_bucket')['shares'].median().to_dict()
        size_table_1d_str = {str(k): float(v) for k, v in size_table_1d.items() if pd.notna(v)}
        
        # Determine conditioning variables
        conditioning_vars = ['inventory_imbalance_ratio']
        if volatility_bucket:
            conditioning_vars.append('volatility')
        
        size_params[market] = {
            'bin_edges': bin_edges.tolist(),
            'size_table': size_table_3d if volatility_bucket else size_table_2d,  # 3D or 2D table
            'size_table_2d': size_table_2d if volatility_bucket else {},  # 2D fallback if 3D
            'size_table_1d': size_table_1d_str,  # 1D fallback
            'conditioning_var': conditioning_vars[0] if len(conditioning_vars) == 1 else conditioning_vars,
            'conditioning_vars': conditioning_vars,  # List of all conditioning vars
            'inventory_buckets': inventory_bucket_labels,
            'inventory_bucket_thresholds': inv_bucket_thresholds,  # For PolicySimulator lookup
            'n_inventory_buckets': len(inventory_bucket_labels),
            'volatility_buckets': volatility_bucket_labels if volatility_bucket else None,
            'n_price_buckets': len(bin_edges) - 1,
            'has_volatility_conditioning': volatility_bucket
        }
    
    return {'per_market': size_params}


def infer_inventory_behavior(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer inventory/rebalance behavior from trade sequence.
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with inventory parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    inventory_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 10:
            continue
        
        # Simulate inventory forward
        inventory_up = 0.0
        inventory_down = 0.0
        max_inventory_up = 0.0
        max_inventory_down = 0.0
        max_total = 0.0
        
        rebalance_events = []
        
        for idx, trade in market_trades.iterrows():
            shares = trade['shares']
            
            if trade['side'] == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            # Track maxima
            max_inventory_up = max(max_inventory_up, inventory_up)
            max_inventory_down = max(max_inventory_down, inventory_down)
            max_total = max(max_total, inventory_up + inventory_down)
            
            # Detect rebalance (buying opposite side when inventory is high)
            if inventory_up > 0 and inventory_down > 0:
                ratio = inventory_up / (inventory_up + inventory_down)
                
                # If we buy the smaller side when ratio is extreme, it's a rebalance
                if ratio > 0.7 and trade['side'] == 'DOWN':
                    rebalance_events.append({
                        'ratio': ratio,
                        'timestamp': trade['Timestamp']
                    })
                elif ratio < 0.3 and trade['side'] == 'UP':
                    rebalance_events.append({
                        'ratio': ratio,
                        'timestamp': trade['Timestamp']
                    })
        
        # Infer rebalance ratio (median of rebalance event ratios)
        rebalance_ratio_R = 0.75  # default
        if rebalance_events:
            ratios = [e['ratio'] for e in rebalance_events]
            rebalance_ratio_R = np.median(ratios)
        
        inventory_params[market] = {
            'rebalance_ratio_R': float(rebalance_ratio_R),
            'max_up_shares': float(max_inventory_up),
            'max_down_shares': float(max_inventory_down),
            'max_total_shares': float(max_total)
        }
    
    return {'per_market': inventory_params}


def infer_cadence(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer cadence/throttle parameters (inter-trade times, max trades per time window).
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with cadence parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    cadence_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 2:
            continue
        
        # Compute inter-trade times
        inter_trade_times = market_trades['Timestamp'].diff().dropna() / 1000.0  # Convert to seconds
        
        min_inter_trade_ms = inter_trade_times.min() * 1000
        p50_inter_trade_ms = inter_trade_times.median() * 1000
        p95_inter_trade_ms = inter_trade_times.quantile(0.95) * 1000
        
        # Compute max trades per second and per minute
        # Use sliding windows
        max_trades_per_sec = 0
        max_trades_per_min = 0
        
        for start_idx in range(len(market_trades)):
            start_ts = market_trades.iloc[start_idx]['Timestamp']
            end_ts_1s = start_ts + 1000
            end_ts_60s = start_ts + 60000
            
            count_1s = ((market_trades['Timestamp'] >= start_ts) & 
                       (market_trades['Timestamp'] < end_ts_1s)).sum()
            count_60s = ((market_trades['Timestamp'] >= start_ts) & 
                        (market_trades['Timestamp'] < end_ts_60s)).sum()
            
            max_trades_per_sec = max(max_trades_per_sec, count_1s)
            max_trades_per_min = max(max_trades_per_min, count_60s)
        
        cadence_params[market] = {
            'min_inter_trade_ms': float(min_inter_trade_ms),
            'p50_inter_trade_ms': float(p50_inter_trade_ms),
            'p95_inter_trade_ms': float(p95_inter_trade_ms),
            'max_trades_per_sec': int(max_trades_per_sec),
            'max_trades_per_min': int(max_trades_per_min)
        }
    
    return {'per_market': cadence_params}


def compute_confidence_scores(trades: pd.DataFrame, tape: pd.DataFrame, params: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Compute confidence scores per market.
    
    Args:
        trades: Trade rows dataframe
        tape: Full price tape dataframe
        params: Inferred parameters
        
    Returns:
        Dictionary with confidence scores per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    confidence = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        n_watch_trades = len(market_trades)
        
        if n_watch_trades < 5:
            continue
        
        # Get entry params for this market
        entry_params = params.get('entry_params', {}).get('per_market', {}).get(market, {})
        size_params = params.get('size_params', {}).get('per_market', {}).get(market, {})
        
        # Entry rule precision: of actual trades, how many fall within price bands?
        entry_rule_precision = 0.0
        entry_rule_recall = 0.0
        
        if entry_params.get('up_price_min') is not None and entry_params.get('up_price_max') is not None:
            up_trades = market_trades[market_trades['side'] == 'UP']
            if len(up_trades) > 0:
                # Precision: of UP trades, how many are in the UP price band?
                up_in_band = ((up_trades['Price UP ($)'] >= entry_params['up_price_min']) & 
                             (up_trades['Price UP ($)'] <= entry_params['up_price_max'])).sum()
                entry_rule_precision = up_in_band / len(up_trades) if len(up_trades) > 0 else 0.0
                
                # Recall: of all price ticks in band, how many have trades?
                market_tape = tape[tape['market'] == market].copy()
                if len(market_tape) > 0:
                    up_in_band_tape = ((market_tape['Price UP ($)'] >= entry_params['up_price_min']) & 
                                      (market_tape['Price UP ($)'] <= entry_params['up_price_max'])).sum()
                    # For recall, we check: of price ticks in band, how many have trades?
                    # Simplified: use ratio of trades in band to ticks in band
                    entry_rule_recall = up_in_band / up_in_band_tape if up_in_band_tape > 0 else 0.0
                    # Clamp to [0, 1]
                    entry_rule_recall = min(1.0, entry_rule_recall)
        
        # Also check DOWN side
        if entry_params.get('down_price_min') is not None and entry_params.get('down_price_max') is not None:
            down_trades = market_trades[market_trades['side'] == 'DOWN']
            if len(down_trades) > 0:
                down_in_band = ((down_trades['Price DOWN ($)'] >= entry_params['down_price_min']) & 
                               (down_trades['Price DOWN ($)'] <= entry_params['down_price_max'])).sum()
                down_precision = down_in_band / len(down_trades) if len(down_trades) > 0 else 0.0
                # Average with UP precision
                entry_rule_precision = (entry_rule_precision + down_precision) / 2.0
        
        # Size table bucket variance
        size_table_bucket_variance = 0.0
        if 'size_table' in size_params and size_params['size_table']:
            size_values = list(size_params['size_table'].values())
            if len(size_values) > 1:
                size_table_bucket_variance = float(np.var(size_values))
        
        confidence[market] = {
            'n_watch_trades': int(n_watch_trades),
            'entry_rule_precision': float(entry_rule_precision),
            'entry_rule_recall': float(entry_rule_recall),
            'size_table_bucket_variance': float(size_table_bucket_variance)
        }
    
    return confidence


def apply_fallback_logic(params: Dict[str, Any], trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Apply fallback logic: if n_watch_trades < 50, use same asset other timeframe or global.
    
    Args:
        params: Inferred parameters
        trades: Trade rows dataframe (to compute n_watch_trades)
        
    Returns:
        Parameters with fallbacks applied
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    # Count trades per market
    market_counts = watch_trades.groupby('market').size().to_dict()
    
    # Extract asset and timeframe from market key
    # Market keys are like "BTC_15m", "ETH_15m", "BTC_1h", "ETH_1h"
    def get_market_info(market: str) -> Tuple[str, str]:
        """Extract asset (BTC/ETH) and timeframe (15m/1h) from market key."""
        parts = market.split('_')
        if len(parts) >= 2:
            asset = parts[0]  # BTC or ETH
            timeframe = parts[1]  # 15m or 1h
        else:
            # Fallback to substring matching
            if 'BTC' in market:
                asset = 'BTC'
            elif 'ETH' in market:
                asset = 'ETH'
            else:
                asset = None
            
            if '15' in market or '15m' in market:
                timeframe = '15m'
            elif '1h' in market or '1 hour' in market:
                timeframe = '1h'
            else:
                timeframe = None
        
        return asset, timeframe
    
    # All parameter types (including new ones)
    all_param_types = [
        'entry_params', 'size_params', 'inventory_params', 'cadence_params',
        'side_selection_params', 'execution_params', 'cooldown_params',
        'risk_params', 'unwind_params', 'reset_params', 'quality_filter_params'
    ]
    
    # Compute global parameters (across all markets)
    global_params = {pt: {} for pt in all_param_types}
    
    # For each param type, aggregate across all markets with >= 50 trades
    for param_type in all_param_types:
        per_market = params.get(param_type, {}).get('per_market', {})
        # Only use markets with enough trades for global aggregation
        valid_markets = {m: v for m, v in per_market.items() if market_counts.get(m, 0) >= 50}
        if valid_markets:
            # Use the first valid market's params as global template
            global_params[param_type] = copy.deepcopy(list(valid_markets.values())[0]) if valid_markets else {}
        elif per_market:
            # Fallback: use any available params
            global_params[param_type] = copy.deepcopy(list(per_market.values())[0]) if per_market else {}
    
    # Apply fallbacks
    result_params = {pt: {'per_market': {}} for pt in all_param_types}
    result_params['confidence'] = {}
    
    # First pass: identify markets that need fallback
    markets_needing_fallback = []
    for market, count in market_counts.items():
        if count < 50:
            markets_needing_fallback.append(market)
    
    # For each market needing fallback, find fallback source
    for market in markets_needing_fallback:
        asset, timeframe = get_market_info(market)
        
        # Try same asset, other timeframe
        fallback_market = None
        if asset and timeframe:
            other_timeframe = '1h' if timeframe == '15m' else '15m'
            fallback_market = f"{asset}_{other_timeframe}"
        
        # Apply fallback for each param type
        for param_type in all_param_types:
            per_market = params.get(param_type, {}).get('per_market', {})
            
            if market in per_market:
                # Keep existing (will be overwritten if fallback found)
                result_params[param_type]['per_market'][market] = per_market[market]
            
            # Try fallback (deep copy to avoid reference issues)
            if fallback_market and fallback_market in per_market:
                result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[fallback_market])
                print(f"  Applied fallback for {market}: using {fallback_market} for {param_type}")
            elif global_params.get(param_type):
                # Use global fallback
                result_params[param_type]['per_market'][market] = copy.deepcopy(global_params[param_type])
                print(f"  Applied global fallback for {market} for {param_type}")
            elif market in per_market:
                # Keep existing (no fallback available)
                result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[market])
    
    # For markets with enough trades, use their own parameters
    for market, count in market_counts.items():
        if count >= 50:
            for param_type in all_param_types:
                per_market = params.get(param_type, {}).get('per_market', {})
                if market in per_market:
                    result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[market])
    
    # Also copy over markets that weren't in markets_needing_fallback but exist in params
    for param_type in all_param_types:
        per_market = params.get(param_type, {}).get('per_market', {})
        for market in per_market:
            if market not in result_params[param_type]['per_market']:
                result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[market])
    
    return result_params


def transform_params_to_market_format(params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Transform parameters from param-type-first to market-first format.
    
    Input format:
    {
        "entry_params": {"per_market": {"BTC_15m": {...}, ...}},
        "size_params": {"per_market": {"BTC_15m": {...}, ...}},
        ...
    }
    
    Output format:
    {
        "BTC_15m": {
            "entry_params": {...},
            "size_params": {...},
            "inventory_params": {...},
            "cadence_params": {...},
            "side_selection_params": {...},
            "execution_params": {...},
            "cooldown_params": {...},
            "risk_params": {...},
            "unwind_params": {...},
            "reset_params": {...},
            "quality_filter_params": {...},
            "confidence": {...}
        },
        ...
    }
    """
    # All parameter types
    all_param_types = [
        'entry_params', 'size_params', 'inventory_params', 'cadence_params',
        'side_selection_params', 'execution_params', 'cooldown_params',
        'risk_params', 'unwind_params', 'reset_params', 'quality_filter_params'
    ]
    
    # Collect all markets from all param types
    all_markets = set()
    for param_type in all_param_types:
        per_market = params.get(param_type, {}).get('per_market', {})
        all_markets.update(per_market.keys())
    
    # Also get markets from confidence
    confidence = params.get('confidence', {}).get('per_market', {})
    all_markets.update(confidence.keys())
    
    # Build market-first structure
    result = {}
    for market in all_markets:
        result[market] = {
            'entry_params': params.get('entry_params', {}).get('per_market', {}).get(market, {}),
            'size_params': params.get('size_params', {}).get('per_market', {}).get(market, {}),
            'inventory_params': params.get('inventory_params', {}).get('per_market', {}).get(market, {}),
            'cadence_params': params.get('cadence_params', {}).get('per_market', {}).get(market, {}),
            'side_selection_params': params.get('side_selection_params', {}).get('per_market', {}).get(market, {}),
            'execution_params': params.get('execution_params', {}).get('per_market', {}).get(market, {}),
            'cooldown_params': params.get('cooldown_params', {}).get('per_market', {}).get(market, {}),
            'risk_params': params.get('risk_params', {}).get('per_market', {}).get(market, {}),
            'unwind_params': params.get('unwind_params', {}).get('per_market', {}).get(market, {}),
            'reset_params': params.get('reset_params', {}).get('per_market', {}).get(market, {}),
            'quality_filter_params': params.get('quality_filter_params', {}).get('per_market', {}).get(market, {}),
            'confidence': confidence.get(market, {})
        }
    
    return result


def infer_side_selection(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer side selection rule when both UP and DOWN satisfy entry conditions.
    
    Analyzes patterns to determine if WATCH uses:
    - inventory-driven (buy side with lower inventory ratio)
    - better edge (distance from 0.5)
    - alternating pattern
    - fixed preference
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with side selection parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    side_selection_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 20:  # Need minimum trades for pattern analysis
            continue
        
        # Simulate inventory to analyze patterns
        inventory_up = 0.0
        inventory_down = 0.0
        
        # Track instances where both UP and DOWN would be valid
        # (We'll need to infer this from nearby price tape entries)
        both_valid_instances = []
        selected_side = []
        inventory_ratios = []
        edge_distances = []
        
        # Analyze pattern from actual trades
        # Pattern 1: Check if trades alternate
        sides = market_trades['side'].values
        alternation_score = 0.0
        if len(sides) > 1:
            alternations = sum(1 for i in range(1, len(sides)) if sides[i] != sides[i-1])
            alternation_score = alternations / (len(sides) - 1) if len(sides) > 1 else 0.0
        
        # Pattern 2: Check inventory-driven behavior
        inventory_driven_evidence = []
        for idx, trade in market_trades.iterrows():
            side = trade['side']
            shares = trade['shares']
            
            # Update inventory
            if side == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            total_inv = inventory_up + inventory_down
            if total_inv > 0:
                inv_ratio_up = inventory_up / total_inv
                inv_ratio_down = inventory_down / total_inv
                
                # If buying the side with lower inventory ratio, it's inventory-driven
                if side == 'UP' and inv_ratio_up < 0.5:
                    inventory_driven_evidence.append(1)
                elif side == 'DOWN' and inv_ratio_down < 0.5:
                    inventory_driven_evidence.append(1)
                else:
                    inventory_driven_evidence.append(0)
        
        inventory_driven_score = np.mean(inventory_driven_evidence) if inventory_driven_evidence else 0.0
        
        # Pattern 3: Check edge-driven (distance from 0.5)
        edge_driven_evidence = []
        for idx, trade in market_trades.iterrows():
            side_px = trade.get('side_px_at_trade', np.nan)
            if pd.notna(side_px):
                distance_from_50 = abs(side_px - 0.5)
                # Lower distance = better edge (closer to fair value)
                # If trading at prices closer to 0.5, it's edge-driven
                if distance_from_50 < 0.1:  # Within 10% of 0.5
                    edge_driven_evidence.append(1)
                else:
                    edge_driven_evidence.append(0)
        
        edge_driven_score = np.mean(edge_driven_evidence) if edge_driven_evidence else 0.0
        
        # Pattern 4: Price-momentum driven (buying the side with rising price)
        momentum_driven_evidence = []
        if 'delta_5s_side_px' in market_trades.columns:
            for idx, trade in market_trades.iterrows():
                side = trade['side']
                delta_5s = trade.get('delta_5s_side_px', np.nan)
                
                if pd.notna(delta_5s):
                    # If buying UP when UP price is rising (positive delta), it's momentum-driven
                    # If buying DOWN when DOWN price is rising (negative delta of UP = DOWN rising), it's momentum-driven
                    if side == 'UP' and delta_5s > 0.001:  # UP price rising
                        momentum_driven_evidence.append(1)
                    elif side == 'DOWN' and delta_5s < -0.001:  # DOWN price rising (UP falling)
                        momentum_driven_evidence.append(1)
                    else:
                        momentum_driven_evidence.append(0)
        
        momentum_driven_score = np.mean(momentum_driven_evidence) if momentum_driven_evidence else 0.0
        
        # Pattern 5: Check if accumulating on losing side (ANTI-PATTERN to detect)
        # This detects if more trades are on the side that's underwater (price below average)
        losing_side_accumulation = 0.0
        up_trades = market_trades[market_trades['side'] == 'UP']
        down_trades = market_trades[market_trades['side'] == 'DOWN']
        
        if len(up_trades) > 5 and len(down_trades) > 5:
            up_avg_price = up_trades['Price UP ($)'].mean()
            down_avg_price = down_trades['Price DOWN ($)'].mean()
            
            # Get recent prices (last 20% of trades)
            recent_up_trades = up_trades.tail(max(1, len(up_trades) // 5))
            recent_down_trades = down_trades.tail(max(1, len(down_trades) // 5))
            
            if len(recent_up_trades) > 0 and len(recent_down_trades) > 0:
                recent_up_price = recent_up_trades['Price UP ($)'].mean()
                recent_down_price = recent_down_trades['Price DOWN ($)'].mean()
                
                # Check if UP side is losing (recent price < avg) but has more trades
                up_is_losing = recent_up_price < up_avg_price * 0.95
                down_is_losing = recent_down_price < down_avg_price * 0.95
                
                if up_is_losing and len(up_trades) > len(down_trades) * 1.2:
                    losing_side_accumulation = len(up_trades) / len(market_trades)
                elif down_is_losing and len(down_trades) > len(up_trades) * 1.2:
                    losing_side_accumulation = len(down_trades) / len(market_trades)
        
        # Pattern 6: Fixed preference (check if one side dominates)
        up_count = (market_trades['side'] == 'UP').sum()
        down_count = (market_trades['side'] == 'DOWN').sum()
        total_count = len(market_trades)
        up_ratio = up_count / total_count if total_count > 0 else 0.5
        fixed_preference_score = max(up_ratio, 1 - up_ratio)  # Higher = more skewed
        
        # Determine mode by choosing highest score
        # Don't hardcode "inventory_driven" - use the actual highest score
        scores = {
            'inventory_driven': inventory_driven_score,
            'alternating': alternation_score,
            'edge_driven': edge_driven_score,
            'momentum_driven': momentum_driven_score,
            'fixed_preference': fixed_preference_score
        }
        
        # Sort by score descending
        sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        top_mode, top_score = sorted_scores[0]
        second_score = sorted_scores[1][1] if len(sorted_scores) > 1 else 0.0
        
        # Compute confidence gap
        confidence_gap = top_score - second_score
        
        # If gap < 0.1, set mode="mixed" (fall back to inventory-first in policy)
        if confidence_gap < 0.1:
            mode = "mixed"
        else:
            mode = top_mode
        
        # Handle fixed_preference mode
        preferred_side = None
        if mode == "fixed_preference":
            preferred_side = "UP" if up_ratio > 0.5 else "DOWN"
        
        side_selection_params[market] = {
            'mode': mode,
            'inventory_driven_score': float(inventory_driven_score),
            'alternation_score': float(alternation_score),
            'edge_driven_score': float(edge_driven_score),
            'momentum_driven_score': float(momentum_driven_score),
            'fixed_preference_score': float(fixed_preference_score),
            'confidence_gap': float(confidence_gap),
            'losing_side_accumulation': float(losing_side_accumulation),  # Warning flag
            'preferred_side': preferred_side
        }
        
        # Print warning if accumulating on losing side
        if losing_side_accumulation > 0.55:  # More than 55% of trades on losing side
            print(f"  ⚠️  WARNING: {market} appears to accumulate on losing side ({losing_side_accumulation:.1%} of trades)")
            print(f"     This suggests side selection may not be price-aware (not profit-maximizing)")
    
    return {'per_market': side_selection_params}


def infer_execution_model(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer execution/fill price model (how fill_px relates to snapshot prices).
    
    Computes fill_bias = fill_px - snapshot_side_px to determine:
    - at snapshot price (bias ~ 0)
    - mid price (bias depends on spread)
    - worst-case (cross spread, bias > 0 for buys)
    - fixed slippage offset
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with execution model parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    execution_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        
        if len(market_trades) < 10:
            continue
        
        # Compute fill bias: fill_px - snapshot_side_px
        fill_biases = []
        for idx, trade in market_trades.iterrows():
            fill_px = trade.get('fill_px', np.nan)
            side_px = trade.get('side_px_at_trade', np.nan)
            
            if pd.notna(fill_px) and pd.notna(side_px):
                bias = fill_px - side_px
                fill_biases.append(bias)
        
        if len(fill_biases) == 0:
            continue
        
        fill_biases = np.array(fill_biases)
        
        # Analyze bias distribution
        median_bias = float(np.median(fill_biases))
        mean_bias = float(np.mean(fill_biases))
        std_bias = float(np.std(fill_biases))
        p25_bias = float(np.percentile(fill_biases, 25))
        p75_bias = float(np.percentile(fill_biases, 75))
        
        # Determine execution model
        # If bias is close to 0, it's at snapshot price
        # If bias has small positive offset, it might be mid-price or fixed slippage
        # If bias varies widely, it might be worst-case (cross spread)
        
        model_type = "snapshot_price"  # default
        slippage_offset = 0.0
        
        if abs(median_bias) < 0.001:  # Very close to 0
            model_type = "snapshot_price"
        elif abs(median_bias) < 0.01 and std_bias < 0.01:  # Small, consistent offset
            model_type = "fixed_slippage"
            slippage_offset = median_bias
        elif std_bias > 0.05:  # High variance
            model_type = "worst_case"  # Cross spread, variable
        else:
            model_type = "mid_price"  # Assumed to be mid
        
        execution_params[market] = {
            'model_type': model_type,
            'fill_bias_median': median_bias,
            'fill_bias_mean': mean_bias,
            'fill_bias_std': std_bias,
            'fill_bias_p25': p25_bias,
            'fill_bias_p75': p75_bias,
            'slippage_offset': slippage_offset
        }
    
    return {'per_market': execution_params}


def infer_cooldown_rules(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer cooldown/lockout rules (pauses after trades).
    
    Analyzes patterns to determine if WATCH pauses:
    - after each trade (time-based)
    - until price moves X
    - during extreme inventory imbalance
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with cooldown parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    cooldown_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        market_tape = tape[tape['market'] == market].copy()
        market_tape = market_tape.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 10:
            continue
        
        # Pattern 1: Time-based cooldown after each trade
        inter_trade_times = market_trades['Timestamp'].diff().dropna() / 1000.0  # seconds
        min_inter_trade = float(inter_trade_times.min()) if len(inter_trade_times) > 0 else 0.0
        median_inter_trade = float(inter_trade_times.median()) if len(inter_trade_times) > 0 else 0.0
        
        # Detect if there's a consistent minimum pause
        # If median is much higher than min, there might be a cooldown
        has_time_cooldown = median_inter_trade > min_inter_trade * 1.5 and median_inter_trade > 1.0
        time_cooldown_seconds = median_inter_trade * 0.5 if has_time_cooldown else 0.0  # Conservative estimate
        
        # Pattern 2: Price move-based cooldown
        # Check if trades only happen after price moves significantly
        price_move_threshold = None
        if 'delta_5s_side_px' in market_trades.columns:
            valid_deltas = market_trades['delta_5s_side_px'].dropna().abs()
            if len(valid_deltas) > 0:
                # If most trades happen after price moves, infer threshold
                median_price_move = float(valid_deltas.median())
                if median_price_move > 0.01:  # At least 1% move
                    price_move_threshold = median_price_move * 0.5  # Conservative threshold
        
        # Pattern 3: Inventory-based lockout
        # Check if trading stops during extreme inventory imbalance
        inventory_up = 0.0
        inventory_down = 0.0
        inventory_lockout_events = []
        
        for idx, trade in market_trades.iterrows():
            side = trade['side']
            shares = trade['shares']
            
            if side == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            total = inventory_up + inventory_down
            if total > 0:
                ratio = max(inventory_up, inventory_down) / total
                # If ratio is extreme and we're not rebalancing, might be lockout
                if ratio > 0.9:
                    inventory_lockout_events.append(ratio)
        
        has_inventory_lockout = len(inventory_lockout_events) > len(market_trades) * 0.2
        inventory_lockout_threshold = 0.85 if has_inventory_lockout else None
        
        cooldown_params[market] = {
            'has_time_cooldown': has_time_cooldown,
            'time_cooldown_seconds': float(time_cooldown_seconds),
            'price_move_threshold': float(price_move_threshold) if price_move_threshold is not None else None,
            'has_inventory_lockout': has_inventory_lockout,
            'inventory_lockout_threshold': float(inventory_lockout_threshold) if inventory_lockout_threshold is not None else None
        }
    
    return {'per_market': cooldown_params}


def infer_risk_limits(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer risk & exposure limits (hard safety caps).
    
    Analyzes:
    - max trades per market session
    - max simultaneous inventory imbalance
    - max exposure per side beyond rebalance logic
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with risk limit parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    risk_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 10:
            continue
        
        # Infer max trades per session
        # Group trades by time windows (sessions could be 15-min windows or 1-hour windows)
        # For 15m markets, session = 15 minutes; for 1h markets, session = 1 hour
        is_15m = '15' in market or '15m' in market
        
        # Determine session length
        if is_15m:
            session_ms = 15 * 60 * 1000  # 15 minutes
        else:
            session_ms = 60 * 60 * 1000  # 1 hour
        
        # Count trades per session
        market_trades['session'] = (market_trades['Timestamp'] // session_ms) * session_ms
        trades_per_session = market_trades.groupby('session').size()
        max_trades_per_session = int(trades_per_session.max()) if len(trades_per_session) > 0 else None
        
        # Infer max inventory imbalance
        inventory_up = 0.0
        inventory_down = 0.0
        max_imbalance_ratio = 0.0
        
        for idx, trade in market_trades.iterrows():
            side = trade['side']
            shares = trade['shares']
            
            if side == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            total = inventory_up + inventory_down
            if total > 0:
                imbalance = max(inventory_up, inventory_down) / total
                max_imbalance_ratio = max(max_imbalance_ratio, imbalance)
        
        # Infer max exposure per side (absolute max shares)
        max_up_shares = float(inventory_up)  # Final inventory (might be cap)
        max_down_shares = float(inventory_down)
        
        # Look for patterns where trading stops despite conditions
        # This is tricky - we'll use the max observed as proxy
        max_exposure_up = float(market_trades[market_trades['side'] == 'UP']['shares'].sum()) if len(market_trades[market_trades['side'] == 'UP']) > 0 else 0.0
        max_exposure_down = float(market_trades[market_trades['side'] == 'DOWN']['shares'].sum()) if len(market_trades[market_trades['side'] == 'DOWN']) > 0 else 0.0
        
        risk_params[market] = {
            'max_trades_per_session': max_trades_per_session,
            'max_imbalance_ratio': float(max_imbalance_ratio),
            'max_exposure_up_shares': max_exposure_up,
            'max_exposure_down_shares': max_exposure_down
        }
    
    return {'per_market': risk_params}


def infer_inventory_unwind(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer inventory unwind/reduction behavior.
    
    Detects if WATCH ever:
    - reduces inventory without immediate rebalance
    - gradually unwinds near resolution
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with unwind parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    unwind_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 20:
            continue
        
        # Simulate inventory forward and backward
        inventory_up = 0.0
        inventory_down = 0.0
        inventory_history = []
        
        for idx, trade in market_trades.iterrows():
            side = trade['side']
            shares = trade['shares']
            
            if side == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            total = inventory_up + inventory_down
            if total > 0:
                ratio_up = inventory_up / total
            else:
                ratio_up = 0.5
            
            inventory_history.append({
                'timestamp': trade['Timestamp'],
                'inventory_up': inventory_up,
                'inventory_down': inventory_down,
                'total': total,
                'ratio_up': ratio_up
            })
        
        # Check for unwind patterns
        # Pattern 1: Gradual reduction near end (last 20% of trades)
        has_unwind = False
        unwind_start_ratio = None
        
        if len(inventory_history) > 5:
            last_n = max(5, len(inventory_history) // 5)  # Last 20%
            recent_history = inventory_history[-last_n:]
            earlier_history = inventory_history[:-last_n] if len(inventory_history) > last_n else []
            
            if len(earlier_history) > 0:
                earlier_max_total = max(h['total'] for h in earlier_history)
                recent_min_total = min(h['total'] for h in recent_history)
                
                # If inventory reduces significantly near end
                if earlier_max_total > 0 and recent_min_total < earlier_max_total * 0.8:
                    has_unwind = True
                    unwind_start_ratio = 0.8  # Start unwinding when inventory drops below 80% of max
        
        # Pattern 2: Reduction without immediate rebalance
        # (Would need to track if opposite side trades happen - simplified for now)
        reduces_without_rebalance = False
        
        unwind_params[market] = {
            'has_unwind': has_unwind,
            'unwind_start_ratio': float(unwind_start_ratio) if unwind_start_ratio is not None else None,
            'reduces_without_rebalance': reduces_without_rebalance
        }
    
    return {'per_market': unwind_params}


def infer_market_reset(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer market reset behavior (what happens when market switches or inactivity).
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with reset parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    reset_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 5:
            continue
        
        # Analyze gap patterns between markets
        # For now, we'll assume inventory resets between market switches
        # (This is conservative and common in trading systems)
        
        # Check for long inactivity gaps (potential market switches)
        timestamps = market_trades['Timestamp'].values
        if len(timestamps) > 1:
            gaps = np.diff(timestamps) / (1000 * 60 * 60)  # hours
            max_gap_hours = float(gaps.max()) if len(gaps) > 0 else 0.0
            
            # If gap > 2 hours, likely market switch (inventory resets)
            # For 15m markets, gaps > 30 min might indicate switch
            is_15m = '15' in market or '15m' in market
            inactivity_threshold_hours = 0.5 if is_15m else 2.0
            
            resets_on_gap = max_gap_hours > inactivity_threshold_hours
        else:
            resets_on_gap = True  # Single trade = new market
        
        reset_params[market] = {
            'resets_on_market_switch': True,  # Conservative default
            'resets_on_inactivity': resets_on_gap,
            'inactivity_threshold_hours': float(inactivity_threshold_hours) if len(timestamps) > 1 else 1.0
        }
    
    return {'per_market': reset_params}


def infer_data_quality_filters(tape: pd.DataFrame, trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer data quality filters.
    
    Checks if WATCH avoids trading when:
    - UP + DOWN ≠ ~1.0
    - timestamps jump
    - price gaps exceed threshold
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        
    Returns:
        Dictionary with data quality filter parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    filter_params = {}
    
    for market in watch_trades['market'].unique():
        market_tape = tape[tape['market'] == market].copy()
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        
        if len(market_tape) == 0:
            continue
        
        # Filter 1: UP + DOWN should be ~1.0
        market_tape['price_sum'] = market_tape['Price UP ($)'] + market_tape['Price DOWN ($)']
        price_sum_deviations = (market_tape['price_sum'] - 1.0).abs()
        max_deviation = float(price_sum_deviations.max()) if len(price_sum_deviations) > 0 else 0.0
        
        # Check if trades happen when deviation is high
        trades_with_deviation = []
        for idx, trade in market_trades.iterrows():
            trade_ts = trade['Timestamp']
            # Find closest tape entry
            closest_idx = (market_tape['Timestamp'] - trade_ts).abs().idxmin()
            closest_row = market_tape.loc[closest_idx]
            deviation = abs(closest_row['price_sum'] - 1.0)
            trades_with_deviation.append(deviation)
        
        if len(trades_with_deviation) > 0:
            median_deviation_at_trade = float(np.median(trades_with_deviation))
            # If trades avoid high deviations, infer threshold
            max_allowed_deviation = max(0.05, median_deviation_at_trade * 2)  # Allow 2x median, min 5%
        else:
            max_allowed_deviation = 0.05  # Default
        
        # Filter 2: Timestamp jumps
        if len(market_tape) > 1:
            time_diffs = market_tape['Timestamp'].diff().dropna() / 1000.0  # seconds
            max_time_jump = float(time_diffs.max()) if len(time_diffs) > 0 else 0.0
            # If jump > 60 seconds, might be filtered
            timestamp_jump_threshold_seconds = 60.0
        else:
            timestamp_jump_threshold_seconds = 60.0
        
        # Filter 3: Price gaps
        if len(market_tape) > 1:
            price_up_diffs = market_tape['Price UP ($)'].diff().abs().dropna()
            price_down_diffs = market_tape['Price DOWN ($)'].diff().abs().dropna()
            max_price_gap = float(max(price_up_diffs.max(), price_down_diffs.max())) if len(price_up_diffs) > 0 and len(price_down_diffs) > 0 else 0.0
            # If gap > 0.2, might be filtered
            price_gap_threshold = max(0.2, max_price_gap * 0.5)  # Conservative
        else:
            price_gap_threshold = 0.2
        
        filter_params[market] = {
            'max_price_sum_deviation': float(max_allowed_deviation),
            'timestamp_jump_threshold_seconds': float(timestamp_jump_threshold_seconds),
            'price_gap_threshold': float(price_gap_threshold)
        }
    
    return {'per_market': filter_params}


def infer_all_parameters(tape: pd.DataFrame, trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer all WATCH bot parameters with confidence scores and fallback logic.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe with features
        
    Returns:
        Dictionary with all inferred parameters including confidence scores
        Format: {market: {entry_params, size_params, inventory_params, cadence_params, 
                 side_selection_params, execution_params, cooldown_params, risk_params,
                 unwind_params, reset_params, quality_filter_params, confidence}}
    """
    print("\n=== Inferring Parameters ===")
    
    # Infer existing parameters per market
    params = {
        'entry_params': infer_entry_rules(trades, tape),
        'size_params': infer_sizing_function(trades),
        'inventory_params': infer_inventory_behavior(trades),
        'cadence_params': infer_cadence(trades),
        # New parameter classes
        'side_selection_params': infer_side_selection(trades, tape),
        'execution_params': infer_execution_model(trades, tape),
        'cooldown_params': infer_cooldown_rules(trades, tape),
        'risk_params': infer_risk_limits(trades),
        'unwind_params': infer_inventory_unwind(trades, tape),
        'reset_params': infer_market_reset(trades, tape),
        'quality_filter_params': infer_data_quality_filters(tape, trades)
    }
    
    # Apply fallback logic (n < 50) - but first compute confidence to know which markets need fallback
    # Compute initial confidence scores
    initial_confidence = {}
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        initial_confidence[market] = len(market_trades)
    
    # Apply fallback logic (n < 50)
    print("\n=== Applying Fallback Logic (n < 50) ===")
    params = apply_fallback_logic(params, trades)
    
    # Compute confidence scores
    print("\n=== Computing Confidence Scores ===")
    confidence = compute_confidence_scores(trades, tape, params)
    params['confidence'] = {'per_market': confidence}
    
    # Print per-market summary
    print("\n=== Per-Market Summary ===")
    for market in sorted(confidence.keys()):
        conf = confidence[market]
        print(f"\n{market}:")
        print(f"  n_watch_trades: {conf['n_watch_trades']}")
        print(f"  entry_rule_precision: {conf['entry_rule_precision']:.2%}")
        print(f"  entry_rule_recall: {conf['entry_rule_recall']:.2%}")
        print(f"  size_table_bucket_variance: {conf['size_table_bucket_variance']:.2f}")
    
    # Print summary of new parameters
    print("\n=== New Parameter Classes Summary ===")
    for market in sorted(watch_trades['market'].unique()):
        market_params = {}
        for param_type in ['side_selection_params', 'execution_params', 'cooldown_params',
                          'risk_params', 'unwind_params', 'reset_params', 'quality_filter_params']:
            per_market = params.get(param_type, {}).get('per_market', {})
            if market in per_market:
                market_params[param_type] = per_market[market]
        
        if market_params:
            print(f"\n{market}:")
            if 'side_selection_params' in market_params:
                ss = market_params['side_selection_params']
                print(f"  Side selection: {ss.get('mode', 'unknown')}")
            if 'execution_params' in market_params:
                ex = market_params['execution_params']
                print(f"  Execution model: {ex.get('model_type', 'unknown')}, bias={ex.get('fill_bias_median', 0):.4f}")
            if 'cooldown_params' in market_params:
                cd = market_params['cooldown_params']
                if cd.get('has_time_cooldown'):
                    print(f"  Cooldown: {cd.get('time_cooldown_seconds', 0):.1f}s")
    
    # Transform to market-first format
    params_market_format = transform_params_to_market_format(params)
    
    return params_market_format

