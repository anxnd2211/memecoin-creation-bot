"""The X accounts worth watching for posts to launch on, ranked from our own feed.

An account qualifies when launches on its posts drew buyers and paid in the sniper band: 3+ launches on its posts by
2+ devs, and either 50%+ of them drew buyers or the first launch on its posts made more than average under the
playbook's exit. Spam accounts (one or two devs launching many coins on stale posts) drop out on both counts.

Two gates keep only accounts where OUR launch can be first. The watcher's pipeline takes about 10-30 s (draft, board,
the owner's approval), so an account only pays when the first launch often arrives 30 s or more after the post
(lateShare >= 0.3) and is not the posting dev's own bot (sameDevFirst < 0.6, which launches within seconds and can
never be beaten). Accounts that fail these still reach us through the launch-follower; they cost stream credits here
for races we lose.
Writes data/watchlist.json for the X watcher (src/live/xwatch.ts). Usage: python3 ml/watchlist.py [top=40]
"""
import json
import sys

import numpy as np

sys.path.insert(0, 'ml')
from common import load  # noqa: E402

top = int(sys.argv[1]) if len(sys.argv) > 1 else 40
df = load()
df = df[df.clearOfGaps & (df.xLink == 'tweet') & df.xHandle.notna() & df.tweetAgeSec.notna()].sort_values('ts').copy()
df['post'] = df.xHandle + ':' + (df.ts - df.tweetAgeSec).astype(int).astype(str)
first = df[~df.post.duplicated()]
g = df.groupby('xHandle').agg(launches=('mint', 'size'), devs=('dev', 'nunique'), drew=('active', 'mean'),
                              posts=('post', 'nunique'), medianAgeMin=('tweetAgeSec', lambda s: s.median() / 60))
f = first[first.curveBuy >= 2.95].groupby('xHandle').agg(firstLaunches=('mint', 'size'), firstAt5=('pnlAt5', 'mean'))
g = g.join(f, how='left')
g = g.join(first.groupby('xHandle').tweetAgeSec.agg(lambda s: (s >= 30).mean()).rename('lateShare'))
g = g.join(first.groupby('xHandle').dev.agg(lambda s: s.value_counts().iloc[0] / len(s)).rename('sameDevFirst'))
g = g.join(first.groupby('xHandle').pnlAt2.mean().rename('firstAt2'))
avg = first[first.curveBuy >= 2.95].pnlAt5.mean()
ok = ((g.launches >= 3) & (g.devs >= 2) & (g.medianAgeMin <= 60) & ((g.drew >= 0.5) | (g.firstAt5.fillna(-1) > avg))
      & (g.lateShare.fillna(0) >= 0.3) & (g.sameDevFirst.fillna(1) < 0.6))
w = g[ok].assign(score=lambda x: x.drew * 2 + x.firstAt5.fillna(avg) / max(avg, 1e-9) + np.log1p(x.posts) / 3)
w = w.sort_values('score', ascending=False).head(top)
out = [dict(handle=h, launches=int(r.launches), devs=int(r.devs), drew=round(float(r.drew), 2), posts=int(r.posts),
            lateShare=round(float(r.lateShare), 2), sameDevFirst=round(float(r.sameDevFirst), 2),
            firstAt2=None if np.isnan(r.firstAt2) else round(float(r.firstAt2), 2),
            firstAt5=None if np.isnan(r.firstAt5) else round(float(r.firstAt5), 2)) for h, r in w.iterrows()]
json.dump({'built': int(df.ts.max()), 'accounts': out}, open('data/watchlist.json', 'w'), indent=1)
print(f'{len(out)} accounts (of {len(g)} seen) written to data/watchlist.json; average first-launch result {avg:+.2f}')
for a in out[:15]:
    print(f"  @{a['handle']:20} launches {a['launches']:3}  devs {a['devs']:3}  drew {a['drew']:.0%}  "
          f"late {a['lateShare']:.0%}  sameDev {a['sameDevFirst']:.0%}  at 2 SOL {a['firstAt2']}  at 5 SOL {a['firstAt5']}")
