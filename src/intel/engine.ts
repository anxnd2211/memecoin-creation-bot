import type { GraduationEvent, LaunchEvent, MarketEvent, MigrationEvent, TradeEvent } from '../chain/events.ts';
import type { PriceBook } from '../market/prices.ts';
import type { Store, TradeRow } from '../store/db.ts';
import { SNIPE_WINDOW_SEC, THRESHOLDS, classify, decayTo, isSmartMoney } from './classify.ts';
import { applyBuy, applySell } from './positions.ts';
import {
  CHECKPOINTS,
  HOLD_BUCKETS,
  coinFromRow,
  newCoin,
  newPosition,
  newWallet,
  positionFromRow,
  walletFromRow,
  type CoinMeta,
  type CoinState,
  type PositionState,
  type WalletState,
} from './state.ts';

export type TradeStorage = 'none' | 'curve' | 'all';

export interface Signal {
  ts: number;
  kind: 'traction' | 'smart_buy' | 'graduated' | 'dev_sold_all';
  mint: string;
  wallet: string | null;
  detail: Record<string, unknown>;
}

export interface EngineOptions {
  storeTrades: TradeStorage;
  metadataMinBuyers: number;
  metadataSampleRate: number;
  /** Unique buyers within the first five minutes that mark a coin as getting traction. */
  tractionBuyers?: number;
  onSignal?: (s: Signal) => void;
  onWantMetadata?: (mint: string, uri: string) => void;
}

const TRACTION_WINDOW_SEC = 300;
const SMART_BUY_MAX_AGE_SEC = 1800;
const DAY = 86_400;

/**
 * Turns the event stream into live coin, wallet and position state. Everything is updated in memory on each
 * event and written to SQLite in batches by `flush()`; idle state is evicted by `sweep()` and reloaded on demand.
 */
export class Engine {
  readonly coins = new Map<string, CoinState>();
  readonly wallets = new Map<string, WalletState>();
  readonly positions = new Map<string, PositionState>();
  readonly counters = { launches: 0, trades: 0, curveTrades: 0, ammTrades: 0, unvalued: 0, graduations: 0 };
  tradeWritesEnabled = true;

  private readonly dirtyCoins = new Set<CoinState>();
  private readonly dirtyWallets = new Set<WalletState>();
  private readonly dirtyPositions = new Set<PositionState>();
  private tradeBuffer: TradeRow[] = [];
  private signalBuffer: Signal[] = [];
  private readonly opts: Required<Omit<EngineOptions, 'onSignal' | 'onWantMetadata'>> & EngineOptions;
  private readonly store: Store;
  private readonly prices: PriceBook;

  constructor(store: Store, prices: PriceBook, opts: EngineOptions) {
    this.store = store;
    this.prices = prices;
    this.opts = { tractionBuyers: 25, ...opts };
  }

  handle(ev: MarketEvent): void {
    switch (ev.kind) {
      case 'launch':
        return this.onLaunch(ev);
      case 'trade':
        return this.onTrade(ev);
      case 'graduate':
        return this.onGraduate(ev);
      case 'migrate':
        return this.onMigrate(ev);
      case 'pool':
        return;
    }
  }

  /** Records fetched metadata on the coin, in memory if loaded so a later flush does not overwrite it. */
  setMeta(mint: string, status: 'done' | 'failed', meta: CoinMeta | null): void {
    const coin = this.coins.get(mint);
    if (coin) {
      coin.metaStatus = status;
      coin.meta = meta;
      this.dirtyCoins.add(coin);
    } else {
      this.store.saveCoinMeta(mint, status, meta);
    }
  }

  private onLaunch(ev: LaunchEvent): void {
    this.counters.launches++;
    const coin = this.coin(ev.mint, ev.quote);
    Object.assign(coin, {
      name: ev.name,
      symbol: ev.symbol,
      uri: ev.uri,
      creator: ev.creator,
      quote: ev.quote,
      createdTs: ev.ts,
      createSig: ev.sig,
      totalSupply: ev.totalSupply || coin.totalSupply,
      isMayhem: ev.isMayhem,
      isHolderReward: ev.isHolderReward,
      launchPriceSol: this.prices.toSol(ev.quote, ev.price),
      tractionSignaled: false,
    });
    this.dirtyCoins.add(coin);

    const creator = this.wallet(ev.creator, ev.ts);
    creator.launches++;
    this.dirtyWallets.add(creator);

    if (ev.uri && Math.random() < this.opts.metadataSampleRate) this.wantMetadata(coin);
  }

