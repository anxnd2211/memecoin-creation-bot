"""Who launches well, and which X posts become coins that draw buyers.

  1. Launcher league: devs ranked by what their launches made (recorded trades, creator fees included), with their
     habits: dev buy, launch tool, links, sell style, single wallet or not, and how often they launch.
  2. What the top launchers do differently from the rest, habit by habit.
  3. X sources: the accounts whose posts are linked by launches (the narrative's source), and how old the post was at
     launch (X post IDs carry their creation time), against whether the launch drew buyers.

Usage: python3 ml/launchers.py [min launches per dev=3]
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import load, table  # noqa: E402

min_launches = int(sys.argv[1]) if len(sys.argv) > 1 else 3
df = load()
df = df[df.clearOfGaps].copy()
df['oneSell'] = df.devSells.map(lambda s: bool(s) and max(x[1] for x in s) >= 0.95)
df['nSells'] = df.devSells.map(len)

dev = df.groupby('dev').agg(
    launches=('mint', 'size'), made=('pnlRecorded', 'sum'), mean=('pnlRecorded', 'mean'),
    median=('pnlRecorded', 'median'), profitable=('pnlRecorded', lambda s: (s > 0).mean()), drew=('active', 'mean'),
    v1=('pnlV1', 'mean'), buy=('curveBuy', 'median'), tool=('tool', lambda s: s.mode().iloc[0]),
    tweet=('xLink', lambda s: (s == 'tweet').mean()), site=('website', lambda s: (s.fillna('').str.len() > 0).mean()),
    single=('clean', 'mean'), sells=('nSells', 'median'), firstSell=('devFirstSellSec', 'median'),
    first=('ts', 'min'), last=('ts', 'max')).reset_index()
dev['perHour'] = dev.launches / ((dev['last'] - dev['first']) / 3600).clip(lower=1)
dev['short'] = dev.dev.str[:6]

print(f'== 1. Launcher league: devs with {min_launches}+ launches, by SOL made '
      f'({df.time.min():%m-%d %H:%M}-{df.time.max():%H:%M} UTC, gaps excluded)')
cols = ['short', 'launches', 'made', 'mean', 'median', 'profitable', 'drew', 'v1', 'buy', 'tool', 'tweet', 'site',
        'single', 'sells', 'firstSell', 'perHour']
league = dev[dev.launches >= min_launches].sort_values('made', ascending=False)
table(league[cols].head(25))
print(f'\n   {len(league)} devs with {min_launches}+ launches; the top 10 made {league.made.head(10).sum():.0f} SOL, '
      f'all of them together {league.made.sum():.0f} SOL. Single-wallet devs in the top 25: '
      f'{(league.head(25).single >= 0.5).sum()}.')

print('\n== 2. Top launchers against the rest (devs with 3+ launches; top = best fifth by mean SOL per launch)')
d3 = dev[dev.launches >= 3].copy()
cut = d3['mean'].quantile(0.8)
d3['group'] = np.where(d3['mean'] >= cut, 'top fifth', 'rest')
habits = ['mean', 'drew', 'buy', 'tweet', 'site', 'single', 'sells', 'firstSell', 'perHour', 'launches']
cmp_ = d3.groupby('group')[habits].median().T
cmp_['top_tools'] = ''
for g in ['top fifth', 'rest']:
    tools = d3[d3.group == g].tool.value_counts(normalize=True).head(3)
    print(f'   {g}: {len(d3[d3.group == g])} devs; tools ' + ', '.join(f'{k} {v:.0%}' for k, v in tools.items()))
print(cmp_.drop(columns='top_tools').to_string(float_format=lambda v: f'{v:.2f}'))

print('\n== 3a. X accounts whose posts were linked by 3+ launches (narrative sources)')
t = df[df.xLink == 'tweet'].copy()
src = t.groupby('xHandle').agg(launches=('mint', 'size'), devs=('dev', 'nunique'), drew=('active', 'mean'),
                               v1=('pnlV1', 'mean'), best=('pnlRecorded', 'max'),
                               ageMin=('tweetAgeSec', lambda s: s.median() / 60)).reset_index()
src = src[src.launches >= 3]
print('   most launched-on:')
table(src.sort_values('launches', ascending=False).head(15))
print('   best by mean result (3+ launches by 2+ devs):')
table(src[src.devs >= 2].sort_values('v1', ascending=False).head(15))

print('\n== 3b. How old the linked post was at launch (launches with a 2.95+ SOL dev buy, and all)')
bins = [-1e9, 0.5, 30, 60, 120, 300, 900, 3600, 6 * 3600, 1e12]
labels = ['same second', '1-30s', '30-60s', '1-2m', '2-5m', '5-15m', '15-60m', '1-6h', '>6h']
t['age'] = pd.cut(t.tweetAgeSec, bins, labels=labels)
for name, x in [('2.95+ SOL', t[t.curveBuy >= 2.95]), ('all', t)]:
    g = x.groupby('age', observed=True).agg(launches=('mint', 'size'), devs=('dev', 'nunique'), drew=('active', 'mean'),
                                            outside60s=('outsideBuy60s', 'median'), v1=('pnlV1', 'mean'),
                                            v1med=('pnlV1', 'median')).reset_index()
    print(f'   {name}:')
    table(g)

print('\n== 3c. Launch order on the same post: the first launch against later ones (2.95+ SOL dev buys)')
t['tweet'] = t.xHandle + ':' + (t.ts - t.tweetAgeSec).astype('Int64').astype(str)
t = t.sort_values('ts')
t['order'] = t.groupby('tweet').cumcount() + 1
t['onTweet'] = t.groupby('tweet').mint.transform('size')
t['ord'] = t.order.map(lambda n: '1st' if n == 1 else '2nd' if n == 2 else '3rd-5th' if n <= 5 else '6th+')
x = t[t.curveBuy >= 2.95]
table(x.groupby('ord').agg(launches=('mint', 'size'), drew=('active', 'mean'), outside60s=('outsideBuy60s', 'median'),
                           v1=('pnlV1', 'mean'), v1med=('pnlV1', 'median')).reset_index())
multi = t[t.onTweet >= 2]
pair = pd.concat([multi[multi.order == 1].set_index('tweet').pnlV1.rename('first'),
                  multi[multi.order > 1].groupby('tweet').pnlV1.mean().rename('later')], axis=1).dropna()
gap = multi.groupby('tweet').ts.apply(lambda s: s.iloc[1] - s.iloc[0])
print(f'   {len(pair)} posts with 2+ launches (all dev buys): first launch {pair["first"].mean():+.2f} SOL, later ones '
      f'{pair.later.mean():+.2f} on the same post; the first did better on {(pair["first"] > pair.later).mean():.0%}. '
      f'The second launch came a median {gap.median():.0f} s after the first (25-75%: {gap.quantile(.25):.0f}-'
      f'{gap.quantile(.75):.0f} s).')
