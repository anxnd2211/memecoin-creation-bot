"""How the devs who made money sold: sell styles, timing and bag kept, and whether keeping part of the bag paid.

Each launch's recorded dev is put in one style by when and how much it sold (shares of the most it held):
  one sell     - sold 95%+ of the bag in a single transaction
  quick split  - several sells, 95%+ gone within 30 s of the first
  tranches     - several sells spread over more than 30 s, 95%+ gone by the end of the data
  moonbag      - sold, but kept over 5% of the bag to the end of the data
  held         - never sold
Every style is compared with the v1 exit replayed on the same launches, so a style is not credited for the coins it
happened to be used on. Usage: python3 ml/sells.py [hours=6] [min dev result SOL=0.5]
"""
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import load, table  # noqa: E402

hours = float(sys.argv[1]) if len(sys.argv) > 1 else 6
good_at = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
df = load()
df = df[df.clearOfGaps & (df.tool != 'vercel-blob')].copy()


def style(r):
    s = r.devSells
    if not s:
        return 'held'
    if r.devSoldByEnd < 0.95:
        return 'moonbag'
    if max(share for _, share, _ in s) >= 0.95:
        return 'one sell'
    first = s[0][0]
    by30 = sum(share for age, share, _ in s if age <= first + 30)
    return 'quick split' if by30 >= 0.95 else 'tranches'


df['style'] = df.apply(style, axis=1)
df['nSells'] = df.devSells.map(len)
df['good'] = df.pnlRecorded >= good_at
rng = np.random.default_rng(7)


def ci(d):
    if len(d) < 3:
        return np.nan, np.nan
    b = [rng.choice(d, len(d)).mean() for _ in range(2000)]
    return np.percentile(b, 5), np.percentile(b, 95)


def styles(d, title):
    print(f'\n== {title}: {len(d)} launches, {d.dev.nunique()} devs')
    rows = []
    for st in ['one sell', 'quick split', 'tranches', 'moonbag', 'held']:
        x = d[d['style'] == st]
        if not len(x):
            continue
        diff = (x.pnlRecorded - x.pnlV1).to_numpy()
        lo, hi = ci(diff)
        rows.append(dict(style=st, launches=len(x), share=len(x) / len(d), devs=x.dev.nunique(),
                         sells=x.nSells.median(), first_sell_s=x.devFirstSellSec.median(),
                         sold_by_30s=x.devSoldBy30s.median(), kept=(1 - x.devSoldByEnd.clip(0, 1)).median(),
                         dev_made=x.pnlRecorded.mean(), v1_made=x.pnlV1.mean(), dev_minus_v1=diff.mean(), lo=lo, hi=hi))
    table(pd.DataFrame(rows))


recent = df[df.ts >= time.time() - hours * 3600]
styles(recent[recent.good], f'Last {hours:g} h, devs that made {good_at:g}+ SOL')
styles(recent, f'Last {hours:g} h, every launch with a dev buy')
styles(df[df.good], f'Whole recording, devs that made {good_at:g}+ SOL')
styles(df[df.curveBuy >= 2.95], 'Whole recording, every launch with a 2.95+ SOL dev buy (the band we launch in)')

print('\n== When the good devs sold, against the outside flow')
g = recent[recent.good & (recent.nSells > 0)]
print(f'first sell: median {g.devFirstSellSec.median():.1f} s after launch '
      f'(25-75%: {g.devFirstSellSec.quantile(.25):.1f}-{g.devFirstSellSec.quantile(.75):.1f} s); '
      f'other wallets had put in a median {g.netBeforeFirstSell.median():.2f} SOL net before it')
print(f'bag sold by 10 s {g.devSoldBy10s.clip(0,1).median():.0%}, by 30 s {g.devSoldBy30s.clip(0,1).median():.0%}, '
      f'by 60 s {g.devSoldBy60s.clip(0,1).median():.0%}, by 5 min {g.devSoldBy300s.clip(0,1).median():.0%}')
first_share = g.devSells.map(lambda s: s[0][1])
print(f'first sell size: median {first_share.median():.0%} of the bag; '
      f'{(first_share >= .95).mean():.0%} sold it all in the first sell')

print('\n== Top 15 dev results in the window, and what v1 would have made on the same coin')
top = recent.sort_values('pnlRecorded', ascending=False).head(15)
for _, r in top.iterrows():
    sells = ' '.join(f'{a:g}s:{sh:.0%}' for a, sh, _ in r.devSells[:6]) + (' ...' if len(r.devSells) > 6 else '')
    print(f'{r.symbol[:10]:10} buy {r.curveBuy:5.2f} {r.tool:11} dev {r.pnlRecorded:+6.2f}  v1 {r.pnlV1:+6.2f}  '
          f'{r["style"]:11} {sells}')
