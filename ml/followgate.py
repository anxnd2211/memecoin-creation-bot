"""Two checks after the first live batch (3 follower launches, all dead):

1. Was the backtest inflated by fake demand? Some "outside" buying on recorded launches is the dev's own: copy
   launches (one operator launching the same metadata from many fresh wallets) and bundles (create-slot buys from
   wallets that only ever buy that one dev's coins). Selling into your own wallets is not profit. This recomputes the
   playbook's result at a 2 SOL bag without them.
2. Should the follower only follow posts whose first launch is drawing buyers? Two of our three triggers were dead
   themselves (0.51 SOL and 0.00 SOL dev buys, no outside buying), and our launch came 14-19 s after each trigger, when
   its early flow was already on the feed. This splits recorded second launches by what their trigger drew in its
   first 3 s and 10 s.

Writes data/exports/block0.csv (create-slot buying per launch, by kind of buyer) for reuse.
Usage: python3 ml/followgate.py
"""
import os
import sqlite3
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import boot_ci, load, table  # noqa: E402

CACHE = 'data/exports/block0.csv'
df = load()
df = df[df.clearOfGaps].sort_values('ts').copy()

db = sqlite3.connect('file:data/observer.db?mode=ro', uri=True)
db.execute('PRAGMA busy_timeout = 5000')
uri = dict(db.execute('SELECT mint, uri FROM coins').fetchall())
uri_n = pd.Series(list(uri.values())).value_counts()
df['copied'] = df.mint.map(lambda m: uri_n.get(uri.get(m), 1) > 1)

if not os.path.exists(CACHE) or os.path.getmtime(CACHE) < os.path.getmtime('data/exports/launches.jsonl'):
    print('building', CACHE, '(create-slot buyers for every launch; a few minutes)', flush=True)
    rows = db.execute('''
      WITH first AS (SELECT mint_id, MIN(slot) AS s0 FROM trades GROUP BY mint_id)
      SELECT m.address, t.wallet_id, t.sol, c.creator, COALESCE(c.launcher, c.creator)
      FROM first f JOIN trades t ON t.mint_id = f.mint_id AND t.slot = f.s0 AND t.is_buy = 1
      JOIN ids m ON m.id = f.mint_id JOIN coins c ON c.mint = m.address
    ''').fetchall()
    b0 = pd.DataFrame(rows, columns=['mint', 'wallet', 'sol', 'creator', 'launcher'])
    idmap = dict(db.execute('SELECT address, id FROM ids WHERE address IN (SELECT creator FROM coins UNION SELECT launcher FROM coins)').fetchall())
    b0 = b0[(b0.wallet != b0.creator.map(idmap)) & (b0.wallet != b0.launcher.map(idmap))]
    reach = b0.groupby('wallet').creator.nunique()
    b0['kind'] = np.where(b0.wallet.map(reach) >= 5, 'bot', np.where(b0.wallet.map(reach) == 1, 'own', 'mid'))
    b0.pivot_table(index='mint', columns='kind', values='sol', aggfunc='sum', fill_value=0).to_csv(CACHE)
b0 = pd.read_csv(CACHE).set_index('mint')
for k in ['bot', 'own', 'mid']:
    df[f'b0{k}'] = df.mint.map(b0[k] if k in b0 else pd.Series(dtype=float)).fillna(0)
df['bundled'] = df.b0own >= 0.05
df['fake'] = df.copied | df.bundled

t = (df.xLink == 'tweet') & df.tweetAgeSec.notna()
df = df[t].copy()
df['post'] = df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec).astype(int).astype(str)
df['rank'] = df.groupby('post').cumcount()


def summary(d, col='pnlAt2'):
    lo, hi = boot_ci(d[col]) if len(d) >= 5 else (np.nan, np.nan)
    per_dev = d.groupby('dev')[col].mean()
    return pd.Series(dict(launches=len(d), devs=d.dev.nunique(), mean=d[col].mean(), lo=lo, hi=hi,
                          perDev=per_dev.mean(), median=d[col].median(), drew=d.active.mean(), profitable=(d[col] > 0).mean()))


