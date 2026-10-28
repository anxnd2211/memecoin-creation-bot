import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { RawTx } from '../src/chain/events.ts';
import { Curve, STANDARD_LAUNCH_MCAP_SOL, TOTAL_SUPPLY } from '../src/chain/curve.ts';
import type { TradeRow } from '../src/intel/devs.ts';
import { ExitEngine, FeedLag, MAINNET_SLOT_MS } from '../src/live/exit.ts';
import { ShadowRun, bandOf, skipReason, summarize, type ShadowRecord } from '../src/live/shadow.ts';
import { LiveFeed, type FeedTrade, type LiveLaunch } from '../src/live/stream.ts';
import type { LiveTrade } from '../src/live/types.ts';
import { PLAYBOOK, exitFor } from '../src/playbook.ts';
import { reconstructFlow } from '../src/sim/flow.ts';
import { RECORDED_DEV, flowPolicy, ladderPolicy, timePolicy } from '../src/sim/policies.ts';
import { DEFAULT_SIM, simulate, type ExitPolicy, type SimCoin } from '../src/sim/simulate.ts';

const T0 = 1_800_000_000;
const S0 = 1000;
const DEV = 1;
/**
 * The chain stamps whole seconds. A trade stamped second `ts` reaches the synthetic feed half a second later, so the
 * feed's real lag is zero and the receive clock runs exactly half a second behind the backtest's.
 */
const HALF = 500;
const LANDED = T0 * 1000 + HALF;
const NO_COSTS = { ...DEFAULT_SIM, launchCostSol: 0, txCostSol: 0 };
const V3 = flowPolicy(10, 5, 0.5, 120, 0);

type Action = { wallet: number; ts: number; k?: number } & ({ buySol: number } | { sellTokens: number });

/** Records actions as the observer stores them (test/sim.test.ts's helper), five slots a second, `k` within it. */
function record(actions: Action[]): TradeRow[] {
  const curve = new Curve();
  return actions.map((a) => {
    const slot = S0 + 5 * (a.ts - T0) + (a.k ?? 0);
    if ('buySol' in a) {
      const r = curve.buy(a.buySol);
      return { ts: a.ts, slot, wallet: a.wallet, isBuy: true, sol: r.sol, coins: r.tokens, mcap: curve.price * 1e9 };
    }
    const r = curve.sell(a.sellTokens);
    return { ts: a.ts, slot, wallet: a.wallet, isBuy: false, sol: r.sol, coins: a.sellTokens, mcap: curve.price * 1e9 };
  });
}

function coin(rows: TradeRow[]): SimCoin {
  const flow = reconstructFlow(rows, new Set([DEV]));
  assert.equal(flow.phantoms, 0, 'synthetic trades are listed in chain order');
  assert.ok(rows.every((r) => !(r.sol === 0 && r.isBuy)), 'the curve did not complete');
  return { mint: 'M', symbol: 'T', createdTs: T0, trades: flow.trades, launchBuySol: rows[0]!.sol };
}

/** The coin's trades as the live feed delivers them; the first is the dev buy in the create transaction. */
const feedTrades = (c: SimCoin): FeedTrade[] =>
  c.trades.map((t, i) => ({
    slot: t.slot,
    chainTs: t.ts,
    receivedAt: t.ts * 1000 + HALF,
    wallet: String(t.wallet),
    isBuy: t.isBuy,
    sol: t.sol,
    tokens: t.tokens,
    dev: t.dev,
    mint: 'M',
    sig: i === 0 ? 'LAUNCH' : `tx${i}`,
    via: null,
  }));

const LAUNCH: Action = { wallet: DEV, ts: T0, buySol: 5.0625 };
/** One buy of `sol` a second from `from` to `to` seconds after launch, each by a new wallet. */
const buys = (from: number, to: number, sol: number, wallet0: number): Action[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ wallet: wallet0 + i, ts: T0 + from + i, buySol: sol }));

/**
 * Drives an engine through the coin's trades with a 100 ms clock: trades received by a tick first, then the tick, then
 * a heartbeat (other coins' events) unless the feed is dead. Returns the decision and the trade that made it, if any.
 */
