import { CURVE_FEE_RATE, CURVE_K, LAUNCH_VIRTUAL_SOL, TOTAL_SUPPLY, virtualSolAt } from '../chain/curve.ts';
import type { TradeRow } from '../intel/devs.ts';

/**
 * Rebuilds a coin's curve trades into the exact order they executed. The feed can deliver trades of one slot out of
 * order and occasionally misses one; each recorded trade carries the price after it, so the state before it is known
 * and the trades can be chained. A trade whose starting state matches nothing is preceded by an inferred "phantom"
 * trade covering the jump, so a replay passes through every recorded state.
 */

/** Wallet id used for trades inferred from a jump in the recorded curve state. */
export const PHANTOM = -1;
/**
 * Other wallets' sells this many slots or fewer after a dev sell are reactions to it: on busy coins, other wallets
 * sold about 15 times their usual rate in the dev's slot and 4 times in the next (many trading terminals offer
 * "sell when the dev sells").
 */
export const REACTION_SLOTS = 2;

export interface FlowTrade {
  ts: number;
  slot: number;
  wallet: number;
  isBuy: boolean;
  /** SOL paid (buy) or received (sell), fees included. */
  sol: number;
  tokens: number;
  /** Made by the coin's own dev wallets. */
  dev: boolean;
  /** Another wallet's sell within REACTION_SLOTS of a dev sell before it. */
  reaction: boolean;
}

export interface Flow {
  trades: FlowTrade[];
  /** Trades that had to be moved within their slot to chain. */
  reordered: number;
  /** Trades inferred to cover state jumps the feed missed. */
  phantoms: number;
  /** SOL moved by phantom trades. */
  phantomSol: number;
}

/** States closer than this (relative) count as the same: recorded amounts are rounded doubles. */
const STATE_TOLERANCE = 1e-4;

interface Step {
  t: TradeRow;
  /** Virtual SOL before and after the trade, from the recorded price after it. */
  before: number;
  after: number;
}

function step(t: TradeRow): Step | null {
  if (t.mcap === null || !(t.mcap > 0)) return null;
  const after = virtualSolAt(t.mcap / TOTAL_SUPPLY);
  let before: number;
  if (t.isBuy) before = after - t.sol / (1 + CURVE_FEE_RATE);
  else {
    const tokensBefore = CURVE_K / after - t.coins;
    if (!(tokensBefore > 0)) return null;
    before = CURVE_K / tokensBefore;
  }
  return before > 0 ? { t, before, after } : null;
}

/** A trade that moves the curve from virtual SOL `from` to `to`. */
function phantom(from: number, to: number, ts: number, slot: number): FlowTrade {
  const isBuy = to > from;
  const tokens = Math.abs(CURVE_K / from - CURVE_K / to);
  const sol = isBuy ? (to - from) * (1 + CURVE_FEE_RATE) : (from - to) * (1 - CURVE_FEE_RATE);
  return { ts, slot, wallet: PHANTOM, isBuy, sol, tokens, dev: false, reaction: false };
}

/** `trades` must be in recorded order (time, slot, arrival); `devIds` marks the coin's own dev wallets. */
export function reconstructFlow(trades: TradeRow[], devIds: ReadonlySet<number>): Flow {
  const out: FlowTrade[] = [];
  let reordered = 0;
  let phantoms = 0;
  let phantomSol = 0;
  let state = LAUNCH_VIRTUAL_SOL;
  let devSellSlot = -Infinity;
  const push = (t: TradeRow) => {
    const dev = devIds.has(t.wallet);
    if (dev && !t.isBuy) devSellSlot = t.slot;
    const reaction = !dev && !t.isBuy && t.slot - devSellSlot <= REACTION_SLOTS;
    out.push({ ts: t.ts, slot: t.slot, wallet: t.wallet, isBuy: t.isBuy, sol: t.sol, tokens: t.coins, dev, reaction });
  };

  const ordered = trades.map((t, i) => ({ t, i })).sort((a, b) => a.t.slot - b.t.slot || a.i - b.i);
  for (let i = 0; i < ordered.length; ) {
    const slot = ordered[i]!.t.slot;
    let j = i;
    while (j < ordered.length && ordered[j]!.t.slot === slot) j++;
    const pending = ordered.slice(i, j).map(({ t }) => ({ t, s: step(t) }));
    i = j;
    while (pending.length) {
      // Next is the trade that starts where the curve is now; trades without a recorded price keep their place.
      let best = 0;
      let bestGap = Infinity;
      pending.forEach((p, k) => {
        const gap = p.s ? Math.abs(p.s.before - state) / state : Infinity;
        if (gap < bestGap) {
          best = k;
          bestGap = gap;
        }
      });
      if (bestGap > STATE_TOLERANCE) {
        // Something was missed. Continue from a trade no other pending trade leads into, the closest such one.
        const leadsInto = (k: number) =>
          pending.some((q, m) => m !== k && q.s && pending[k]!.s && Math.abs(q.s.after - pending[k]!.s!.before) / state <= STATE_TOLERANCE);
        let headGap = Infinity;
        best = 0;
        pending.forEach((p, k) => {
          const gap = p.s ? Math.abs(p.s.before - state) / state : Infinity;
          if (gap < headGap && !leadsInto(k)) {
            best = k;
            headGap = gap;
          }
        });
        bestGap = headGap;
      }
      if (best !== 0) reordered++;
      const { t, s } = pending.splice(best, 1)[0]!;
      if (s && bestGap > STATE_TOLERANCE) {
        const p = phantom(state, s.before, t.ts, t.slot);
        out.push(p);
        phantoms++;
        phantomSol += p.sol;
      }
      push(t);
      if (s) state = s.after;
      else if (t.isBuy) state += t.sol / (1 + CURVE_FEE_RATE);
      else state = CURVE_K / (CURVE_K / state + t.coins);
    }
  }
  return { trades: out, reordered, phantoms, phantomSol };
}
