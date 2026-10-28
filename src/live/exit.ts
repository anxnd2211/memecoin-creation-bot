import type { ExitPolicy } from '../sim/simulate.ts';
import type { ExitDecision, LaunchFill, LiveTrade } from './types.ts';

/**
 * The live exit: decides, from the trade feed of our own coin, when to sell the whole bag. It runs the backtest's
 * decision rule (src/sim/simulate.ts) on live events and does no I/O: the caller feeds it trades, feed heartbeats and
 * clock ticks, and acts on the one decision it returns.
 *
 * Time base: local receive time. A trade counts from the moment the feed delivered it (`receivedAt`), and the hold
 * timers run from the local time the launch was seen landed. The backtest evaluates windows on the chain clock with no
 * feed lag; with a feed running L behind the chain, the window ending now on the receive clock holds exactly the
 * trades of the chain window ending L ago, so the engine makes the backtest's decisions on the same windows, each L
 * later in real time. That delay is what costs the flow exit its edge on a slow feed, which is why the live command
 * picks the exit with `exitFor(playbook, lag)` from `FeedLag` below. Jitter in the lag moves a trade within the
 * window by the jitter. Pass a landing time measured the way trades are (the feed's receipt of the create
 * transaction when there is one): a later landing time only lengthens the hold.
 *
 * Supported policies: the flow exit (`stall`, whole bag, max hold) and the timed exit (whole bag at max hold, the
 * playbook's slow-feed exit). Anything that sells in parts throws, so a policy the engine cannot run is never run
 * half-way.
 */

/** Sell when no feed event of any kind has arrived for this many seconds after the hold. */
export const DEFAULT_FEED_LOST_SEC = 5;

export interface ExitEngineOptions {
  /** Seconds without any feed event, after the minimum hold, before the bag is sold blind (default 5). */
  feedLostSec?: number;
}

/** Window used to report net buying for a timed policy, which has no stall window of its own. */
const REPORT_WINDOW_SEC = 5;

/** Throws unless the engine can run `policy` exactly: one whole-bag sell, a finite max hold. */
function checkPolicy(p: ExitPolicy): void {
  const unsupported: string[] = [];
  if (p.ladder.length) unsupported.push('inflow ladder');
  if (p.timeLadder?.length) unsupported.push('time ladder');
  if (p.idleSec !== null) unsupported.push('idle exit');
  if (p.moonbagShare > 0) unsupported.push('moonbag');
  if (p.moonbagExit) unsupported.push('moonbag exit');
  if (p.replayDev) unsupported.push('recorded-dev replay');
  if (!(p.maxHoldSec > 0) || !Number.isFinite(p.maxHoldSec)) unsupported.push(`max hold ${p.maxHoldSec}`);
  const s = p.stall;
  if (s && !(s.windowSec > 0 && s.minHoldSec >= 0 && Number.isFinite(s.minSol))) unsupported.push('stall settings');
  if (unsupported.length) throw new Error(`ExitEngine cannot run "${p.name}": ${unsupported.join(', ')}`);
}

/**
 * Decides when to sell the whole bag of one launch. Feed it every trade on the coin (`onTrade`), any other feed
 * event (`onEvent`, so it knows the feed is alive) and clock ticks (`onTick`, every 100 ms or so, or at
 * `nextCheckAt()`); each returns the decision the first time one is made, and null otherwise. A decision is final:
 * after it every call returns null, and selling (with retries) is the caller's job.
 *
 * - **stall** (flow policy): from max(minHold, window) seconds after landing, other wallets' net SOL into the curve
 *   over the last `windowSec` is at or below `minSol`. A trade that brings it there decides at once; a window that
 *   goes quiet with no trade decides on the next tick.
 * - **max hold**, or **slow feed timer** for a timed policy (one without a stall window): `maxHoldSec` after landing.
 * - **feed lost**: past the minimum hold, no feed event of any kind for `feedLostSec`, so a dead feed never strands
 *   the bag. A timed policy needs no feed and keeps its timer.
 * - **kill**: `kill()`, the owner's switch.
 *
 * Our own trades (`dev`, or the dev wallet) never count toward net buying. As in the backtest, timers fire before a
 * trade that arrives after them, and a trade arriving exactly when the window would go quiet still counts in it.
 */