function drive(engine: ExitEngine, trades: LiveTrade[], untilSec: number, heartbeat = true) {
  let i = 0;
  for (let now = LANDED; now <= LANDED + untilSec * 1000; now += 100) {
    for (; i < trades.length && trades[i]!.receivedAt <= now; i++) {
      const d = engine.onTrade(trades[i]!);
      if (d) return { d, trigger: trades[i]! };
    }
    const d = engine.onTick(now) ?? (heartbeat ? engine.onEvent(now) : null);
    if (d) return { d, trigger: null };
  }
  return { d: null, trigger: null };
}

const STANDARD_PRICE = STANDARD_LAUNCH_MCAP_SOL / TOTAL_SUPPLY;

function launchOf(c: SimCoin): LiveLaunch {
  return {
    mint: 'M',
    sig: 'LAUNCH',
    slot: S0,
    chainTs: T0,
    receivedAt: LANDED,
    name: 'Test',
    symbol: 'T',
    uri: '',
    creator: String(DEV),
    signer: String(DEV),
    quote: 'SOL',
    price: STANDARD_PRICE,
    isMayhem: false,
    devBuySol: c.launchBuySol,
    devTokens: c.trades[0]!.tokens,
  };
}

/** Runs the shadow replay on a synthetic launch the way the shadow command does, until it is done. */
function shadow(c: SimCoin, policy: ExitPolicy, followSec: number): ShadowRecord {
  const lag = new FeedLag();
  lag.add(LANDED, T0, S0);
  const run = new ShadowRun(launchOf(c), {
    policy,
    exit: 'flow',
    lagSec: null,
    slotAt: (ms) => lag.slotAt(ms),
    slotMs: () => lag.msPerSlot(),
    followSec,
  });
  const trades = feedTrades(c);
  let i = 0;
  for (let now = LANDED; now <= LANDED + (followSec + 2) * 1000 && !run.done; now += 100) {
    for (; i < trades.length && trades[i]!.receivedAt <= now; i++) {
      lag.add(trades[i]!.receivedAt, trades[i]!.chainTs, trades[i]!.slot);
      run.onTrade(trades[i]!);
    }
    run.onTick(now);
    run.onEvent(now);
  }
  const rec = run.record();
  assert.ok(rec, 'the shadow run finished');
  return rec;
}

interface Case {
  name: string;
  actions: Action[];
  policy: ExitPolicy;
  reason: string;
  /** How simulate.ts reports this decision as firstSellSec: the decision time, or the trade the sell lands before. */
  by: 'tick' | 'trade';
  /** Expected seconds after launch: the decision for 'tick', the landing trade's second for 'trade'. */
  sec: number;
}

const bought = record([LAUNCH, ...buys(1, 1, 1, 100), { wallet: 60, ts: T0 + 1, k: 1, buySol: 6 }]);
const CASES: Case[] = [
  {
    name: 'a buying streak, then the window goes quiet with no trade',
    actions: [LAUNCH, ...buys(1, 30, 1, 100), { wallet: 50, ts: T0 + 40, buySol: 2 }],
    policy: V3,
    reason: 'stall',
    by: 'tick',
    sec: 35,
  },
  {
    name: 'a buy arriving just as a 10 s window would go quiet still counts',
    actions: [LAUNCH, ...buys(1, 30, 1, 100), { wallet: 50, ts: T0 + 40, buySol: 2 }],
    policy: flowPolicy(10, 10, 0.5, 120, 0),
    reason: 'stall',
    by: 'tick',
    sec: 50,
  },
  {
    name: 'a dump turns the window negative: the sell lands two slots after it',
    actions: [
      LAUNCH,
      ...buys(1, 1, 1, 100),
      { wallet: 60, ts: T0 + 1, k: 1, buySol: 6 },
      ...buys(2, 15, 1, 101),
      { wallet: 60, ts: T0 + 16, sellTokens: bought[2]!.coins },
      { wallet: 70, ts: T0 + 16, k: 1, buySol: 0.3 },
      { wallet: 71, ts: T0 + 17, buySol: 3 },
    ],
    policy: V3,
    reason: 'stall',
    by: 'trade',
    sec: 17,
  },
  {
    name: 'nobody buys: the minimum hold, then sell',
    actions: [LAUNCH, { wallet: 9, ts: T0 + 60, buySol: 0.01 }],
    policy: V3,
    reason: 'stall',
    by: 'tick',
    sec: 10,
  },
  {
    name: 'nobody buys, window longer than the hold: no stall before the window has filled',
    actions: [LAUNCH, { wallet: 9, ts: T0 + 60, buySol: 0.01 }],
    policy: flowPolicy(2, 5, 0.5, 120, 0),
    reason: 'stall',
    by: 'tick',
    sec: 5,
  },
  {
    name: 'the minimum hold keeps the bag through an early lull',
    actions: [LAUNCH, ...buys(1, 2, 1, 100), ...buys(9, 20, 1, 200), { wallet: 50, ts: T0 + 40, buySol: 2 }],
    policy: V3,
    reason: 'stall',
    by: 'tick',
    sec: 25,
  },
  {
    name: 'without a minimum hold the early lull sells',
    actions: [LAUNCH, ...buys(1, 2, 1, 100), ...buys(9, 20, 1, 200), { wallet: 50, ts: T0 + 40, buySol: 2 }],
    policy: flowPolicy(0, 5, 0.5, 120, 0),
    reason: 'stall',
    by: 'tick',
    sec: 7,
  },
  {
    name: 'our own trades do not count as buying',
    actions: [
      LAUNCH,
      ...buys(1, 10, 1, 100),
      { wallet: DEV, ts: T0 + 12, buySol: 3 },
      { wallet: DEV, ts: T0 + 13, buySol: 3 },
      { wallet: 9, ts: T0 + 30, buySol: 0.5 },
    ],
    policy: V3,
    reason: 'stall',
    by: 'tick',
    sec: 15,
  },
  {
    name: 'buying never stalls: max hold',
    actions: [LAUNCH, ...buys(1, 130, 0.5, 100)],
    policy: V3,
    reason: 'max hold',
    by: 'tick',
    sec: 120,
  },
  {
    name: 'the slow-feed timer ignores the flow',
    actions: [LAUNCH, ...buys(1, 30, 1, 100)],
    policy: timePolicy(20, 0),
    reason: 'slow feed timer',
    by: 'tick',
    sec: 20,
  },
];

