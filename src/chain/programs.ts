export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export const DEFAULT_PUBKEY = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Normalized id for SOL as a quote asset (the curve reports it as the default pubkey, PumpSwap as WSOL). */
export const SOL = 'SOL';

/** Every pump.fun coin has 6 decimals. */
export const COIN_DECIMALS = 6;

export function normalizeQuote(mint: string): string {
  return mint === DEFAULT_PUBKEY || mint === WSOL_MINT ? SOL : mint;
}

/** Quote assets are SOL, USDC or another pump.fun coin; only SOL has 9 decimals. */
export function quoteDecimals(quote: string): number {
  return quote === SOL ? 9 : 6;
}