export class ExitEngine {
  readonly policy: ExitPolicy;
  /** Local ms the launch was seen landed: the zero of every timer. */
  readonly landedAt: number;
  readonly landedSlot: number | null;
  readonly dev: string;
  private readonly windowMs: number;
  private readonly minSol: number;
  /** A window can only stall once it has had time to fill: max(minHold, window) after landing. */
  private readonly stallFrom: number;
  private readonly maxHoldAt: number;
  /** From here a silent feed means the feed is lost. */
  private readonly holdEnd: number;
  private readonly feedLostMs: number;
  private readonly timerReason: ExitDecision['reason'];
  /** Other wallets' trades still inside some future window, as signed SOL into the curve, in receive order. */
  private readonly recent: { at: number; sol: number }[] = [];
  /** When the stall exit fires if no other trade comes first: now, or when enough trades age out. */
  private stallAt: number;
  private now: number;
  private lastEventAt: number;
  private made: ExitDecision | null = null;

  constructor(policy: ExitPolicy, landing: Pick<LaunchFill, 'landedAt' | 'slot'>, dev: string, opts: ExitEngineOptions = {}) {
    checkPolicy(policy);
    this.policy = policy;
    this.landedAt = landing.landedAt;
    this.landedSlot = landing.slot;
    this.dev = dev;
    const s = policy.stall ?? null;
    this.windowMs = (s?.windowSec ?? REPORT_WINDOW_SEC) * 1000;
    this.minSol = s?.minSol ?? -Infinity;
    this.stallFrom = s ? this.landedAt + Math.max(s.minHoldSec, s.windowSec) * 1000 : Infinity;
    this.stallAt = this.stallFrom;
    this.maxHoldAt = this.landedAt + policy.maxHoldSec * 1000;
    this.holdEnd = s ? this.landedAt + s.minHoldSec * 1000 : this.maxHoldAt;
    this.feedLostMs = (opts.feedLostSec ?? DEFAULT_FEED_LOST_SEC) * 1000;
    this.timerReason = s ? 'max hold' : 'slow feed timer';
    this.now = this.landedAt;
    this.lastEventAt = this.landedAt;
  }

  /** The decision, once made. */
  get decision(): ExitDecision | null {
    return this.made;
  }

  /** A trade on the coin. Timers due before it fire first; then it counts toward net buying unless it is ours. */
  onTrade(t: LiveTrade): ExitDecision | null {
    if (this.made) return null;
    const now = this.advance(t.receivedAt);
    this.lastEventAt = now;
    const due = this.due(now, true);
    if (due || t.dev || t.wallet === this.dev) return due;
    this.recent.push({ at: now, sol: t.isBuy ? t.sol : -t.sol });
    this.trim(now);
    if (!this.policy.stall) return null;
    this.stallAt = this.nextStall(now);
    return this.stallAt <= now ? this.decide('stall', now) : null;
  }

  /** Any other feed event (another coin's trade, a launch): the feed is alive. */
  onEvent(receivedAt: number): ExitDecision | null {
    if (this.made) return null;
    const now = this.advance(receivedAt);
    this.lastEventAt = now;
    return this.due(now, true);
  }

  /** The clock: fires timers, quiet windows and a lost feed. */
  onTick(nowMs: number): ExitDecision | null {
    if (this.made) return null;
    return this.due(this.advance(nowMs), false);
  }

  /** The owner's kill switch: sell now. Returns the decision already made, if there is one. */
  kill(nowMs: number): ExitDecision {
    return this.made ?? this.decide('kill', this.advance(nowMs));
  }

  /** Local ms of the next moment a tick could decide, if no trade or event comes first. */
  nextCheckAt(): number {
    if (this.made) return Infinity;
    const lost = Math.max(this.holdEnd, this.lastEventAt + this.feedLostMs);
    return Math.min(this.maxHoldAt, this.stallAt, this.policy.stall ? lost : Infinity);
  }

