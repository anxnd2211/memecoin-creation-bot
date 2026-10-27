"""Exit research on launch paths: how close can an exit get to the best moment to sell, on launches it never saw?

  ceiling  the best single whole-bag sell in hindsight, per launch: no exit can beat it
  v2       the playbook's flow exit
  rules    flow exits whose settings depend on how the launch started (its first 3 seconds of buying)
  learned  policy improvement over v2: at each slot a model predicts what holding on (and then following v2) would add
           over selling now; sell at the first slot it predicts no gain. Trained on the other time blocks only.

Each method is scored on 4 time blocks, each held out in turn, against v2 on the same launches with a 90% bootstrap
interval. Launches after SEAL are left out entirely: they are the final check.

Usage: python3 ml/exits.py [min dev buy SOL=2.95]
"""
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

sys.path.insert(0, 'ml')
from common import load  # noqa: E402
from paths import SLOT, first_true, flow_exit, load_paths, static_features  # noqa: E402

SEAL = 1793140500  # 2026-10-27T22:35Z: launches from here on are kept for the final check
FEATURES = ['age', 'cumNet', 'net1', 'net2', 'net5', 'net10', 'net20', 'buy5', 'sell5', 'nbuy5', 'nsell5', 'buyers',
            'earlySold', 'earlyBuy', 'gain', 'drawdown', 'sincePeak', 'sinceBuy']
STATIC = ['curveBuy', 'postAgeLog', 'j7', 'spam']
DECIDE_FROM, DECIDE_TO, STEP = 3, 300, 2  # slots: 1.2 s to 120 s, every 0.8 s
EXTEND_TO = 750  # slots: 300 s
rng = np.random.default_rng(7)


def boot(d, n=2000):
    b = [rng.choice(d, len(d)).mean() for _ in range(n)]
    return np.percentile(b, 5), np.percentile(b, 95)


def base_triggers(c, max_hold=120):
    """Slots where v2 would sell if it got there: its stall condition, or the hold limit."""
    w = c['X']['net5']
    k = np.arange(len(w))
    cond = (k >= round(10 / SLOT)) & (w <= 0.5)
    cond[round(max_hold / SLOT):] = True
    return cond


def decision_slots(c, mode):
    """Slots where the learned exit decides: anywhere (both), only before v2 would sell (early), or from then on (extend)."""
    k0 = flow_exit(c)
    if mode == 'early':
        return np.arange(DECIDE_FROM, k0, STEP), k0
    if mode == 'extend':
        return np.arange(k0, EXTEND_TO + 1, STEP), EXTEND_TO
    return np.arange(DECIDE_FROM, DECIDE_TO + 1, STEP), DECIDE_TO


def features_at(c, static, ks):
    return np.column_stack([c['X'][f][ks] for f in FEATURES] + [np.full(len(ks), static.loc[c['mint'], s]) for s in STATIC])


def rows(paths, static, mode):
    """Training rows: features at each decision slot and what holding on adds over selling now. Holding on means
    following v2 (both, early) or selling at the next stall within 300 s (extend)."""
    Xs, ys, gid = [], [], []
    for g, c in enumerate(paths):
        ks, _ = decision_slots(c, mode)
        if not len(ks):
            continue
        trig = base_triggers(c, max_hold=300 if mode == 'extend' else 120)
        nxt = np.full(len(trig), len(trig) - 1)
        nt = len(trig) - 1
        for k in range(len(trig) - 1, -1, -1):
            nxt[k] = nt
            if trig[k]:
                nt = k
        Xs.append(features_at(c, static, ks))
        ys.append(c['pnl'][nxt[ks]] - c['pnl'][ks])
        gid.append(np.full(len(ks), g))
    return np.vstack(Xs), np.concatenate(ys), np.concatenate(gid)


def model():
    return HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=200,
                                         l2_regularization=1.0, random_state=7)


def learned_exit(c, static, m, theta, mode):
    ks, fallback = decision_slots(c, mode)
    if not len(ks):
        return fallback
    hit = np.where(m.predict(features_at(c, static, ks)) <= theta)[0]
    return ks[hit[0]] if len(hit) else fallback


def fit_learned(train, static, mode):
    """Fit, and choose the threshold on out-of-fold predictions inside the training launches."""
    X, y, g = rows(train, static, mode)
    half = np.array([c['ts'] for c in train])
    cut = np.median(half)
    inner = []
    for a, b in [(half < cut, half >= cut), (half >= cut, half < cut)]:
        idx_a = np.isin(g, np.where(a)[0])
        m = model().fit(X[idx_a], y[idx_a])
        inner.append((m, [c for c, keep in zip(train, b) if keep]))
    thetas = [-0.1, -0.05, 0.0, 0.05, 0.1, 0.2]
    score = {t: np.mean([c['pnl'][learned_exit(c, static, m, t, mode)] for m, cs in inner for c in cs]) for t in thetas}
    theta = max(score, key=score.get)
    return model().fit(X, y), theta