for (const c of CASES) {
  test(`exit engine matches the backtest: ${c.name}`, () => {
    const sc = coin(record(c.actions));
    const sim = simulate(sc, c.policy, NO_COSTS);
    const trades = feedTrades(sc);
    const { d, trigger } = drive(new ExitEngine(c.policy, { landedAt: LANDED, slot: S0 }, String(DEV)), trades, 200);
    assert.ok(d, 'decided');
    assert.equal(d.reason, c.reason);
    assert.equal(sim.firstSellSec, c.sec, 'simulate.ts agrees with the case');
    if (c.by === 'tick') {
      // The backtest decides at that second; the engine within one slot of it.
      assert.ok(Math.abs(d.ageSec - sim.firstSellSec!) <= MAINNET_SLOT_MS / 1000, `decided at ${d.ageSec} s, backtest ${sim.firstSellSec} s`);
    } else {
      assert.ok(trigger, 'a trade decided');
      // The sell lands before the first trade at or after the deciding trade's slot + latency, as in the backtest.
      const landing = trades.find((t) => t.slot >= trigger.slot + DEFAULT_SIM.latencySlots && t.receivedAt > trigger.receivedAt);
      assert.equal(landing!.chainTs - T0, sim.firstSellSec);
      assert.equal(d.ageSec, trigger.chainTs - T0);
    }
  });
}

for (const c of CASES.filter((c) => c.reason === 'stall')) {
  test(`shadow replay fetches what the backtest's sell does: ${c.name}`, () => {
    const sc = coin(record(c.actions));
    const sim = simulate(sc, c.policy, { ...DEFAULT_SIM, horizonSec: 200 });
    const rec = shadow(sc, c.policy, 200);
    assert.ok(Math.abs(rec.sellSol - sim.received) < 1e-9, `shadow ${rec.sellSol} vs backtest ${sim.received}`);
    assert.ok(Math.abs(rec.result - sim.pnl) < 1e-9, `shadow ${rec.result} vs backtest ${sim.pnl}`);
    assert.equal(rec.decision.reason, 'stall');
  });
}