  /** Other wallets' net SOL into the curve over the window ending at `nowMs` (5 s for a timed policy). */
  netBuying(nowMs: number = this.now): number {
    let sum = 0;
    for (const e of this.recent) if (e.at > nowMs - this.windowMs && e.at <= nowMs) sum += e.sol;
    return sum;
  }

  /** Time never runs backwards: a late receive time counts as now. */
  private advance(at: number): number {
    this.now = Math.max(this.now, at);
    return this.now;
  }

  /**
   * Timers due at `now`. Events arriving at the very moment the window goes quiet count in it, as trades stamped with
   * that second do in the backtest, so they only see a stall due strictly before them.
   */
  private due(now: number, strict: boolean): ExitDecision | null {
    if (now >= this.maxHoldAt) return this.decide(this.timerReason, now);
    if (this.policy.stall && now >= this.holdEnd && now - this.lastEventAt >= this.feedLostMs) return this.decide('feed lost', now);
    if (strict ? now > this.stallAt : now >= this.stallAt) return this.decide('stall', now);
    return null;
  }

  private decide(reason: ExitDecision['reason'], at: number): ExitDecision {
    this.made = { reason, at, ageSec: (at - this.landedAt) / 1000 };
    return this.made;
  }

  /** Drops trades no window from `now` on can hold. */
  private trim(now: number): void {
    while (this.recent.length && this.recent[0]!.at <= now - this.windowMs) this.recent.shift();
  }

  /**
   * When the window ending then holds net buying at or below the threshold, if no other trade comes first: now (or
   * the first moment a stall is allowed), or when enough of the trades in it age out. simulate.ts's `nextStall`, in
   * receive-time milliseconds.
   */
  private nextStall(now: number): number {
    const w = this.windowMs;
    const recent = this.recent;
    this.trim(now);
    const from = Math.max(now, this.stallFrom);
    let sum = 0;
    for (const e of recent) if (e.at > from - w) sum += e.sol;
    if (sum <= this.minSol) return from;
    // Trades are in time order: drop each moment's as it ages out until the window is quiet enough.
    for (let i = 0; i < recent.length; ) {
      const at = recent[i]!.at;
      for (; i < recent.length && recent[i]!.at === at; i++) if (at > from - w) sum -= recent[i]!.sol;
      if (at + w > from && sum <= this.minSol) return at + w;
    }
    return Infinity;
  }
}

export interface FeedLagOptions {
  /** Samples older than this are forgotten (default 60 s). */
  windowSec?: number;
  /** Fewer samples than this in the window and the lag is unknown (default 20). */
  minSamples?: number;
  /** No sample for this long and the lag is unknown: the feed may be dead (default 5 s). */
  staleSec?: number;
  /** Slot time until the feed has measured one (default `MAINNET_SLOT_MS`). */
  slotMs?: number;
}

/**
 * Mainnet slot time, measured 2026-10-28 from block times over 20,000 slots (213 ms; 215 ms from the feed). The
 * backtest's SLOT_SEC (0.4 s) is out of date. Used until the feed has measured its own.
 */
export const MAINNET_SLOT_MS = 213;
/** Most samples kept; a busy feed (100+ events a second) is thinned to the newest. */
const MAX_LAG_SAMPLES = 20_000;
/** Chain timestamps are whole seconds, so a sample reads on average half a second more than the real lag. */
const WHOLE_SECOND_BIAS_MS = 500;

/**
 * How far the feed runs behind the chain, from every pump event: receive time minus the event's chain timestamp. The
 * chain stamps whole seconds, so each sample reads the real lag plus a uniform 0-1 s; `estimate` is the p95 over the
 * last minute minus 0.5 s (for a steady lag L it reads about L + 0.45 s, erring towards the slow-feed exit), and is
 * null without enough recent samples, which `exitFor` treats as a slow feed. Lag includes any offset between the
 * local clock and the chain's.
 */
