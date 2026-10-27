"""How much to buy at launch: the dev buy that maximises the result per launch.

Three views, because no one of them is enough on its own:
  1. Sniper response by exact dev buy: which amounts make sniper bots buy in the first second (a hit is over 1 SOL of
     outside buying by 1.2 s), to find where the threshold sits.
  2. Results by dev-buy band, each dev counted once and the interval bootstrapped over devs, on the hours playbook v1
     was chosen on and on the fresh hours after. Launches from the same tool and the same dev at different amounts
     are compared directly, which removes most of the dev's own quality from the comparison.
  3. The same outside flow replayed with a different dev buy: what a bigger bag alone does to the result.

Usage: python3 ml/devbuy.py [export.jsonl]
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import FEE, load, table  # noqa: E402

df = load(sys.argv[1] if len(sys.argv) > 1 else 'data/exports/launches.jsonl')
df = df[df.clearOfGaps & (df.tool != 'vercel-blob')].copy()
df['hit'] = df.outsideBuy1s > 1
df['cb'] = df.curveBuy.round(3)
SNIPER_TOOLS = ['j7tracker', 'uxento', 'rapidlaunch', 'ipfs.io', 'pinata']

print('== 1. Sniper response by exact dev buy (SOL into the curve; the wallet pays 1.25% more)')
near = df[(df.curveBuy >= 2.8) & (df.curveBuy < 3.25)]
g = near.groupby('cb').agg(launches=('mint', 'size'), devs=('dev', 'nunique'), sniped=('hit', 'mean'),
                           outside1s=('outsideBuy1s', 'median'), v1=('pnlV1', 'mean')).reset_index()
table(g[g.launches >= 3])

BANDS = [(0.5, 1.5), (1.5, 2.9), (2.95, 3.01), (3.01, 3.9), (3.9, 4.1), (4.1, 4.9), (4.9, 5.1), (5.1, 7.9), (7.9, 10.1), (10.1, 100)]


def band(x):
    for lo, hi in BANDS:
        if lo <= x < hi:
            return f'{lo:g}-{hi:g}'
    return None


df['band'] = df.curveBuy.map(band)
rng = np.random.default_rng(7)


def dev_mean(d, col):
    """Each dev counted once (the mean of its launches), with a 90% interval from resampling devs."""
    per = d.groupby('dev')[col].mean().to_numpy()
    if len(per) < 3:
        return float(per.mean()) if len(per) else np.nan, np.nan, np.nan
    boots = [rng.choice(per, len(per)).mean() for _ in range(2000)]
    return float(per.mean()), float(np.percentile(boots, 5)), float(np.percentile(boots, 95))


def band_table(d):
    rows = []
    for b in [f'{lo:g}-{hi:g}' for lo, hi in BANDS]:
        x = d[d.band == b]
        if len(x) < 5:
            continue
        m, lo, hi = dev_mean(x, 'pnlV1')
        old, new = x[~x.fresh], x[x.fresh]
        rows.append(dict(band=b, launches=len(x), devs=x.dev.nunique(), sniped=x.groupby('dev').hit.mean().mean(),
                         drew=x.groupby('dev').active.mean().mean(), v1=m, lo=lo, hi=hi,
                         perSol=(x.pnlV1 / x.curveBuy).groupby(x.dev).mean().mean(),
                         v1_v1hours=dev_mean(old, 'pnlV1')[0] if len(old) else np.nan,
                         v1_fresh=dev_mean(new, 'pnlV1')[0] if len(new) else np.nan, fresh=len(new)))
    table(pd.DataFrame(rows))


print('\n== 2a. Result per launch under the v1 exit by dev buy (SOL), each dev counted once; all launch tools but spam')
band_table(df[df.tool.isin(SNIPER_TOOLS)])
print('\n   single-wallet devs only (launched the way we will)')
band_table(df[df.tool.isin(SNIPER_TOOLS) & df.clean])
print('\n   by launch tool, round amounts only')
rows = []
for tool in SNIPER_TOOLS + ['other']:
    for amt in [3.0, 4.0, 5.0]:
        x = df[(df.tool == tool) & ((df.cb == amt) | (df.cb == round(amt / FEE, 3)))]
        if len(x) >= 5:
            rows.append(dict(tool=tool, amount=amt, launches=len(x), devs=x.dev.nunique(), sniped=x.hit.mean(),
                             outside3s=x.outsideBuy3s.median(), v1=dev_mean(x, 'pnlV1')[0]))
table(pd.DataFrame(rows))

print('\n== 2b. Same dev, different amounts (devs that launched both; the difference is within each dev)')
x = df[df.tool.isin(SNIPER_TOOLS) & df.band.isin(['2.95-3.01', '3.9-4.1', '4.9-5.1'])]
per = x.groupby(['dev', 'band']).agg(v1=('pnlV1', 'mean'), hit=('hit', 'mean'), n=('mint', 'size')).reset_index()
for a, b in [('2.95-3.01', '3.9-4.1'), ('2.95-3.01', '4.9-5.1'), ('3.9-4.1', '4.9-5.1')]:
    w = per.pivot(index='dev', columns='band', values='v1').dropna(subset=[a, b]) if {a, b} <= set(per.band) else pd.DataFrame()
    if len(w) < 3:
        print(f'   {a} vs {b}: only {len(w)} devs launched both')
        continue
    d = (w[b] - w[a]).to_numpy()
    boots = [rng.choice(d, len(d)).mean() for _ in range(2000)]
    h = per.pivot(index='dev', columns='band', values='hit').loc[w.index]
    print(f'   {b} minus {a} SOL: {d.mean():+.2f} SOL per launch (90% {np.percentile(boots, 5):+.2f} to '
          f'{np.percentile(boots, 95):+.2f}) over {len(d)} devs; sniped {h[a].mean():.0%} -> {h[b].mean():.0%}')

print('\n== 3. Same outside flow, different dev buy (launches made at 2.95-5.1 SOL that drew snipers)')
cf = [c for c in df.columns if c.startswith('pnlAt')]
x = df[df.tool.isin(SNIPER_TOOLS) & df.band.isin(['2.95-3.01', '3.9-4.1', '4.9-5.1'])]
rows = []
for b in ['2.95-3.01', '3.9-4.1', '4.9-5.1']:
    y = x[x.band == b]
    rows.append(dict(recorded=b, launches=len(y), **{c.replace('pnlAt', 'buy '): y[c].mean() for c in cf}))
table(pd.DataFrame(rows))
dead = x[~x.active]
print(f'   launches that drew no buyers ({len(dead)}): ' + ', '.join(f"{c.replace('pnlAt', '')} SOL {dead[c].mean():+.3f}" for c in cf))
print(f'   worst launch at each buy: ' + ', '.join(f"{c.replace('pnlAt', '')} SOL {x[c].min():+.3f}" for c in cf))
