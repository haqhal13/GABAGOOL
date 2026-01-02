"""
Model validation - compare inferred policy against actual WATCH trades.
"""
import pandas as pd
import numpy as np
from typing import Dict, List, Tuple, Any
import json


class PolicySimulator:
    """Simple policy simulator based on inferred parameters."""
    
    def __init__(self, params: Dict[str, Any]):
        self.params = params
        self.entry_params = params.get('entry_params', {}).get('per_market', {})
        self.size_params = params.get('size_params', {}).get('per_market', {})
        self.inventory_params = params.get('inventory_params', {}).get('per_market', {})
        self.cadence_params = params.get('cadence_params', {}).get('per_market', {})
        
        # State
        self.inventory_up = {}
        self.inventory_down = {}
        self.last_trade_time = {}
    
    def should_trade(self, market: str, timestamp: float, up_px: float, down_px: float, 
                    delta_5s: float = None) -> Tuple[bool, str]:
        """
        Decide if we should trade and which side.
        
        Returns:
            (should_trade, side) where side is 'UP', 'DOWN', or None
        """
        if market not in self.entry_params:
            return False, None
        
        entry = self.entry_params[market]
        
        # Check cadence (minimum inter-trade time)
        if market in self.cadence_params:
            cadence = self.cadence_params[market]
            if market in self.last_trade_time:
                time_since_last = (timestamp - self.last_trade_time[market]) / 1000.0
                if time_since_last < cadence.get('min_inter_trade_ms', 0) / 1000.0:
                    return False, None
        
        # Check entry rules
        # UP trades
        if entry.get('up_price_min') is not None and entry.get('up_price_max') is not None:
            if entry['up_price_min'] <= up_px <= entry['up_price_max']:
                # Check momentum/reversion if available
                if entry['mode'] != 'none' and delta_5s is not None:
                    if entry['mode'] == 'momentum' and delta_5s < entry['momentum_threshold']:
                        return False, None
                    if entry['mode'] == 'reversion' and delta_5s > -entry['momentum_threshold']:
                        return False, None
                
                # Check inventory limits
                if self._check_inventory(market, 'UP'):
                    return True, 'UP'
        
        # DOWN trades
        if entry.get('down_price_min') is not None and entry.get('down_price_max') is not None:
            if entry['down_price_min'] <= down_px <= entry['down_price_max']:
                # Check momentum/reversion if available
                if entry['mode'] != 'none' and delta_5s is not None:
                    # For DOWN, we'd check DOWN price delta
                    if entry['mode'] == 'momentum' and delta_5s < entry['momentum_threshold']:
                        return False, None
                    if entry['mode'] == 'reversion' and delta_5s > -entry['momentum_threshold']:
                        return False, None
                
                # Check inventory limits
                if self._check_inventory(market, 'DOWN'):
                    return True, 'DOWN'
        
        return False, None
    
    def _check_inventory(self, market: str, side: str) -> bool:
        """Check if inventory limits allow trading."""
        if market not in self.inventory_params:
            return True
        
        inv_params = self.inventory_params[market]
        
        if market not in self.inventory_up:
            self.inventory_up[market] = 0.0
            self.inventory_down[market] = 0.0
        
        current_up = self.inventory_up[market]
        current_down = self.inventory_down[market]
        total = current_up + current_down
        
        # Check max total
        if total >= inv_params.get('max_total_shares', float('inf')):
            return False
        
        # Check side-specific limits
        if side == 'UP' and current_up >= inv_params.get('max_up_shares', float('inf')):
            return False
        if side == 'DOWN' and current_down >= inv_params.get('max_down_shares', float('inf')):
            return False
        
        return True
    
    def get_size(self, market: str, side: str, side_px: float) -> float:
        """Get trade size based on price bucket x inventory bucket [x volatility bucket] (2D/3D table)."""
        if market not in self.size_params:
            return 1.0  # default
        
        size_params = self.size_params[market]
        size_table = size_params.get('size_table', {})
        
        # Find price bucket
        bin_edges = size_params.get('bin_edges', np.arange(0, 1.05, 0.05))
        bucket_idx = np.digitize(side_px, bin_edges) - 1
        bucket_idx = max(0, min(bucket_idx, len(bin_edges) - 2))
        price_bucket = pd.Interval(bin_edges[bucket_idx], bin_edges[bucket_idx + 1])
        price_bucket_str = str(price_bucket)
        
        # Get inventory bucket using quantile thresholds
        eps = 1e-6
        if market not in self.inventory_up:
            self.inventory_up[market] = 0.0
            self.inventory_down[market] = 0.0
        
        inv_up = self.inventory_up[market]
        inv_down = self.inventory_down[market]
        inventory_ratio = inv_up / max(inv_down, eps)
        
        # Determine inventory bucket using thresholds
        inv_thresholds = size_params.get('inventory_bucket_thresholds', None)
        if inv_thresholds and len(inv_thresholds) >= 2:
            inv_bucket_idx = 0
            for i in range(len(inv_thresholds) - 1):
                if inventory_ratio <= inv_thresholds[i + 1]:
                    inv_bucket_idx = i
                    break
            else:
                inv_bucket_idx = len(inv_thresholds) - 2
            inv_bucket = f'bucket_{inv_bucket_idx}'
        else:
            # Fallback to old logic if thresholds not available
            if inventory_ratio <= 0.8:
                inv_bucket = 'low'
            elif inventory_ratio <= 1.25:
                inv_bucket = 'med_low'
            elif inventory_ratio <= 2.0:
                inv_bucket = 'med_high'
            else:
                inv_bucket = 'high'
        
        # Check if 3D table (with volatility)
        has_volatility = size_params.get('has_volatility_conditioning', False)
        if has_volatility:
            # For 3D, we'd need volatility - skip for now, use 2D fallback
            size_table_2d = size_params.get('size_table_2d', {})
            key_2d = f"{price_bucket_str}|{inv_bucket}"
            if key_2d in size_table_2d:
                return size_table_2d[key_2d]
        else:
            # 2D lookup: price_bucket|inventory_bucket
            key_2d = f"{price_bucket_str}|{inv_bucket}"
            if key_2d in size_table:
                return size_table[key_2d]
        
        # Fallback 1: Try other inventory buckets for same price bucket
        inventory_buckets = size_params.get('inventory_buckets', [])
        if not inventory_buckets:
            inventory_buckets = ['bucket_0', 'bucket_1', 'bucket_2', 'bucket_3']  # Fallback
        
        for fallback_bucket in inventory_buckets:
            fallback_key = f"{price_bucket_str}|{fallback_bucket}"
            fallback_table = size_params.get('size_table_2d', size_table)
            if fallback_key in fallback_table:
                return fallback_table[fallback_key]
        
        # Fallback 2: Use 1D table if available
        size_table_1d = size_params.get('size_table_1d', {})
        if price_bucket_str in size_table_1d:
            return size_table_1d[price_bucket_str]
        
        # Fallback 3: Use median of all sizes
        if size_table:
            return np.median(list(size_table.values()))
        
        return 1.0
    
    def execute_trade(self, market: str, timestamp: float, side: str, shares: float):
        """Update inventory after trade."""
        if market not in self.inventory_up:
            self.inventory_up[market] = 0.0
            self.inventory_down[market] = 0.0
        
        if side == 'UP':
            self.inventory_up[market] += shares
        else:
            self.inventory_down[market] += shares
        
        self.last_trade_time[market] = timestamp