  private onTrade(ev: TradeEvent): void {
    this.counters.trades++;
    if (ev.venue === 'curve') this.counters.curveTrades++;
    else this.counters.ammTrades++;

    const coin = this.coin(ev.mint, ev.quote);
    const sol = this.prices.toSol(ev.quote, ev.quoteAmount);
    const priceSol = this.prices.toSol(ev.quote, ev.price);
    if (sol === null) this.counters.unvalued++;

    this.fillCheckpoints(coin, ev.ts);

    // Coin
    coin.trades++;
    coin.lastTradeTs = ev.ts;
    if (ev.isBuy) coin.buys++;
    else coin.sells++;
    if (sol !== null) coin.volumeSol += sol;
    if (ev.venue === 'amm' && ev.pool) coin.pool ??= ev.pool;
    let mcapSol: number | null = null;
    if (priceSol !== null && priceSol > 0) {
      mcapSol = priceSol * coin.totalSupply;
      coin.lastPriceSol = priceSol;
      coin.lastMcapSol = mcapSol;
      if (mcapSol > coin.peakMcapSol) {
        coin.peakMcapSol = mcapSol;
        coin.peakTs = ev.ts;
      }
    }
    if (ev.isBuy && !coin.buyers.has(ev.wallet)) {
      coin.buyers.add(ev.wallet);
      coin.uniqueBuyers++;
      if (coin.createdTs !== null && ev.ts - coin.createdTs <= SNIPE_WINDOW_SEC) coin.earlyBuyers++;
      if (coin.uniqueBuyers - coin.earlyBuyers === this.opts.metadataMinBuyers) this.wantMetadata(coin);
    }
    if (coin.creator === ev.wallet) {
      if (ev.isBuy) coin.devBought += ev.coinAmount;
      else {
        coin.devSold += ev.coinAmount;
        coin.devFirstSellTs ??= ev.ts;
        if (coin.devSoldAllTs === null && coin.devBought > 0 && coin.devSold >= coin.devBought * 0.99) {
          coin.devSoldAllTs = ev.ts;
          this.emit({
            ts: ev.ts,
            kind: 'dev_sold_all',
            mint: coin.mint,
            wallet: ev.wallet,
            detail: { ageSec: coin.createdTs !== null ? ev.ts - coin.createdTs : null, buyers: coin.uniqueBuyers },
          });
        }
      }
    }
    this.dirtyCoins.add(coin);

    // Wallet and position
    const w = this.wallet(ev.wallet, ev.ts);
    decayTo(w, ev.ts);
    w.lastTs = Math.max(w.lastTs, ev.ts);
    w.trades++;
    w.tradesDecayed++;
    w.hourHist[new Date(ev.ts * 1000).getUTCHours()]!++;
    const day = Math.floor(ev.ts / DAY);
    if (w.days[w.days.length - 1] !== day) {
      w.days.push(day);
      if (w.days.length > 30) w.days.shift();
    }
    if (sol !== null) w.volumeSol += sol;

    const p = this.position(ev.wallet, ev.mint, ev.ts);
    if (ev.isBuy) {
      // Launch-second buys are snipes, bundles or a launcher buying out its own curve.
      const launchSecond = coin.createdTs !== null && ev.ts - coin.createdTs <= SNIPE_WINDOW_SEC;
      w.buys++;
      if (sol !== null) {
        w.buySol += sol;
        w.maxBuySol = Math.max(w.maxBuySol, sol);
        if (sol >= THRESHOLDS.whaleLargeBuySol && !launchSecond) w.largeBuys++;
      }
      const { opened } = applyBuy(p, ev.ts, ev.coinAmount, sol);
      if (opened) {
        w.opened++;
        w.openNow++;
        w.maxOpen = Math.max(w.maxOpen, w.openNow);
        const hour = String(Math.floor(ev.ts / 3600));
        w.hourOpens[hour] = (w.hourOpens[hour] ?? 0) + 1;
        const hours = Object.keys(w.hourOpens);
        if (hours.length > 72) delete w.hourOpens[hours.sort()[0]!];
        if (coin.createdTs !== null) {
          p.entryDelay = Math.max(0, ev.ts - coin.createdTs);
          w.knownEntries++;
          if (p.entryDelay <= SNIPE_WINDOW_SEC) w.snipes++;
        }
      }
      if (
        opened &&
        !launchSecond &&
        coin.createdTs !== null &&
        ev.ts - coin.createdTs <= SMART_BUY_MAX_AGE_SEC &&
        isSmartMoney(w.archetypes) &&
        coin.creator !== ev.wallet
      ) {
        coin.smartBuys++;
        coin.firstSmartBuyTs ??= ev.ts;
        this.emit({
          ts: ev.ts,
          kind: 'smart_buy',
          mint: coin.mint,
          wallet: ev.wallet,
          detail: { sol, archetypes: w.archetypes, ageSec: ev.ts - coin.createdTs, mcapSol, symbol: coin.symbol },
        });
      }
    } else {
      w.sells++;
      const res = applySell(p, ev.ts, ev.coinAmount, sol);
      w.realizedSol += res.realizedDelta;
      w.pnlDecayed += res.realizedDelta;
      if (res.closed) {
        w.openNow = Math.max(0, w.openNow - 1);
        if (p.complete && res.holdSec !== null) {
          w.closed++;
          if (p.realizedSol > 0) w.wins++;
          const bucket = HOLD_BUCKETS.findIndex((b) => res.holdSec! <= b);
          w.holdHist[bucket]!++;
        }
      }
    }
    this.dirtyWallets.add(w);
    this.dirtyPositions.add(p);

    // Traction: enough distinct buyers soon after launch, not counting launch-second snipers and bundles.
    if (
      !coin.tractionSignaled &&
      coin.createdTs !== null &&
      ev.ts - coin.createdTs <= TRACTION_WINDOW_SEC &&
      coin.uniqueBuyers - coin.earlyBuyers >= this.opts.tractionBuyers
    ) {
      coin.tractionSignaled = true;
      this.emit({
        ts: ev.ts,
        kind: 'traction',
        mint: coin.mint,
        wallet: null,
        detail: {
          symbol: coin.symbol,
          name: coin.name,
          buyers: coin.uniqueBuyers,
          earlyBuyers: coin.earlyBuyers,
          ageSec: ev.ts - coin.createdTs,
          mcapSol,
          smartBuys: coin.smartBuys,
          devSold: coin.devSold > 0,
        },
      });
    }

    if (
      this.tradeWritesEnabled &&
      (this.opts.storeTrades === 'all' || (this.opts.storeTrades === 'curve' && ev.venue === 'curve'))
    ) {
      this.tradeBuffer.push({
        ts: ev.ts,
        slot: ev.slot,
        mint: ev.mint,
        wallet: ev.wallet,
        isBuy: ev.isBuy,
        venue: ev.venue === 'curve' ? 0 : 1,
        sol,
        coins: ev.coinAmount,
        mcapSol,
      });
    }
  }

