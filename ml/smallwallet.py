"""What a small launch wallet can do: the dev buy it allows, what that buy draws, and a bankroll simulation.

With W SOL in the wallet the largest dev buy is W minus a reserve for rent, tips and a retried sell. Below about
2.95 SOL into the curve sniper bots mostly stay away, so the question is what a smaller buy still makes, and whether
it is better to launch small, to launch small and step up to 5 SOL once the wallet has grown, or to wait.

  1. Sniper response by dev buy from 0.5 to 3.1 SOL (into the curve), each dev counted once.
  2. Results by dev-buy band on strong posts (the first launch on a post under 2 minutes old) and on every launch.
  3. The same devs at 2-2.95 SOL and at 3 SOL.
  4. Bankroll: starting from W SOL, many simulated sessions of N launches under each strategy, drawing each launch's
     result from recorded launches at that size on strong posts, with our hit rate at 100%, 50% and 25% of theirs.

Usage: python3 ml/smallwallet.py [wallet SOL=2.5] [launches=20]
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import load, table  # noqa: E402

W = float(sys.argv[1]) if len(sys.argv) > 1 else 2.5
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20
FEE = 1.0125
RESERVE = 0.06  # rent (~0.009), tips and network (~0.003), one retried sell, a claim
rng = np.random.default_rng(7)

df = load()
df = df[df.clearOfGaps & ~df.tool.isin(['other', 'vercel-blob'])].sort_values('ts').copy()
df['sniped'] = df.outsideBuy1s > 1
t = (df.xLink == 'tweet') & df.tweetAgeSec.notna()
df['post'] = np.where(t, df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec.fillna(0)).astype(int).astype(str), None)
df['strong'] = t & ~df.post.duplicated() & (df.tweetAgeSec <= 120)


def ci(x):
    x = np.asarray(x, float)
    if len(x) < 3:
        return np.nan, np.nan
    b = [rng.choice(x, len(x)).mean() for _ in range(2000)]
    return np.percentile(b, 5), np.percentile(b, 95)


max_buy = (W - RESERVE) / FEE
print(f'Wallet {W} SOL: the largest dev buy is {max_buy:.2f} SOL into the curve ({max_buy * FEE:.2f} with fees), '
      f'keeping {RESERVE} SOL for rent, tips and a retried sell.\n')

print('== 1. Sniper response by dev buy (SOL into the curve), each dev counted once')
edges = [0.5, 0.9, 1.0, 1.1, 1.5, 1.9, 2.0, 2.1, 2.4, 2.5, 2.6, 2.9, 2.95, 3.05, 3.2]
df['fine'] = pd.cut(df.curveBuy, edges, right=False)
rows = []
for b, x in df.groupby('fine', observed=True):
    rows.append(dict(band=str(b), launches=len(x), devs=x.dev.nunique(), sniped=x.groupby('dev').sniped.mean().mean(),
                     outside1s=x.outsideBuy1s.median(), outside10s=x.outsideBuy10s.median(),
                     result=x.groupby('dev').pnlV2.mean().mean()))
table(pd.DataFrame(rows))

BANDS = [(0.5, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 2.5), (2.5, 2.95), (2.95, 3.05), (4.9, 5.1)]
df['band'] = None
for lo, hi in BANDS:
    df.loc[df.curveBuy.between(lo, hi, inclusive='left'), 'band'] = f'{lo:g}-{hi:g}'


def by_band(d, title):
    print(f'\n== 2. {title}')
    rows = []
    for lo, hi in BANDS:
        x = d[d.band == f'{lo:g}-{hi:g}']
        if len(x) < 5:
            continue
        per = x.groupby('dev').pnlV2.mean()
        lo_, hi_ = ci(per)
        rows.append(dict(band=f'{lo:g}-{hi:g}', launches=len(x), devs=x.dev.nunique(), sniped=x.sniped.mean(),
                         drew=x.active.mean(), mean=per.mean(), lo=lo_, hi=hi_, median=x.pnlV2.median(),
                         profitable=(x.pnlV2 > 0).mean(), worst=x.pnlV2.min(), perSol=(x.pnlV2 / x.curveBuy).mean()))
    table(pd.DataFrame(rows))


by_band(df[df.strong], 'Strong posts (first launch on a post under 2 min old), by dev buy, each dev counted once')
by_band(df, 'Every launch, by dev buy, each dev counted once')

print('\n== 3. The same devs at 2-2.95 SOL and at 3 SOL')
x = df[df.band.isin(['2-2.5', '2.5-2.95', '2.95-3.05'])].copy()
x['size'] = np.where(x.band == '2.95-3.05', '3', '2-2.95')
w = x.groupby(['dev', 'size']).agg(pnl=('pnlV2', 'mean'), sniped=('sniped', 'mean')).unstack().dropna()
if len(w) >= 3:
    d = (w[('pnl', '3')] - w[('pnl', '2-2.95')]).to_numpy()
    lo_, hi_ = ci(d)
    print(f'   {len(w)} devs launched at both: 3 SOL minus 2-2.95 SOL {d.mean():+.2f} a launch (90% {lo_:+.2f} to {hi_:+.2f}); '
          f'sniped {w[("sniped", "2-2.95")].mean():.0%} -> {w[("sniped", "3")].mean():.0%}')
else:
    print(f'   only {len(w)} devs launched at both')

print(f'\n== 4. A {W} SOL wallet over up to {N} launches (20,000 simulated sessions each)')
# Each launch's result is drawn from strong-post launches recorded at that exact size (their flow, our exit). A launch
# that drew buyers is made dead with chance 1 - keep (our coins drawing buyers less often than theirs). The session
# stops where the bot would: after 3 dead launches in a row (the pause for a review), at the daily-loss limit, or
# when the wallet cannot fund the next buy.
pools = {}
for name, lo, hi in [('two', 1.97, 2.03), ('three', 2.99, 3.01), ('five', 4.9, 5.1)]:
    x = df[df.strong & df.curveBuy.between(lo, hi)]
    pools[name] = (x.pnlV2.to_numpy(), x.active.to_numpy())
    print(f'   pool {name}: {len(x)} strong-post launches at {lo}-{hi} SOL by {x.dev.nunique()} devs, mean {x.pnlV2.mean():+.2f}, '
          f'median {x.pnlV2.median():+.2f}, drew {x.active.mean():.0%}')
BUY = {'two': 2.0, 'three': 3.0, 'five': 5.0}
STOP_LOSS = 0.75  # SOL a day, scaled for a small wallet


def draw(pool, keep):
    pnl, drew = pools[pool]
    i = rng.integers(len(pnl))
    dead = -(BUY[pool] * 2 * 0.0095 + 0.012)
    if drew[i] and rng.random() > keep:
        return dead, False
    return (pnl[i], bool(drew[i])) if pnl[i] > dead else (dead, False)


def session(strategy, keep, start):
    bal, launches, dead_run = start, 0, 0
    for _ in range(N):
        need = lambda pool: BUY[pool] * FEE + 0.15
        if strategy == 'two, then five once the wallet allows':
            pool = 'five' if bal >= need('five') + 0.3 else 'two'
        else:
            pool = {'two only': 'two', 'three only': 'three', 'five only': 'five'}[strategy]
        if bal < need(pool) or start - bal >= STOP_LOSS or dead_run >= 3:
            break
        r, drew = draw(pool, keep)
        bal += r
        launches += 1
        dead_run = 0 if drew else dead_run + 1
    return bal, launches, dead_run >= 3


rows = []
for strategy, start in [('two only', W), ('two, then five once the wallet allows', W), ('three only', 3.25), ('five only', 8.0)]:
    for keep in [1.0, 0.5, 0.25]:
        res = [session(strategy, keep, start) for _ in range(20000)]
        end = np.array([r[0] for r in res])
        n = np.array([r[1] for r in res])
        paused = np.array([r[2] for r in res])
        rows.append(dict(strategy=strategy, start=start, ourHitRate=f'{keep:.0%}', launches=n.mean(),
                         median=np.median(end), p05=np.percentile(end, 5), p95=np.percentile(end, 95),
                         gainMedian=np.median(end) - start, P_loss=(end < start).mean(), P_paused=paused.mean(),
                         P_reach5=(end >= 5.27).mean()))
table(pd.DataFrame(rows))
