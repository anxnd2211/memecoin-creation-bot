"""The final check: the playbook on launches made after the research data was sealed (SEAL), which no rule, plan or
model was chosen on. Usage: npm run export-launches && python3 ml/sealed.py [seal unix time]"""
import sys

import numpy as np

sys.path.insert(0, 'ml')
from common import load  # noqa: E402

SEAL = int(sys.argv[1]) if len(sys.argv) > 1 else 1793140500
rng = np.random.default_rng(7)


def ci(d):
    if len(d) < 3:
        return np.nan, np.nan
    b = [rng.choice(d, len(d)).mean() for _ in range(2000)]
    return np.percentile(b, 5), np.percentile(b, 95)


df = load()
df = df[df.clearOfGaps & (df.ts >= SEAL)].copy()
print(f'Sealed launches: {len(df)} ({df.time.min():%m-%d %H:%M}-{df.time.max():%H:%M} UTC)')
x = df[df.curveBuy >= 2.95]
d = (x.pnlV2 - x.pnlRecorded).to_numpy()
lo, hi = ci(d)
print(f'  exit, 2.95+ SOL launches ({len(x)}): v2 {x.pnlV2.mean():+.2f}, recorded devs {x.pnlRecorded.mean():+.2f}, '
      f'v2 minus recorded {d.mean():+.2f} (90% {lo:+.2f} to {hi:+.2f})')
for lo_, hi_, name in [(2.95, 3.01, '3 SOL'), (3.9, 4.1, '4 SOL'), (4.9, 5.1, '5 SOL'), (6.5, 7.5, '7 SOL'), (9.5, 10.5, '10 SOL')]:
    y = x[x.curveBuy.between(lo_, hi_) & ~x.tool.isin(['other', 'vercel-blob'])]
    if len(y):
        print(f'  dev buy {name}: {len(y)} launches by {y.dev.nunique()} devs, sniped {(y.outsideBuy1s > 1).mean():.0%}, '
              f'v2 exit {y.pnlV2.mean():+.2f} (per dev {y.groupby("dev").pnlV2.mean().mean():+.2f})')
t = df[(df.xLink == 'tweet') & df.tweetAgeSec.notna()].sort_values('ts')
t['post'] = t.xHandle.fillna('') + ':' + (t.ts - t.tweetAgeSec).astype(int).astype(str)
t['first'] = ~t.post.duplicated()
v2 = t[t.curveBuy.between(4.9, 5.1) & (t.tweetAgeSec <= 120) & t['first']]
band = t[t.curveBuy.between(2.95, 5.1) & (t.tweetAgeSec <= 120) & t['first']]
print(f'  launches meeting every v2 rule: {len(v2)}, mean {v2.pnlV2.mean():+.2f}, median {v2.pnlV2.median():+.2f}, '
      f'profitable {(v2.pnlV2 > 0).mean():.0%}')
print(f'  same rules at 3-5 SOL: {len(band)}, mean {band.pnlV2.mean():+.2f}; every launch with a 0.5+ SOL dev buy: '
      f'{(df.curveBuy >= 0.5).sum()}, mean {df[df.curveBuy >= 0.5].pnlV2.mean():+.2f}')