  private onGraduate(ev: GraduationEvent): void {
    this.counters.graduations++;
    const coin = this.coin(ev.mint, 'SOL');
    if (coin.graduatedTs !== null) return;
    coin.graduatedTs = ev.ts;
    this.dirtyCoins.add(coin);
    this.emit({
      ts: ev.ts,
      kind: 'graduated',
      mint: coin.mint,
      wallet: null,
      detail: {
        symbol: coin.symbol,
        name: coin.name,
        ageSec: coin.createdTs !== null ? ev.ts - coin.createdTs : null,
        buyers: coin.uniqueBuyers,
      },
    });
  }

  private onMigrate(ev: MigrationEvent): void {
    const coin = this.coin(ev.mint, ev.quote);
    coin.pool = ev.pool;
    coin.graduatedTs ??= ev.ts;
    this.dirtyCoins.add(coin);
  }

  private wantMetadata(coin: CoinState): void {
    if (coin.metaStatus !== 'none' || !coin.uri || !this.opts.onWantMetadata) return;
    coin.metaStatus = 'queued';
    this.dirtyCoins.add(coin);
    this.opts.onWantMetadata(coin.mint, coin.uri);
  }

  private emit(s: Signal): void {
    this.signalBuffer.push(s);
    this.opts.onSignal?.(s);
  }

