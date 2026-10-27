import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREATOR_FEE_RATE, CURVE_FEE_RATE, CURVE_MAX_PRICE_SOL, CURVE_REAL_TOKENS, Curve, maxDevBuyLoss } from '../src/chain/curve.ts';
import type { TradeRow } from '../src/intel/devs.ts';
import { pairedDifference, rankCorrelation } from '../src/sim/backtest.ts';
import { PHANTOM, reconstructFlow } from '../src/sim/flow.ts';
import { RECORDED_DEV, ladderPolicy, timePolicy } from '../src/sim/policies.ts';
import { DEFAULT_SIM, simulate, type SimCoin } from '../src/sim/simulate.ts';

const T0 = 1_800_000_000;
const DEV = 1;
const NO_COSTS = { ...DEFAULT_SIM, launchCostSol: 0, txCostSol: 0 };

type Action = { wallet: number; slot: number; ts: number } & ({ buySol: number } | { sellTokens: number });

/** Records actions the way the observer stores them: SOL with fees, tokens, and market cap after the trade. */
function record(actions: Action[]): TradeRow[] {
  const curve = new Curve();
  return actions.map((a) => {
    if ('buySol' in a) {
      const r = curve.buy(a.buySol);
      return { ts: a.ts, slot: a.slot, wallet: a.wallet, isBuy: true, sol: r.sol, coins: r.tokens, mcap: curve.price * 1e9 };
    }
    const r = curve.sell(a.sellTokens);
    return { ts: a.ts, slot: a.slot, wallet: a.wallet, isBuy: false, sol: r.sol, coins: a.sellTokens, mcap: curve.price * 1e9 };
  });
}

const coin = (trades: TradeRow[], launchBuySol: number): SimCoin => ({
  mint: 'M',
  symbol: 'T',
  createdTs: T0,
  trades: reconstructFlow(trades, new Set([DEV])).trades,
  launchBuySol,
});

test('the curve charges 1.25% on each side and stops at completion', () => {
  const c = new Curve();
  const b = c.buy(1.0125);
  assert.ok(Math.abs(b.sol - 1.0125) < 1e-12);
  assert.ok(Math.abs(b.creatorFee - CREATOR_FEE_RATE) < 1e-12);
  // 1 SOL into 30 virtual SOL against 1.073B virtual tokens.
  assert.ok(Math.abs(b.tokens - (1_073_000_000 - (30 * 1_073_000_000) / 31)) < 1e-3);
  const s = c.sell(b.tokens);
  assert.ok(Math.abs(s.sol - 1 * (1 - CURVE_FEE_RATE)) < 1e-9);

  const big = new Curve();
  const all = big.buy(500);
  assert.ok(big.complete);
  assert.ok(Math.abs(all.tokens - CURVE_REAL_TOKENS) < 1e-3);
  assert.ok(all.sol < 500);
  assert.ok(Math.abs(big.price - CURVE_MAX_PRICE_SOL) < 1e-15);
  assert.equal(big.buy(1).tokens, 0);
});

test('trades recorded out of order within a slot are put back in chain order', () => {
  const trades = record([
    { wallet: DEV, slot: 100, ts: T0, buySol: 1 },
    { wallet: 5, slot: 101, ts: T0 + 1, buySol: 0.5 },
    { wallet: 6, slot: 101, ts: T0 + 1, buySol: 2 },
  ]);
  const flow = reconstructFlow([trades[0]!, trades[2]!, trades[1]!], new Set([DEV]));
  assert.deepEqual(flow.trades.map((t) => t.wallet), [DEV, 5, 6]);
  assert.equal(flow.reordered, 1);
  assert.equal(flow.phantoms, 0);
  assert.equal(flow.trades[0]!.dev, true);
});

test('a trade the feed missed is replaced by a phantom that covers the jump', () => {
  const trades = record([
    { wallet: DEV, slot: 100, ts: T0, buySol: 1 },
    { wallet: 5, slot: 101, ts: T0 + 1, buySol: 3 },
    { wallet: 6, slot: 102, ts: T0 + 2, buySol: 0.5 },
  ]);
  const flow = reconstructFlow([trades[0]!, trades[2]!], new Set([DEV]));
  assert.equal(flow.phantoms, 1);
  const p = flow.trades[1]!;
  assert.equal(p.wallet, PHANTOM);
  assert.equal(p.isBuy, true);
  assert.ok(Math.abs(p.sol - trades[1]!.sol) < 1e-9);
  assert.ok(Math.abs(p.tokens - trades[1]!.coins) < 1e-3);
});

test('replaying the recorded dev reproduces its result exactly', () => {
  const actions: Action[] = [
    { wallet: DEV, slot: 100, ts: T0, buySol: 2 },
    { wallet: 5, slot: 101, ts: T0 + 1, buySol: 1 },
    { wallet: 6, slot: 105, ts: T0 + 2, buySol: 3 },
  ];
  const bought = record(actions)[0]!.coins;
  const trades = record([...actions, { wallet: DEV, slot: 110, ts: T0 + 4, sellTokens: bought / 2 }, { wallet: 5, slot: 120, ts: T0 + 8, buySol: 0.2 }]);
  const recorded = trades.filter((t) => t.wallet === DEV).reduce((s, t) => s + (t.isBuy ? -t.sol : t.sol), 0);
  const r = simulate(coin(trades, trades[0]!.sol), RECORDED_DEV, { ...NO_COSTS, horizonSec: Infinity });
  const curve = new Curve();
  for (const t of trades) t.isBuy ? curve.buy(t.sol) : curve.sell(t.coins);
  assert.ok(Math.abs(r.received - r.spent - recorded) < 1e-9);
  assert.ok(Math.abs(r.bagSol - curve.sellValue(bought / 2)) < 1e-9);
});

