import { CURVE_FEE_RATE, Curve, STANDARD_LAUNCH_MCAP_SOL, TOTAL_SUPPLY } from '../chain/curve.ts';
import { SOL } from '../chain/programs.ts';
import { mean, median, share } from '../intel/reports.ts';
import { REACTION_SLOTS } from '../sim/flow.ts';
import { DEFAULT_SIM, type ExitPolicy } from '../sim/simulate.ts';
import { DEFAULT_FEED_LOST_SEC, ExitEngine, MAINNET_SLOT_MS } from './exit.ts';
import type { FeedTrade, LiveLaunch } from './stream.ts';
import type { ExitDecision } from './types.ts';

/**
 * Shadow mode: the live exit run on other devs' launches as if we were their dev, to check in real time what the
 * backtest (src/sim/simulate.ts) claims. Each launch the playbook would make is replayed on a `Curve` with our bag in
 * place of the dev's, the same way the backtest replays recorded launches: buyers spend the SOL they spent on chain,
 * sellers sell the same share of what they hold, the recorded dev's trades are left out, and sells that reacted to the
 * recorded dev's sell wait until ours. The `ExitEngine` decides live on that replay, and our whole-bag sell lands
 * `latencySlots` after the chain's slot at the moment of the decision: before the first trade at or after that slot.
 * Unlike the backtest, the decision slot includes the feed's lag, so the result is what the exit makes on this feed.
 * Nothing is sent: no keys, no transactions.
 */

/** Starting price of the standard curve, SOL per coin. */
const STANDARD_PRICE = STANDARD_LAUNCH_MCAP_SOL / TOTAL_SUPPLY;

/** Dev buy, SOL into the curve (fees excluded), that a launch must fall in: the playbook's `devBuyBands`. */
export interface DevBuyBand {
  minSol: number;
  maxSol: number;
}

/** The band covering a playbook's `devBuyBands` (e.g. '4.9-5.1'). */
export function bandOf(bands: string[]): DevBuyBand {
  const edges = bands.map((b) => b.split('-').map(Number) as [number, number]);
  return { minSol: Math.min(...edges.map((e) => e[0])), maxSol: Math.max(...edges.map((e) => e[1])) };
}

/** Why a launch is not one the playbook would make (normal mode, SOL, standard curve, dev buy in band); null if it is. */
export function skipReason(l: LiveLaunch, band: DevBuyBand): string | null {
  if (l.isMayhem) return 'mayhem';
  if (l.quote !== SOL) return 'not SOL';
  if (!(Math.abs(l.price / STANDARD_PRICE - 1) < 0.01)) return 'non-standard curve';
  const intoCurve = l.devBuySol / (1 + CURVE_FEE_RATE);
  if (!(intoCurve >= band.minSol && intoCurve < band.maxSol)) return 'dev buy';
  return null;
}

export interface ShadowConfig {
  policy: ExitPolicy;
  /** Which of the playbook's exits `policy` is. */
  exit: 'flow' | 'timer';
  /** Feed lag estimate (s) when the launch was seen; null when unknown. */
  lagSec: number | null;
  /** The chain's estimated slot at a local time (`LiveFeed.slotAt`). */
  slotAt: (ms: number) => number | null;
  /** The feed lag estimate at a local time, for the record. */
  lagAt?: (ms: number) => number | null;
  /** Milliseconds per slot (`FeedLag.msPerSlot`); mainnet's 213 by default. */
  slotMs?: () => number;
  /** Slots between the decision and our sell landing (the backtest's 2). */
  latencySlots?: number;
  feedLostSec?: number;
  /** Seconds after launch the replay keeps running after our sell, for creator fees (the backtest's horizon). */
  followSec?: number;
  /** On a coin with no trade after the decision, wait this long past the landing slot for late trades, then land. */
  settleMs?: number;
  launchCostSol?: number;
  txCostSol?: number;
}

