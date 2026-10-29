"""The X accounts worth watching for posts to launch on, ranked from our own feed.

An account qualifies when launches on its posts drew real buyers and paid at our bag: 3+ launches on its posts by
2+ devs, and either 50%+ of its real-demand launches drew buyers or the first launch on its posts made more than average
at a 2 SOL bag under the playbook's exit. "Real demand" leaves out copy launches and create-slot bundles
(src/sim/demand.ts): half of all first launches carried the dev's own buying, which made some accounts look busy
when nobody else was buying. Spam accounts (one or two devs launching many coins on stale posts) drop out too.

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
real = df[~df.fakeDemand]
realFirst = first[~first.fakeDemand]
g = df.groupby('xHandle').agg(launches=('mint', 'size'), devs=('dev', 'nunique'), posts=('post', 'nunique'),
                              medianAgeMin=('tweetAgeSec', lambda s: s.median() / 60))
g = g.join(real.groupby('xHandle').active.mean().rename('drew'))
f = realFirst.groupby('xHandle').agg(firstLaunches=('mint', 'size'), firstAt2=('pnlAt2', 'mean'), firstAt5=('pnlAt5', 'mean'))
g = g.join(f, how='left')
g = g.join(first.groupby('xHandle').tweetAgeSec.agg(lambda s: (s >= 30).mean()).rename('lateShare'))
g = g.join(first.groupby('xHandle').dev.agg(lambda s: s.value_counts().iloc[0] / len(s)).rename('sameDevFirst'))
avg = realFirst.pnlAt2.mean()
ok = ((g.launches >= 3) & (g.devs >= 2) & (g.medianAgeMin <= 60) & ((g.drew.fillna(0) >= 0.5) | (g.firstAt2.fillna(-1) > avg))
      & (g.lateShare.fillna(0) >= 0.3) & (g.sameDevFirst.fillna(1) < 0.6))
w = g[ok].assign(score=lambda x: x.drew.fillna(0) * 2 + x.firstAt2.fillna(avg) / max(avg, 1e-9) + np.log1p(x.posts) / 3)
w = w.sort_values('score', ascending=False).head(top)
out = [dict(handle=h, launches=int(r.launches), devs=int(r.devs), drew=round(float(0 if np.isnan(r.drew) else r.drew), 2), posts=int(r.posts),
            lateShare=round(float(r.lateShare), 2), sameDevFirst=round(float(r.sameDevFirst), 2),
            firstAt2=None if np.isnan(r.firstAt2) else round(float(r.firstAt2), 2),
            firstAt5=None if np.isnan(r.firstAt5) else round(float(r.firstAt5), 2)) for h, r in w.iterrows()]
json.dump({'built': int(df.ts.max()), 'accounts': out}, open('data/watchlist.json', 'w'), indent=1)
print(f'{len(out)} accounts (of {len(g)} seen) written to data/watchlist.json; average real-demand first launch at 2 SOL {avg:+.2f}')
for a in out[:15]:
    print(f"  @{a['handle']:20} launches {a['launches']:3}  devs {a['devs']:3}  drew {a['drew']:.0%}  "
          f"late {a['lateShare']:.0%}  sameDev {a['sameDevFirst']:.0%}  at 2 SOL {a['firstAt2']}  at 5 SOL {a['firstAt5']}")
