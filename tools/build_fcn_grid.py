#!/usr/bin/env python3
"""Precompute the FCN Streak Illusion explorer data.

Runs the *paper's own engine* (fcn_core from the "When Winning Streaks
Mislead" reproducibility package) — via the bit-identical vectorized
re-implementation in fcn_fast.py — over a grid of note terms, and writes
derived aggregates to static/experiments/fcn/:

  index.json         every grid point's summary + per-note stats (loaded first)
  points/<key>.json  histogram + delivery timeline for one point (lazy-loaded)
  streak.json        written separately by build_fcn_streak.py (slow)

Faithfulness rules — the gate refuses to write anything unless ALL pass:
  * Oracle parity: at the paper's terms, fcn_fast reproduces
    fcn_core.summarize_fixed_horizon exactly (every path return, no-D flag and
    start, both horizons) — the paper engine stays the source of truth.
  * Published anchors at the paper's terms (KI 60%, strike 80%, 63-day tenor,
    autocall from day 21): 2y no-Scenario-D rate 56.8%; 5y median +23.9%,
    5th percentile -68.3%; per-note worst-of-3 P(D) and N equal the paper's
    empirical_data.json exactly.
  * streak.json exists and was produced by build_fcn_streak.py's own gate.
  Every other barrier / strike / tenor / autocall start is an extension on
  the same engine, labelled as such on the page.
  * Output contains ONLY derived aggregates (rates, quantiles, histograms,
    per-start-month event fractions, per-name shares) — never price series.

Run: python3 build_fcn_streak.py && python3 build_fcn_grid.py   (numpy env)
"""
from __future__ import annotations

import hashlib
import itertools
import json
import shutil
import sys
from pathlib import Path

import numpy as np

import paper_bridge as pb
from paper_bridge import fcn_core
import fcn_fast as ff

BARRIERS = [0.50, 0.55, 0.60, 0.65, 0.70]
STRIKES = [0.80, 0.90, 1.00]
TENORS = [63, 126]
KOSTARTS = [21, 42]
HORIZONS = {"2y": 504, "5y": 1260}
START_STEP = 21  # monthly, as in the paper's fixed-horizon summaries
NOTE_STEP = 5    # per-note pool, as in the paper's backtest.pool
HIST_BINS = np.arange(-1.0, 1.55, 0.05)

# Published anchors for the paper's terms (paper README / VALIDATION_REPORT).
ANCHOR = {"no_d_2y": 0.568, "median_5y": 0.239, "p5_5y": -0.683}
TOL = 0.005

OUT = Path(__file__).resolve().parent.parent / "static/experiments/fcn"


def cfg_key(t: ff.Terms) -> str:
    return f"{t.ki:.2f}|{t.strike:.2f}|{t.tenor}|{t.kostart}"


def file_key(h: str, t: ff.Terms) -> str:
    return f"{h}_ki{round(t.ki * 100):03d}_k{round(t.strike * 100):03d}_t{t.tenor:03d}_a{t.kostart:03d}"


def short_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def summarize(ret, nod, starts, dates):
    hist, _ = np.histogram(np.clip(ret, -0.999, 1.499), bins=HIST_BINS)
    frac = {}
    for s in np.unique(starts):
        m = starts == s
        frac[dates[int(s)].isoformat()] = round(1.0 - float(nod[m].mean()), 4)
    summary = {
        "n_paths": int(len(ret)),
        "no_d_rate": round(float(nod.mean()), 4),
        "ret_median": round(float(np.median(ret)), 4),
        "ret_mean": round(float(ret.mean()), 4),
        "ret_p5": round(float(np.percentile(ret, 5)), 4),
        "ret_p25": round(float(np.percentile(ret, 25)), 4),
        "ret_p75": round(float(np.percentile(ret, 75)), 4),
        "ret_worst": round(float(ret.min()), 4),
        "pct_positive": round(float((ret > 0).mean()), 4),
    }
    detail = {"hist_edges": [round(float(x), 2) for x in HIST_BINS],
              "hist_counts": [int(x) for x in hist], "timeline": frac}
    return summary, detail


