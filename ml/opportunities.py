"""Which posts to launch on, how fast, and how many chances an hour.

The unit is a post: an X post that at least one launch linked. Being first on a post is what the playbook aims for,
so each post is scored by its first launch, made with a dev buy in the sniper band (2.95+ SOL, spam tool left out),
and by what our 5 SOL bag would have made in that launch's flow (`pnlAt5`, the same-flow replay).

  1. Speed: the first launch's result by how old the post was, in fine steps.
  2. Source accounts: each account's record before the post (time-respecting), split into tiers; tiers are scored on
     later posts only, so the ranking is tested the way it will be used.
  3. Chances an hour: how many first-on-post opportunities each tier gives, and the SOL an hour if we took them one
     at a time.

Usage: python3 ml/opportunities.py
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import load, table  # noqa: E402

SEAL = 1793140500  # 2026-10-27T22:35Z, as in ml/exits.py
df = load()
df = df[df.clearOfGaps & (df.ts < SEAL)].copy()
t = df[(df.xLink == 'tweet') & df.xHandle.notna() & df.tweetAgeSec.notna()].copy()
t['postTs'] = t.ts - t.tweetAgeSec
t['post'] = t.xHandle + ':' + t.postTs.astype(int).astype(str)
t = t.sort_values('ts')
t['order'] = t.groupby('post').cumcount()
t['onPost'] = t.groupby('post').mint.transform('size')
first = t[(t.order == 0) & (t.curveBuy >= 2.95) & (t.tool != 'other') & (t.tool != 'vercel-blob')].copy()
rng = np.random.default_rng(7)


def ci(x):
    if len(x) < 3:
        return np.nan, np.nan
    b = [rng.choice(x, len(x)).mean() for _ in range(2000)]
    return np.percentile(b, 5), np.percentile(b, 95)


print(f'== 1. First launch on a post (2.95+ SOL, {len(first)} posts): result by the post\'s age at launch')
bins = [-1, 3, 10, 20, 30, 60, 120, 300, 1e9]
labels = ['0-3s', '3-10s', '10-20s', '20-30s', '30-60s', '1-2m', '2-5m', '>5m']
first['age'] = pd.cut(first.tweetAgeSec.clip(lower=0), bins, labels=labels)
g = first.groupby('age', observed=True).agg(posts=('mint', 'size'), drew=('active', 'mean'), recorded=('pnlV2', 'mean'),
                                            at5=('pnlAt5', 'mean'), at5med=('pnlAt5', 'median'),
                                            laterLaunches=('onPost', lambda s: (s - 1).mean())).reset_index()
g['lo'], g['hi'] = zip(*[ci(first[first.age == a].pnlAt5.to_numpy()) for a in g.age])
table(g)

# 2. Source accounts: record before each post, from all launches on that account's posts (any dev buy).
t['busy'] = t.active.astype(float)
acc = t.groupby('xHandle')
t['srcPrior'] = acc.cumcount()
t['srcPriorBusy'] = acc.busy.cumsum() - t.busy
t['srcPriorPosts'] = t.groupby('xHandle').post.transform(lambda s: (~s.duplicated()).cumsum()) - 1
first = first.join(t[['srcPrior', 'srcPriorBusy']], how='left')
first['srcRate'] = (first.srcPriorBusy + 2 * 0.45) / (first.srcPrior + 2)


def tier(r):
    if r.srcPrior == 0:
        return 'new account'
    if r.srcPrior >= 3 and r.srcRate >= 0.6:
        return 'proven (3+ launches, 60%+ busy)'
    if r.srcRate >= 0.45:
        return 'decent'
    return 'weak'


first['tier'] = first.apply(tier, axis=1)
half = first.ts.quantile(0.5)
print('\n== 2. Source-account tiers (record before the post only); later half of the hours = posts the tiers never saw')
rows = []
for name, d in [('all hours', first), ('later half', first[first.ts >= half])]:
    for tr, x in d.groupby('tier'):
        lo, hi = ci(x.pnlAt5.to_numpy())
        rows.append(dict(period=name, tier=tr, posts=len(x), accounts=x.xHandle.nunique(), drew=x.active.mean(),
                         at5=x.pnlAt5.mean(), lo=lo, hi=hi, median=x.pnlAt5.median(), fastShare=(x.tweetAgeSec <= 30).mean()))
table(pd.DataFrame(rows))

print('\n== 3. Chances an hour (posts first-launched in the band, hours with recording) and SOL an hour at 5 SOL')
hours = df.ts.groupby((df.ts // 3600)).size()
n_hours = (hours > 50).sum()
rows = []
for name, mask in [('every post', np.ones(len(first), bool)),
                   ('post under 30 s old', first.tweetAgeSec <= 30),
                   ('not a weak account', first.tier != 'weak'),
                   ('not weak, under 30 s', (first.tier != 'weak') & (first.tweetAgeSec <= 30)),
                   ('proven accounts only', first.tier.str.startswith('proven'))]:
    x = first[mask]
    rows.append(dict(rule=name, posts=len(x), perHour=len(x) / n_hours, at5=x.pnlAt5.mean(),
                     solPerHour=x.pnlAt5.sum() / n_hours, drew=x.active.mean()))
table(pd.DataFrame(rows))
print(f'   ({n_hours} recorded hours; one launch at a time ties up the dev buy for 10 s to 2 min, so tens of '
      f'launches an hour fit; the limit is posts, not SOL)')

print('\n== 4. Bigger dev buys in the best spots: same-flow replay of first launches on posts under 30 s old')
x = first[first.tweetAgeSec <= 30]
print('   ' + ', '.join(f"{c.replace('pnlAt', '')} SOL {x[c].mean():+.2f}" for c in ['pnlAt3', 'pnlAt5', 'pnlAt7', 'pnlAt10']) +
      f'   (worst launch at 10 SOL {x.pnlAt10.min():+.2f})')
big = df[df.tool.isin(['j7tracker', 'uxento', 'rapidlaunch', 'ipfs.io'])]
big = big.assign(band=np.select([big.curveBuy.between(4.9, 5.1), big.curveBuy.between(9.5, 10.5)], ['5', '10'], ''))
per = big[big.band != ''].groupby(['dev', 'band']).pnlV2.mean().unstack()
both = per.dropna()
if len(both) >= 3:
    d = (both['10'] - both['5']).to_numpy()
    lo, hi = ci(d)
    print(f'   same dev at 10 vs 5 SOL: {d.mean():+.2f} a launch (90% {lo:+.2f} to {hi:+.2f}) over {len(d)} devs')
else:
    print(f'   only {len(both)} devs launched at both 5 and 10 SOL: not enough to compare within devs')
snip = big[big.band != ''].groupby('band').apply(lambda d: pd.Series(dict(launches=len(d), devs=d.dev.nunique(),
                                                                          sniped=(d.outsideBuy1s > 1).mean())))
print('   ' + '; '.join(f'{b} SOL: {int(r.launches)} launches by {int(r.devs)} devs, sniped {r.sniped:.0%}' for b, r in snip.iterrows()))