def trail_exit(c, arm, drop, max_hold):
    """v2's stall exit until the bag is up `arm` of the dev buy; from then on, sell once the gain falls back by `drop`
    of its peak (a trailing stop that lets runners run), and at `max_hold` at the latest."""
    X = c['X']
    spent = X['vNow'][0] / (1 + X['gain'][0]) if (1 + X['gain'][0]) else 1
    peak = np.maximum.accumulate(X['vNow'])
    k = np.arange(len(peak))
    armed = (peak - spent) >= arm * spent
    cond = (k >= round(10 / SLOT)) & np.where(armed, X['vNow'] <= peak - drop * (peak - spent), X['net5'] <= 0.5)
    cond[min(round(max_hold / SLOT), len(cond) - 1):] = True
    return first_true(cond)


TRAIL_GRID = [(a, d, h) for a in [0.1, 0.25, 0.5, 1.0] for d in [0.2, 0.35, 0.5] for h in [120, 300]]


def regime_rules(train):
    """A flow exit per starting regime (outside net buying in the first 3 s: low, middle, high thirds)."""
    start = np.array([c['X']['cumNet'][round(3 / SLOT)] for c in train])
    cuts = np.quantile(start, [1 / 3, 2 / 3])
    grid = [(h, w, s, mh) for h in [3, 5, 10, 20] for w in [2, 5, 10, 20] for s in [0, 0.5, 1, 2] for mh in [60, 120, 300]]
    chosen = {}
    for r in range(3):
        cs = [c for c, x in zip(train, start) if np.searchsorted(cuts, x) == r]
        chosen[r] = max(grid, key=lambda p: np.mean([c['pnl'][flow_exit(c, *p)] for c in cs]))
    return cuts, chosen


def regime_exit(c, cuts, chosen):
    r = int(np.searchsorted(cuts, c['X']['cumNet'][round(3 / SLOT)]))
    return flow_exit(c, *chosen[r])


def main():
    min_buy = float(sys.argv[1]) if len(sys.argv) > 1 else 2.95
    paths = [c for c in load_paths(min_spent=min_buy * 1.0125) if c['ts'] < SEAL]
    paths.sort(key=lambda c: c['ts'])
    static = static_features(paths, load())
    n = len(paths)
    print(f'{n} launches with a {min_buy}+ SOL dev buy before the seal, 4 time blocks held out in turn')
    modes = ['both', 'early', 'extend']
    keys = ['ceiling', 'v2', 'rules', 'trail'] + [f'learned:{m}' for m in modes]
    res = {k: np.zeros(n) for k in keys}
    blocks = np.array_split(np.arange(n), 4)
    for b, test in enumerate(blocks):
        held = set(test)
        train = [paths[i] for i in range(n) if i not in held]
        cuts, chosen = regime_rules(train)
        trail = max(TRAIL_GRID, key=lambda p: np.mean([c['pnl'][trail_exit(c, *p)] for c in train]))
        fitted = {m: fit_learned(train, static, m) for m in modes}
        for i in test:
            c = paths[i]
            res['ceiling'][i] = c['pnl'].max()
            res['v2'][i] = c['pnl'][flow_exit(c)]
            res['rules'][i] = c['pnl'][regime_exit(c, cuts, chosen)]
            res['trail'][i] = c['pnl'][trail_exit(c, *trail)]
            for m in modes:
                res[f'learned:{m}'][i] = c['pnl'][learned_exit(c, static, *fitted[m], m)]
        print(f'  block {b + 1}: ' + '  '.join(f'{k} {res[k][test].mean():.3f}' for k in keys) +
              f'; trail {trail}; thresholds ' + ', '.join(f'{m} {fitted[m][1]}' for m in modes), flush=True)
    print('\nAll held-out blocks together (SOL a launch):')
    for k in keys:
        x = res[k]
        line = f'  {k:15} mean {x.mean():.3f}  median {np.median(x):.3f}  profitable {(x > 0).mean():.0%}  p05 {np.percentile(x, 5):.3f}'
        if k not in ('v2', 'ceiling'):
            lo, hi = boot(x - res['v2'])
            line += f'  vs v2 {np.mean(x - res["v2"]):+.3f} (90% {lo:+.3f} to {hi:+.3f})'
        print(line)
    return paths, res


if __name__ == '__main__':
    main()
