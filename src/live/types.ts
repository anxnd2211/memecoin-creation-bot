/**
 * Shared types for the live launcher (src/live/). The same pipeline runs in four modes:
 *   fork    everything on the local copy of pump.fun (src/paper/fork.ts), with an in-memory wallet
 *   dry     real mainnet state, feed and Telegram; transactions are simulated against mainnet, never sent
 *   shadow  no launch: the exit manager runs live on other devs' launches that match the playbook, as if it were
 *           their dev, to measure live timing against the backtest
 *   live    real launches from the owner's wallet, each approved by the owner on Telegram
 */

export type Mode = 'fork' | 'dry' | 'shadow' | 'live';

/** An X post a coin is built on. */
export interface PostInfo {
  url: string;
  handle: string;
  postId: string;
  /** Unix seconds, from the post ID. */
  postedAt: number;
  authorName: string | null;
  text: string | null;
}

/** A coin ready to launch: what the metadata will say. */
export interface CoinDraft {
  name: string;
  symbol: string;
  description: string;
  /** The post the narrative came from: the coin's X link. */
  postUrl: string;
  /** The narrative's original source: the coin's website. */
  website: string;
  telegram?: string;
  image: { bytes: Uint8Array; mime: string; filename: string };
}

export interface LaunchParams {
  name: string;
  symbol: string;
  uri: string;
  /** SOL paid for the dev buy, fees included (the playbook's devBuySol). */
  devBuySol: number;
  /** The mint keypair's secret key; a fresh one is made when absent. */
  mintSecret?: Uint8Array;
  /** Compute-unit price for the launch transaction. */
  priorityMicroLamports?: number;
}

export interface LaunchFill {
  mint: string;
  signature: string;
  slot: number | null;
  /** Local time (ms) the launch was seen confirmed. */
  landedAt: number;
  devTokens: bigint;
  /** Lamports into the curve plus trading fees for the dev buy (no rent, no network fee). */
  lamportsSpent: bigint;
  rentLamports: bigint;
  networkFeeLamports: bigint;
  /** True when nothing was sent: a fork or dry-run fill. */
  simulated: boolean;
}

export interface SellFill {
  signature: string;
  landedAt: number;
  tokensSold: bigint;
  /** Lamports received after trading fees. */
  lamportsReceived: bigint;
  networkFeeLamports: bigint;
  attempts: number;
  simulated: boolean;
}

export class PreflightError extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[]) {
    super(message);
    this.name = 'PreflightError';
    this.logs = logs;
  }
}

/** Where launches and sells happen: the local fork, mainnet simulation, or mainnet. */
export interface Venue {
  readonly mode: Mode;
  /** The dev wallet: creator and signer of every launch. */
  readonly dev: string;
  balanceLamports(): Promise<bigint>;
  /** Simulates the launch transaction against current state; throws PreflightError (with logs) if it would fail. */
  preflightLaunch(p: LaunchParams): Promise<{ computeUnits: number; logs: string[] }>;
  launch(p: LaunchParams): Promise<LaunchFill>;
  /** Lamports selling `tokens` of `mint` would return now, after fees. */
  quoteSell(mint: string, tokens: bigint): Promise<bigint>;
  tokenBalance(mint: string): Promise<bigint>;
  /**
   * Sells the whole bag in one transaction with a minimum out of the quote less `maxSlippage`; when that fails it
   * re-quotes and retries with each wider limit in `ladder` (e.g. [0.2, 0.35]).
   */
  sellAll(mint: string, opts: { maxSlippage: number; ladder?: number[]; priorityMicroLamports?: number }): Promise<SellFill>;
  /** Creator fees waiting in the dev's creator vault. */
  creatorVaultLamports(): Promise<bigint>;
}

/** A trade on a coin as the exit manager sees it, from the live feed. */
export interface LiveTrade {
  slot: number;
  /** On-chain unix seconds. */
  chainTs: number;
  /** Local time (ms) the feed delivered it. */
  receivedAt: number;
  wallet: string;
  isBuy: boolean;
  /** SOL paid (buy) or received (sell), fees included. */
  sol: number;
  tokens: number;
  /** One of the dev's own trades. */
  dev: boolean;
}

export interface ExitDecision {
  reason: 'stall' | 'max hold' | 'slow feed timer' | 'kill' | 'feed lost' | 'near graduation' | 'recovery';
  /** Local time (ms) of the decision. */
  at: number;
  /** Seconds since the launch landed. */
  ageSec: number;
}

export interface Approval {
  approved: boolean;
  by: 'owner' | 'timeout';
  at: number;
}

/** How the bot talks to the owner (Telegram live; the console in tests). */
export interface Notifier {
  send(text: string): Promise<void>;
  /** Shows a launch card and waits for Approve or Reject; no answer within `timeoutSec` is a rejection. */
  askApproval(card: { text: string; image?: Uint8Array; timeoutSec: number }): Promise<Approval>;
}
