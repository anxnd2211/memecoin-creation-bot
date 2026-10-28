import { CURVE_FEE_RATE } from '../chain/curve.ts';

/**
 * Dev-buy sizes for wallets smaller than the playbook's 5 SOL. Sniper bots answer exact round amounts into the curve:
 * on 2026-10-27/28, 2.000 SOL was sniped 74-79% of the time (73 devs) while 1.95-1.97 and 2.1-2.4 SOL drew 12-57%; 3.000
 * SOL 80%, 4.000 SOL about 85%, 5.000 SOL 82%. So a small wallet buys exactly one of these, never "whatever fits"
 * (`python3 ml/smallwallet.py`). Amounts here are SOL into the curve; the wallet pays 1.25% more in fees.
 */

/** The exact amounts into the curve that sniper bots answer. */
export const SNIPER_TIERS = [2, 3, 4, 5] as const;

/** SOL a wallet keeps beyond the dev buy (rent, tips, a retried sell): the launch board's reserve. */
export const WALLET_RESERVE_SOL = 0.15;

/** Extra SOL the wallet must hold before `auto` steps up to 5 SOL, so one dead launch does not drop it straight back. */
export const STEP_UP_BUFFER_SOL = 0.3;

/** SOL the wallet pays for a dev buy of `intoCurve` SOL, fees included. */
export const withFees = (intoCurve: number): number => intoCurve * (1 + CURVE_FEE_RATE);

/**
 * The dev buy (fees included) for a wallet holding `balanceSol`. `auto` buys 5 SOL once the wallet holds 5 SOL plus
 * the reserve and a buffer, else 2 SOL; with less than 2 SOL plus the reserve it still returns 2 SOL, and the launch
 * board's balance gate blocks the launch. A fixed tier always returns that tier.
 */
export function devBuyFor(choice: 'auto' | (typeof SNIPER_TIERS)[number], balanceSol: number | null): number {
  if (choice !== 'auto') return withFees(choice);
  if (balanceSol !== null && balanceSol >= withFees(5) + WALLET_RESERVE_SOL + STEP_UP_BUFFER_SOL) return withFees(5);
  return withFees(2);
}

/** Parses a --dev-buy value: one of the sniper tiers, or auto; null for anything else. */
export function parseDevBuy(v: string | undefined): 'auto' | (typeof SNIPER_TIERS)[number] | null {
  if (v === undefined) return null;
  if (v === 'auto') return 'auto';
  const n = Number(v);
  return (SNIPER_TIERS as readonly number[]).includes(n) ? (n as (typeof SNIPER_TIERS)[number]) : null;
}