/** One shadow run, as appended to data/shadow/runs.jsonl. Ages are seconds after the launch reached the feed. */
export interface ShadowRecord {
  mint: string;
  symbol: string;
  name: string;
  sig: string;
  creator: string;
  signer: string;
  launchSlot: number;
  launchedAt: string;
  exit: 'flow' | 'timer';
  policy: string;
  lagAtLaunchSec: number | null;
  ourBuySol: number;
  ourTokens: number;
  decision: {
    reason: ExitDecision['reason'] | 'graduated';
    ageSec: number;
    /** The chain's estimated slot when the decision was made. */
    slot: number | null;
    lagSec: number | null;
    /** Other wallets' net SOL into the curve over the exit's window at the decision. */
    netBuyingSol: number;
  };
  /** The slot our sell lands in (the decision's slot + latency) and its estimated age. */
  landing: { ageSec: number; slot: number };
  /** What the whole-bag sell fetched, after fees. */
  sellSol: number;
  tradingPnl: number;
  /** Creator fees on every replayed trade until the end of the follow. */
  creatorFeesSol: number;
  costsSol: number;
  /** tradingPnl + creatorFeesSol - costsSol: the backtest's per-launch result. */
  result: number;
  graduated: boolean;
  followSec: number;
  /** The run ended before its follow time (shutdown). */
  followCut: boolean;
  /** Longest stretch (s) with no feed event while the run was open: over a few seconds, trades were likely missed. */
  maxFeedGapSec: number;
  trades: { buys: number; sells: number; deferredReactions: number };
  /** What the recorded dev did, from the trades as recorded. */
  recordedDev: {
    buySol: number;
    firstSellSec: number | null;
    soldShareAtOurSell: number;
    soldShare: number;
    /** SOL received - spent, plus tokens still held valued on the recorded curve at the end. */
    tradingPnl: number;
    /** tradingPnl + creator fees on the recorded curve - the same costs we are charged. */
    result: number;
  };
}

/**
 * One launch replayed with our bag. Feed it the coin's trades (`onTrade`, from `LiveFeed.subscribe` with the creator
 * and signer as dev wallets), every other feed event (`onEvent`) and clock ticks (`onTick`); `done` turns true once
 * our sell has landed and the follow time has passed, and `record()` then returns the result.
 */
export class ShadowRun {
  readonly launch: LiveLaunch;
  readonly engine: ExitEngine;
  private readonly cfg: Required<Omit<ShadowConfig, 'lagAt'>> & Pick<ShadowConfig, 'lagAt'>;
  /** The replay: our bag in place of the recorded dev's. */
  private readonly curve = new Curve();
  /** Every trade as recorded, the dev's included: values the recorded dev's leftover bag. */
  private readonly recordedCurve = new Curve();
  /** Other wallets' tokens as recorded and as replayed, to sell the same share of a holding. */
  private readonly held = new Map<string, { recorded: number; replayed: number }>();
  /** Other wallets' sells that reacted to the recorded dev's sell, held back until ours. */
  private readonly deferred: FeedTrade[] = [];
  private devSellSlot = -Infinity;
  private readonly ours: { spent: number; tokens: number; received: number };
  private creatorFees = 0;
  private recordedCreatorFees = 0;
  private costs: number;
  private readonly dev = { spent: 0, received: 0, bought: 0, sold: 0, sells: 0, firstSellAt: null as number | null, soldAtOurSell: 0 };
  private made: (ShadowRecord['decision'] & { at: number; landingSlot: number; landingAgeSec: number }) | null = null;
  /** Local time our sell was applied to the replay. */
  private landed: { at: number } | null = null;
  private endedAt: number | null = null;
  private lastSlot: number;
  private graduated = false;
  private followCut = false;
  private readonly counts = { buys: 0, sells: 0, deferredReactions: 0 };
  private lastEventAt: number;
  private maxGapMs = 0;