test('shadow replay of a launch whose recorded dev sold early matches the backtest and the recorded dev', () => {
  const pre = record([LAUNCH, { wallet: 10, ts: T0, k: 1, buySol: 3 }, { wallet: 11, ts: T0, k: 2, buySol: 2 }, ...buys(1, 5, 1, 20)]);
  const actions: Action[] = [
    LAUNCH,
    { wallet: 10, ts: T0, k: 1, buySol: 3 },
    { wallet: 11, ts: T0, k: 2, buySol: 2 },
    ...buys(1, 5, 1, 20),
    // The recorded dev sells half at 6 s; wallet 10 sells when the dev sells (a reaction, held until our sell).
    { wallet: DEV, ts: T0 + 6, sellTokens: pre[0]!.coins / 2 },
    { wallet: 10, ts: T0 + 6, k: 1, sellTokens: pre[1]!.coins },
    ...buys(7, 14, 1, 40),
    { wallet: 11, ts: T0 + 8, k: 1, sellTokens: pre[2]!.coins / 2 },
    // Quiet from 14 s: the exit decides at 19 s and lands before this buy.
    { wallet: 60, ts: T0 + 20, buySol: 2 },
    { wallet: 20, ts: T0 + 25, sellTokens: pre[3]!.coins },
    { wallet: DEV, ts: T0 + 30, sellTokens: pre[0]!.coins / 2 },
    ...buys(40, 60, 0.2, 80),
  ].sort((a, b) => a.ts - b.ts || (a.k ?? 0) - (b.k ?? 0));
  const sc = coin(record(actions));
  assert.ok(sc.trades.some((t) => t.reaction), 'the dump after the dev sell is a reaction');
  const o = { ...DEFAULT_SIM, horizonSec: 100 };
  const sim = simulate(sc, V3, o);
  const rec = shadow(sc, V3, 100);
  assert.equal(rec.decision.reason, 'stall');
  assert.equal(rec.decision.ageSec, 19);
  assert.equal(sim.firstSellSec, 19);
  assert.equal(rec.trades.deferredReactions, 1);
  assert.ok(rec.maxFeedGapSec <= 0.1 + 1e-9, 'heartbeats every tick: no feed gap');
  assert.ok(Math.abs(rec.sellSol - sim.received) < 1e-9, `shadow ${rec.sellSol} vs backtest ${sim.received}`);
  assert.ok(Math.abs(rec.creatorFeesSol - sim.creatorFees) < 1e-9);
  assert.ok(Math.abs(rec.result - sim.pnl) < 1e-9, `shadow ${rec.result} vs backtest ${sim.pnl}`);
  // The sell lands at the chain's slot at the decision plus the latency.
  assert.equal(rec.landing.slot, rec.decision.slot! + DEFAULT_SIM.latencySlots);
  // The recorded dev, from the trades as recorded, is the backtest's recorded-dev replay.
  const dev = simulate(sc, RECORDED_DEV, o);
  assert.ok(Math.abs(rec.recordedDev.result - dev.pnl) < 1e-9, `recorded dev ${rec.recordedDev.result} vs ${dev.pnl}`);
  assert.equal(rec.recordedDev.firstSellSec, 6);
  assert.ok(Math.abs(rec.recordedDev.soldShareAtOurSell - 0.5) < 1e-12);
  assert.ok(Math.abs(rec.recordedDev.soldShare - 1) < 1e-12);

  const s = summarize([rec, { ...rec, result: -0.1, decision: { ...rec.decision, reason: 'max hold', ageSec: 120, lagSec: 1 } }]);
  assert.equal(s.runs, 2);
  assert.equal(s.profitableShare, 0.5);
  assert.deepEqual(s.byReason, { stall: 1, 'max hold': 1 });
  assert.equal(s.meanLagSec, 1);
});

test('the shadow sell on a timer lands latency slots after the decision, not at the timer', () => {
  const sc = coin(record([LAUNCH, ...buys(1, 130, 0.5, 100)]));
  const rec = shadow(sc, V3, 200);
  assert.equal(rec.decision.reason, 'max hold');
  assert.equal(rec.decision.ageSec, 120);
  assert.equal(rec.landing.slot, rec.decision.slot! + DEFAULT_SIM.latencySlots);
  // The backtest's timers sell with no latency, before the trades of second 120; live, those land first.
  const sim = simulate(sc, V3, { ...DEFAULT_SIM, horizonSec: 200 });
  assert.ok(rec.sellSol >= sim.received);
});

test('kill sells at once and is final', () => {
  const engine = new ExitEngine(V3, { landedAt: LANDED, slot: S0 }, String(DEV));
  assert.equal(engine.onTick(LANDED + 3000), null);
  const k = engine.kill(LANDED + 4000);
  assert.deepEqual(k, { reason: 'kill', at: LANDED + 4000, ageSec: 4 });
  assert.equal(engine.onTick(LANDED + 200_000), null);
  assert.equal(engine.kill(LANDED + 5000), k);
  assert.equal(engine.decision, k);
});

