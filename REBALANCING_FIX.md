# Rebalancing Logic Fix

## Problem

Paper mode was doing **even 50/50 trades** (40 UP / 40 DOWN, 45 UP / 45 DOWN), but watch mode shows **skewed allocation toward winning side**:
- When UP is winning: 55.9% UP / 44.1% DOWN
- When DOWN is winning: 32.8% UP / 67.2% DOWN

## Root Cause

The rebalancing logic was **too strict** - it prevented accumulation on the winning side:
- If UP ratio > R (0.75) and we want to buy UP, it switched to DOWN
- This forced 50/50 distribution instead of allowing natural accumulation

## Fix

Changed rebalancing to be **less strict**:
- Only rebalance if ratio is **EXTREME** (> R + 0.1 = 0.85)
- Allow accumulation up to R (0.75) on either side
- This matches watch mode behavior where winning side can accumulate up to ~75%

## What This Means

- Paper mode can now accumulate more shares on the winning side (up to 75%)
- Matches watch mode's behavior of favoring the winning side
- Still prevents extreme skew (> 85%) for risk management

## Testing

After restart, you should see:
- ✅ Uneven trade distribution (not exactly 50/50)
- ✅ More trades on the side that's currently winning (based on live prices)
- ✅ Portfolio allocation skewing toward winning side (like watch mode)
