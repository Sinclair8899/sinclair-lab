"""Vectorized re-implementation of the paper engine (fcn_core) for the explorer.

The paper's ``fcn_core.contract`` settles one 63-day note at a time in Python.
This module settles *every* possible note inception for *every* basket at once
with numpy, using the same element-wise arithmetic in the same order, so the
results are meant to be bit-identical — not merely close.  The paper engine
remains the oracle: ``build_fcn_grid.py`` refuses to write anything unless this
module reproduces fcn_core exactly on the paper configuration, and
``test_fcn_fast.py`` checks parity on the full grid of terms the page offers.

Nothing here reads or writes price data except through ``fcn_core.load_prices``.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

TRADING_DAYS = 252
KO = 1.00


@dataclass(frozen=True)
class Terms:
    ki: float = 0.60      # knock-in barrier (fcn_core.KI)
    strike: float = 0.80  # fcn_core.STK
    tenor: int = 63       # fcn_core.TENOR
    kostart: int = 21     # fcn_core.KOSTART (first autocall observation day)
    coupon: float = 0.12  # fcn_core.COUP


@dataclass
class Settled:
    """Outcomes of every note inception (rows) for every basket (columns)."""
    outcome: np.ndarray   # int8: 0 = A (autocall), 1 = W (coupon, no loss), 2 = D (delivery)
    pnl: np.ndarray       # float64, identical to fcn_core.contract's pnl
    hold: np.ndarray      # int64 holding days
    worst: np.ndarray     # int64 position (0..2) of the worst name at final, within the basket
    finite: np.ndarray    # bool: the full segment has finite prices


A, W, D = 0, 1, 2


def settle_all(prices: np.ndarray, baskets: list[tuple[int, ...]], terms: Terms) -> Settled:
    T = terms.tenor
    n_start = prices.shape[0] - T          # inceptions 0 .. N-T-1 have T+1 rows
    win = sliding_window_view(prices, T + 1, axis=0)[:n_start]   # (n_start, n_names, T+1)
    norm = win / win[:, :, :1]                                    # segment / segment[0]
    finite_name = np.isfinite(win).all(axis=2)                    # (n_start, n_names)
    with np.errstate(invalid="ignore"):
        body_min = np.nanmin(np.where(np.isfinite(norm[:, :, 1:]), norm[:, :, 1:], np.inf), axis=2)
        ki_name = body_min <= terms.ki
        hits = norm[:, :, terms.kostart:] >= KO
    any_hit = hits.any(axis=2)
    first = np.where(any_hit, terms.kostart + hits.argmax(axis=2), T + 1)   # fcn_core "memory"
    final = norm[:, :, -1]

    nb = len(baskets)
    outcome = np.empty((n_start, nb), dtype=np.int8)
    pnl = np.empty((n_start, nb), dtype=np.float64)
    hold = np.empty((n_start, nb), dtype=np.int64)
    worst = np.empty((n_start, nb), dtype=np.int64)
    finite = np.empty((n_start, nb), dtype=bool)
    coup_full = terms.coupon * T / TRADING_DAYS
    for b, cols in enumerate(baskets):
        c = list(cols)
        autocall_day = first[:, c].max(axis=1)
        autocall = autocall_day <= T
        knock_in = ki_name[:, c].any(axis=1)
        wf = final[:, c].min(axis=1)
        is_d = ~autocall & knock_in & (wf < terms.strike)
        outcome[:, b] = np.where(autocall, A, np.where(is_d, D, W))
        pnl_a = terms.coupon * autocall_day / TRADING_DAYS
        pnl_d = coup_full + (wf / terms.strike - 1)
        pnl[:, b] = np.where(autocall, pnl_a, np.where(is_d, pnl_d, coup_full))
        hold[:, b] = np.where(autocall, autocall_day, T)
        worst[:, b] = final[:, c].argmin(axis=1)
        finite[:, b] = finite_name[:, c].all(axis=1)
    return Settled(outcome, pnl, hold, worst, finite)


def calendar_paths(st: Settled, n_rows: int, tenor: int, horizon: int, start_step: int):
    """fcn_core.summarize_fixed_horizon semantics, driven by precomputed notes.

    Returns (returns, no_d, starts, basket_ids, n_notes) for every observable
    (start, basket) path, in fcn_core's iteration order (start-major).
    """
    returns, no_d, starts, bids, counts = [], [], [], [], []
    nb = st.outcome.shape[1]
    for start in range(0, n_rows - horizon, start_step):
        end = start + horizon
        if end >= n_rows:
            continue
        for b in range(nb):
            current = start
            factors = []
            had_d = False
            ok = True
            while current + tenor <= end:
                if not st.finite[current, b]:
                    ok = False
                    break
                factors.append(1.0 + float(st.pnl[current, b]))
                had_d = had_d or st.outcome[current, b] == D
                current += int(st.hold[current, b])
            if not ok or not factors:
                continue
            returns.append(float(np.prod(factors)) - 1.0)
            no_d.append(not had_d)
            starts.append(start)
            bids.append(b)
            counts.append(len(factors))
    return (np.asarray(returns), np.asarray(no_d), np.asarray(starts),
            np.asarray(bids), np.asarray(counts))


def pooled_notes(st: Settled, step: int = 5):
    """backtest.pool semantics: every note started every ``step`` days, all baskets."""
    rows = np.arange(0, st.outcome.shape[0], step)
    fin = st.finite[rows]
    out = st.outcome[rows][fin]
    worst = st.worst[rows]
    return out, fin, worst
