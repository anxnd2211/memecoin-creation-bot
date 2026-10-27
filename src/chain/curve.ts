/**
 * pump.fun's standard SOL bonding curve. A trade moves the virtual reserves along x * y = k, and the protocol fee
 * (0.95%) and creator fee (0.30%) are charged on top of a buy and taken out of a sell. Checked against 48,000 recorded
 * trades: token amounts match to within 1e-8 and prices to within 1e-10.
 */

export const LAUNCH_VIRTUAL_SOL = 30;
export const LAUNCH_VIRTUAL_TOKENS = 1_073_000_000;
export const CURVE_K = LAUNCH_VIRTUAL_SOL * LAUNCH_VIRTUAL_TOKENS;
/** Tokens the curve sells before it completes and the coin graduates to PumpSwap. */
export const CURVE_REAL_TOKENS = 793_100_000;
const END_VIRTUAL_TOKENS = LAUNCH_VIRTUAL_TOKENS - CURVE_REAL_TOKENS;
export const TOTAL_SUPPLY = 1_000_000_000;
export const STANDARD_LAUNCH_MCAP_SOL = (LAUNCH_VIRTUAL_SOL / LAUNCH_VIRTUAL_TOKENS) * TOTAL_SUPPLY;
/** The curve completes at this price (about 115 virtual SOL against 279.9M virtual tokens); any higher is PumpSwap. */
export const CURVE_MAX_PRICE_SOL = CURVE_K / END_VIRTUAL_TOKENS ** 2;

export const PROTOCOL_FEE_RATE = 0.0095;
export const CREATOR_FEE_RATE = 0.003;
export const CURVE_FEE_RATE = PROTOCOL_FEE_RATE + CREATOR_FEE_RATE;

/**
 * The most a dev who buys in the create transaction can lose by later selling the whole bag, on a normal curve: no one
 * can sell back more tokens than they bought after the dev, so the price never falls below the dev's entry, and the
 * creator fee on both trades comes back to the dev. What is left is the protocol fee both ways, about 1.9% of the buy.
 * Mayhem mode breaks this, because pump.fun's agent sells newly minted supply.
 */
export const maxDevBuyLoss = (sol: number): number => (sol * 2 * PROTOCOL_FEE_RATE) / (1 + CURVE_FEE_RATE);

/** Virtual SOL reserves of a standard curve whose price is `price` SOL per token. */
export const virtualSolAt = (price: number): number => Math.sqrt(CURVE_K * price);

/** SOL that selling `tokens` into a standard curve at `price` returns after fees. */
export function curveSellValue(price: number, tokens: number): number {
  if (!(price > 0) || !(tokens > 0)) return 0;
  const vSol = virtualSolAt(price);
  const vTok = Math.sqrt(CURVE_K / price);
  return Math.max(0, vSol - CURVE_K / (vTok + tokens)) * (1 - CURVE_FEE_RATE);
}

/** A standard curve's state, for replaying trades against it. */
export class Curve {
  vSol = LAUNCH_VIRTUAL_SOL;
  vTokens = LAUNCH_VIRTUAL_TOKENS;

  get price(): number {
    return this.vSol / this.vTokens;
  }

  /** The curve has sold all its tokens; trading continues on PumpSwap. */
  get complete(): boolean {
    return this.vTokens <= END_VIRTUAL_TOKENS * (1 + 1e-12);
  }

  /**
   * Spends up to `sol` (fees included). The last buy before completion fills only what the curve has left and pays
   * only for that, as on chain.
   */
  buy(sol: number): { sol: number; tokens: number; creatorFee: number } {
    if (!(sol > 0) || this.complete) return { sol: 0, tokens: 0, creatorFee: 0 };
    let net = sol / (1 + CURVE_FEE_RATE);
    let tokens = this.vTokens - CURVE_K / (this.vSol + net);
    const left = this.vTokens - END_VIRTUAL_TOKENS;
    if (tokens > left) {
      tokens = left;
      net = CURVE_K / END_VIRTUAL_TOKENS - this.vSol;
    }
    this.vSol += net;
    this.vTokens -= tokens;
    return { sol: net * (1 + CURVE_FEE_RATE), tokens, creatorFee: net * CREATOR_FEE_RATE };
  }

  /** Sells `tokens`; returns the SOL received after fees. */
  sell(tokens: number): { sol: number; creatorFee: number } {
    if (!(tokens > 0)) return { sol: 0, creatorFee: 0 };
    const vSol = CURVE_K / (this.vTokens + tokens);
    const gross = this.vSol - vSol;
    this.vSol = vSol;
    this.vTokens += tokens;
    return { sol: gross * (1 - CURVE_FEE_RATE), creatorFee: gross * CREATOR_FEE_RATE };
  }

  /** SOL that selling `tokens` now would return after fees, without trading. */
  sellValue(tokens: number): number {
    if (!(tokens > 0)) return 0;
    return (this.vSol - CURVE_K / (this.vTokens + tokens)) * (1 - CURVE_FEE_RATE);
  }
}