def simulate_policy(tape: pd.DataFrame, trades: pd.DataFrame, params: Dict[str, Any]) -> pd.DataFrame:
    """
    Simulate trading policy on the tape and generate simulated trades.
    
    Args:
        tape: Full price tape dataframe
        trades: Actual trade rows dataframe (for reference)
        params: Inferred parameters
        
    Returns:
        Dataframe with simulated trades
    """
    simulator = PolicySimulator(params)
    simulated_trades = []
    
    tape = tape.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    for market in tape['market'].unique():
        market_tape = tape[tape['market'] == market].copy()
        market_tape = market_tape.sort_values('Timestamp').reset_index(drop=True)
        
        # Get actual trades for this market for delta computation
        market_actual_trades = trades[trades['market'] == market].copy()
        
        # Compute deltas if available (simplified - would need proper computation)
        for idx, row in market_tape.iterrows():
            timestamp = row['Timestamp']
            up_px = row['Price UP ($)']
            down_px = row['Price DOWN ($)']
            
            # Get delta_5s if available (simplified)
            delta_5s = None
            if 'delta_5s_side_px' in row:
                delta_5s = row['delta_5s_side_px']
            
            should_trade, side = simulator.should_trade(market, timestamp, up_px, down_px, delta_5s)
            
            if should_trade:
                side_px = up_px if side == 'UP' else down_px
                shares = simulator.get_size(market, side, side_px)
                
                simulated_trades.append({
                    'Timestamp': timestamp,
                    'market': market,
                    'side': side,
                    'shares': shares,
                    'Price UP ($)': up_px,
                    'Price DOWN ($)': down_px,
                    'side_px_at_trade': side_px
                })
                
                simulator.execute_trade(market, timestamp, side, shares)
    
    return pd.DataFrame(simulated_trades)


