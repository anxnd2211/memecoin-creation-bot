"""What makes the best coin on the best post: a scan of design and context features, kept only if it replicates.

Two tests per feature, each run on the earlier and the later half of the research launches separately:
  same post   launches that linked the same X post are compared with each other (each launch minus its post's
              average), so the narrative is held fixed and only the design differs; dev buy and launch order are
              controlled. This is the test for design: name, ticker, description, website, Telegram.
  across      every launch in the sniper band, the outcome minus what dev buy, tool, post age and launch order
              predict, by feature. This is the test for context: source account, hour, ticker waves.
A feature counts only if it moves the outcome the same way, at p < 0.05, in both halves (and the survivors are then
checked on the sealed launches by ml/sealed.py). With a few hundred tests, about 1 in 400 passes both halves by luck.

Outcomes: drew buyers (the dev screen's busy), and pnlAt5, what our 5 SOL bag would have made in the launch's flow.
Usage: python3 ml/design.py
"""
import re
import sys
import unicodedata

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, 'ml')
from common import load  # noqa: E402
from exits import SEAL  # noqa: E402

WORDS = ['coin', 'token', 'inu', 'doge', 'pepe', 'cat', 'dog', 'frog', 'ai', 'trump', 'elon', 'musk', 'sol', 'meme',
         'moon', 'baby', 'king', 'the', 'official', 'grok', 'ceo', 'gpt', 'bull', 'bear', 'chad', 'wojak']
SITES = {'x.com': 'x', 'twitter.com': 'x', 'youtube.com': 'youtube', 'youtu.be': 'youtube', 'tiktok.com': 'tiktok',
         'instagram.com': 'instagram', 'reddit.com': 'reddit', 'wikipedia.org': 'wikipedia', 'github.com': 'github',
         'truthsocial.com': 'truth', 't.me': 'telegram', 'pump.fun': 'pumpfun', 'dexscreener.com': 'dexscreener'}


def emoji(s):
    return any(unicodedata.category(ch) in ('So', 'Sk') or ord(ch) > 0x2000 for ch in s)


def features(df: pd.DataFrame) -> pd.DataFrame:
    name = df.name.fillna('')
    sym = df.symbol.fillna('')
    desc = df.description.fillna('')
    site = df.website.fillna('')
    handle = df.xHandle.fillna('')
    f = {}
    f['ticker 1-3 chars'] = sym.str.len() <= 3
    f['ticker 4-5 chars'] = sym.str.len().between(4, 5)
    f['ticker 6-8 chars'] = sym.str.len().between(6, 8)
    f['ticker 9+ chars'] = sym.str.len() >= 9
    f['ticker all caps'] = (sym == sym.str.upper()) & sym.str.contains('[A-Z]')
    f['ticker lower case'] = (sym == sym.str.lower()) & sym.str.contains('[a-z]')
    f['ticker has digits'] = sym.str.contains(r'\d')
    f['ticker has emoji or non-latin'] = sym.map(lambda s: any(ord(c) > 127 for c in s))
    f['ticker equals name'] = sym.str.lower().str.replace(r'\W', '', regex=True) == name.str.lower().str.replace(r'\W', '', regex=True)
    f['ticker inside name'] = [bool(s) and s.lower() in n.lower() for s, n in zip(sym, name)]
    f['ticker is initials of name'] = [len(n.split()) > 1 and s.upper() == ''.join(w[0] for w in n.split()).upper() for s, n in zip(sym, name)]
    f['name 1 word'] = name.str.split().str.len() == 1
    f['name 2-3 words'] = name.str.split().str.len().between(2, 3)
    f['name 4+ words'] = name.str.split().str.len() >= 4
    f['name 20+ chars'] = name.str.len() >= 20
    f['name all caps'] = (name == name.str.upper()) & name.str.contains('[A-Z]')
    f['name has emoji or non-latin'] = name.map(lambda s: emoji(s) or any(ord(c) > 127 for c in s))
    f['name has digits'] = name.str.contains(r'\d')
    f['name mentions the post account'] = [bool(h) and (h.lower() in n.lower().replace(' ', '')) for h, n in zip(handle, name)]
    for w in WORDS:
        f[f'name has "{w}"'] = name.str.lower().str.contains(rf'\b{w}\b', regex=True)
    f['no description'] = desc.str.len() == 0
    f['description under 40 chars'] = desc.str.len().between(1, 39)
    f['description 40-150 chars'] = desc.str.len().between(40, 150)
    f['description 150+ chars'] = desc.str.len() > 150
    f['description has a link'] = desc.str.contains('http|www\\.|\\.com', case=False)
    f['description has emoji'] = desc.map(emoji)
    f['description quotes the post account'] = [bool(h) and h.lower() in d.lower() for h, d in zip(handle, desc)]
    f['description says CTO or community'] = desc.str.contains(r'\bcto\b|community', case=False)
    f['description says official'] = desc.str.contains(r'official', case=False)
    f['description all caps'] = (desc == desc.str.upper()) & desc.str.contains('[A-Z]{4}')
    f['no website'] = site == ''
    kinds = site.map(lambda h: next((v for k, v in SITES.items() if h.endswith(k)), 'other site' if h else ''))
    for k in sorted(set(SITES.values()) | {'other site'}):
        f[f'website is {k}'] = kinds == k
    f['telegram'] = df.telegram.fillna(False).astype(bool)
    f['X link is the post'] = df.xLink == 'tweet'
    f['X link is a community'] = df.xLink == 'community'
    f['X link is a profile'] = df.xLink == 'profile'
    return pd.DataFrame(f, index=df.index).astype(float)


