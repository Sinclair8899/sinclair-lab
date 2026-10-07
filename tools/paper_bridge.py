"""Read-only bridge to the working paper's reproducibility package.

``backtest.py`` and ``streak_diagnostic.py`` in the paper package run their full
analysis *at import time* and overwrite the paper's own JSON outputs.  This
bridge therefore never imports them.  It parses each file with ``ast`` and
executes only the leading imports, constants and function definitions (the
code before the first module-level analysis statement), unmodified, in a fresh
namespace.  The paper files are never written.

``set_terms`` changes fcn_core's module-level contract terms; every paper
function reads them at call time, which is how the paper's own grid was swept.
"""
from __future__ import annotations

import ast
import contextlib
import sys
from pathlib import Path

PAPER_CODE = Path.home() / "codex-projects/openclaw-notes/fcn-no-survey-v2/code"
sys.path.insert(0, str(PAPER_CODE))
import fcn_core  # noqa: E402  (the paper's engine, unmodified)

PAPER_TERMS = dict(KI=0.60, STK=0.80, TENOR=63, KOSTART=21, COUP=0.12)


def _load_defs(filename: str, stop_line: int) -> dict:
    path = PAPER_CODE / filename
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    keep = [n for n in tree.body if n.lineno < stop_line
            and not (isinstance(n, ast.Expr) and isinstance(getattr(n, "value", None), ast.Constant))]
    assert all(isinstance(n, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef)) for n in keep)
    ns = {"__file__": str(path), "__name__": f"paper_{path.stem}"}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(path), "exec"), ns)
    return ns


def backtest_defs() -> dict:
    """``pool`` & friends; stops before the first print() analysis line (119)."""
    return _load_defs("backtest.py", 119)


def streak_defs() -> dict:
    """``build_dataset``, ``conditional_table`` …; stops before line 373."""
    return _load_defs("streak_diagnostic.py", 373)


@contextlib.contextmanager
def terms(**overrides):
    """Temporarily set fcn_core contract terms (KI, STK, TENOR, KOSTART, COUP)."""
    saved = {k: getattr(fcn_core, k) for k in PAPER_TERMS}
    try:
        for k, v in overrides.items():
            assert k in PAPER_TERMS, k
            setattr(fcn_core, k, v)
        yield
    finally:
        for k, v in saved.items():
            setattr(fcn_core, k, v)


def assert_paper_defaults():
    for k, v in PAPER_TERMS.items():
        assert getattr(fcn_core, k) == v, (k, getattr(fcn_core, k))
