#!/usr/bin/env python3
"""Precompute the FCN Streak Illusion explorer grid.

Runs the *paper's own engine* (fcn_core from the "When Winning Streaks
Mislead" reproducibility package) over a knock-in-barrier x horizon grid and
writes derived aggregates to static/experiments/fcn/grid.json.

Faithfulness rules:
  * The settlement/reinvestment code is imported from the paper unmodified;
    only the module-level KI constant is swept. KI=0.60 is the paper's
    published configuration and is validated against its published numbers
    (2y no-Scenario-D rate 56.8%; 5y median +23.9%, 5th percentile -68.3%)
    before anything is written. Other barriers are an extension on the same
    engine.
  * Output contains ONLY derived aggregates (rates, quantiles, histograms,
    per-start-month event fractions) -- never the underlying price series.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

PAPER_CODE = Path.home() / "codex-projects/openclaw-notes/fcn-no-survey-v2/code"
sys.path.insert(0, str(PAPER_CODE))
import fcn_core  # noqa: E402  (the paper's engine)

BARRIERS = [0.50, 0.55, 0.60, 0.65, 0.70]
HORIZONS = {"2y": 504, "5y": 1260}
START_STEP = 21  # monthly, as in the paper's fixed-horizon summaries
HIST_BINS = np.arange(-1.0, 1.55, 0.05)

# Published anchors for KI=0.60 (paper README / VALIDATION_REPORT).
ANCHOR = {"no_d_2y": 0.568, "median_5y": 0.239, "p5_5y": -0.683}
TOL = 0.005


def run_point(prices, baskets, ki: float, horizon: int):
    fcn_core.KI = ki  # contract() reads the module global at call time
    returns, no_d, starts = [], [], []
    for start in range(0, len(prices) - horizon, START_STEP):
        for columnsns in baskets:
            records = fcn_core.calendar_path(prices, columnsns, start, horizon)
            if records is None or not records:
                continue
            wealth = float(np.prod([1.0 + r["pnl"] for r in records]))
            returns.append(wealth - 1.0)
            no_d.append(not any(r["outcome"] == "D" for r in records))
            starts.append(start)
    return np.asarray(returns), np.asarray(no_d), np.asarray(starts)


def main() -> int:
    import itertools

    tickers, _, prices, dates, _ = fcn_core.load_prices(PAPER_CODE / "prices.csv")
    baskets = list(itertools.combinations(range(len(tickers)), 3))
    out = {"tickers": tickers, "n_baskets": len(baskets), "start_step": START_STEP,
           "strike": fcn_core.STK, "coupon": fcn_core.COUP, "tenor_days": fcn_core.TENOR,
           "barriers": BARRIERS, "horizons": {}, "grid": {}}

    for hname, horizon in HORIZONS.items():
        out["horizons"][hname] = horizon
        for ki in BARRIERS:
            returns, no_d, starts = run_point(prices, baskets, ki, horizon)
            key = f"{hname}:{ki:.2f}"
            hist, _ = np.histogram(np.clip(returns, -0.999, 1.499), bins=HIST_BINS)
            # Per-start-month fraction of baskets that saw >=1 delivery.
            frac = {}
            for s in np.unique(starts):
                mask = starts == s
                frac[dates[int(s)].isoformat()] = round(1.0 - float(no_d[mask].mean()), 4)
            out["grid"][key] = {
                "n_paths": int(len(returns)),
                "no_d_rate": round(float(no_d.mean()), 4),
                "ret_median": round(float(np.median(returns)), 4),
                "ret_mean": round(float(returns.mean()), 4),
                "ret_p5": round(float(np.percentile(returns, 5)), 4),
                "ret_p25": round(float(np.percentile(returns, 25)), 4),
                "ret_p75": round(float(np.percentile(returns, 75)), 4),
                "ret_worst": round(float(returns.min()), 4),
                "pct_positive": round(float((returns > 0).mean()), 4),
                "hist_edges": [round(float(x), 2) for x in HIST_BINS],
                "hist_counts": [int(x) for x in hist],
                "timeline": frac,
            }
            print(f"{key}: n={len(returns)} noD={no_d.mean():.3f} "
                  f"med={np.median(returns):+.3f} p5={np.percentile(returns, 5):+.3f}",
                  flush=True)

    # Validate the paper's configuration before writing anything.
    p60_2y = out["grid"]["2y:0.60"]
    p60_5y = out["grid"]["5y:0.60"]
    checks = [
        ("2y no-D", p60_2y["no_d_rate"], ANCHOR["no_d_2y"]),
        ("5y median", p60_5y["ret_median"], ANCHOR["median_5y"]),
        ("5y p5", p60_5y["ret_p5"], ANCHOR["p5_5y"]),
    ]
    for name, got, want in checks:
        if abs(got - want) > TOL:
            print(f"VALIDATION FAILED: {name} got {got} want {want}", file=sys.stderr)
            return 1
    print("validation vs published paper numbers: PASS")

    # Streak conditional probabilities come straight from the paper's data file.
    streak = json.load(open(PAPER_CODE / "streak_diagnostic_data.json"))
    out["streak_d_within_1y"] = streak.get("D_within_1y_given_streak")
    out["streak_methodology"] = streak.get("methodology")

    dest = Path(__file__).resolve().parent.parent / "static/experiments/fcn/grid.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
