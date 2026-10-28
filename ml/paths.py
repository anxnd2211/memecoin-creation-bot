"""Launch paths on a slot grid, for exit research (from npm run export-paths).

Until we sell the whole bag our position does not move the curve, so each launch has one price path whatever exit we
pick. For every slot s (about 0.21 s) up to the horizon this builds what selling then would make, and the market state an
exit could see at that moment. A decision at slot s lands before the first trade at slot s + LATENCY or later, as in
the replay (src/sim/simulate.ts).
"""
import json

import numpy as np
import pandas as pd

SLOT = 0.213  # mainnet slot time, measured 2026-10-28
LATENCY = 2
HORIZON = 1400  # slots: about 300 s
CREATOR_FEE_ON_SELL = 0.003 / (1 - 0.0125)  # creator fee earned on our own sell, per SOL received
COSTS = 0.02 + 0.002  # launch rent and fees, one sell


def slots(sec: float) -> int:
    """Slots in `sec` seconds."""
    return max(1, round(sec / SLOT))


def window(x: np.ndarray, n: int) -> np.ndarray:
    """Sum over the last n slots, inclusive."""
    c = np.cumsum(x)
    out = c.copy()
    out[n:] -= c[:-n]
    return out


def build(p: dict) -> dict:
    ev = np.array(p['events'], dtype=float).reshape(-1, 7)
    slot, isbuy, sol, value, _, wallet, early = (ev[:, i] for i in range(7))
    H = HORIZON + 1
    keep = slot <= HORIZON
    slot, isbuy, sol, value, wallet, early = slot[keep], isbuy[keep], sol[keep], value[keep], wallet[keep], early[keep]
    s = slot.astype(int)
    # What our whole bag fetches if the sell lands before the first trade at slot >= k (k = 0..H+LATENCY).
    end_value = p['endValue'] if keep.all() else value[-1] if len(value) else p['endValue']
    first_at = np.searchsorted(s, np.arange(H + LATENCY), side='left')
    v_at = np.where(first_at < len(s), value[np.minimum(first_at, len(s) - 1)] if len(s) else end_value, end_value)
    land = v_at[LATENCY:LATENCY + H]
    # Creator fees: the whole horizon's, whenever we sell (trades after our sell pay fees as recorded, near enough).
    pnl = land * (1 + CREATOR_FEE_ON_SELL) - p['spent'] + p['endFees'] - COSTS
    # Value now (after the trades in slot s), for drawdown features.
    now_idx = np.searchsorted(s, np.arange(H), side='right')
    v_now = np.where(now_idx < len(s), value[np.minimum(now_idx, len(s) - 1)] if len(s) else end_value, end_value)

    def per_slot(mask, x):
        a = np.zeros(H)
        np.add.at(a, s[mask], x[mask])
        return a

    allm = np.ones(len(s), bool)
    net = per_slot(allm, sol)
    buy_sol = per_slot(isbuy == 1, sol)
    sell_sol = -per_slot(isbuy == 0, sol)
    n_buy = per_slot(isbuy == 1, np.ones(len(s)))
    n_sell = per_slot(isbuy == 0, np.ones(len(s)))
    early_buy = per_slot((isbuy == 1) & (early == 1), sol)
    early_sell = -per_slot((isbuy == 0) & (early == 1), sol)
    # Unique buyers so far.
    seen, newb = set(), np.zeros(len(s))
    for i in range(len(s)):
        if isbuy[i] == 1 and wallet[i] >= 0 and wallet[i] not in seen:
            seen.add(wallet[i])
            newb[i] = 1
    buyers = np.cumsum(per_slot(allm, newb))
    last_buy = np.full(H, -1.0)
    has_buy = n_buy > 0
    idx = np.where(has_buy, np.arange(H), -1)
    last_buy = np.maximum.accumulate(idx)
    # Observable at slot s: the bag's value after the trades so far (no latency lookahead, no future fees).
    peak = np.maximum.accumulate(v_now)
    peak_at = np.zeros(H)
    best = -np.inf
    for k in range(H):
        if v_now[k] > best:
            best, peak_at[k] = v_now[k], k
        else:
            peak_at[k] = peak_at[k - 1]
    age = np.arange(H) * SLOT
    return dict(
        mint=p['mint'], ts=p['ts'], dev=p['dev'], clean=p['clean'], active=p['active'], spent=p['spent'],
        pnl=pnl, end_pnl=p['endValue'] * (1 + CREATOR_FEE_ON_SELL) - p['spent'] + p['endFees'] - COSTS,
        X=dict(
            age=age,
            cumNet=np.cumsum(net),
            net1=window(net, slots(1)), net2=window(net, slots(2)), net5=window(net, slots(5)),
            net10=window(net, slots(10)), net20=window(net, slots(20)),
            buy5=window(buy_sol, slots(5)), sell5=window(sell_sol, slots(5)), nbuy5=window(n_buy, slots(5)),
            nsell5=window(n_sell, slots(5)),
            buyers=buyers,
            earlySold=np.cumsum(early_sell) / np.maximum(np.cumsum(early_buy), 1e-9),
            earlyBuy=np.cumsum(early_buy),
            gain=v_now / p['spent'] - 1, vNow=v_now,
            drawdown=peak - v_now, sincePeak=(np.arange(H) - peak_at) * SLOT,
            sinceBuy=np.where(last_buy >= 0, (np.arange(H) - last_buy) * SLOT, age),
        ),
    )


def load_paths(path='data/exports/paths.jsonl', min_spent=0.0):
    out = []
    for line in open(path):
        p = json.loads(line)
        if p['spent'] >= min_spent:
            out.append(build(p))
    return out


def first_true(cond: np.ndarray) -> int:
    """Index of the first True, or the last index when none (the forced sell at the horizon)."""
    i = int(np.argmax(cond))
    return i if cond[i] else len(cond) - 1


def flow_exit(c, min_hold=10, window_sec=5, min_sol=0.5, max_hold=120):
    """The playbook's exit on the grid: after the hold, sell once net buying over the window is at most min_sol."""
    X = c['X']
    w = {1: X['net1'], 2: X['net2'], 5: X['net5'], 10: X['net10'], 20: X['net20']}[window_sec]
    start = round(max(min_hold, window_sec) / SLOT)
    cond = (np.arange(len(w)) >= start) & (w <= min_sol)
    cond[min(round(max_hold / SLOT), len(w) - 1)] = True
    return first_true(cond)


def static_features(paths, launches: pd.DataFrame) -> pd.DataFrame:
    m = launches.set_index('mint')
    rows = []
    for c in paths:
        r = m.loc[c['mint']] if c['mint'] in m.index else None
        rows.append(dict(
            mint=c['mint'],
            curveBuy=c['spent'] / 1.0125,
            postAgeLog=np.log1p(max(r.tweetAgeSec, 0)) if r is not None and r.xLink == 'tweet' and r.tweetAgeSec == r.tweetAgeSec else np.nan,
            j7=float(r is not None and r.tool == 'j7tracker'),
            spam=float(r is not None and r.tool == 'other'),
        ))
    return pd.DataFrame(rows).set_index('mint')