test('a lost feed sells after the hold instead of stranding the bag', () => {
  // Heavy buying until 8 s, then nothing at all arrives. The 20 s window would only go quiet at 28 s.
  const sc = coin(record([LAUNCH, ...buys(1, 8, 3, 100)]));
  const policy = flowPolicy(10, 20, 0.5, 120, 0);
  const dead = drive(new ExitEngine(policy, { landedAt: LANDED, slot: S0 }, String(DEV)), feedTrades(sc), 200, false);
  assert.equal(dead.d?.reason, 'feed lost');
  assert.equal(dead.d?.ageSec, 13);
  // With the feed alive (other coins' events) the stall exit decides as the backtest does.
  const alive = drive(new ExitEngine(policy, { landedAt: LANDED, slot: S0 }, String(DEV)), feedTrades(sc), 200);
  assert.equal(alive.d?.reason, 'stall');
  assert.equal(alive.d?.ageSec, simulate(sc, policy, NO_COSTS).firstSellSec);
  // Configurable, and never before the minimum hold.
  const quick = new ExitEngine(policy, { landedAt: LANDED, slot: S0 }, String(DEV), { feedLostSec: 2 });
  assert.equal(quick.onTick(LANDED + 9_900), null);
  assert.equal(quick.onTick(LANDED + 10_000)?.reason, 'feed lost');
  assert.equal(new ExitEngine(policy, { landedAt: LANDED, slot: S0 }, 'x').nextCheckAt(), LANDED + 10_000);
});

test('the dev wallet never counts, flagged or not', () => {
  const engine = new ExitEngine(V3, { landedAt: LANDED, slot: S0 }, 'OURS');
  const t = (wallet: string, sec: number, dev: boolean): LiveTrade => ({
    slot: S0 + 3 * sec,
    chainTs: T0 + sec,
    receivedAt: LANDED + sec * 1000,
    wallet,
    isBuy: true,
    sol: 5,
    tokens: 1e7,
    dev,
  });
  assert.equal(engine.onTrade(t('OURS', 8, false)), null);
  assert.equal(engine.onTrade(t('OTHER', 9, true)), null);
  assert.equal(engine.netBuying(LANDED + 9000), 0);
  assert.equal(engine.onTick(LANDED + 10_000)?.reason, 'stall');
});

test('the engine refuses policies it cannot run whole', () => {
  const landing = { landedAt: LANDED, slot: S0 };
  assert.throws(() => new ExitEngine(ladderPolicy(1, 60, null, 0), landing, 'x'), /inflow ladder/);
  assert.throws(() => new ExitEngine(flowPolicy(10, 5, 0.5, 120, 0.1), landing, 'x'), /moonbag/);
  assert.throws(() => new ExitEngine({ ...V3, maxHoldSec: Infinity }, landing, 'x'), /max hold/);
  assert.doesNotThrow(() => new ExitEngine(PLAYBOOK.exit, landing, 'x'));
  assert.doesNotThrow(() => new ExitEngine(PLAYBOOK.slowFeedExit, landing, 'x'));
});

/** Samples at `perSec` a second for `secs` seconds whose real lag is `lagMs`, stamped in whole chain seconds. */
function lagSamples(lag: FeedLag, lagMs: number, start: number, secs: number, perSec = 10): number {
  let last = start;
  for (let i = 0; i < secs * perSec; i++) {
    const chainMs = start + (i * 1000) / perSec + ((i * 618) % 97); // spread across each second
    last = chainMs + lagMs;
    lag.add(last, Math.floor(chainMs / 1000), S0 + Math.floor((chainMs - start) / MAINNET_SLOT_MS));
  }
  return last;
}

