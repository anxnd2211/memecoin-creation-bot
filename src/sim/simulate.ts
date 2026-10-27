import { Curve } from '../chain/curve.ts';
import { PHANTOM, type FlowTrade } from './flow.ts';

/**
 * Replays a recorded launch with our dev position in place of the recorded dev's, under a selling plan. Everyone
 * else's trades happen as recorded: buyers spend the same SOL, and sellers sell the same share of what they hold
 * (tokens they never bought here, such as router or phantom trades, are sold as recorded). Prices follow from the
 * curve, so our sells move the price the others trade at. Sells that reacted to the recorded dev's sell are skipped
 * until we have sold. What the replay cannot know is whether buyers would have treated our coin the way they treated
 * the real one, or how others react to a partial sell of ours.
 */

/** Average Solana slot time. */
export const SLOT_SEC = 0.4;

export interface ExitPolicy {
  name: string;
  /** Our launch buy in SOL, fees included; null uses the recorded dev's launch buy, which the outside flow saw. */
  devBuySol: number | null;
  /** Each time other wallets' net SOL into the curve since launch reaches a level, sell that share of the launch bag. */
  ladder: { inflowSol: number; share: number }[];
  /** Seconds after launch at which everything but the moonbag is sold. */
  maxHoldSec: number;
  /** Sell everything but the moonbag once no outside buy has come for this many seconds; null turns it off. */
  idleSec: number | null;
  /**
   * Sell everything but the moonbag once, after `minHoldSec`, other wallets' net SOL into the curve over the last
   * `windowSec` seconds is at or below `minSol`: hold while buying keeps coming, leave when it stalls or turns.
   */
  stall?: { minHoldSec: number; windowSec: number; minSol: number } | null;
  /** Share of the launch bag kept, once the dev buy is recovered, and valued at the end. */
  moonbagShare: number;
  /** Replay the recorded dev's own trades instead of a plan, to check the replay and as a benchmark. */
  replayDev?: boolean;
}

export interface SimOptions {
  /** Slots between a trade we react to and our sell landing. */
  latencySlots: number;
  /** Trades later than this after launch are ignored; what we still hold is valued at that point. */
  horizonSec: number;
  /** Rent and fees of the create transaction, beyond the dev buy. */
  launchCostSol: number;
  /** Network, priority fee and tip per sell. */
  txCostSol: number;
}

/** Launch cost measured from recorded create transactions (0.01-0.025 SOL beyond the dev buy). */
export const DEFAULT_SIM: SimOptions = { latencySlots: 2, horizonSec: 1800, launchCostSol: 0.02, txCostSol: 0.002 };

export interface SimCoin {
  mint: string;
  symbol: string | null;
  createdTs: number;
  trades: FlowTrade[];
  /** The recorded dev's buys in the launch slot (the create transaction), SOL with fees. */
  launchBuySol: number;
}

export interface SimResult {
  /** Trading result + creator fees - costs. */
  pnl: number;
  spent: number;
  received: number;
  /** What tokens still held at the end would return sold into the curve. */
  bagSol: number;
  creatorFees: number;
  costs: number;
  sells: number;
  firstSellSec: number | null;
  /** The curve completed during the replay; the bag is valued at the completed curve. */
  graduated: boolean;
}

