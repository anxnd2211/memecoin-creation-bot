import type { PositionState } from './state.ts';

/** A position counts as fully exited once it holds less than this share of its peak size. */
export const DUST_SHARE = 0.01;

export interface BuyResult {
  /** True when this buy starts a new position cycle (first buy, or re-entry after a full exit). */
  opened: boolean;
}

export interface SellResult {
  realizedDelta: number;
  closed: boolean;
  holdSec: number | null;
}

/** Applies a buy using average-cost accounting. `sol` is null when the trade could not be valued in SOL. */
export function applyBuy(p: PositionState, ts: number, coins: number, sol: number | null): BuyResult {
  let opened = p.buys === 0 && p.sells === 0;
  if (p.closedTs !== null || (p.tokens <= 0 && !opened)) {
    // Re-entry after a full exit starts a fresh cycle; the previous one was already counted.
    Object.assign(p, {
      tokens: 0,
      peakTokens: 0,
      basisSol: 0,
      costSol: 0,
      proceedsSol: 0,
      realizedSol: 0,
      buys: 0,
      sells: 0,
      firstTs: ts,
      closedTs: null,
      entryDelay: null,
      complete: true,
    });
    opened = true;
  }
  p.buys++;
  p.lastTs = ts;
  p.tokens += coins;
  p.peakTokens = Math.max(p.peakTokens, p.tokens);
  if (sol === null) p.complete = false;
  else {
    p.basisSol += sol;
    p.costSol += sol;
  }
  return { opened };
}

/** Applies a sell; realizes PnL only on tokens whose purchase was observed. */
export function applySell(p: PositionState, ts: number, coins: number, sol: number | null): SellResult {
  p.sells++;
  p.lastTs = ts;
  if (sol === null) p.complete = false;
  else p.proceedsSol += sol;

  if (p.tokens <= 0 || p.closedTs !== null) {
    // Selling tokens bought before the observer started (or received by transfer).
    p.complete = false;
    return { realizedDelta: 0, closed: false, holdSec: null };
  }

  const sold = Math.min(coins, p.tokens);
  if (coins > p.tokens * 1.001) p.complete = false;
  const released = p.basisSol * (sold / p.tokens);
  let realizedDelta = 0;
  if (sol !== null && coins > 0) {
    realizedDelta = sol * (sold / coins) - released;
    p.realizedSol += realizedDelta;
  }
  p.basisSol -= released;
  p.tokens -= sold;

  if (p.tokens <= p.peakTokens * DUST_SHARE) {
    p.closedTs = ts;
    return { realizedDelta, closed: true, holdSec: ts - p.firstTs };
  }
  return { realizedDelta, closed: false, holdSec: null };
}
