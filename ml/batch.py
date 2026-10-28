"""What a batch of 10 launches could make: a Monte Carlo over the recorded launches that met the playbook's rules.

Each simulated batch draws 10 launches from those launches' replayed results (5 SOL band, X link to the post, first
on it, post under 2 minutes; the v2 exit). Because our own coins may draw buyers less often than other devs' did,
the same is run with a share of the busy launches replaced by dead ones (what a dead 5 SOL launch costs).
Usage: python3 ml/batch.py [launches per batch=10] [single]
"""
import sys

import numpy as np

sys.path.insert(0, 'ml')
from common import load  # noqa: E402

n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
# Devs using extra wallets have those wallets' buys in the "outside" flow, which a single-wallet launch would not get:
# 'single' keeps only single-wallet launches, the honest comparison for ours.
single = len(sys.argv) > 2 and sys.argv[2] == 'single'
df = load()
df = df[df.clearOfGaps & df.metaKnown & ~df.tool.isin(['other', 'vercel-blob'])].sort_values('ts').copy()
t = (df.xLink == 'tweet') & df.tweetAgeSec.notna()
df['post'] = np.where(t, df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec.fillna(0)).astype(int).astype(str), None)
m = t & ~df.post.duplicated() & (df.tweetAgeSec <= 120) & df.curveBuy.between(4.9, 5.1)
if single:
    # Too few single-wallet launches at exactly 5 SOL: widen to 3-5 SOL and use our 5 SOL bag in their flow.
    m = t & ~df.post.duplicated() & (df.tweetAgeSec <= 120) & df.curveBuy.between(2.95, 5.1) & df.clean
    df['pnlV2'] = df.pnlAt5
x = df[m]
busy, dead = x[x.active].pnlV2.to_numpy(), x[~x.active].pnlV2.to_numpy()
# A dead launch for us: the worst-case fees on 5 SOL, rent, network and priority fees.
DEAD = -(5.0625 * 2 * 0.0095 / 1.0125 + 0.009 + 0.04)
rng = np.random.default_rng(7)
print(f'{len(x)} recorded launches met the rules ({len(busy)} drew buyers); a dead launch of ours costs about {DEAD:.3f} SOL')
print(f'{"our hit rate vs theirs":24} {"mean":>7} {"p05":>7} {"p25":>7} {"median":>7} {"p75":>7} {"P(loss)":>8} {"P(< -1)":>8}')
for keep in [1.0, 0.75, 0.5, 0.25]:
    tot = []
    for _ in range(20000):
        b = rng.choice(x.pnlV2.to_numpy(), n)
        drew = rng.random(n) < keep
        isbusy = np.isin(b, busy)
        b = np.where(isbusy & ~drew, DEAD, b)
        tot.append(b.sum())
    tot = np.array(tot)
    print(f'{f"{keep:.0%} of theirs":24} {tot.mean():7.2f} {np.percentile(tot, 5):7.2f} {np.percentile(tot, 25):7.2f} '
          f'{np.median(tot):7.2f} {np.percentile(tot, 75):7.2f} {(tot < 0).mean():8.1%} {(tot < -1).mean():8.1%}')