  constructor(launch: LiveLaunch, cfg: ShadowConfig) {
    this.launch = launch;
    this.cfg = {
      latencySlots: DEFAULT_SIM.latencySlots,
      feedLostSec: DEFAULT_FEED_LOST_SEC,
      followSec: DEFAULT_SIM.horizonSec,
      settleMs: 3000,
      slotMs: () => MAINNET_SLOT_MS,
      launchCostSol: DEFAULT_SIM.launchCostSol,
      txCostSol: DEFAULT_SIM.txCostSol,
      ...cfg,
    };
    this.engine = new ExitEngine(cfg.policy, { landedAt: launch.receivedAt, slot: launch.slot }, launch.signer, {
      feedLostSec: this.cfg.feedLostSec,
    });
    // Our launch buy comes first, in the create transaction, as the recorded dev's did.
    const r = this.curve.buy(cfg.policy.devBuySol ?? launch.devBuySol);
    this.ours = { spent: r.sol, tokens: r.tokens, received: 0 };
    this.creatorFees += r.creatorFee;
    this.costs = this.cfg.launchCostSol;
    this.recordedCreatorFees += this.recordedCurve.buy(launch.devBuySol).creatorFee;
    this.dev.spent = launch.devBuySol;
    this.dev.bought = launch.devTokens;
    this.lastSlot = launch.slot;
    this.lastEventAt = launch.receivedAt;
  }

  /** Our sell has landed and the follow time is over. */
  get done(): boolean {
    return this.endedAt !== null;
  }

  get decided(): boolean {
    return this.made !== null;
  }

  get sold(): boolean {
    return this.landed !== null;
  }

  /** Our sell once it has landed: what it fetched and the trading result, before creator fees and costs. */
  get sale(): { ageSec: number; sellSol: number; tradingPnl: number } | null {
    if (!this.landed) return null;
    return {
      ageSec: this.made?.landingAgeSec ?? (this.landed.at - this.launch.receivedAt) / 1000,
      sellSol: this.ours.received,
      tradingPnl: this.ours.received - this.ours.spent,
    };
  }

  /** A trade on the coin, in the order the feed delivered it. */
  onTrade(t: FeedTrade): void {
    if (this.endedAt !== null) return;
    this.heard(t.receivedAt);
    if (this.landed && t.receivedAt - this.launch.receivedAt > this.cfg.followSec * 1000) return this.end(t.receivedAt);
    this.lastSlot = Math.max(this.lastSlot, t.slot);
    if (this.made && !this.landed && t.slot >= this.made.landingSlot) this.land(t.receivedAt);

    const createBuy = t.dev && t.isBuy && t.sig === this.launch.sig;
    if (!createBuy) {
      const r = t.isBuy ? this.recordedCurve.buy(t.sol) : this.recordedCurve.sell(t.tokens);
      this.recordedCreatorFees += r.creatorFee;
    }
    if (t.dev) {
      if (!createBuy) this.devTrade(t);
      this.decide(this.engine.onTrade(t), t.receivedAt);
    } else if (!t.isBuy && !this.landed && t.slot >= this.devSellSlot && t.slot - this.devSellSlot <= REACTION_SLOTS) {
      // We are the dev and have not sold: this dump waits for our sell.
      this.deferred.push(t);
      this.counts.deferredReactions++;
      this.decide(this.engine.onEvent(t.receivedAt), t.receivedAt);
    } else {
      const sol = this.other(t);
      // The exit sees net buying in our version of the coin, as the backtest's does.
      this.decide(this.engine.onTrade({ ...t, sol }), t.receivedAt);
    }
    this.afterTrade(t.receivedAt);
  }

  /** Any other feed event: the feed is alive. */
  onEvent(receivedAt: number): void {
    if (this.endedAt !== null) return;
    this.heard(receivedAt);
    if (!this.made) this.decide(this.engine.onEvent(receivedAt), receivedAt);
  }

  onTick(nowMs: number): void {
    if (this.endedAt !== null) return;
    this.maxGapMs = Math.max(this.maxGapMs, nowMs - this.lastEventAt);
    if (!this.made) this.decide(this.engine.onTick(nowMs), nowMs);
    // No trade at or after the landing slot: the curve has not moved, so land once late trades had time to arrive.
    if (this.made && !this.landed) {
      const dueAt = this.made.at + this.cfg.latencySlots * this.cfg.slotMs() + this.cfg.settleMs;
      if (nowMs >= dueAt) this.land(nowMs);
    }
    if (this.landed && nowMs - this.launch.receivedAt > this.cfg.followSec * 1000) this.end(nowMs);
  }