def context(df: pd.DataFrame) -> pd.DataFrame:
    f = {}
    for h in range(24):
        if (df.hourUtc == h).sum() >= 30:
            f[f'hour {h:02d} UTC'] = df.hourUtc == h
    f['ticker wave: none before'] = df.waveBefore == 0
    f['ticker wave: 1-2 before'] = df.waveBefore.between(1, 2)
    f['ticker wave: 3+ before'] = df.waveBefore >= 3
    f['ticker wave already has a busy coin'] = df.waveBusyBefore >= 1
    f['dev first seen'] = df.devPriorLaunches == 0
    f['dev launched within the last 10 min'] = df.devLastLaunchAgoSec.fillna(1e9) <= 600
    f['dev has a busy launch before'] = df.devPriorBusy >= 1
    f['dev has 5+ earlier launches'] = df.devPriorLaunches >= 5
    f['post account seen 3+ times before'] = df.srcPrior >= 3
    f['post account new'] = df.srcPrior == 0
    f['post account mostly busy before'] = (df.srcPrior >= 3) & (df.srcRate >= 0.6)
    f['post account mostly dead before'] = (df.srcPrior >= 3) & (df.srcRate < 0.3)
    f['post account launched on 3+ times in the last hour'] = df.srcHour >= 3
    return pd.DataFrame(f, index=df.index).astype(float)


def prepare():
    df = load()
    df = df[df.clearOfGaps & (df.ts < SEAL) & df.metaKnown & ~df.tool.isin(['other', 'vercel-blob']) & (df.curveBuy >= 0.5)]
    df = df.sort_values('ts').copy()
    t = df.xLink == 'tweet'
    df['post'] = np.where(t, df.xHandle.fillna('') + ':' + (df.ts - df.tweetAgeSec.fillna(0)).astype(int).astype(str), None)
    df['order'] = df.groupby('post').cumcount().where(t)
    h = df.xHandle.where(t)
    df['srcPrior'] = df.groupby(h).cumcount().where(t).fillna(0)
    df['srcRate'] = ((df.groupby(h).active.cumsum() - df.active) / df.srcPrior.replace(0, np.nan)).fillna(0)
    ts = df.ts.to_numpy()
    df['srcHour'] = [((df.xHandle == hh) & (ts < x) & (ts >= x - 3600)).sum() if isinstance(hh, str) else 0
                     for hh, x in zip(df.xHandle.where(t), ts)]
    df['logBuy'] = np.log(df.curveBuy)
    df['ageLog'] = np.log1p(df.tweetAgeSec.clip(lower=0)).fillna(10)
    df['isFirst'] = (df.order == 0).astype(float)
    return df


