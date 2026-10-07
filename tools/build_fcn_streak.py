#!/usr/bin/env python3
"""Streak-illusion data for the explorer, per knock-in barrier.

Re-runs the working paper's own streak diagnostic (``build_dataset`` and
``conditional_table`` from streak_diagnostic.py, loaded read-only through
paper_bridge) once per barrier; every other term stays at the paper's
configuration.  Gate: at KI=0.60 the conditional table must equal the paper's
published streak_diagnostic_data.json exactly, or nothing is written.

Uncertainty: calendar-year block bootstrap (resample whole note-start years
with replacement), the same scheme as the paper's bootstrap.py.  Windows in
adjacent years still overlap, so these percentile bands are a descriptive,
dependence-aware sensitivity check — not exact confidence intervals.

Output: static/experiments/fcn/streak.json (derived aggregates only).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

import paper_bridge as pb

BARRIERS = [0.50, 0.55, 0.60, 0.65, 0.70]
EXACT_MAX = 11            # bars 0..11 shown individually, then one pooled "12+" bar
B_REPS = 2000
SEED = 20261006
HETERO_MIN_N = 200        # per-length rates inside "12+" reported only for lengths with n >= 200


def label_of(q: int) -> str:
    return str(q) if q <= EXACT_MAX else f"{EXACT_MAX + 1}+"


def bootstrap(rows_year, rows_label, rows_event, labels, rng):
    years = np.unique(rows_year)
    yi = np.searchsorted(years, rows_year)
    li = np.asarray([labels.index(x) for x in rows_label])
    n = np.zeros((len(years), len(labels)))
    e = np.zeros((len(years), len(labels)))
    np.add.at(n, (yi, li), 1)
    np.add.at(e, (yi, li), rows_event)
    draws = rng.integers(0, len(years), size=(B_REPS, len(years)))
    w = np.zeros((B_REPS, len(years)))
    np.add.at(w, (np.repeat(np.arange(B_REPS), len(years)), draws.ravel()), 1)
    nb, eb = w @ n, w @ e
    with np.errstate(invalid="ignore", divide="ignore"):
        p = eb / nb
        base = eb.sum(1) / nb.sum(1)
    lo, hi = np.nanpercentile(p, [2.5, 97.5], axis=0)
    blo, bhi = np.percentile(base, [2.5, 97.5])
    return lo, hi, (blo, bhi), len(years)


def main() -> int:
    pb.assert_paper_defaults()
    sd = pb.streak_defs()
    published = json.load(open(pb.PAPER_CODE / "streak_diagnostic_data.json"))
    labels = [str(q) for q in range(EXACT_MAX + 1)] + [f"{EXACT_MAX + 1}+"]
    out = {"barriers": BARRIERS, "bootstrap": {
        "scheme": "calendar-year block bootstrap over note-start years (as in the paper's bootstrap.py)",
        "reps": B_REPS, "seed": SEED, "interval": "2.5th-97.5th percentile",
        "caveat": ("Adjacent-year windows still overlap, so these bands are a descriptive, "
                   "dependence-aware sensitivity check, not exact confidence intervals.")},
        "definitions": {k: published["methodology"][k] for k in
                        ("one_year_definition", "streak_definition", "sample", "dependence_caveat",
                         "survivorship_caveat")},
        "by_barrier": {}}
    rng = np.random.default_rng(SEED)
    for ki in BARRIERS:
        t0 = time.time()
        with pb.terms(KI=ki):
            records, _, _, paths = sd["build_dataset"]()
            table = sd["conditional_table"](records, "d_within_1y")
        if abs(ki - 0.60) < 1e-12:
            want = published["D_within_1y_given_streak"]
            if table != want:
                print("GATE FAILED: KI=0.60 streak table differs from the paper's published data")
                return 1
            print("gate: KI=0.60 streak table == paper streak_diagnostic_data.json (exact)")
        fut = [r for r in records if r["d_within_1y"] is not None]
        q = np.asarray([r["streak"] for r in fut])
        ev = np.asarray([r["d_within_1y"] for r in fut], dtype=float)
        yr = np.asarray([r["year"] for r in fut])
        lab = [label_of(int(x)) for x in q]
        lo, hi, (blo, bhi), n_years = bootstrap(yr, lab, ev, labels, rng)
        rows = []
        for i, name in enumerate(labels):
            m = np.asarray([x == name for x in lab])
            rows.append({"label": name, "n": int(m.sum()), "events": int(ev[m].sum()),
                         "p": round(float(ev[m].mean()), 4),
                         "lo": round(float(lo[i]), 4), "hi": round(float(hi[i]), 4)})
        tail = [(int(k), v) for k, v in table["exact"].items() if int(k) > EXACT_MAX]
        dense = [v["probability"] for k, v in tail if v["n"] >= HETERO_MIN_N]
        out["by_barrier"][f"{ki:.2f}"] = {
            "rows": rows,
            "base": {"p": round(float(ev.mean()), 4), "lo": round(float(blo), 4),
                     "hi": round(float(bhi), 4), "n": int(len(ev))},
            "pooled_tail": {"max_streak": max(k for k, _ in tail),
                            "lengths": len(tail),
                            "range_n_min": HETERO_MIN_N,
                            "p_min": round(min(dense), 4), "p_max": round(max(dense), 4)},
            "n_years": n_years, "paths": int(paths)}
        print(f"KI={ki:.2f}: {len(fut)} obs, base {ev.mean():.3f} [{blo:.3f},{bhi:.3f}], "
              f"{n_years} year blocks ({time.time() - t0:.0f}s)", flush=True)
    pb.assert_paper_defaults()
    dest = Path(__file__).resolve().parent.parent / "static/experiments/fcn/streak.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