export function simulate(coin: SimCoin, policy: ExitPolicy, o: SimOptions = DEFAULT_SIM): SimResult {
  const curve = new Curve();
  const created = coin.createdTs;
  let spent = 0;
  let received = 0;
  let tokens = 0;
  let creatorFees = 0;
  let sells = 0;
  let costs = o.launchCostSol;
  let firstSellTs: number | null = null;

  const sell = (amount: number, ts: number) => {
    amount = Math.min(amount, tokens);
    if (!(amount > 0)) return;
    const r = curve.sell(amount);
    received += r.sol;
    creatorFees += r.creatorFee;
    tokens -= amount;
    sells++;
    costs += o.txCostSol;
    firstSellTs ??= ts;
  };
  const buy = (sol: number) => {
    const r = curve.buy(sol);
    spent += r.sol;
    creatorFees += r.creatorFee;
    tokens += r.tokens;
    return r.tokens;
  };

  const plan = !policy.replayDev;
  const launchBag = plan ? buy(policy.devBuySol ?? coin.launchBuySol) : 0;
  const moonbag = launchBag * policy.moonbagShare;
  /** Ladder sells waiting to land: they execute before the first trade at or after `slot`. */
  let pending: { slot: number; tokens: number } | null = null;
  let exited = false;
  /** Sells everything but the moonbag; the moonbag is kept only if the dev buy is back by then. */
  const exit = (ts: number) => {
    if (exited) return;
    exited = true;
    pending = null;
    const keep = moonbag > 0 && received + curve.sellValue(tokens - moonbag) >= spent ? moonbag : 0;
    sell(tokens - keep, ts);
  };

  /** Other wallets' tokens as recorded and as replayed, to sell the same share of a holding. */
  const held = new Map<number, { recorded: number; replayed: number }>();
  let devRecorded = 0;
  let inflow = 0;
  let lastBuyTs = created;
  let rung = 0;
  const latencySec = o.latencySlots * SLOT_SEC;
  const stall = policy.stall ?? null;
  /** Other wallets' trades in the stall window, as signed SOL into the curve. */
  const recent: { ts: number; sol: number }[] = [];
  /** A window can only stall once it has had time to fill. */
  const stallFrom = stall ? created + Math.max(stall.minHoldSec, stall.windowSec) : Infinity;
  /**
   * When the window ending then holds net buying at or below the threshold, if no other trade comes first: now, or
   * when enough of the trades in it age out.
   */
  const nextStall = (now: number): number => {
    const w = stall!.windowSec;
    while (recent.length && recent[0]!.ts <= now - w) recent.shift();
    const from = Math.max(now, stallFrom);
    let sum = 0;
    for (const e of recent) if (e.ts > from - w) sum += e.sol;
    if (sum <= stall!.minSol) return from;
    // Trades are in time order: drop each second's as it ages out until the window is quiet enough.
    for (let i = 0; i < recent.length; ) {
      const ts = recent[i]!.ts;
      for (; i < recent.length && recent[i]!.ts === ts; i++) if (ts > from - w) sum -= recent[i]!.sol;
      if (ts + w > from && sum <= stall!.minSol) return ts + w;
    }
    return Infinity;
  };
  /** The stall exit's time if nothing else trades first; a stall a trade causes lands `latencySlots` after it. */
  let stallAt = stallFrom;
  let stallExitSlot: number | null = null;

  for (const t of coin.trades) {
    if (t.ts - created > o.horizonSec || curve.complete) break;
    if (plan && !exited) {
      // Timers fire before any trade that comes after them.
      if (t.ts - created >= policy.maxHoldSec) exit(created + policy.maxHoldSec);
      else if (policy.idleSec !== null && t.ts - lastBuyTs >= policy.idleSec + latencySec) exit(lastBuyTs + policy.idleSec);
      else if (stallExitSlot !== null ? t.slot >= stallExitSlot : t.ts >= stallAt + latencySec) {
        // A window that went quiet needs no trade to notice; the curve has not moved since the last one.
        exit(stallExitSlot !== null ? t.ts : stallAt);
      }
      if (pending && t.slot >= pending.slot) {
        sell(pending.tokens, t.ts);
        pending = null;
      }
    }

    // Sells that reacted to the recorded dev's sell would not happen before we sell: we are the dev.
    if (plan && t.reaction && sells === 0) continue;
    if (t.dev) {
      if (plan) continue;
      // Benchmark: the recorded dev's trades, sells as a share of what the dev held.
      if (t.isBuy) {
        buy(t.sol);
        devRecorded += t.tokens;
      } else {
        sell(devRecorded > 0 ? Math.min(1, t.tokens / devRecorded) * tokens : t.tokens, t.ts);
        devRecorded = Math.max(0, devRecorded - t.tokens);
      }
      continue;
    }

    if (t.isBuy) {
      const r = curve.buy(t.sol);
      creatorFees += r.creatorFee;
      inflow += r.sol;
      lastBuyTs = t.ts;
      if (stall) recent.push({ ts: t.ts, sol: r.sol });
      if (t.wallet !== PHANTOM) {
        const h = held.get(t.wallet) ?? { recorded: 0, replayed: 0 };
        h.recorded += t.tokens;
        h.replayed += r.tokens;
        held.set(t.wallet, h);
      }
    } else {
      const h = held.get(t.wallet);
      let amount = t.tokens;
      if (h && h.recorded > 0) {
        const share = Math.min(1, t.tokens / h.recorded);
        amount = share * h.replayed;
        h.recorded -= share * h.recorded;
        h.replayed -= amount;
      }
      const r = curve.sell(amount);
      creatorFees += r.creatorFee;
      inflow -= r.sol;
      if (stall) recent.push({ ts: t.ts, sol: -r.sol });
    }

    if (plan && !exited) {
      if (stall && stallExitSlot === null) {
        stallAt = nextStall(t.ts);
        if (stallAt <= t.ts) stallExitSlot = t.slot + o.latencySlots;
      }
      while (rung < policy.ladder.length && inflow >= policy.ladder[rung]!.inflowSol) {
        const add = policy.ladder[rung]!.share * launchBag;
        pending = pending ? { slot: pending.slot, tokens: pending.tokens + add } : { slot: t.slot + o.latencySlots, tokens: add };
        rung++;
      }
    }
  }

  // Timers still fire after the last recorded trade; the earliest is when the plan would have sold.
  if (plan) {
    const endTs = Math.min(coin.trades.at(-1)?.ts ?? created, created + o.horizonSec);
    if (pending) {
      sell(pending.tokens, endTs);
      pending = null;
    }
    const idleAt = policy.idleSec !== null ? lastBuyTs + policy.idleSec : Infinity;
    exit(Math.max(endTs, Math.min(created + policy.maxHoldSec, idleAt, stallAt)));
  }

  const bagSol = curve.sellValue(tokens);
  return {
    pnl: received - spent + bagSol + creatorFees - costs,
    spent,
    received,
    bagSol,
    creatorFees,
    costs,
    sells,
    firstSellSec: firstSellTs !== null ? firstSellTs - created : null,
    graduated: curve.complete,
  };
}