  /** Ends the run early (shutdown): the record if our sell has landed, otherwise null. */
  finish(nowMs: number): ShadowRecord | null {
    if (this.endedAt === null) {
      if (!this.landed) return null;
      this.followCut = true;
      this.end(nowMs);
    }
    return this.record();
  }

  /** The run's result once `done`; null before. */
  record(): ShadowRecord | null {
    const d = this.made;
    const l = this.landed;
    if (this.endedAt === null || !d || !l) return null;
    const launchAt = this.launch.receivedAt;
    const tradingPnl = this.ours.received - this.ours.spent;
    const devLeft = Math.max(0, this.dev.bought - this.dev.sold);
    const devTrading = this.dev.received - this.dev.spent + this.recordedCurve.sellValue(devLeft);
    const devShare = (sold: number) => (this.dev.bought > 0 ? Math.min(1, sold / this.dev.bought) : 0);
    return {
      mint: this.launch.mint,
      symbol: this.launch.symbol,
      name: this.launch.name,
      sig: this.launch.sig,
      creator: this.launch.creator,
      signer: this.launch.signer,
      launchSlot: this.launch.slot,
      launchedAt: new Date(launchAt).toISOString(),
      exit: this.cfg.exit,
      policy: this.cfg.policy.name,
      lagAtLaunchSec: this.cfg.lagSec,
      ourBuySol: this.ours.spent,
      ourTokens: this.ours.tokens,
      decision: { reason: d.reason, ageSec: d.ageSec, slot: d.slot, lagSec: d.lagSec, netBuyingSol: d.netBuyingSol },
      landing: { ageSec: d.landingAgeSec, slot: d.landingSlot },
      sellSol: this.ours.received,
      tradingPnl,
      creatorFeesSol: this.creatorFees,
      costsSol: this.costs,
      result: tradingPnl + this.creatorFees - this.costs,
      graduated: this.graduated,
      followSec: (this.endedAt - launchAt) / 1000,
      followCut: this.followCut,
      maxFeedGapSec: this.maxGapMs / 1000,
      trades: { ...this.counts },
      recordedDev: {
        buySol: this.launch.devBuySol,
        firstSellSec: this.dev.firstSellAt !== null ? (this.dev.firstSellAt - launchAt) / 1000 : null,
        soldShareAtOurSell: devShare(this.dev.soldAtOurSell),
        soldShare: devShare(this.dev.sold),
        tradingPnl: devTrading,
        result: devTrading + this.recordedCreatorFees - this.cfg.launchCostSol - this.cfg.txCostSol * this.dev.sells,
      },
    };
  }

  private heard(at: number): void {
    this.maxGapMs = Math.max(this.maxGapMs, at - this.lastEventAt);
    this.lastEventAt = Math.max(this.lastEventAt, at);
  }

  private devTrade(t: FeedTrade): void {
    if (t.isBuy) {
      this.dev.spent += t.sol;
      this.dev.bought += t.tokens;
      return;
    }
    this.dev.received += t.sol;
    this.dev.sold += t.tokens;
    this.dev.sells++;
    this.dev.firstSellAt ??= t.receivedAt;
    this.devSellSlot = Math.max(this.devSellSlot, t.slot);
  }

  /**
   * Another wallet's trade on the replay: buys spend the recorded SOL, sells sell the recorded share of what the
   * wallet holds (tokens it never bought here are sold as recorded). Returns the SOL it moved in our version.
   */
  private other(t: FeedTrade): number {
    if (t.isBuy) {
      this.counts.buys++;
      const r = this.curve.buy(t.sol);
      this.creatorFees += r.creatorFee;
      const h = this.held.get(t.wallet) ?? { recorded: 0, replayed: 0 };
      h.recorded += t.tokens;
      h.replayed += r.tokens;
      this.held.set(t.wallet, h);
      return r.sol;
    }
    this.counts.sells++;
    const h = this.held.get(t.wallet);
    let amount = t.tokens;
    if (h && h.recorded > 0) {
      const part = Math.min(1, t.tokens / h.recorded);
      amount = part * h.replayed;
      h.recorded -= part * h.recorded;
      h.replayed -= amount;
    }
    const r = this.curve.sell(amount);
    this.creatorFees += r.creatorFee;
    return r.sol;
  }

