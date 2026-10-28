import { config } from '../config.ts';
import { PayloadDeduper, decodeTx, type DecodeStats } from '../chain/decoder.ts';
import type { RawTx } from '../chain/events.ts';
import { PUMP_PROGRAM, SOL } from '../chain/programs.ts';
import { RpcLogStream, type StreamStats } from '../chain/sources/rpcLogs.ts';
import { log } from '../log.ts';
import { FeedLag } from './exit.ts';
import type { LiveTrade } from './types.ts';

/**
 * The live pump.fun feed for the launcher: the observer's websocket stream and decoder (src/cli/observe.ts) on the
 * pump.fun program alone, with no database. It times every event into a `FeedLag`, hands out one coin's trades as
 * `LiveTrade`s, and announces new launches (for shadow mode). Read-only: a `logsSubscribe` websocket, nothing sent.
 * Reconnects and duplicate deliveries are handled by `RpcLogStream`; events missed while it was down are gone, which
 * `lastEventAt` and the exit's 'feed lost' rule are there to catch.
 */

/** A launch as the feed saw it, with the dev's buy from the create transaction. */
export interface LiveLaunch {
  mint: string;
  sig: string;
  slot: number;
  /** On-chain unix seconds. */
  chainTs: number;
  /** Local time (ms) the feed delivered it. */
  receivedAt: number;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  /** The wallet that signed the create transaction. */
  signer: string;
  quote: string;
  /** Starting price in quote units per coin; 30 / 1.073B SOL on the standard curve. */
  price: number;
  isMayhem: boolean;
  /** SOL the creator and signer paid for buys in the create transaction, fees included. */
  devBuySol: number;
  devTokens: number;
}

/** A trade on a subscribed coin: a `LiveTrade` plus where it came from. */
export interface FeedTrade extends LiveTrade {
  mint: string;
  sig: string;
  /** Top-level program the trade went through when not called directly (a router or trading bot). */
  via: string | null;
}

export interface LiveFeedOptions {
  /** Websocket URL; the configured RPC (SOLANA_RPC_WS) by default. */
  url?: string;
  commitment?: 'processed' | 'confirmed';
  lag?: FeedLag;
}

interface Subscription {
  dev: ReadonlySet<string>;
  handler: (t: FeedTrade) => void;
}

export class LiveFeed {
  readonly lag: FeedLag;
  /** Local time (ms) of the last decoded pump event of any kind; null before the first. */
  lastEventAt: number | null = null;
  readonly stats = { txs: 0, events: 0, launches: 0, trades: 0, truncated: 0, handlerErrors: 0 };
  readonly decodeStats: DecodeStats = { undecodable: 0, duplicates: 0 };
  private readonly url: string;
  private readonly commitment: 'processed' | 'confirmed';
  private readonly dedupe = new PayloadDeduper(50_000);
  private stream: RpcLogStream | null = null;
  private readonly launchHandlers = new Set<(l: LiveLaunch) => void>();
  private readonly eventHandlers = new Set<(receivedAt: number) => void>();
  private readonly subs = new Map<string, Set<Subscription>>();

  constructor(opts: LiveFeedOptions = {}) {
    this.url = opts.url ?? config.rpcWs;
    this.commitment = opts.commitment ?? config.commitment;
    this.lag = opts.lag ?? new FeedLag();
  }

  start(): void {
    if (this.stream) return;
    this.stream = new RpcLogStream({
      url: this.url,
      programs: [PUMP_PROGRAM],
      commitment: this.commitment,
      onTx: (tx) => this.handleTx(tx),
    });
    this.stream.start();
  }

  stop(): void {
    this.stream?.stop();
    this.stream = null;
  }

  /** Connection stats of the underlying stream; null while stopped. */
  get streamStats(): StreamStats | null {
    return this.stream?.stats ?? null;
  }