export class FeedLag {
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly staleMs: number;
  /** Receive time and raw lag (ms) of each sample, in arrival order, from `head` on. */
  private at: number[] = [];
  private lagMs: number[] = [];
  /** Each sample's slot, 0 when unknown. */
  private slots: number[] = [];
  private head = 0;
  private newest: { slot: number; at: number; chainMs: number } | null = null;
  private readonly defaultSlotMs: number;

  constructor(opts: FeedLagOptions = {}) {
    this.windowMs = (opts.windowSec ?? 60) * 1000;
    this.minSamples = opts.minSamples ?? 20;
    this.staleMs = (opts.staleSec ?? 5) * 1000;
    this.defaultSlotMs = opts.slotMs ?? MAINNET_SLOT_MS;
  }

  /** One event: local receive time (ms), chain timestamp (unix seconds) and, if known, its slot. */
  add(receivedAt: number, chainTs: number, slot?: number): void {
    if (!Number.isFinite(receivedAt) || !Number.isFinite(chainTs) || chainTs <= 0) return;
    this.at.push(receivedAt);
    this.lagMs.push(receivedAt - chainTs * 1000);
    this.slots.push(slot ?? 0);
    if (slot !== undefined && slot > 0 && (!this.newest || slot > this.newest.slot)) {
      this.newest = { slot, at: receivedAt, chainMs: chainTs * 1000 };
    }
    while (this.head < this.at.length && (this.at[this.head]! <= receivedAt - this.windowMs || this.at.length - this.head > MAX_LAG_SAMPLES)) {
      this.head++;
    }
    if (this.head > 4096 && this.head * 2 > this.at.length) {
      this.at = this.at.slice(this.head);
      this.lagMs = this.lagMs.slice(this.head);
      this.slots = this.slots.slice(this.head);
      this.head = 0;
    }
  }

  /** Samples inside the window ending at `nowMs`. */
  count(nowMs: number): number {
    return this.window(nowMs).length;
  }

  /** p95 lag in seconds over the last minute, less the whole-second bias; null when not enough recent data. */
  estimate(nowMs: number): number | null {
    return this.quantile(nowMs, 0.95);
  }

  /** Median lag in seconds, less the whole-second bias; null when not enough recent data. */
  median(nowMs: number): number | null {
    return this.quantile(nowMs, 0.5);
  }

  /**
   * Milliseconds per slot, from the chain timestamps of the oldest and newest slots in the window once they span 10 s;
   * `slotMs` (mainnet's 213 ms) before that.
   */
  msPerSlot(): number {
    const n = this.newest;
    if (n) {
      for (let i = this.head; i < this.at.length; i++) {
        if (!(this.slots[i]! > 0)) continue;
        const slots = n.slot - this.slots[i]!;
        const ms = n.chainMs - (this.at[i]! - this.lagMs[i]!);
        if (slots >= 20 && ms >= 10_000) return ms / slots;
        break;
      }
    }
    return this.defaultSlotMs;
  }

  /**
   * The chain's slot at local time `ms`: the newest slot seen, plus the time since it arrived and the median lag at
   * `msPerSlot()`; null before any slot. Without a lag estimate the slot it arrived in counts as current.
   */
  slotAt(ms: number): number | null {
    if (!this.newest) return null;
    const lag = Math.max(0, this.median(ms) ?? 0) * 1000;
    return this.newest.slot + Math.max(0, Math.floor((ms - this.newest.at + lag) / this.msPerSlot()));
  }

  private window(nowMs: number): number[] {
    const out: number[] = [];
    for (let i = this.at.length - 1; i >= this.head && this.at[i]! > nowMs - this.windowMs; i--) {
      if (this.at[i]! <= nowMs) out.push(this.lagMs[i]!);
    }
    return out;
  }

  private quantile(nowMs: number, q: number): number | null {
    const last = this.at.length > this.head ? this.at[this.at.length - 1]! : null;
    if (last === null || nowMs - last > this.staleMs) return null;
    const xs = this.window(nowMs);
    if (xs.length < this.minSamples) return null;
    xs.sort((a, b) => a - b);
    return (xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]! - WHOLE_SECOND_BIAS_MS) / 1000;
  }
}
