"""When to launch: clock hours, and the market's state in the minutes before a launch.

  1. Clock hours: launches in the sniper band and first-on-post chances, hour by hour, each dev counted once.
  2. Market state: what the feed showed before each launch (trading volume and traders in the last 10 minutes,
     launches in the last 10 and 60, how many recent launches drew buyers, sniper buying on recent 3 SOL+ launches,
     what the playbook's exit made on launches 10-70 minutes earlier, graduations in the last hour). Each measure,
     and models built on them, are scored on time blocks they were not fitted on, against the hour of day.
  3. Timing policies, simulated on first-on-post chances with 10 minutes between our launches: launch at every
     chance, or only when the market state the model was fitted on other blocks predicts a good launch.

Only minutes the observer recorded count: features whose window runs into a feed gap are left out.
Usage: python3 ml/timing.py
"""
import sqlite3
import sys

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

sys.path.insert(0, 'ml')
from common import load, table  # noqa: E402
from exits import SEAL  # noqa: E402

rng = np.random.default_rng(7)


def ci(x):
    x = np.asarray(x, float)
    if len(x) < 3:
        return np.nan, np.nan
    b = [rng.choice(x, len(x)).mean() for _ in range(2000)]
    return np.percentile(b, 5), np.percentile(b, 95)


def minute_table():
    db = sqlite3.connect('file:data/observer.db?mode=ro', uri=True)
    tr = pd.read_sql('SELECT ts / 60 AS m, COUNT(*) AS trades, SUM(sol) AS vol, COUNT(DISTINCT wallet_id) AS wallets '
                     'FROM trades GROUP BY m', db)
    la = pd.read_sql("SELECT created_ts / 60 AS m, COUNT(*) AS launches, SUM(is_mayhem) AS mayhem, "
                     "SUM(unique_buyers - early_buyers >= 10) AS busy FROM coins WHERE quote = 'SOL' GROUP BY m", db)
    gr = pd.read_sql('SELECT graduated_ts / 60 AS m, COUNT(*) AS grads FROM coins WHERE graduated_ts IS NOT NULL GROUP BY m', db)
    m = pd.DataFrame({'m': np.arange(tr.m.min(), tr.m.max() + 1)})
    m = m.merge(tr, on='m', how='left').merge(la, on='m', how='left').merge(gr, on='m', how='left').fillna(0)
    m['recorded'] = m.trades > 0
    # A minute with no trades inside a quiet stretch of 5+ minutes is a feed gap, not a quiet market.
    run = (m.recorded != m.recorded.shift()).cumsum()
    m['gap'] = ~m.recorded & (m.groupby(run).m.transform('size') >= 5)
    return m.set_index('m')


