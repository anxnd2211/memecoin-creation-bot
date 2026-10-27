"""Do big dev buys scare traders off, does a dumping record hurt a dev, and what does sniping do to us?

  A. Dev buy and organic buying: buyers and net SOL arriving after the first 10 s (past the sniper bots) by dev-buy
     band, each dev counted once, and the same devs at 3 and at 5 SOL; also the 2-3 SOL range on strong posts.
  B. A dumping record: devs whose earlier launches they sold 95%+ of within 60 s, against devs who did not, on their
     next launch (sniped share, organic buyers, result).
  C. Sniping: how many wallets buy within two slots, what they put in, when they sell, and what our exit makes on
     lightly and heavily sniped launches.

Research launches only (before ml/exits.py SEAL). Usage: python3 ml/sentiment.py
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import load, table  # noqa: E402
from exits import SEAL  # noqa: E402

df = load()
df = df[df.clearOfGaps & (df.ts < SEAL) & ~df.tool.isin(['other', 'vercel-blob'])].copy()
df['organicBuyers'] = df.buyers600s - df.buyers10s
df['organicNet'] = df.outsideNet600s - df.outsideNet10s
df['organicBuy10to60'] = df.outsideBuy60s - df.outsideBuy10s
df['sniped'] = df.outsideBuy1s > 1
rng = np.random.default_rng(7)


def ci(x):
    x = np.asarray(x, float)
    if len(x) < 3:
        return np.nan, np.nan
    b = [rng.choice(x, len(x)).mean() for _ in range(2000)]
    return np.percentile(b, 5), np.percentile(b, 95)


def dev_mean(d, col):
    return d.groupby('dev')[col].mean().mean()


BANDS = [(0.5, 1.5, '0.5-1.5'), (1.5, 2.0, '1.5-2'), (2.0, 2.95, '2-2.95'), (2.95, 3.05, '3'), (3.9, 4.1, '4'),
         (4.9, 5.1, '5'), (5.5, 8.5, '6-8'), (9.5, 10.5, '10')]
df['band'] = None
for lo, hi, name in BANDS:
    df.loc[df.curveBuy.between(lo, hi, inclusive='left'), 'band'] = name

print('== A1. Organic buying after the first 10 s, by dev buy (each dev counted once; SOL into the curve)')
rows = []
for _, _, b in BANDS:
    x = df[df.band == b]
    if len(x) < 5:
        continue
    rows.append(dict(band=b, launches=len(x), devs=x.dev.nunique(), sniped=dev_mean(x, 'sniped'),
                     buyers10s=dev_mean(x, 'buyers10s'), organicBuyers=dev_mean(x, 'organicBuyers'),
                     organicNet=dev_mean(x, 'organicNet'), buy10to60=dev_mean(x, 'organicBuy10to60'),
                     graduated=dev_mean(x, 'graduated'), v2=dev_mean(x, 'pnlV2'),
                     perSol=(x.pnlV2 / x.curveBuy).groupby(x.dev).mean().mean()))
table(pd.DataFrame(rows))

print('\n== A2. Same devs at 3 and at 5 SOL: does the bigger buy cost organic buyers?')
per = df[df.band.isin(['3', '5'])].groupby(['dev', 'band'])[['organicBuyers', 'organicNet', 'buy10to60', 'pnlV2', 'sniped']
                                                              if False else ['organicBuyers', 'organicNet', 'organicBuy10to60', 'pnlV2', 'sniped']].mean()
w = per.unstack('band').dropna()
print(f'   {len(w)} devs launched at both')
for col in ['organicBuyers', 'organicNet', 'organicBuy10to60', 'sniped', 'pnlV2']:
    d = (w[(col, '5')] - w[(col, '3')]).to_numpy()
    lo, hi = ci(d)
    print(f'   {col:17} 3 SOL {w[(col, "3")].mean():7.2f}   5 SOL {w[(col, "5")].mean():7.2f}   5 minus 3 {d.mean():+.2f} (90% {lo:+.2f} to {hi:+.2f})')

print('\n== A3. On strong posts (first launch on a post under 2 min old): does a smaller dev buy do as well?')
t = df[(df.xLink == 'tweet') & df.tweetAgeSec.notna()].sort_values('ts').copy()
t['post'] = t.xHandle.fillna('') + ':' + (t.ts - t.tweetAgeSec).astype(int).astype(str)
strong = t[~t.post.duplicated() & (t.tweetAgeSec <= 120)]
rows = []
for _, _, b in BANDS:
    x = strong[strong.band == b]
    if len(x) < 5:
        continue
    lo, hi = ci(x.pnlV2)
    rows.append(dict(band=b, launches=len(x), devs=x.dev.nunique(), sniped=x.sniped.mean(), drew=x.active.mean(),
                     organicBuyers=x.organicBuyers.mean(), v2=x.pnlV2.mean(), lo=lo, hi=hi, median=x.pnlV2.median(),
                     worst=x.pnlV2.min(), perSol=(x.pnlV2 / x.curveBuy).mean()))
table(pd.DataFrame(rows))

print('\n== B. Does a dumping record hurt a dev? (launches whose dev had 2+ earlier recorded launches)')
df = df.sort_values('ts')
df['dumped'] = (df.devSoldBy60s >= 0.95).astype(float)
g = df.groupby('dev')
df['priorN'] = g.cumcount()
df['priorDumps'] = g.dumped.cumsum() - df.dumped
df['priorBusy'] = g.active.cumsum() - df.active
x = df[df.priorN >= 2].copy()
x['dumpShare'] = x.priorDumps / x.priorN
x['busyShare'] = x.priorBusy / x.priorN
x['record'] = np.where(x.dumpShare >= 0.8, 'dumped 80%+ of earlier launches', np.where(x.dumpShare <= 0.2, 'dumped 20% or less', 'mixed'))
x['history'] = np.where(x.busyShare > 0, 'had a busy launch', 'all dead')
table(x.groupby(['history', 'record']).agg(launches=('mint', 'size'), devs=('dev', 'nunique'), sniped=('sniped', 'mean'),
                                           drew=('active', 'mean'), organicBuyers=('organicBuyers', 'mean'),
                                           v2=('pnlV2', 'mean')).reset_index())

print('\n== C. Sniping, launches with a 2.95+ SOL dev buy')
s = df[df.curveBuy >= 2.95].copy()
print(f'   per launch: median {s.snipers.median():.0f} sniper wallets (within 2 slots) putting in {s.sniperBuySol.median():.2f} SOL; '
      f'their first sells come a median {s.sniperFirstSellMedianSec.median():.1f} s after launch; by 30 s they have taken out '
      f'{(s.sniperSellSol30s / s.sniperBuySol.where(s.sniperBuySol > 0)).median():.0%} of what they put in (median)')
s['snipeLevel'] = pd.qcut(s.sniperBuySol.rank(method='first'), 4, labels=['least sniped', 'light', 'heavy', 'most sniped'])
table(s.groupby('snipeLevel', observed=True).agg(launches=('mint', 'size'), sniperSol=('sniperBuySol', 'median'),
                                                 sniperExitSec=('sniperFirstSellMedianSec', 'median'),
                                                 organicBuyers=('organicBuyers', 'mean'), drew=('active', 'mean'),
                                                 v2=('pnlV2', 'mean'), v2median=('pnlV2', 'median'),
                                                 worst=('pnlV2', 'min'), profitable=('pnlV2', lambda v: (v > 0).mean())).reset_index())
