import { log } from '../log.ts';
import type { PoolRow, Store } from '../store/db.ts';
import { ammAccountCoder } from './decoder.ts';
import type { MigrationEvent, PoolCreatedEvent, PoolTrade, TradeEvent } from './events.ts';
import { COIN_DECIMALS, DEFAULT_PUBKEY, SOL, normalizeQuote, quoteDecimals } from './programs.ts';

const BATCH = 100;
const MAX_PENDING_TRADES = 50_000;
const MAX_WAIT_MS = 30_000;

/**
 * PumpSwap trade events name the pool but not the coin. This maps pools to coins, learning from pool-creation and
 * migration events and falling back to reading pool accounts over RPC in batches. Pools that do not hold a
 * pump.fun coin are remembered as untracked and their trades ignored.
 */
export class PoolResolver {
  readonly stats = { resolvedViaRpc: 0, untrackedTrades: 0, droppedTrades: 0, rpcErrors: 0 };
  private readonly pools = new Map<string, PoolRow>();
  private readonly pending = new Map<string, { since: number; trades: PoolTrade[] }>();
  private pendingTrades = 0;
  private inflight = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly rpcHttp: string;
  private readonly store: Store;
  private readonly emit: (ev: TradeEvent) => void;

  constructor(rpcHttp: string, store: Store, emit: (ev: TradeEvent) => void) {
    this.rpcHttp = rpcHttp;
    this.store = store;
    this.emit = emit;
    for (const row of store.loadPools()) this.pools.set(row.pool, row);
  }

  get pendingCount(): number {
    return this.pendingTrades;
  }

  start(intervalMs = 300): void {
    this.timer = setInterval(() => void this.resolveBatch(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  learnPool(ev: PoolCreatedEvent): void {
    this.remember(classifyPool(ev.pool, ev.baseMint, ev.quoteMint, ev.creator));
  }

  learnMigration(ev: MigrationEvent): void {
    this.remember({ pool: ev.pool, coinMint: ev.mint, quote: ev.quote, inverted: false, tracked: true });
  }

  handle(pt: PoolTrade): void {
    const row = this.pools.get(pt.pool);
    if (row) {
      this.dispatch(row, pt);
      return;
    }
    if (this.pendingTrades >= MAX_PENDING_TRADES) {
      this.stats.droppedTrades++;
      return;
    }
    const entry = this.pending.get(pt.pool) ?? { since: Date.now(), trades: [] };
    entry.trades.push(pt);
    this.pending.set(pt.pool, entry);
    this.pendingTrades++;
  }

  private remember(row: PoolRow): void {
    this.pools.set(row.pool, row);
    this.store.savePool(row);
    const waiting = this.pending.get(row.pool);
    if (waiting) {
      this.pending.delete(row.pool);
      this.pendingTrades -= waiting.trades.length;
      for (const pt of waiting.trades) this.dispatch(row, pt);
    }
  }

  private dispatch(row: PoolRow, pt: PoolTrade): void {
    if (!row.tracked || !row.coinMint || !row.quote) {
      this.stats.untrackedTrades++;
      return;
    }
    const trade = toTrade(row, pt);
    if (trade) this.emit(trade);
  }

  private async resolveBatch(): Promise<void> {
    if (this.inflight || this.pending.size === 0) return;
    this.inflight = true;
    const now = Date.now();
    for (const [pool, entry] of this.pending) {
      if (now - entry.since > MAX_WAIT_MS) {
        this.pending.delete(pool);
        this.pendingTrades -= entry.trades.length;
        this.stats.droppedTrades += entry.trades.length;
      }
    }
    const keys = [...this.pending.keys()].slice(0, BATCH);
    try {
      if (keys.length === 0) return;
      const res = await fetch(this.rpcHttp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getMultipleAccounts',
          params: [keys, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as {
        result?: { value: ({ data: [string, string] } | null)[] };
        error?: unknown;
      };
      if (!body.result) throw new Error(`RPC error ${JSON.stringify(body.error ?? res.status)}`);
      body.result.value.forEach((acc, i) => {
        const pool = keys[i]!;
        if (!acc) {
          // Not visible yet at this commitment; retry until MAX_WAIT_MS.
          return;
        }
        try {
          const d = ammAccountCoder.decode('Pool', Buffer.from(acc.data[0], 'base64'));
          this.stats.resolvedViaRpc++;
          this.remember(
            classifyPool(pool, d.base_mint.toBase58(), d.quote_mint.toBase58(), d.coin_creator.toBase58()),
          );
        } catch {
          this.remember({ pool, coinMint: null, quote: null, inverted: false, tracked: false });
        }
      });
    } catch (err) {
      this.stats.rpcErrors++;
      log.warn('pool lookup failed', { error: String(err).slice(0, 200) });
    } finally {
      this.inflight = false;
    }
  }
}

/** Decides which side of a pool is the pump.fun coin. */
export function classifyPool(pool: string, baseMint: string, quoteMint: string, coinCreator: string): PoolRow {
  const base = normalizeQuote(baseMint);
  const quote = normalizeQuote(quoteMint);
  const pumpLike = (m: string) => m.endsWith('pump');
  if (base !== SOL && (coinCreator !== DEFAULT_PUBKEY || pumpLike(baseMint))) {
    return { pool, coinMint: baseMint, quote, inverted: false, tracked: true };
  }
  if (base === SOL && quote !== SOL && pumpLike(quoteMint)) {
    return { pool, coinMint: quoteMint, quote: SOL, inverted: true, tracked: true };
  }
  return { pool, coinMint: null, quote: null, inverted: false, tracked: false };
}

export function toTrade(row: PoolRow, pt: PoolTrade): TradeEvent | null {
  const quote = row.quote!;
  const qd = 10 ** quoteDecimals(quote);
  const cd = 10 ** COIN_DECIMALS;
  let isBuy: boolean;
  let coinAmount: number;
  let quoteAmount: number;
  let price: number;
  if (!row.inverted) {
    isBuy = pt.baseBuy;
    coinAmount = pt.baseAmountRaw / cd;
    quoteAmount = pt.quoteAmountRaw / qd;
    price = coinAmount > 0 ? pt.quoteAmountNoFeeRaw / qd / coinAmount : 0;
  } else {
    // Base is SOL: buying the base means selling the coin.
    isBuy = !pt.baseBuy;
    coinAmount = pt.quoteAmountRaw / cd;
    quoteAmount = pt.baseAmountRaw / qd;
    price = coinAmount > 0 ? quoteAmount / coinAmount : 0;
  }
  if (!(coinAmount > 0)) return null;
  return {
    kind: 'trade',
    sig: pt.sig,
    slot: pt.slot,
    ts: pt.ts,
    venue: 'amm',
    mint: row.coinMint!,
    wallet: pt.wallet,
    isBuy,
    quote,
    quoteAmount,
    coinAmount,
    price,
    pool: row.pool,
  };
}