  /** Calls `handler` for every new launch; returns the unsubscribe function. */
  onLaunch(handler: (l: LiveLaunch) => void): () => void {
    this.launchHandlers.add(handler);
    return () => this.launchHandlers.delete(handler);
  }

  /** Calls `handler` with the receive time of every transaction that carried a pump event: the feed's heartbeat. */
  onEvent(handler: (receivedAt: number) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Calls `handler` with every curve trade on `mint` quoted in SOL, flagged `dev` when made by one of `dev` (our dev
   * wallet live; the coin's creator and signer in shadow mode). Returns the unsubscribe function.
   */
  subscribe(mint: string, dev: string | readonly string[], handler: (t: FeedTrade) => void): () => void {
    const sub: Subscription = { dev: new Set(typeof dev === 'string' ? [dev] : dev), handler };
    const set = this.subs.get(mint) ?? new Set<Subscription>();
    this.subs.set(mint, set);
    set.add(sub);
    return () => {
      set.delete(sub);
      if (!set.size && this.subs.get(mint) === set) this.subs.delete(mint);
    };
  }

  /** The chain's estimated slot at local time `ms` (see `FeedLag.slotAt`). */
  slotAt(ms: number): number | null {
    return this.lag.slotAt(ms);
  }

  /**
   * Decodes one streamed transaction and dispatches it: lag samples first, then launches, then trades, then the
   * heartbeat. Launch handlers that subscribe to the new coin receive the create transaction's own trades. Public so
   * tests can feed recorded transactions.
   */
  handleTx(tx: RawTx): void {
    this.stats.txs++;
    const { events, truncated } = decodeTx(tx, this.decodeStats, this.dedupe);
    if (truncated) this.stats.truncated++;
    if (!events.length) return;
    const at = tx.receivedAt;
    this.lastEventAt = at;
    for (const ev of events) {
      this.stats.events++;
      this.lag.add(at, ev.ts, ev.slot);
    }

    for (const ev of events) {
      if (ev.kind !== 'launch') continue;
      this.stats.launches++;
      const dev = new Set([ev.creator, ev.user]);
      let devBuySol = 0;
      let devTokens = 0;
      for (const t of events) {
        if (t.kind === 'trade' && t.venue === 'curve' && t.mint === ev.mint && t.isBuy && dev.has(t.wallet)) {
          devBuySol += t.quoteAmount;
          devTokens += t.coinAmount;
        }
      }
      const launch: LiveLaunch = {
        mint: ev.mint,
        sig: ev.sig,
        slot: ev.slot,
        chainTs: ev.ts,
        receivedAt: at,
        name: ev.name,
        symbol: ev.symbol,
        uri: ev.uri,
        creator: ev.creator,
        signer: ev.user,
        quote: ev.quote,
        price: ev.price,
        isMayhem: ev.isMayhem,
        devBuySol,
        devTokens,
      };
      for (const h of this.launchHandlers) this.call(() => h(launch));
    }

    for (const ev of events) {
      if (ev.kind !== 'trade' || ev.venue !== 'curve') continue;
      this.stats.trades++;
      const subs = this.subs.get(ev.mint);
      if (!subs || ev.quote !== SOL) continue;
      for (const s of [...subs]) {
        const t: FeedTrade = {
          slot: ev.slot,
          chainTs: ev.ts,
          receivedAt: at,
          wallet: ev.wallet,
          isBuy: ev.isBuy,
          sol: ev.quoteAmount,
          tokens: ev.coinAmount,
          dev: s.dev.has(ev.wallet),
          mint: ev.mint,
          sig: ev.sig,
          via: ev.via ?? null,
        };
        this.call(() => s.handler(t));
      }
    }

    for (const h of this.eventHandlers) this.call(() => h(at));
  }

  /** One failing handler must not stop the feed for the others. */
  private call(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.stats.handlerErrors++;
      log.error('live feed handler failed', { error: String(err) });
    }
  }
}