print(f'\n== 1. First launches on posts under 2 min old: the playbook exit at a 2 SOL bag (pnlAt2)')
first = df[(df['rank'] == 0) & (df.tweetAgeSec <= 120)]
rows = [('all', first), ('no copy launches', first[~first.copied]), ('no bundles', first[~first.bundled]),
        ('neither (real demand only)', first[~first.fake])]
table(pd.DataFrame([summary(d).rename(name) for name, d in rows]).reset_index().rename(columns={'index': 'set'}))
print(f'   share of first launches that are copies or bundled: {first.fake.mean():.0%}')

print(f'\n== 2. Second launches (another dev, within 60 s of the first, post under 3 min old), by what the trigger drew')
f = df[df['rank'] == 0].set_index('post')
s = df[(df['rank'] == 1) & (df.tweetAgeSec <= 180)].copy()
s['gap'] = s.ts - s.post.map(f.ts)
s = s[(s.gap <= 60) & (s.dev != s.post.map(f.dev))]
s['trig3'] = s.post.map(f.outsideBuy3s)
s['trig10'] = s.post.map(f.outsideBuy10s)
s['trigFake'] = s.post.map(f.fake)
for name, d in [('all', s), ('real demand only (neither launch copied or bundled)', s[~s.fake & ~s.trigFake])]:
    print(f'\n   {name}:')
    d = d.assign(band=pd.cut(d.trig3, [-1, 0.05, 1, 5, 1e9], labels=['nothing', '<1 SOL', '1-5 SOL', '5+ SOL']))
    table(d.groupby('band', observed=True).apply(summary, include_groups=False).reset_index().rename(columns={'band': 'trigger 3 s'}))
    d = d.assign(band=pd.cut(d.trig10, [-1, 0.05, 1, 5, 1e9], labels=['nothing', '<1 SOL', '1-5 SOL', '5+ SOL']))
    table(d.groupby('band', observed=True).apply(summary, include_groups=False).reset_index().rename(columns={'band': 'trigger 10 s'}))


# 3. The gate as the live bot can measure it: the trigger's outside buying in its first 3 s, create-slot buys left out
# (a trigger's own bundle lands there; this version cannot be fooled by it).
print('\n== 3. Second launches, real demand only, by the trigger\'s first 3 s with create-slot buys left out')
r = s[~s.fake & ~s.trigFake].copy()
b0all = (f.b0bot + f.b0own + f.b0mid)
r['trigAfter0'] = (r.trig3 - r.post.map(b0all)).clip(lower=0)
r = r.assign(band=pd.cut(r.trigAfter0, [-1, 0.05, 0.5, 1, 1e9], labels=['nothing', '<0.5 SOL', '0.5-1 SOL', '1+ SOL']))
table(r.groupby('band', observed=True).apply(summary, include_groups=False).reset_index().rename(columns={'band': 'after slot 0'}))
for cut in [0.5, 1.0]:
    a, b = r[r.trigAfter0 >= cut], r[r.trigAfter0 < cut]
    print(f'   gate {cut} SOL: follow {len(a)} ({a.pnlAt2.mean():+.2f}, {(a.pnlAt2 > 0).mean():.0%} profitable), '
          f'skip {len(b)} ({b.pnlAt2.mean():+.2f}, {(b.pnlAt2 > 0).mean():.0%})')

# 4. Where first launches with real demand pay: post age and the X watcher's list.
print('\n== 4. First launches, real demand only: post age and whether the account is on the X watcher\'s list')
import json  # noqa: E402
watch = {a['handle'].lower() for a in json.load(open('data/watchlist.json'))['accounts']}
fr = first[~first.fake].copy()
fr['age'] = pd.cut(fr.tweetAgeSec, [-10, 30, 60, 120], labels=['<=30 s', '30-60 s', '60-120 s'])
fr['watched'] = fr.xHandle.str.lower().isin(watch)
table(fr.groupby('age', observed=True).apply(summary, include_groups=False).reset_index())
table(fr.groupby('watched').apply(summary, include_groups=False).reset_index())

