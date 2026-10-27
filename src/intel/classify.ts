import { HOLD_BUCKETS, type WalletState } from './state.ts';

export const DECAY_HALF_LIFE_SEC = 86_400;

/** Bump whenever archetype rules change, so stored labels are recomputed on the next observer start. */
export const CLASSIFY_VERSION = 2;

/** Entry within this many seconds of launch counts as a snipe. */
export const SNIPE_WINDOW_SEC = 3;

/**
 * Archetype thresholds. These are starting values; Phase 5's playbook loop is expected to tune them once there
 * is enough data to see which cut-offs separate useful wallets from noise.
 */
export const THRESHOLDS = {
  topMinClosed: 15,
  topMinRealizedSol: 10,
  topMinWinRate: 0.45,
  /** A large buy is at least this size, outside a coin's launch second (launch buyouts are not whale behaviour). */
  whaleLargeBuySol: 5,
  whaleMinLargeBuys: 3,
  aggressiveMinTradesPerDay: 150,
  aggressiveMinAvgBuySol: 0.5,
  flipperMinClosed: 10,
  flipperMaxMedianHoldSec: 60,
  sniperMinEntries: 8,
  sniperMinShare: 0.5,
  multiMinOpensPerActiveHour: 8,
  multiMinActiveHours: 3,
  multiMinMaxOpen: 25,
  scheduledMinDays: 3,
  scheduledMinTrades: 40,
  scheduledMinWindowShare: 0.7,
  botMinTradesPerDay: 1500,
  botMaxMedianHoldSec: 5,
  botMinClosed: 50,
  serialCreatorMinLaunches: 3,
};

export const ARCHETYPES: Record<string, string> = {
  top_performer: 'consistently profitable on closed positions, and still in form',
  whale: 'repeated large buys (5+ SOL, not in a launch second)',
  aggressive: 'high trade frequency at meaningful size',
  flipper: 'median hold of a minute or less',
  sniper: 'usually enters within seconds of launch',
  multi_coin: 'opens many coins per hour or holds many at once',
  scheduled: 'trades mostly inside the same few hours each day',
  bot_like: 'trade rate or hold times only a bot would produce',
  serial_creator: 'has launched several coins',
};

export function decayFactor(fromTs: number, toTs: number): number {
  return toTs > fromTs ? Math.pow(2, -(toTs - fromTs) / DECAY_HALF_LIFE_SEC) : 1;
}

/** Brings the wallet's decayed counters forward to `ts`. */
export function decayTo(w: WalletState, ts: number): void {
  const f = decayFactor(w.decayTs, ts);
  w.pnlDecayed *= f;
  w.tradesDecayed *= f;
  w.decayTs = Math.max(w.decayTs, ts);
}

export function tradesPerDay(w: WalletState, nowTs: number): number {
  return w.tradesDecayed * decayFactor(w.decayTs, nowTs) * Math.LN2;
}

/** Upper bound of the hold-time bucket that contains the median closed position, or null with no closes. */
export function medianHoldSec(hist: number[]): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= total / 2) return HOLD_BUCKETS[i]!;
  }
  return null;
}

/** Largest share of trades inside any `width`-hour window of the UTC day (wrapping midnight). */
export function bestWindow(hourHist: number[], width = 3): { share: number; startHour: number } {
  const total = hourHist.reduce((a, b) => a + b, 0);
  if (total === 0) return { share: 0, startHour: 0 };
  let best = 0;
  let startHour = 0;
  for (let h = 0; h < 24; h++) {
    let sum = 0;
    for (let k = 0; k < width; k++) sum += hourHist[(h + k) % 24]!;
    if (sum > best) {
      best = sum;
      startHour = h;
    }
  }
  return { share: best / total, startHour };
}

export function opensPerActiveHour(w: WalletState): { rate: number; activeHours: number } {
  const counts = Object.values(w.hourOpens);
  if (counts.length === 0) return { rate: 0, activeHours: 0 };
  return { rate: counts.reduce((a, b) => a + b, 0) / counts.length, activeHours: counts.length };
}

export function classify(w: WalletState, nowTs: number): string[] {
  const t = THRESHOLDS;
  const out: string[] = [];
  const winRate = w.closed > 0 ? w.wins / w.closed : 0;
  const avgBuy = w.buys > 0 ? w.buySol / w.buys : 0;
  const perDay = tradesPerDay(w, nowTs);
  const median = medianHoldSec(w.holdHist);
  const pnlNow = w.pnlDecayed * decayFactor(w.decayTs, nowTs);

  if (w.closed >= t.topMinClosed && w.realizedSol >= t.topMinRealizedSol && winRate >= t.topMinWinRate && pnlNow > 0) {
    out.push('top_performer');
  }
  if (w.largeBuys >= t.whaleMinLargeBuys) out.push('whale');
  if (perDay >= t.aggressiveMinTradesPerDay && avgBuy >= t.aggressiveMinAvgBuySol) out.push('aggressive');
  if (w.closed >= t.flipperMinClosed && median !== null && median <= t.flipperMaxMedianHoldSec) out.push('flipper');
  if (w.knownEntries >= t.sniperMinEntries && w.snipes / w.knownEntries >= t.sniperMinShare) out.push('sniper');
  const opens = opensPerActiveHour(w);
  if (
    (opens.activeHours >= t.multiMinActiveHours && opens.rate >= t.multiMinOpensPerActiveHour) ||
    w.maxOpen >= t.multiMinMaxOpen
  ) {
    out.push('multi_coin');
  }
  if (
    w.days.length >= t.scheduledMinDays &&
    w.trades >= t.scheduledMinTrades &&
    bestWindow(w.hourHist).share >= t.scheduledMinWindowShare
  ) {
    out.push('scheduled');
  }
  if (
    perDay >= t.botMinTradesPerDay ||
    (w.closed >= t.botMinClosed && median !== null && median <= t.botMaxMedianHoldSec)
  ) {
    out.push('bot_like');
  }
  if (w.launches >= t.serialCreatorMinLaunches) out.push('serial_creator');
  return out;
}

/**
 * Wallets whose buys are worth flagging on a young coin. Snipers are excluded even when profitable: winning by
 * buying launches in their first seconds is usually a creator or bundler trading its own coins, not judgement.
 */
export function isSmartMoney(archetypes: string[]): boolean {
  if (archetypes.includes('bot_like') || archetypes.includes('sniper')) return false;
  return archetypes.includes('top_performer') || archetypes.includes('whale');
}