  private decide(d: ExitDecision | null, now: number): void {
    if (!d || this.made) return;
    const slot = this.cfg.slotAt(d.at);
    this.made = {
      reason: d.reason,
      ageSec: d.ageSec,
      at: d.at,
      slot,
      lagSec: this.cfg.lagAt?.(now) ?? null,
      netBuyingSol: this.engine.netBuying(d.at),
      landingSlot: (slot ?? this.lastSlot) + this.cfg.latencySlots,
      landingAgeSec: d.ageSec + (this.cfg.latencySlots * this.cfg.slotMs()) / 1000,
    };
  }

  /** Our whole-bag sell lands; the dumps that waited for it follow at once. */
  private land(at: number): void {
    const r = this.curve.sell(this.ours.tokens);
    this.ours.received = r.sol;
    this.creatorFees += r.creatorFee;
    this.costs += this.cfg.txCostSol;
    this.landed = { at };
    this.dev.soldAtOurSell = this.dev.sold;
    for (const t of this.deferred.splice(0)) this.other(t);
  }

  private afterTrade(now: number): void {
    if (!this.curve.complete) return;
    // The curve completed in our version: as in the backtest, the bag is sold into the completed curve.
    this.graduated = true;
    if (!this.made) {
      const ageSec = (now - this.launch.receivedAt) / 1000;
      const slot = this.cfg.slotAt(now);
      this.made = {
        reason: 'graduated',
        ageSec,
        at: now,
        slot,
        lagSec: this.cfg.lagAt?.(now) ?? null,
        netBuyingSol: this.engine.netBuying(now),
        landingSlot: slot ?? this.lastSlot,
        landingAgeSec: ageSec,
      };
    }
    if (!this.landed) this.land(now);
    this.end(now);
  }

  private end(now: number): void {
    this.endedAt ??= now;
  }
}

export interface ShadowSummary {
  runs: number;
  meanResult: number | null;
  medianResult: number | null;
  profitableShare: number | null;
  /** The recorded devs on the same launches. */
  meanRecordedDevResult: number | null;
  medianDecisionAgeSec: number | null;
  byReason: Record<string, number>;
  byExit: Record<string, number>;
  /** Mean feed lag (s) at the decision, over runs where it was known. */
  meanLagSec: number | null;
}

export function summarize(records: ShadowRecord[]): ShadowSummary {
  const count = (key: (r: ShadowRecord) => string) =>
    records.reduce<Record<string, number>>((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {});
  const lags = records.map((r) => r.decision.lagSec).filter((x): x is number => x !== null);
  return {
    runs: records.length,
    meanResult: mean(records.map((r) => r.result)),
    medianResult: median(records.map((r) => r.result)),
    profitableShare: share(records.map((r) => r.result > 0)),
    meanRecordedDevResult: mean(records.map((r) => r.recordedDev.result)),
    medianDecisionAgeSec: median(records.map((r) => r.decision.ageSec)),
    byReason: count((r) => r.decision.reason),
    byExit: count((r) => r.exit),
    meanLagSec: mean(lags),
  };
}

export function formatSummary(s: ShadowSummary): string {
  const f = (x: number | null, d = 3) => (x === null ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
  const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const kv = (m: Record<string, number>) =>
    Object.entries(m)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';
  return [
    `shadow runs ${s.runs}: mean ${f(s.meanResult)} SOL, median ${f(s.medianResult)}, profitable ${pct(s.profitableShare)}` +
      ` (recorded devs ${f(s.meanRecordedDevResult)})`,
    `  decision age median ${s.medianDecisionAgeSec === null ? 'n/a' : s.medianDecisionAgeSec.toFixed(1) + ' s'};` +
      ` by reason: ${kv(s.byReason)}; exit: ${kv(s.byExit)}; mean feed lag ${s.meanLagSec === null ? 'n/a' : s.meanLagSec.toFixed(2) + ' s'}`,
  ].join('\n');
}
