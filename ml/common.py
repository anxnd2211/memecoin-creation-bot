"""Shared loading for the model scripts: reads the launch export (npm run export-launches)."""
import json
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

EXPORT = 'data/exports/launches.jsonl'
FEE = 1.0125  # protocol + creator fee charged on top of a curve buy
# Playbook v1 was chosen on launches before this time; later launches are fresh for checking it.
V1_CUTOFF = int(datetime(2026, 10, 27, 19, 54, tzinfo=timezone.utc).timestamp())


def load(path: str = EXPORT) -> pd.DataFrame:
    rows = [json.loads(line) for line in open(path)]
    df = pd.DataFrame(rows)
    for k in [c for c in df.columns if c.startswith('pnl')]:
        df[k] = df[k].map(lambda v: v['pnl'])
    df['curveBuy'] = df.devBuySol / FEE
    df['fresh'] = df.ts >= V1_CUTOFF
    df['time'] = pd.to_datetime(df.ts, unit='s', utc=True)
    return df


def boot_ci(x, n=2000, seed=7, stat=np.mean):
    """90% bootstrap interval of a statistic."""
    x = np.asarray(x, dtype=float)
    if len(x) < 2:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed)
    s = [stat(rng.choice(x, len(x))) for _ in range(n)]
    return (float(np.percentile(s, 5)), float(np.percentile(s, 95)))


def fmt(v, d=2):
    return '-' if v is None or (isinstance(v, float) and np.isnan(v)) else f'{v:+.{d}f}' if isinstance(v, float) else str(v)


def table(df: pd.DataFrame, file=sys.stdout):
    print(df.to_string(index=False, float_format=lambda v: f'{v:.2f}'), file=file)