def ols_effect(y, x, controls):
    """Coefficient of x in y ~ x + controls, with its p-value."""
    X = np.column_stack([np.ones(len(y)), x] + controls)
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    dof = max(1, len(y) - X.shape[1])
    cov = np.linalg.pinv(X.T @ X) * (resid @ resid) / dof
    se = np.sqrt(max(cov[1, 1], 1e-18))
    return beta[1], 2 * stats.t.sf(abs(beta[1] / se), dof)


def scan(df, F, outcome, within_post):
    rows = []
    half = df.ts.quantile(0.5)
    for col in F.columns:
        res = []
        for part in [df.ts < half, df.ts >= half]:
            d, x = df[part], F[col][part]
            if within_post:
                keep = d.post.notna() & (d.groupby('post').mint.transform('size') >= 2)
                d, x = d[keep], x[keep]
                if x.nunique() < 2 or x.groupby(d.post).std().fillna(0).sum() == 0:
                    res.append((np.nan, np.nan, 0))
                    continue
                dm = lambda v: v - v.groupby(d.post).transform('mean')  # noqa: E731
                b, p = ols_effect(dm(d[outcome].astype(float)).to_numpy(), dm(x).to_numpy(),
                                  [dm(d.logBuy).to_numpy(), dm(d.isFirst).to_numpy()])
            else:
                if x.sum() < 10 or (1 - x).sum() < 10:
                    res.append((np.nan, np.nan, int(x.sum())))
                    continue
                tools = [(d.tool == k).astype(float).to_numpy() for k in ['j7tracker', 'uxento', 'rapidlaunch']]
                b, p = ols_effect(d[outcome].astype(float).to_numpy(), x.to_numpy(),
                                  [d.logBuy.to_numpy(), d.ageLog.to_numpy(), d.isFirst.fillna(0).to_numpy(), *tools])
            res.append((b, p, int(x.sum())))
        (b1, p1, n1), (b2, p2, n2) = res
        rows.append(dict(feature=col, n1=n1, effect1=b1, p1=p1, n2=n2, effect2=b2, p2=p2,
                         replicates=bool(p1 < 0.05 and p2 < 0.05 and np.sign(b1) == np.sign(b2))))
    return pd.DataFrame(rows)


def main():
    df = prepare()
    D, C = features(df), context(df)
    tests = 0
    for outcome in ['active', 'pnlAt5']:
        for name, F, within, d in [('design, same post', D, True, df),
                                   ('design, across launches (2.95+ SOL)', D, False, df[df.curveBuy >= 2.95]),
                                   ('context, across launches (2.95+ SOL)', C, False, df[df.curveBuy >= 2.95])]:
            r = scan(d, F.loc[d.index], outcome, within)
            tests += len(r)
            rep = r[r.replicates]
            print(f'\n== {name}, outcome {outcome}: {len(r)} features, {len(rep)} replicate in both halves')
            if len(rep):
                print(rep[['feature', 'n1', 'effect1', 'p1', 'n2', 'effect2', 'p2']].to_string(
                    index=False, float_format=lambda v: f'{v:.3f}'))
            near = r[~r.replicates & (r[['p1', 'p2']].max(axis=1) < 0.2) & (np.sign(r.effect1) == np.sign(r.effect2))]
            if len(near):
                print('   consistent but not significant in both halves: ' +
                      '; '.join(f'{x.feature} ({x.effect1:+.2f}/{x.effect2:+.2f})' for x in near.itertuples()))
    print(f'\n{tests} tests in all; at p < 0.05 in both halves with the same sign, about {tests * 0.05 * 0.05 / 2:.1f} would pass by luck.')


if __name__ == '__main__':
    main()