def compute_validation_metrics(actual_trades: pd.DataFrame, simulated_trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Compute validation metrics comparing actual vs simulated trades.
    Returns per-market metrics.
    
    Args:
        actual_trades: Actual WATCH trades
        simulated_trades: Simulated trades from policy
        
    Returns:
        Dictionary with per-market validation metrics: {market: {recall, precision, size_mape, ...}}
    """
    actual_watch = actual_trades[actual_trades['bot'] == 'WATCH'].copy()
    
    if len(actual_watch) == 0 or len(simulated_trades) == 0:
        return {'error': 'No trades to compare'}
    
    per_market_metrics = {}
    
    # Compute metrics per market
    for market in actual_watch['market'].unique():
        market_actual = actual_watch[actual_watch['market'] == market].copy()
        market_sim = simulated_trades[simulated_trades['market'] == market].copy()
        
        if len(market_sim) == 0:
            per_market_metrics[market] = {
                'recall': 0.0,
                'precision': 0.0,
                'side_accuracy': 0.0,
                'size_mape': 0.0,
                'matched_count': 0,
                'actual_count': len(market_actual),
                'simulated_count': 0
            }
            continue
        
        market_sim = market_sim.sort_values('Timestamp').reset_index(drop=True)
        matched = []
        
        for _, actual_trade in market_actual.iterrows():
            actual_ts = actual_trade['Timestamp']
            
            # Find nearest simulated trade within ±2000ms
            time_diffs_ms = abs(market_sim['Timestamp'] - actual_ts)
            within_window = time_diffs_ms <= 2000.0
            
            if within_window.any():
                nearest_idx = time_diffs_ms[within_window].idxmin()
                sim_trade = market_sim.loc[nearest_idx]
                
                matched.append({
                    'market': market,
                    'dt_ms': float(time_diffs_ms[nearest_idx]),
                    'same_side': actual_trade['side'] == sim_trade['side'],
                    'size_ratio': sim_trade['shares'] / actual_trade['shares'] if actual_trade['shares'] > 0 else 0,
                    'actual_shares': actual_trade['shares'],
                    'sim_shares': sim_trade['shares'],
                    'fill_px_diff': abs(actual_trade.get('fill_px', 0) - sim_trade.get('side_px_at_trade', 0))
                })
        
        matched_df = pd.DataFrame(matched)
        
        if len(matched_df) > 0:
            # Recall: how many actual trades were matched
            recall = len(matched_df) / len(market_actual)
            
            # Precision: how many simulated trades matched actual
            precision = len(matched_df) / len(market_sim) if len(market_sim) > 0 else 0
            
            # Side accuracy
            side_accuracy = matched_df['same_side'].mean() if len(matched_df) > 0 else 0
            
            # Size error: Compute ONLY on matched trades (same market, same side, within ±2000ms)
            # APE = abs(predicted - actual) / max(abs(actual), eps)
            # Report as percent (multiply by 100)
            eps = 1e-6
            size_percentage_errors = []
            
            # Filter to matched trades with same side and within ±2000ms
            matched_same_side = matched_df[matched_df['same_side'] == True].copy()
            if len(matched_same_side) > 0:
                # Already filtered to ±2000ms in matching logic, but double-check
                matched_same_side = matched_same_side[matched_same_side['dt_ms'] <= 2000.0]
                
                for _, row in matched_same_side.iterrows():
                    actual_shares = row['actual_shares']
                    sim_shares = row['sim_shares']
                    
                    # Use the correct formula: abs(pred-actual) / max(abs(actual), eps)
                    ape = abs(sim_shares - actual_shares) / max(abs(actual_shares), eps)
                    size_percentage_errors.append(ape * 100)  # Convert to percent
            
            # Compute MdAPE (median) and p90 APE
            if len(size_percentage_errors) > 0:
                size_mape = float(np.median(size_percentage_errors))
                size_p90_ape = float(np.percentile(size_percentage_errors, 90))
            else:
                size_mape = 0.0
                size_p90_ape = 0.0
            
            per_market_metrics[market] = {
                'recall': float(recall),
                'precision': float(precision),
                'side_accuracy': float(side_accuracy),
                'size_mape': float(size_mape),
                'size_p90_ape': float(size_p90_ape),
                'matched_count': len(matched_df),
                'matched_same_side_count': len(matched_same_side) if len(matched_df) > 0 else 0,
                'actual_count': len(market_actual),
                'simulated_count': len(market_sim)
            }
        else:
            per_market_metrics[market] = {
                'recall': 0.0,
                'precision': 0.0,
                'side_accuracy': 0.0,
                'size_mape': 0.0,
                'size_p90_ape': 0.0,
                'matched_count': 0,
                'matched_same_side_count': 0,
                'actual_count': len(market_actual),
                'simulated_count': len(market_sim)
            }
    
    # Also compute global metrics for backward compatibility
    all_matched = []
    for market in actual_watch['market'].unique():
        market_actual = actual_watch[actual_watch['market'] == market].copy()
        market_sim = simulated_trades[simulated_trades['market'] == market].copy()
        if len(market_sim) == 0:
            continue
        market_sim = market_sim.sort_values('Timestamp').reset_index(drop=True)
        for _, actual_trade in market_actual.iterrows():
            actual_ts = actual_trade['Timestamp']
            time_diffs = abs(market_sim['Timestamp'] - actual_ts) / 1000.0
            within_window = time_diffs <= 2.0
            if within_window.any():
                nearest_idx = time_diffs[within_window].idxmin()
                sim_trade = market_sim.loc[nearest_idx]
                all_matched.append({
                    'same_side': actual_trade['side'] == sim_trade['side'],
                    'size_ratio': sim_trade['shares'] / actual_trade['shares'] if actual_trade['shares'] > 0 else 0,
                })
    
    all_matched_df = pd.DataFrame(all_matched)
    global_metrics = {}
    if len(all_matched_df) > 0:
        global_metrics = {
            'recall': float(len(all_matched_df) / len(actual_watch)),
            'precision': float(len(all_matched_df) / len(simulated_trades)) if len(simulated_trades) > 0 else 0,
            'side_accuracy': float(all_matched_df['same_side'].mean()),
            'size_mape': float((abs(all_matched_df['size_ratio'] - 1.0).mean() * 100)),
            'matched_count': len(all_matched_df),
            'actual_count': len(actual_watch),
            'simulated_count': len(simulated_trades)
        }
    else:
        global_metrics = {
            'recall': 0.0,
            'precision': 0.0,
            'side_accuracy': 0.0,
            'size_mape': 0.0,
            'matched_count': 0,
            'actual_count': len(actual_watch),
            'simulated_count': len(simulated_trades)
        }
    
    return {
        'per_market': per_market_metrics,
        'global': global_metrics
    }


def validate_model(tape: pd.DataFrame, trades: pd.DataFrame, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Main validation function.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        params: Inferred parameters (market-first format)
        
    Returns:
        Dictionary with validation results
    """
    print("\n=== Validating Model ===")
    
    # Convert params to old format for PolicySimulator (it expects param-type-first)
    params_old_format = {
        'entry_params': {'per_market': {}},
        'size_params': {'per_market': {}},
        'inventory_params': {'per_market': {}},
        'cadence_params': {'per_market': {}}
    }
    for market, market_params in params.items():
        params_old_format['entry_params']['per_market'][market] = market_params.get('entry_params', {})
        params_old_format['size_params']['per_market'][market] = market_params.get('size_params', {})
        params_old_format['inventory_params']['per_market'][market] = market_params.get('inventory_params', {})
        params_old_format['cadence_params']['per_market'][market] = market_params.get('cadence_params', {})
    
    # Simulate policy
    print("Simulating policy...")
    simulated_trades = simulate_policy(tape, trades, params_old_format)
    print(f"Generated {len(simulated_trades)} simulated trades")
    
    # Compute metrics
    metrics = compute_validation_metrics(trades, simulated_trades)
    
    # Print per-market validation metrics
    print("\n=== Per-Market Validation Metrics ===")
    per_market = metrics.get('per_market', {})
    for market in sorted(per_market.keys()):
        m = per_market[market]
        print(f"\n{market}:")
        print(f"  entry_precision: {m.get('precision', 0):.2%}")
        print(f"  entry_recall: {m.get('recall', 0):.2%}")
        print(f"  MdAPE: {m.get('size_mape', 0):.2f}%, p90 APE: {m.get('size_p90_ape', 0):.2f}%")
        print(f"  matched_count: {m.get('matched_count', 0)} / {m.get('actual_count', 0)} (same_side: {m.get('matched_same_side_count', 0)})")
    
    # Print global summary
    global_metrics = metrics.get('global', {})
    print(f"\n=== Global Validation Summary ===")
    print(f"  Recall: {global_metrics.get('recall', 0):.2%}")
    print(f"  Precision: {global_metrics.get('precision', 0):.2%}")
    print(f"  Side Accuracy: {global_metrics.get('side_accuracy', 0):.2%}")
    print(f"  Size MAPE: {global_metrics.get('size_mape', 0):.2f}%")
    
    return {
        'metrics': metrics,
        'simulated_trades': simulated_trades
    }

