#!/usr/bin/env python3
"""Parity test: tools/fcn_fast.py must reproduce the paper engine bit-for-bit.

Oracle = the paper's own code, unmodified: fcn_core.summarize_fixed_horizon
(window returns / no-D flags / starts, in iteration order) and backtest.pool
(per-note pooled P(D) and N).  Every array is compared with exact equality.

Usage: test_fcn_fast.py            # all 120 configurations the page offers (60 terms x 2 horizons)
       test_fcn_fast.py --quick    # paper terms only
"""
from __future__ import annotations

import itertools
import sys
import time

import numpy as np

import paper_bridge as pb
from paper_bridge import fcn_core
import fcn_fast as ff

BARRIERS = [0.50, 0.55, 0.60, 0.65, 0.70]
STRIKES = [0.80, 0.90, 1.00]
TENORS = [63, 126]
KOSTARTS = [21, 42]


def check(terms: ff.Terms, horizon: int, prices, baskets, bt) -> list[str]:
    errs = []
    st = ff.settle_all(prices, baskets, terms)
    ret, nod, starts, _, _ = ff.calendar_paths(st, len(prices), terms.tenor, horizon, 21)
    with pb.terms(KI=terms.ki, STK=terms.strike, TENOR=terms.tenor, KOSTART=terms.kostart):
        ref = fcn_core.summarize_fixed_horizon(prices, baskets, horizon=horizon, start_step=21)
        bt["TENOR"] = terms.tenor                     # backtest bound TENOR by name
        try:
            pooled = bt["pool"](prices, baskets)
        finally:
            bt["TENOR"] = pb.PAPER_TERMS["TENOR"]
    for name, mine, theirs in (("returns", ret, ref["returns"]), ("no_d", nod, ref["no_d"]),
                               ("starts", starts, ref["starts"])):
        if mine.shape != theirs.shape or not np.array_equal(mine, theirs):
            if mine.shape != theirs.shape:
                diff = f"shape {mine.shape} vs {theirs.shape}"
            elif mine.dtype == bool:
                diff = f"{int((mine != theirs).sum())} flags differ"
            else:
                diff = f"max |diff| {np.max(np.abs(mine.astype(float) - theirs.astype(float)))}"
            errs.append(f"{name} differs ({diff})")
    out, fin, _ = ff.pooled_notes(st)
    n, n_d = int(fin.sum()), int((out == ff.D).sum())
    if n != pooled["n"] or n_d / n != pooled["pD"]:
        errs.append(f"pool differs: mine n={n} pD={n_d / n!r} paper n={pooled['n']} pD={pooled['pD']!r}")
    return errs


def main() -> int:
    quick = "--quick" in sys.argv
    pb.assert_paper_defaults()
    tickers, _, prices, _, _ = fcn_core.load_prices(pb.PAPER_CODE / "prices.csv")
    baskets = list(itertools.combinations(range(len(tickers)), 3))
    bt = pb.backtest_defs()
    if quick:
        cases = [(ff.Terms(), 504), (ff.Terms(), 1260)]
    else:   # every configuration the page offers: 60 term combinations x both horizons
        cases = [(ff.Terms(ki=ki, strike=k, tenor=t, kostart=a), horizon)
                 for horizon in (504, 1260)
                 for ki, k, t, a in itertools.product(BARRIERS, STRIKES, TENORS, KOSTARTS)]
    failed = 0
    t0 = time.time()
    for terms, horizon in cases:
        errs = check(terms, horizon, prices, baskets, bt)
        tag = f"KI={terms.ki:.2f} K={terms.strike:.2f} T={terms.tenor} AC={terms.kostart} H={horizon}"
        if errs:
            failed += 1
            print(f"FAIL {tag}: " + "; ".join(errs), flush=True)
        else:
            print(f"ok   {tag}", flush=True)
    pb.assert_paper_defaults()
    print(f"{len(cases) - failed}/{len(cases)} cases bit-identical ({time.time() - t0:.0f}s)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