test('feed lag: p95 less the whole-second bias, and unknown without enough recent data', () => {
  const empty = new FeedLag();
  assert.equal(empty.estimate(LANDED), null);
  assert.equal(empty.slotAt(LANDED), null);

  const few = new FeedLag();
  const fewLast = lagSamples(few, 1200, T0 * 1000, 1);
  assert.equal(few.estimate(fewLast), null, '10 samples are not enough');

  const fast = new FeedLag();
  const last = lagSamples(fast, 1200, T0 * 1000, 60);
  const p95 = fast.estimate(last)!;
  assert.ok(p95 >= 1.2 && p95 <= 1.7, `p95 ${p95}`);
  assert.ok(Math.abs(fast.median(last)! - 1.2) < 0.1, `median ${fast.median(last)}`);
  assert.equal(exitFor(PLAYBOOK, p95), PLAYBOOK.exit);
  // Stale: no sample for over 5 s.
  assert.equal(fast.estimate(last + 6000), null);
  assert.equal(exitFor(PLAYBOOK, fast.estimate(last + 6000)), PLAYBOOK.slowFeedExit);
  // Slot time is measured from the chain timestamps, and the chain's slot keeps moving at it past the newest event.
  assert.ok(Math.abs(fast.msPerSlot() - MAINNET_SLOT_MS) < 5, `ms per slot ${fast.msPerSlot()}`);
  assert.equal(new FeedLag({ slotMs: 400 }).msPerSlot(), 400);
  const newest = fast.slotAt(last)!;
  assert.ok(Math.abs(fast.slotAt(last + 4000)! - newest - 4000 / MAINNET_SLOT_MS) <= 1);

  const slow = new FeedLag();
  const slowLast = lagSamples(slow, 2600, T0 * 1000, 60);
  assert.ok(slow.estimate(slowLast)! > PLAYBOOK.maxFeedLagSec);
  assert.equal(exitFor(PLAYBOOK, slow.estimate(slowLast)), PLAYBOOK.slowFeedExit);

  // Only the last minute counts.
  const recovering = new FeedLag();
  const mid = lagSamples(recovering, 5000, T0 * 1000, 60);
  const end = lagSamples(recovering, 800, mid + 1000, 61);
  assert.ok(recovering.estimate(end)! < 1.5, `recovered p95 ${recovering.estimate(end)}`);
});

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/live-txs.json', import.meta.url), 'utf8')) as Record<string, { tx: RawTx }>;

test('live feed: launches carry the dev buy, subscribers get the coin trades flagged by dev wallet', () => {
  const feed = new LiveFeed({ url: 'ws://unused' });
  const launches: LiveLaunch[] = [];
  const trades: FeedTrade[] = [];
  const beats: number[] = [];
  let unsubscribe = () => {};
  feed.onLaunch((l) => {
    launches.push(l);
    unsubscribe = feed.subscribe(l.mint, [l.creator, l.signer], (t) => trades.push(t));
  });
  feed.onEvent((at) => beats.push(at));
  const { tx } = fixtures['launch']!;
  feed.handleTx(tx);
  assert.equal(launches.length, 1);
  const l = launches[0]!;
  assert.equal(l.mint, 'GkLYiEnGayTRWNi3RxumejMSmp89g7VVVjyboHdQpump');
  assert.equal(l.isMayhem, true);
  assert.ok(Math.abs(l.devBuySol - 0.119757661) < 1e-12);
  assert.ok(Math.abs(l.devTokens - 4213837.994916) < 1e-6);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]!.dev, true);
  assert.equal(trades[0]!.sig, l.sig);
  assert.equal(trades[0]!.receivedAt, tx.receivedAt);
  assert.equal(feed.lastEventAt, tx.receivedAt);
  assert.deepEqual(beats, [tx.receivedAt]);
  assert.equal(feed.lag.count(tx.receivedAt), 2);

  // The playbook's launch filter: normal mode, SOL, standard curve, the 5 SOL band into the curve.
  const band = bandOf(PLAYBOOK.devBuyBands);
  assert.deepEqual(band, { minSol: 4.9, maxSol: 5.1 });
  assert.equal(skipReason(l, band), 'mayhem');
  assert.equal(skipReason({ ...l, isMayhem: false, devBuySol: 5.0625 }, band), null);
  assert.equal(skipReason({ ...l, isMayhem: false, devBuySol: 3.0375 }, band), 'dev buy');
  assert.equal(skipReason({ ...l, isMayhem: false, devBuySol: 5.0625, price: l.price * 2 }, band), 'non-standard curve');

  // After unsubscribing nothing arrives, and a throwing handler does not stop the others.
  unsubscribe();
  const other = new LiveFeed({ url: 'ws://unused' });
  const seen: string[] = [];
  other.onLaunch(() => {
    throw new Error('a failing handler (expected in this test)');
  });
  other.onLaunch((x) => seen.push(x.mint));
  other.subscribe(l.mint, l.creator, (t) => trades.push(t))();
  other.handleTx(tx);
  assert.deepEqual(seen, [l.mint]);
  assert.equal(other.stats.handlerErrors, 1);
  assert.equal(trades.length, 1);
});