  /** Snapshots checkpoints the coin has passed; called before applying each trade so values reflect that moment. */
  private fillCheckpoints(coin: CoinState, ts: number): void {
    if (coin.createdTs === null) return;
    for (const cp of CHECKPOINTS) {
      const k = String(cp);
      if (coin.checkpoints[k] || ts - coin.createdTs < cp) continue;
      coin.checkpoints[k] = {
        buyers: coin.uniqueBuyers,
        mcapSol: coin.lastMcapSol,
        volumeSol: coin.volumeSol,
        trades: coin.trades,
      };
      this.dirtyCoins.add(coin);
    }
  }

  private coin(mint: string, quote: string): CoinState {
    let c = this.coins.get(mint);
    if (!c) {
      const row = this.store.loadCoin(mint);
      c = row ? coinFromRow(row) : newCoin(mint, quote);
      this.coins.set(mint, c);
    }
    c.touchedAt = Date.now();
    return c;
  }

  private wallet(addr: string, ts: number): WalletState {
    let w = this.wallets.get(addr);
    if (!w) {
      const row = this.store.loadWallet(addr);
      w = row ? walletFromRow(row) : newWallet(addr, ts);
      this.wallets.set(addr, w);
    }
    w.touchedAt = Date.now();
    return w;
  }

  private position(wallet: string, mint: string, ts: number): PositionState {
    const key = wallet + '|' + mint;
    let p = this.positions.get(key);
    if (!p) {
      const row = this.store.loadPosition(wallet, mint);
      p = row ? positionFromRow(wallet, mint, row) : newPosition(wallet, mint, ts);
      this.positions.set(key, p);
    }
    p.touchedAt = Date.now();
    return p;
  }

  /** Writes all pending state in one transaction. Returns the number of rows written. */
  flush(): number {
    const nowTs = Math.floor(Date.now() / 1000);
    for (const w of this.dirtyWallets) w.archetypes = classify(w, nowTs);
    const trades = this.tradeBuffer;
    const signals = this.signalBuffer;
    this.tradeBuffer = [];
    this.signalBuffer = [];
    let rows = 0;
    this.store.transaction(() => {
      for (const t of trades) this.store.insertTrade(t);
      for (const c of this.dirtyCoins) this.store.saveCoin(c);
      for (const w of this.dirtyWallets) this.store.saveWallet(w);
      for (const p of this.dirtyPositions) this.store.savePosition(p);
      for (const s of signals) this.store.signal(s.ts, s.kind, s.mint, s.wallet, s.detail);
      rows = trades.length + this.dirtyCoins.size + this.dirtyWallets.size + this.dirtyPositions.size + signals.length;
    });
    this.dirtyCoins.clear();
    this.dirtyWallets.clear();
    this.dirtyPositions.clear();
    return rows;
  }

  /** Fills overdue checkpoints for quiet coins, then drops idle state from memory. Call right after `flush()`. */
  sweep(opts = { coinIdleMs: 3 * 3600_000, walletIdleMs: 30 * 60_000, positionIdleMs: 30 * 60_000 }): void {
    const now = Date.now();
    const nowTs = Math.floor(now / 1000);
    for (const c of this.coins.values()) this.fillCheckpoints(c, nowTs);
    if (this.dirtyCoins.size) this.flush();
    for (const [k, c] of this.coins) if (now - c.touchedAt > opts.coinIdleMs) this.coins.delete(k);
    for (const [k, w] of this.wallets) if (now - w.touchedAt > opts.walletIdleMs) this.wallets.delete(k);
    for (const [k, p] of this.positions) if (now - p.touchedAt > opts.positionIdleMs) this.positions.delete(k);
  }
}
