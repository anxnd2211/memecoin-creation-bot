"""Why our first live launches drew nobody: a cold wallet, or how the launch looks?

Our first three live launches (2026-10-28, 2.025 SOL, second on fresh posts, metadata on ipfs.io) drew no sniper buy at
all, while recorded launches under the same rules were sniped 74-79% of the time. Two explanations predict different
things in the record:

  A. Cold wallet: snipers answer devs with a history. Then devs with no earlier launch are sniped far less than devs
     with one, whatever the tool.
  B. How the launch looks: snipers answer some launch tools and not others. Then the gap follows the tool (the
     metadata URI host, and the metadata's fields), whatever the dev's history.

"No earlier launch" only counts launches we recorded, so a dev launching first after 12+ hours of recording is used
as the new-dev group (a dev active before recording began would usually have shown up by then).

Usage: python3 ml/coldstart.py
"""
import json
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, 'ml')
from common import boot_ci, load, table  # noqa: E402

OURS = ['2CzY87t9tiEFMGiuhapYXQc3VSvtaoHTZK988mY8pump', '3EeyQkeaa2YzatkXYStdu1xFXoTuDo2xhudnw9jypump',
        '3L5r9rK4TKXhNcu7RfJfdEzQPFitC7fZYfnvCZwTpump']

df = load()
start = df.ts.min()
df = df[df.clearOfGaps].sort_values('ts').copy()
df['sniped'] = df.outsideBuy1s > 1
t = (df.xLink == 'tweet') & df.tweetAgeSec.notna()
df['post'] = np.where(t, df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec.fillna(0)).astype(int).astype(str), None)
df['seat'] = np.where(~t, 'no post', np.where(~df.post.duplicated(), 'first', 'later'))
df['tier'] = pd.cut(df.curveBuy, [1.97, 2.03, 2.95, 3.05, 3.95, 4.05, 4.9, 5.1], labels=['2', 'x', '3', 'y', '4', 'z', '5'])
df = df[df.tier.isin(['2', '3', '4', '5'])].copy()
df['tier'] = df.tier.astype(str)
df['history'] = np.where(df.devPriorLaunches > 0, 'has launched', np.where(df.ts - start >= 12 * 3600, 'new (12h+ unseen)', 'unknown'))

print(f'recording {pd.to_datetime(start, unit="s", utc=True):%m-%d %H:%M} to {df.time.max():%m-%d %H:%M} UTC; '
      f'{len(df)} launches at an exact tier (2/3/4/5 SOL into the curve)\n')

print('== Our launches in the record')
ours = load()
ours = ours[ours.mint.isin(OURS)]
table(ours[['symbol', 'tool', 'devBuySol', 'tweetAgeSec', 'devPriorLaunches', 'outsideBuy1s', 'outsideBuy10s', 'snipers', 'active']])


def rate(d):
    lo, hi = boot_ci(d.sniped.astype(float)) if len(d) >= 5 else (np.nan, np.nan)
    return pd.Series(dict(launches=len(d), devs=d.dev.nunique(), sniped=d.sniped.mean(), lo=lo, hi=hi,
                          drew=d.active.mean(), outside1s=d.outsideBuy1s.median()))


print('\n== A. Snipe rate by dev history (fresh tweet posts only, ipfs.io tool, first launch on the post)')
x = df[(df.seat == 'first') & (df.tool == 'ipfs.io') & (df.tweetAgeSec <= 120)]
table(x.groupby(['tier', 'history']).apply(rate, include_groups=False).reset_index())

print('\n== B. Snipe rate by launch tool (fresh tweet posts, any seat, any history)')
x = df[(df.seat != 'no post') & (df.tweetAgeSec <= 120)]
table(x.groupby(['tier', 'tool']).apply(rate, include_groups=False).reset_index().query('launches >= 10'))

print('\n== C. New devs only: by tool and seat (fresh tweet posts)')
x = df[(df.history == 'new (12h+ unseen)') & (df.seat != 'no post') & (df.tweetAgeSec <= 120)]
table(x.groupby(['tool', 'seat']).apply(rate, include_groups=False).reset_index().query('launches >= 5'))

print('\n== D. Seat on the post, ipfs.io tool, fresh tweet posts: first vs later, by history')
x = df[(df.tool == 'ipfs.io') & (df.seat != 'no post') & (df.tweetAgeSec <= 180)]
table(x.groupby(['seat', 'history']).apply(rate, include_groups=False).reset_index())

print('\n== E. 2 SOL tier, ipfs.io: who are the devs that get sniped? (prior launches, prior busy)')
x = df[(df.tier == '2') & (df.tool == 'ipfs.io')]
x = x.assign(priorBand=pd.cut(x.devPriorLaunches, [-1, 0, 2, 10, 1e9], labels=['0', '1-2', '3-10', '>10']))
table(x.groupby('priorBand', observed=True).apply(rate, include_groups=False).reset_index())


# F over-corrects and is kept for the record: dropping every launch with create-slot buying also drops the real
# block-0 buying of independent sniper bots, which G shows is common. G separates the two; src/sim/demand.ts uses G's
# rule (a bundle is create-slot buying by wallets that only buy one dev's coins).
# F. The same question without two contaminations found in A-E: copy launches (one operator launching the same
# metadata from many fresh wallets, often buying their own coins) and bundles (outside buys landing in the create
# slot, which no sniper reacting to the launch can do). An independent snipe is a buy from another wallet landing 1-5
# slots (~0.2-1.1 s) after the create.
import sqlite3  # noqa: E402