def market_features(launches: pd.DataFrame, mins: pd.DataFrame, band: pd.DataFrame) -> pd.DataFrame:
    c = mins.astype(float).cumsum()

    def window(col, a, b, at):
        """Sum of col over minutes [at - a, at - b)."""
        lo, hi = at - a - 1, at - b - 1
        return c[col].reindex(hi).to_numpy() - c[col].reindex(lo).to_numpy()

    at = (launches.ts // 60).to_numpy()
    f = pd.DataFrame(index=launches.index)
    f['vol10'] = window('vol', 10, 0, at)
    f['wallets10'] = window('wallets', 10, 0, at)
    f['trades10'] = window('trades', 10, 0, at)
    f['launches10'] = window('launches', 10, 0, at)
    f['launches60'] = window('launches', 60, 0, at)
    f['mayhemShare60'] = window('mayhem', 60, 0, at) / np.maximum(f.launches60, 1)
    f['busyRate'] = window('busy', 70, 10, at) / np.maximum(window('launches', 70, 10, at), 1)
    f['grads60'] = window('grads', 60, 0, at)
    f['volTrend'] = f.vol10 / np.maximum(window('vol', 60, 0, at) / 6, 1)
    gaps = window('gap', 70, 0, at)
    f.loc[~(gaps == 0), :] = np.nan
    # Climate from the band itself: sniper buying on the last 30 minutes' 3 SOL+ launches, and what the exit made on
    # launches 10-70 minutes before (their 10-minute replay has finished by then).
    bt, b1, bp = band.ts.to_numpy(), band.outsideBuy1s.to_numpy(), band.pnlV2.to_numpy()
    snipe, made = [], []
    for t in launches.ts.to_numpy():
        s = (bt < t) & (bt >= t - 1800)
        p = (bt < t - 600) & (bt >= t - 4200)
        snipe.append(np.median(b1[s]) if s.sum() >= 3 else np.nan)
        made.append(np.mean(bp[p]) if p.sum() >= 5 else np.nan)
    f['sniperBuy30m'] = snipe
    f['exitMade70m'] = made
    f['hour'] = launches.hourUtc.to_numpy()
    return f


FEATS = ['vol10', 'wallets10', 'trades10', 'launches10', 'launches60', 'mayhemShare60', 'busyRate', 'grads60',
         'volTrend', 'sniperBuy30m', 'exitMade70m']


def main():
    df = load()
    df = df[df.clearOfGaps & (df.ts < SEAL) & ~df.tool.isin(['other', 'vercel-blob'])].sort_values('ts').copy()
    band = df[df.curveBuy >= 2.95].copy()
    mins = minute_table()

    print('== 1. Clock hours (UTC), launches with a 2.95+ SOL dev buy; each dev counted once')
    t = df[(df.xLink == 'tweet') & df.tweetAgeSec.notna()].copy()
    t['post'] = t.xHandle.fillna('') + ':' + (t.ts - t.tweetAgeSec).astype(int).astype(str)
    chances = t[~t.post.duplicated() & (t.tweetAgeSec <= 120) & t.curveBuy.between(2.95, 5.1)]
    recorded = mins[mins.recorded].groupby((mins[mins.recorded].index * 60 // 3600) % 24).size() / 60
    rows = []
    for h, x in band.groupby('hourUtc'):
        lo, hi = ci(x.groupby('dev').pnlV2.mean())
        ch = chances[chances.hourUtc == h]
        hours = recorded.get(h, np.nan)
        rows.append(dict(hourUtc=h, recordedHours=hours, launches=len(x), devs=x.dev.nunique(),
                         sniped=x.groupby('dev').apply(lambda d: (d.outsideBuy1s > 1).mean()).mean(),
                         drew=x.groupby('dev').active.mean().mean(), v2=x.groupby('dev').pnlV2.mean().mean(), lo=lo, hi=hi,
                         chancesPerHour=len(ch) / hours if hours else np.nan, chanceAt5=ch.pnlAt5.mean(),
                         marketSolPerMin=mins[mins.recorded & ((mins.index * 60 // 3600) % 24 == h)].vol.mean()))
    table(pd.DataFrame(rows))

    print('\n== 2. Market state before a launch, scored on time blocks it was not fitted on (2.95+ SOL launches)')
    F = market_features(band, mins, band)
    ok = F[FEATS].notna().all(axis=1)
    X, y = F[ok], band.pnlV2[ok].to_numpy()
    active = band.active[ok].astype(float).to_numpy()
    n = len(X)
    print(f'   {n} launches with a full trailing hour of recording')
    print('   each measure alone, rank agreement with the result (both halves):')
    half = n // 2
    for col in FEATS + ['hour']:
        r1 = spearmanr(X[col].iloc[:half], y[:half]).statistic
        r2 = spearmanr(X[col].iloc[half:], y[half:]).statistic
        flag = '  <- same sign, both |r| > 0.1' if np.sign(r1) == np.sign(r2) and min(abs(r1), abs(r2)) > 0.1 else ''
        print(f'     {col:14} {r1:+.3f}  {r2:+.3f}{flag}')

    blocks = np.array_split(np.arange(n), 4)
    pred = {k: np.full(n, np.nan) for k in ['hour', 'ridge', 'boosted']}
    for test in blocks:
        tr = np.setdiff1d(np.arange(n), test)
        hour_means = pd.Series(y[tr]).groupby(X.hour.iloc[tr].to_numpy()).mean()
        pred['hour'][test] = X.hour.iloc[test].map(hour_means).fillna(y[tr].mean()).to_numpy()
        mu, sd = X[FEATS].iloc[tr].mean(), X[FEATS].iloc[tr].std().replace(0, 1)
        z = lambda a: ((a - mu) / sd).to_numpy()  # noqa: E731
        pred['ridge'][test] = Ridge(alpha=10).fit(z(X[FEATS].iloc[tr]), y[tr]).predict(z(X[FEATS].iloc[test]))
        g = HistGradientBoostingRegressor(max_iter=150, learning_rate=0.05, max_leaf_nodes=7, min_samples_leaf=40,
                                          loss='absolute_error', random_state=7)
        pred['boosted'][test] = g.fit(X[FEATS].iloc[tr], y[tr]).predict(X[FEATS].iloc[test])
    print('   models, on held-out blocks:')
    for k, p in pred.items():
        top = p >= np.median(p)
        d = y[top].mean() - y[~top].mean()
        lo, hi = ci(np.concatenate([y[top] - y[top].mean(), y[~top] - y[~top].mean()]))
        print(f'     {k:8} rank agreement {spearmanr(p, y).statistic:+.3f}; better half of predictions {y[top].mean():+.2f} '
              f'vs worse half {y[~top].mean():+.2f} ({d:+.2f}); drew buyers {active[top].mean():.0%} vs {active[~top].mean():.0%}')

    print('\n== 3. Timing policies on first-on-post chances (3-5 SOL, post under 2 min), 10 min between our launches')
    C = chances.copy()
    CF = market_features(C, mins, band)
    C = C[CF[FEATS].notna().all(axis=1)]
    CF = CF.loc[C.index]
    bounds = [X.index[b[0]] for b in blocks]  # block starts, in launch time order
    starts = [band.loc[i, 'ts'] for i in bounds] + [np.inf]
    total = {}
    for name in ['every chance', 'market model above its training median', 'market model above training 25th pct']:
        got = []
        for b, test in enumerate(blocks):
            tr = np.setdiff1d(np.arange(n), test)
            g = HistGradientBoostingRegressor(max_iter=150, learning_rate=0.05, max_leaf_nodes=7, min_samples_leaf=40,
                                              loss='absolute_error', random_state=7).fit(X[FEATS].iloc[tr], y[tr])
            cut = {'every chance': -np.inf,
                   'market model above its training median': np.median(g.predict(X[FEATS].iloc[tr])),
                   'market model above training 25th pct': np.percentile(g.predict(X[FEATS].iloc[tr]), 25)}[name]
            cb = C[(C.ts >= starts[b]) & (C.ts < starts[b + 1])]
            score = g.predict(CF.loc[cb.index, FEATS]) if len(cb) else []
            last = -np.inf
            for (i, r), sc in zip(cb.iterrows(), score):
                if r.ts - last >= 600 and sc >= cut:
                    got.append(r.pnlAt5)
                    last = r.ts
        hours = mins[mins.recorded & (mins.index * 60 >= starts[0]) & (mins.index * 60 < SEAL)].shape[0] / 60
        total[name] = got
        print(f'   {name:40} {len(got):3} launches, {np.mean(got):+.2f} a launch, {np.sum(got) / hours:+.2f} SOL an hour '
              f'over {hours:.1f} recorded hours')


if __name__ == '__main__':
    main()