# 5. A 2.43 SOL wallet buying 2 SOL, drawing each launch from real-demand first launches (pnlAt2: our bag and exit
# under their outside flow), with the bot's own stops: 3 dead in a row, the balance floor, 0.75 SOL down.
print('\n== 5. Bankroll: 2.43 SOL, 2 SOL launches drawn from real-demand first launches, up to 20 launches, 20,000 sessions')
rng = np.random.default_rng(11)
pool = fr.pnlAt2.to_numpy()
drew_pool = fr.active.to_numpy()
rows = []
for keep in [1.0, 0.75, 0.5]:
    ends, ns = [], []
    for _ in range(20000):
        bal, n, dead = 2.43, 0, 0
        while n < 20 and bal >= 2.025 + 0.15 and 2.43 - bal < 0.75 and dead < 3:
            i = rng.integers(len(pool))
            p, d = pool[i], bool(drew_pool[i])
            if d and rng.random() > keep:
                p, d = -0.055, False
            bal += max(p, -0.06) if not d else p
            n += 1
            dead = 0 if d else dead + 1
        ends.append(bal)
        ns.append(n)
    e = np.array(ends)
    rows.append(dict(ourHitRate=f'{keep:.0%}', launches=np.mean(ns), median=np.median(e), p05=np.percentile(e, 5),
                     p95=np.percentile(e, 95), P_loss=(e < 2.43).mean()))
table(pd.DataFrame(rows))


# 6. The dead-streak pause at a real hit rate near 1 in 3. A streak of 3 dead launches happens by chance about 30% of
# the time, so the pause (set when the hit rate looked like 65-88%) mostly stops healthy sessions. Same bankroll as 5,
# up to 10 launches a day, different pause lengths; the daily loss stop stays at 0.75 SOL for this wallet.
print('\n== 6. The dead-streak pause: 2.43 SOL, up to 10 launches, 20,000 sessions each')
rows = []
for pause in [3, 5, 6, 8, 99]:
    for keep in [1.0, 0.5]:
        ends, ns, paused = [], [], 0
        for _ in range(20000):
            bal, n, dead = 2.43, 0, 0
            while n < 10 and bal >= 2.025 + 0.15 and 2.43 - bal < 0.75 and dead < pause:
                i = rng.integers(len(pool))
                p, d = pool[i], bool(drew_pool[i])
                if d and rng.random() > keep:
                    p, d = -0.055, False
                bal += max(p, -0.06) if not d else p
                n += 1
                dead = 0 if d else dead + 1
            ends.append(bal)
            ns.append(n)
            paused += dead >= pause
        e = np.array(ends)
        rows.append(dict(pauseAfter=pause if pause < 99 else 'never', ourHitRate=f'{keep:.0%}', launches=np.mean(ns),
                         mean=e.mean() - 2.43, median=np.median(e) - 2.43, p05=np.percentile(e, 5) - 2.43,
                         P_loss=(e < 2.43).mean(), P_paused=paused / 20000))
table(pd.DataFrame(rows))
print('   (mean, median and p05 are the change from 2.43 SOL)')


# 7. Does the gate hold in each half of the record (by time)? A rule ships only if it points the same way in both.
print('\n== 7. The 1 SOL trigger gate in each half of the record (real demand only)')
cut = r.ts.median()
for name, h in [('first half', r[r.ts < cut]), ('second half', r[r.ts >= cut])]:
    a, b = h[h.trigAfter0 >= 1], h[h.trigAfter0 < 1]
    print(f'   {name}: follow {len(a)} {a.pnlAt2.mean():+.2f} ({(a.pnlAt2 > 0).mean():.0%} profitable, drew {a.active.mean():.0%}); '
          f'skip {len(b)} {b.pnlAt2.mean():+.2f} ({(b.pnlAt2 > 0).mean():.0%}, drew {b.active.mean():.0%})')
cutf = fr.ts.median()
for name, h in [('first half', fr[fr.ts < cutf]), ('second half', fr[fr.ts >= cutf])]:
    print(f'   first launches {name}: <=30 s {h[h.tweetAgeSec <= 30].pnlAt2.mean():+.2f}, '
          f'30-120 s {h[h.tweetAgeSec > 30].pnlAt2.mean():+.2f}; drew {h.active.mean():.0%}')