db = sqlite3.connect('file:data/observer.db?mode=ro', uri=True)
db.execute('PRAGMA busy_timeout = 5000')
uri_count = dict(db.execute("SELECT uri, COUNT(*) FROM coins WHERE uri IS NOT NULL GROUP BY uri HAVING COUNT(*) > 1").fetchall())
ids = {}


def wid(address):
    if address not in ids:
        r = db.execute('SELECT id FROM ids WHERE address = ?', (address,)).fetchone()
        ids[address] = r[0] if r else -1
    return ids[address]


def flow(mint):
    c = db.execute('SELECT uri, creator, launcher FROM coins WHERE mint = ?', (mint,)).fetchone()
    if not c:
        return None
    dev = {wid(c[1]), wid(c[2] or c[1])}
    rows = db.execute('SELECT slot, wallet_id, is_buy, sol FROM trades WHERE mint_id = ? ORDER BY slot LIMIT 400', (wid(mint),)).fetchall()
    if not rows:
        return None
    s0 = rows[0][0]
    same = sum(sol or 0 for slot, w, b, sol in rows if b and w not in dev and slot == s0)
    indep = sum(sol or 0 for slot, w, b, sol in rows if b and w not in dev and 1 <= slot - s0 <= 5)
    wallets = len({w for slot, w, b, sol in rows if b and w not in dev and 1 <= slot - s0 <= 5})
    return dict(copied=uri_count.get(c[0], 1) > 1, bundleSol=same, snipeSol=indep, snipeWallets=wallets)


base = df[(df.seat != 'no post') & (df.tweetAgeSec <= 180)].copy()
extra = {m: flow(m) for m in base.mint}
base = base[base.mint.map(lambda m: extra.get(m) is not None)].copy()
for k in ['copied', 'bundleSol', 'snipeSol', 'snipeWallets']:
    base[k] = base.mint.map(lambda m: extra[m][k])
base['indepSniped'] = base.snipeSol >= 0.5
clean = base[~base.copied & (base.bundleSol < 0.05)]


def rate2(d):
    lo, hi = boot_ci(d.indepSniped.astype(float)) if len(d) >= 5 else (np.nan, np.nan)
    return pd.Series(dict(launches=len(d), devs=d.dev.nunique(), indepSniped=d.indepSniped.mean(), lo=lo, hi=hi,
                          snipeSol=d.snipeSol.median(), drew=d.active.mean()))


print(f'\n== F. Independent snipes (1-5 slots after the create, 0.5+ SOL), copy launches and bundled launches removed '
      f'({len(base) - len(clean)} of {len(base)} dropped)')
table(clean.groupby(['tier', 'history']).apply(rate2, include_groups=False).reset_index())
print('\n   by tool, 2 SOL tier, any history:')
table(clean[clean.tier == '2'].groupby(['tool', 'seat']).apply(rate2, include_groups=False).reset_index().query('launches >= 5'))
print('\n   by seat, every tier, ipfs.io:')
table(clean[clean.tool == 'ipfs.io'].groupby(['seat', 'history']).apply(rate2, include_groups=False).reset_index())
print(f"\n   dropped as copy launches: {int(base.copied.sum())}; as bundled (0.05+ SOL in the create slot): "
      f"{int(((~base.copied) & (base.bundleSol >= 0.05)).sum())}")


# G. Who buys in the create slot? A wallet buying block-0 on launches by many unrelated devs is an independent sniper
# bot; one that only ever buys block-0 on one dev's launches is that dev's own (bundled) wallet. If independent
# block-0 snipers are common, sniping is still a strategy; if block-0 buying is almost all the dev's own, the "sniped"
# share in A-E measured bundles, not demand.
rows = db.execute('''
  SELECT c.mint, c.creator, COALESCE(c.launcher, c.creator) AS launcher, c.uri, t.wallet_id, t.sol
  FROM coins c JOIN ids m ON m.address = c.mint
  JOIN trades t ON t.mint_id = m.id
  WHERE c.created_ts >= ? AND t.is_buy = 1
    AND t.slot = (SELECT MIN(slot) FROM trades WHERE mint_id = m.id)
''', (int(start),)).fetchall()
b0 = pd.DataFrame(rows, columns=['mint', 'creator', 'launcher', 'uri', 'wallet', 'sol'])
b0 = b0[b0.wallet != b0.creator.map(wid)]
b0 = b0[b0.wallet != b0.launcher.map(wid)]
reach = b0.groupby('wallet').creator.nunique()
b0['buyer'] = np.where(b0.wallet.map(reach) >= 5, 'multi-dev bot (5+ devs)', np.where(b0.wallet.map(reach) >= 2, '2-4 devs', 'one dev only'))
tool = df.set_index('mint').tool
b0['tool'] = b0.mint.map(tool).fillna('?')
print('\n== G. Block-0 buying (create slot, not the dev) by who buys and the launch tool: SOL and launches reached')
g = b0.groupby(['tool', 'buyer']).agg(sol=('sol', 'sum'), launches=('mint', 'nunique')).reset_index()
table(g[g.tool.isin(['ipfs.io', 'j7tracker', 'uxento', 'rapidlaunch', 'pinata', 'other'])])
print(f'\n   block-0 buyer wallets: {len(reach)}; reaching 5+ devs: {int((reach >= 5).sum())}')
