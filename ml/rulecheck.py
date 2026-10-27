"""Playbook launch rules side by side on the research halves and the sealed launches (never used to choose them).

v2: 5 SOL band, the X link is the post, first launch on it, post at most 2 min old.
v3: v2, plus a website that is the narrative's source (not a promo or trading-tool site), a source account not
    launched on 3+ times in the hour before, and the dev's previous launch at least 10 min earlier.
Usage: python3 ml/rulecheck.py
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import load  # noqa: E402
from exits import SEAL  # noqa: E402

# Websites that are not a narrative's source: promo and referral pages and trading tools seen across unrelated launches.
NOT_SOURCE = ('otcdesks.cash', 'axiom.trade', 'usepaid.app', 'launchdap.fun', 'coincommunities.org', 'pump.fun',
              'dexscreener.com', 'gmgn.ai', 'photon-sol.tinyastro.io', 'bullx.io', 't.me')
rng = np.random.default_rng(7)

df = load()
df = df[df.clearOfGaps & df.metaKnown & ~df.tool.isin(['other', 'vercel-blob'])].sort_values('ts').copy()
t = (df.xLink == 'tweet') & df.tweetAgeSec.notna()
df['post'] = np.where(t, df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec.fillna(0)).astype(int).astype(str), None)
df['first'] = t & ~df.post.duplicated()
ts, hh = df.ts.to_numpy(), df.xHandle.where(t).to_numpy()
df['srcHour'] = [((hh == h) & (ts < x) & (ts >= x - 3600)).sum() if isinstance(h, str) else 0 for h, x in zip(hh, ts)]
site = df.website.fillna('')
df['sourceSite'] = (site != '') & (site != '?') & ~site.map(lambda h: any(h.endswith(n) for n in NOT_SOURCE))
v2 = df['first'] & (df.tweetAgeSec <= 120)
v3 = v2 & df.sourceSite & (df.srcHour < 3) & (df.devLastLaunchAgoSec.fillna(1e9) >= 600)

half = df[df.ts < SEAL].ts.quantile(0.5)
periods = [('research, earlier half', df.ts < half), ('research, later half', (df.ts >= half) & (df.ts < SEAL)),
           ('sealed', df.ts >= SEAL)]
rows = []
for band, bm in [('5 SOL', df.curveBuy.between(4.9, 5.1)), ('3-5 SOL', df.curveBuy.between(2.95, 5.1))]:
    for pname, pm in periods:
        for rname, rm in [('v2 rules', v2), ('v3 rules', v3), ('v2 but not v3', v2 & ~v3)]:
            x = df[bm & pm & rm]
            if not len(x):
                continue
            b = [rng.choice(x.pnlV2.to_numpy(), len(x)).mean() for _ in range(1000)] if len(x) > 2 else [np.nan]
            rows.append(dict(band=band, period=pname, rules=rname, launches=len(x), devs=x.dev.nunique(),
                             drew=x.active.mean(), mean=x.pnlV2.mean(), lo=np.percentile(b, 5), hi=np.percentile(b, 95),
                             median=x.pnlV2.median(), profitable=(x.pnlV2 > 0).mean()))
print(pd.DataFrame(rows).to_string(index=False, float_format=lambda v: f'{v:.2f}'))
s = df[df.ts >= SEAL]
print(f'\nSealed launches: {len(s)} ({s.time.min():%H:%M}-{s.time.max():%H:%M} UTC)')