def main() -> int:
    pb.assert_paper_defaults()
    tickers, _, prices, dates, _ = fcn_core.load_prices(pb.PAPER_CODE / "prices.csv")
    baskets = list(itertools.combinations(range(len(tickers)), 3))
    paper = ff.Terms()

    # ---- Gate 1: oracle parity at the paper's terms (bit-identical) ----
    st_paper = ff.settle_all(prices, baskets, paper)
    for h, horizon in HORIZONS.items():
        mine = ff.calendar_paths(st_paper, len(prices), paper.tenor, horizon, START_STEP)
        ref = fcn_core.summarize_fixed_horizon(prices, baskets, horizon=horizon, start_step=START_STEP)
        for i, name in enumerate(("returns", "no_d", "starts")):
            if not np.array_equal(mine[i], ref[name]):
                print(f"GATE FAILED: fcn_fast {name} != fcn_core at paper terms, {h}", file=sys.stderr)
                return 1
    print("gate 1: fcn_fast == fcn_core at paper terms, 2y and 5y (bit-identical)")

    # ---- Grid ----
    index = {"version": 2, "tickers": tickers, "n_baskets": len(baskets), "start_step": START_STEP,
             "note_step": NOTE_STEP, "coupon": paper.coupon, "ko": ff.KO,
             "dims": {"h": list(HORIZONS), "ki": BARRIERS, "k": STRIKES, "t": TENORS, "a": KOSTARTS},
             "paper": {"ki": paper.ki, "k": paper.strike, "t": paper.tenor, "a": paper.kostart},
             "points": {}, "notes": {}}
    details = {}
    for ki, k, t, a in itertools.product(BARRIERS, STRIKES, TENORS, KOSTARTS):
        terms = ff.Terms(ki=ki, strike=k, tenor=t, kostart=a)
        st = ff.settle_all(prices, baskets, terms)
        _, fin, worst = ff.pooled_notes(st, NOTE_STEP)
        rows = np.arange(0, st.outcome.shape[0], NOTE_STEP)
        d_mask = (st.outcome[rows] == ff.D) & fin
        share = np.zeros(len(tickers))
        for b, cols in enumerate(baskets):
            w = worst[d_mask[:, b], b]
            np.add.at(share, np.asarray(cols)[w], 1)
        n_notes, n_d = int(fin.sum()), int(d_mask.sum())
        index["notes"][cfg_key(terms)] = {
            "n": n_notes, "n_d": n_d, "pd": round(n_d / n_notes, 4),
            "worst_share": [round(float(x / n_d), 4) if n_d else 0.0 for x in share]}
        for h, horizon in HORIZONS.items():
            ret, nod, starts, _, _ = ff.calendar_paths(st, len(prices), t, horizon, START_STEP)
            summary, detail = summarize(ret, nod, starts, dates)
            fk = file_key(h, terms)
            details[fk] = detail
            index["points"][f"{h}|{cfg_key(terms)}"] = dict(summary, file=f"points/{fk}.json")
        print(f"{cfg_key(terms)}: P(D) note {n_d / n_notes:.3f} | "
              f"2y noD {index['points']['2y|' + cfg_key(terms)]['no_d_rate']:.3f} | "
              f"5y med {index['points']['5y|' + cfg_key(terms)]['ret_median']:+.3f}", flush=True)

    # ---- Gate 2: published anchors at the paper's terms ----
    p2, p5 = index["points"]["2y|" + cfg_key(paper)], index["points"]["5y|" + cfg_key(paper)]
    for name, got, want in (("2y no-D", p2["no_d_rate"], ANCHOR["no_d_2y"]),
                            ("5y median", p5["ret_median"], ANCHOR["median_5y"]),
                            ("5y p5", p5["ret_p5"], ANCHOR["p5_5y"])):
        if abs(got - want) > TOL:
            print(f"VALIDATION FAILED: {name} got {got} want {want}", file=sys.stderr)
            return 1
    emp = json.load(open(pb.PAPER_CODE / "empirical_data.json"))["worst"]
    note = index["notes"][cfg_key(paper)]
    if note["n"] != emp["n"] or note["n_d"] / note["n"] != emp["pD"]:
        print(f"VALIDATION FAILED: per-note P(D) {note} vs paper {emp['pD']} n={emp['n']}", file=sys.stderr)
        return 1
    print("gate 2: published anchors PASS (2y no-D, 5y median, 5y p5; per-note P(D) exact)")

    # ---- Gate 3: streak.json from build_fcn_streak.py ----
    streak_path = OUT / "streak.json"
    if not streak_path.exists():
        print("GATE FAILED: run build_fcn_streak.py first", file=sys.stderr)
        return 1
    index["streak"] = {"file": "streak.json", "v": short_hash(streak_path.read_bytes())}
    pb.assert_paper_defaults()

    # ---- Write (only after every gate) ----
    pts = OUT / "points"
    if pts.exists():
        shutil.rmtree(pts)
    pts.mkdir(parents=True)
    for point in index["points"].values():
        fk = Path(point["file"]).stem
        data = json.dumps(details[fk], separators=(",", ":")).encode()
        (pts / f"{fk}.json").write_bytes(data)
        point["v"] = short_hash(data)
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    legacy = OUT / "grid.json"
    if legacy.exists():
        legacy.unlink()          # superseded by index.json + points/
    size = sum(f.stat().st_size for f in OUT.rglob("*.json"))
    print(f"wrote {OUT}/index.json + {len(index['points'])} point files ({size / 1024:.0f} KB total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