test('other wallets sell the same share of what they hold in the replay as they did on record', () => {
  const recorded = record([
    { wallet: DEV, slot: 100, ts: T0, buySol: 1 },
    { wallet: 5, slot: 101, ts: T0 + 2, buySol: 1 },
  ]);
  // Wallet 5 then sells everything it bought.
  const trades = record([
    { wallet: DEV, slot: 100, ts: T0, buySol: 1 },
    { wallet: 5, slot: 101, ts: T0 + 2, buySol: 1 },
    { wallet: 5, slot: 102, ts: T0 + 3, sellTokens: recorded[1]!.coins },
  ]);
  // With our bigger launch buy, wallet 5 gets fewer tokens for its SOL and sells all of those.
  const r = simulate(coin(trades, 1.0125), { ...timePolicy(60, 0), devBuySol: 3 }, NO_COSTS);
  const expected = new Curve();
  const ours = expected.buy(3).tokens;
  expected.sell(expected.buy(1).tokens);
  assert.ok(Math.abs(r.received - expected.sell(ours).sol) < 1e-9);
});

test('a time exit sells everything before any trade after the hold', () => {
  const trades = record([
    { wallet: DEV, slot: 100, ts: T0, buySol: 1 },
    { wallet: 5, slot: 101, ts: T0 + 2, buySol: 2 },
    { wallet: DEV, slot: 102, ts: T0 + 3, sellTokens: 1e6 },
    { wallet: 6, slot: 150, ts: T0 + 25, buySol: 4 },
  ]);
  const r = simulate(coin(trades, 1.0125), timePolicy(20, 0), NO_COSTS);
  assert.equal(r.sells, 1);
  assert.equal(r.firstSellSec, 20);
  assert.equal(r.bagSol, 0);
  // We bought 1 SOL, then 2 SOL came in; the dev's recorded sell is not part of the replay.
  const expected = new Curve();
  const ours = expected.buy(1.0125).tokens;
  expected.buy(2);
  assert.ok(Math.abs(r.received - expected.sell(ours).sol) < 1e-9);
  assert.ok(r.pnl > 0);
});

test('ladder sells land after the latency, and the moonbag is kept only once the dev buy is back', () => {
  const trades = record([
    { wallet: DEV, slot: 100, ts: T0, buySol: 1 },
    { wallet: 5, slot: 101, ts: T0 + 1, buySol: 0.6 },
    { wallet: 6, slot: 102, ts: T0 + 1, buySol: 3 },
    { wallet: 7, slot: 104, ts: T0 + 2, buySol: 3 },
  ]);
  const plan = ladderPolicy(0.5, 60, null, 0.2);
  const r = simulate(coin(trades, 1.0125), plan, NO_COSTS);
  // Rungs at 0.5, 1, 2, 4 SOL: the first is reached at slot 101 and lands at 103, after wallet 6's buy at 102.
  assert.equal(r.firstSellSec, 2);
  assert.ok(r.received > r.spent);
  // 20% kept as moonbag after the timer exit.
  assert.ok(r.bagSol > 0);

  // Nobody buys: the timer exit sells everything, moonbag included, since the dev buy is not back.
  const dead = record([{ wallet: DEV, slot: 100, ts: T0, buySol: 1 }, { wallet: 9, slot: 400, ts: T0 + 120, buySol: 0.01 }]);
  const d = simulate(coin(dead, 1.0125), plan, NO_COSTS);
  assert.equal(d.bagSol, 0);
  assert.ok(Math.abs(d.pnl - (d.received - d.spent + d.creatorFees)) < 1e-12);
  assert.ok(d.pnl < 0 && d.pnl > -0.03);
});

test('a dev who buys first and sells everything loses at most the protocol fee both ways', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 200; run++) {
    const actions: Action[] = [{ wallet: DEV, slot: 100, ts: T0, buySol: 1 }];
    const held = new Map<number, number>();
    const probe = new Curve();
    probe.buy(1);
    for (let k = 0; k < 40; k++) {
      const wallet = 10 + Math.floor(rand() * 6);
      const slot = 101 + k;
      const ts = T0 + 1 + Math.floor(k / 2);
      const h = held.get(wallet) ?? 0;
      if (h > 0 && rand() < 0.5) {
        const tokens = h * (0.2 + 0.8 * rand());
        probe.sell(tokens);
        held.set(wallet, h - tokens);
        actions.push({ wallet, slot, ts, sellTokens: tokens });
      } else {
        const sol = rand() * 2;
        held.set(wallet, h + probe.buy(sol).tokens);
        actions.push({ wallet, slot, ts, buySol: sol });
      }
    }
    const buy = 0.5 + rand() * 5;
    const r = simulate(coin(record(actions), 1.0125), { ...timePolicy(1 + Math.floor(rand() * 25), 0), devBuySol: buy }, NO_COSTS);
    assert.ok(r.pnl >= -maxDevBuyLoss(buy) - 1e-9, `run ${run}: ${r.pnl} < ${-maxDevBuyLoss(buy)}`);
  }
  // Selling straight back into an untouched curve costs exactly that.
  const flat = simulate(coin(record([{ wallet: DEV, slot: 100, ts: T0, buySol: 1 }]), 1.0125), { ...timePolicy(5, 0), devBuySol: 3 }, NO_COSTS);
  assert.ok(Math.abs(flat.pnl + maxDevBuyLoss(3)) < 1e-9);
});

test('paired bootstrap and rank correlation', () => {
  const d = pairedDifference([1, 2, 3, 4], [0, 1, 2, 3])!;
  assert.equal(d.mean, 1);
  assert.equal(d.lo, 1);
  assert.equal(d.hi, 1);
  assert.equal(rankCorrelation([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(rankCorrelation([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});
