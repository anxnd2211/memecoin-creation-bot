/**
 * Normalized market events. Amounts are in whole units (SOL, USDC or coins), not lamports or raw token units.
 * `quote` is `SOL` or the quote mint address. `ts` is the on-chain unix timestamp in seconds.
 */

export type Venue = 'curve' | 'amm';

interface Base {
  sig: string;
  slot: number;
  ts: number;
}

export interface LaunchEvent extends Base {
  kind: 'launch';
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  /** Signer of the create tx; differs from `creator` on free-creation flows. */
  user: string;
  quote: string;
  totalSupply: number;
  /** Starting price in quote units per whole coin. */
  price: number;
  isMayhem: boolean;
  isHolderReward: boolean;
}

export interface TradeEvent extends Base {
  kind: 'trade';
  venue: Venue;
  mint: string;
  wallet: string;
  isBuy: boolean;
  quote: string;
  /** Quote paid (buy) or received (sell) by the trader, fees included. */
  quoteAmount: number;
  coinAmount: number;
  /** Price in quote units per whole coin after the trade (curve) or at execution (PumpSwap). */
  price: number;
  pool?: string;
}

export interface GraduationEvent extends Base {
  kind: 'graduate';
  mint: string;
}

export interface MigrationEvent extends Base {
  kind: 'migrate';
  mint: string;
  pool: string;
  quote: string;
}

export interface PoolCreatedEvent extends Base {
  kind: 'pool';
  pool: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
}

/** A PumpSwap trade before its pool has been mapped to a coin. */
export interface PoolTrade extends Base {
  kind: 'pool_trade';
  pool: string;
  wallet: string;
  /** Buy of the pool's base asset. */
  baseBuy: boolean;
  baseAmountRaw: number;
  quoteAmountRaw: number;
  /** Quote amount excluding fees, for pricing. */
  quoteAmountNoFeeRaw: number;
}

export type MarketEvent = LaunchEvent | TradeEvent | GraduationEvent | MigrationEvent | PoolCreatedEvent;
export type DecodedEvent = MarketEvent | PoolTrade;

export interface RawTx {
  sig: string;
  slot: number;
  logs: string[];
  /** Local wall-clock ms when the tx reached us. */
  receivedAt: number;
}
