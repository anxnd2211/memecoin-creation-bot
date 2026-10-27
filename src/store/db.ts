import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CoinState, PositionState, WalletState } from '../intel/state.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

-- Dictionary of wallet and mint addresses, so high-volume tables store small integers.
CREATE TABLE IF NOT EXISTS ids (id INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE);

CREATE TABLE IF NOT EXISTS coins (
  mint TEXT PRIMARY KEY,
  name TEXT, symbol TEXT, uri TEXT, creator TEXT, launcher TEXT, quote TEXT NOT NULL,
  created_ts INTEGER, create_sig TEXT, total_supply REAL NOT NULL,
  is_mayhem INTEGER NOT NULL DEFAULT 0, is_holder_reward INTEGER NOT NULL DEFAULT 0,
  launch_price_sol REAL,
  trades INTEGER NOT NULL DEFAULT 0, buys INTEGER NOT NULL DEFAULT 0, sells INTEGER NOT NULL DEFAULT 0,
  unique_buyers INTEGER NOT NULL DEFAULT 0, early_buyers INTEGER NOT NULL DEFAULT 0,
  volume_sol REAL NOT NULL DEFAULT 0, creator_fees_sol REAL NOT NULL DEFAULT 0,
  last_price_sol REAL, last_mcap_sol REAL, peak_mcap_sol REAL NOT NULL DEFAULT 0, peak_ts INTEGER,
  last_trade_ts INTEGER,
  dev_bought REAL NOT NULL DEFAULT 0, dev_sold REAL NOT NULL DEFAULT 0,
  dev_first_sell_ts INTEGER, dev_sold_all_ts INTEGER,
  graduated_ts INTEGER, pool TEXT,
  smart_buys INTEGER NOT NULL DEFAULT 0, first_smart_buy_ts INTEGER,
  checkpoints TEXT NOT NULL DEFAULT '{}',
  meta_status TEXT NOT NULL DEFAULT 'none',
  description TEXT, image TEXT, twitter TEXT, telegram TEXT, website TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coins_created ON coins(created_ts);
CREATE INDEX IF NOT EXISTS coins_creator ON coins(creator, created_ts);
CREATE INDEX IF NOT EXISTS coins_peak ON coins(peak_mcap_sol);

-- Launchers looked up after the fact for coins recorded before the coins table had a launcher column.
CREATE TABLE IF NOT EXISTS launchers (mint TEXT PRIMARY KEY, launcher TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS trades (
  ts INTEGER NOT NULL, slot INTEGER NOT NULL, mint_id INTEGER NOT NULL, wallet_id INTEGER NOT NULL,
  is_buy INTEGER NOT NULL, venue INTEGER NOT NULL, sol REAL, coins REAL NOT NULL, mcap_sol REAL
);
CREATE INDEX IF NOT EXISTS trades_mint_ts ON trades(mint_id, ts);
CREATE INDEX IF NOT EXISTS trades_wallet_ts ON trades(wallet_id, ts);
CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);

CREATE TABLE IF NOT EXISTS positions (
  wallet_id INTEGER NOT NULL, mint_id INTEGER NOT NULL,
  tokens REAL NOT NULL, peak_tokens REAL NOT NULL, basis_sol REAL NOT NULL,
  cost_sol REAL NOT NULL, proceeds_sol REAL NOT NULL, realized_sol REAL NOT NULL,
  buys INTEGER NOT NULL, sells INTEGER NOT NULL,
  first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, closed_ts INTEGER, entry_delay INTEGER,
  complete INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, mint_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS positions_last ON positions(last_ts);
CREATE INDEX IF NOT EXISTS positions_mint ON positions(mint_id);

CREATE TABLE IF NOT EXISTS wallet_stats (
  wallet TEXT PRIMARY KEY,
  first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  trades INTEGER NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL,
  volume_sol REAL NOT NULL, buy_sol REAL NOT NULL, max_buy_sol REAL NOT NULL, large_buys INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL, closed INTEGER NOT NULL, wins INTEGER NOT NULL, realized_sol REAL NOT NULL,
  pnl_decayed REAL NOT NULL, trades_decayed REAL NOT NULL, decay_ts INTEGER NOT NULL,
  snipes INTEGER NOT NULL, known_entries INTEGER NOT NULL, launches INTEGER NOT NULL,
  open_now INTEGER NOT NULL, max_open INTEGER NOT NULL,
  hold_hist TEXT NOT NULL, hour_hist TEXT NOT NULL, days TEXT NOT NULL, hour_opens TEXT NOT NULL,
  archetypes TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS wallet_realized ON wallet_stats(realized_sol);
CREATE INDEX IF NOT EXISTS wallet_last ON wallet_stats(last_ts);

CREATE TABLE IF NOT EXISTS pools (
  pool TEXT PRIMARY KEY, coin_mint TEXT, quote TEXT, inverted INTEGER NOT NULL, tracked INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS signals (
  ts INTEGER NOT NULL, kind TEXT NOT NULL, mint TEXT, wallet TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS signals_ts ON signals(ts);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- The bot's own launches, paper or live: one dossier each, written by the launcher and read by the post-mortem.
CREATE TABLE IF NOT EXISTS our_launches (
  mint TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                 -- paper | live
  created_ts INTEGER NOT NULL,
  playbook INTEGER NOT NULL,
  narrative TEXT, source_post TEXT, post_age_sec REAL, first_on_post INTEGER,
  dev_buy_sol REAL NOT NULL,
  exit_plan TEXT NOT NULL, feed_lag_sec REAL,
  forecast_drew REAL, forecast_pnl REAL,
  pnl_sol REAL, drew INTEGER, first_sell_sec REAL,
  notes TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS our_launches_created ON our_launches(created_ts);
`;

export interface TradeRow {
  ts: number;
  slot: number;
  mint: string;
  wallet: string;
  isBuy: boolean;
  venue: 0 | 1;
  sol: number | null;
  coins: number;
  mcapSol: number | null;
  /** Top-level program the trade went through, when not called directly. */
  via: string | null;
}

export interface PoolRow {
  pool: string;
  coinMint: string | null;
  quote: string | null;
  inverted: boolean;
  tracked: boolean;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly idCache = new Map<string, number>();
  private readonly s: Record<string, StatementSync>;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    if (!opts.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
    if (opts.readOnly) {
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.s = {};
      return;
    }
    this.db.exec(SCHEMA);
    // Columns added after the first release; CREATE TABLE IF NOT EXISTS leaves older databases without them.
    this.ensureColumn('wallet_stats', 'large_buys', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('coins', 'creator_fees_sol', 'REAL NOT NULL DEFAULT 0');
    this.ensureColumn('coins', 'launcher', 'TEXT');
    this.ensureColumn('trades', 'via_id', 'INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS coins_launcher ON coins(launcher, created_ts)');
    const p = (sql: string) => this.db.prepare(sql);
    this.s = {
      idInsert: p('INSERT OR IGNORE INTO ids (address) VALUES (?)'),
      idSelect: p('SELECT id FROM ids WHERE address = ?'),
      trade: p(
        'INSERT INTO trades (ts, slot, mint_id, wallet_id, is_buy, venue, sol, coins, mcap_sol, via_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      coinGet: p('SELECT * FROM coins WHERE mint = ?'),
      coinPut: p(`INSERT OR REPLACE INTO coins (mint, name, symbol, uri, creator, launcher, quote, created_ts, create_sig, total_supply,
        is_mayhem, is_holder_reward, launch_price_sol, trades, buys, sells, unique_buyers, early_buyers, volume_sol, creator_fees_sol, last_price_sol,
        last_mcap_sol, peak_mcap_sol, peak_ts, last_trade_ts, dev_bought, dev_sold, dev_first_sell_ts, dev_sold_all_ts,
        graduated_ts, pool, smart_buys, first_smart_buy_ts, checkpoints, meta_status, description, image, twitter,
        telegram, website, updated_at)
        VALUES (@mint, @name, @symbol, @uri, @creator, @launcher, @quote, @created_ts, @create_sig, @total_supply, @is_mayhem,
        @is_holder_reward, @launch_price_sol, @trades, @buys, @sells, @unique_buyers, @early_buyers, @volume_sol, @creator_fees_sol, @last_price_sol,
        @last_mcap_sol, @peak_mcap_sol, @peak_ts, @last_trade_ts, @dev_bought, @dev_sold, @dev_first_sell_ts,
        @dev_sold_all_ts, @graduated_ts, @pool, @smart_buys, @first_smart_buy_ts, @checkpoints, @meta_status,
        @description, @image, @twitter, @telegram, @website, @updated_at)`),
      walletGet: p('SELECT * FROM wallet_stats WHERE wallet = ?'),
      walletPut: p(`INSERT OR REPLACE INTO wallet_stats (wallet, first_ts, last_ts, trades, buys, sells, volume_sol,
        buy_sol, max_buy_sol, large_buys, opened, closed, wins, realized_sol, pnl_decayed, trades_decayed, decay_ts, snipes,
        known_entries, launches, open_now, max_open, hold_hist, hour_hist, days, hour_opens, archetypes, updated_at)
        VALUES (@wallet, @first_ts, @last_ts, @trades, @buys, @sells, @volume_sol, @buy_sol, @max_buy_sol, @large_buys, @opened,
        @closed, @wins, @realized_sol, @pnl_decayed, @trades_decayed, @decay_ts, @snipes, @known_entries, @launches,
        @open_now, @max_open, @hold_hist, @hour_hist, @days, @hour_opens, @archetypes, @updated_at)`),
      positionGet: p('SELECT * FROM positions WHERE wallet_id = ? AND mint_id = ?'),
      abandoned: p(`SELECT w.address AS wallet, m.address AS mint, c.last_price_sol AS price
        FROM positions p JOIN ids w ON w.id = p.wallet_id JOIN ids m ON m.id = p.mint_id JOIN coins c ON c.mint = m.address
        WHERE p.last_ts < ? AND p.closed_ts IS NULL AND p.tokens > 0 AND (c.last_trade_ts IS NULL OR c.last_trade_ts < ?)
        LIMIT ?`),
      positionPut: p(`INSERT OR REPLACE INTO positions (wallet_id, mint_id, tokens, peak_tokens, basis_sol, cost_sol,
        proceeds_sol, realized_sol, buys, sells, first_ts, last_ts, closed_ts, entry_delay, complete)
        VALUES (@wallet_id, @mint_id, @tokens, @peak_tokens, @basis_sol, @cost_sol, @proceeds_sol, @realized_sol,
        @buys, @sells, @first_ts, @last_ts, @closed_ts, @entry_delay, @complete)`),
      poolPut: p('INSERT OR REPLACE INTO pools (pool, coin_mint, quote, inverted, tracked) VALUES (?, ?, ?, ?, ?)'),
      poolAll: p('SELECT * FROM pools'),
      signal: p('INSERT INTO signals (ts, kind, mint, wallet, detail) VALUES (?, ?, ?, ?, ?)'),
      metaPut: p('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      setArchetypes: p('UPDATE wallet_stats SET archetypes = ? WHERE wallet = ?'),
      coinMeta: p(`UPDATE coins SET meta_status = @meta_status, description = @description, image = @image,
        twitter = @twitter, telegram = @telegram, website = @website WHERE mint = @mint`),
    };
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private st(name: string): StatementSync {
    const stmt = this.s[name];
    if (!stmt) throw new Error(`statement ${name} unavailable (read-only store?)`);
    return stmt;
  }

  id(address: string): number {
    const cached = this.idCache.get(address);
    if (cached !== undefined) return cached;
    this.st('idInsert').run(address);
    const row = this.st('idSelect').get(address) as { id: number };
    if (this.idCache.size > 400_000) this.idCache.clear();
    this.idCache.set(address, row.id);
    return row.id;
  }

  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  insertTrade(t: TradeRow): void {
    const via = t.via !== null ? this.id(t.via) : null;
    this.st('trade').run(t.ts, t.slot, this.id(t.mint), this.id(t.wallet), t.isBuy ? 1 : 0, t.venue, t.sol, t.coins, t.mcapSol, via);
  }

  loadCoin(mint: string): Record<string, any> | undefined {
    return this.st('coinGet').get(mint) as Record<string, any> | undefined;
  }

  saveCoin(c: CoinState): void {
    this.st('coinPut').run({
      mint: c.mint,
      name: c.name,
      symbol: c.symbol,
      uri: c.uri,
      creator: c.creator,
      launcher: c.launcher,
      quote: c.quote,
      created_ts: c.createdTs,
      create_sig: c.createSig,
      total_supply: c.totalSupply,
      is_mayhem: c.isMayhem ? 1 : 0,
      is_holder_reward: c.isHolderReward ? 1 : 0,
      launch_price_sol: c.launchPriceSol,
      trades: c.trades,
      buys: c.buys,
      sells: c.sells,
      unique_buyers: c.uniqueBuyers,
      early_buyers: c.earlyBuyers,
      volume_sol: c.volumeSol,
      creator_fees_sol: c.creatorFeesSol,
      last_price_sol: c.lastPriceSol,
      last_mcap_sol: c.lastMcapSol,
      peak_mcap_sol: c.peakMcapSol,
      peak_ts: c.peakTs,
      last_trade_ts: c.lastTradeTs,
      dev_bought: c.devBought,
      dev_sold: c.devSold,
      dev_first_sell_ts: c.devFirstSellTs,
      dev_sold_all_ts: c.devSoldAllTs,
      graduated_ts: c.graduatedTs,
      pool: c.pool,
      smart_buys: c.smartBuys,
      first_smart_buy_ts: c.firstSmartBuyTs,
      checkpoints: JSON.stringify(c.checkpoints),
      meta_status: c.metaStatus,
      description: c.meta?.description ?? null,
      image: c.meta?.image ?? null,
      twitter: c.meta?.twitter ?? null,
      telegram: c.meta?.telegram ?? null,
      website: c.meta?.website ?? null,
      updated_at: Math.floor(Date.now() / 1000),
    });
  }

  saveCoinMeta(mint: string, status: string, meta: CoinState['meta']): void {
    this.st('coinMeta').run({
      mint,
      meta_status: status,
      description: meta?.description ?? null,
      image: meta?.image ?? null,
      twitter: meta?.twitter ?? null,
      telegram: meta?.telegram ?? null,
      website: meta?.website ?? null,
    });
  }

  loadWallet(wallet: string): Record<string, any> | undefined {
    return this.st('walletGet').get(wallet) as Record<string, any> | undefined;
  }

  saveWallet(w: WalletState): void {
    this.st('walletPut').run({
      wallet: w.wallet,
      first_ts: w.firstTs,
      last_ts: w.lastTs,
      trades: w.trades,
      buys: w.buys,
      sells: w.sells,
      volume_sol: w.volumeSol,
      buy_sol: w.buySol,
      max_buy_sol: w.maxBuySol,
      large_buys: w.largeBuys,
      opened: w.opened,
      closed: w.closed,
      wins: w.wins,
      realized_sol: w.realizedSol,
      pnl_decayed: w.pnlDecayed,
      trades_decayed: w.tradesDecayed,
      decay_ts: w.decayTs,
      snipes: w.snipes,
      known_entries: w.knownEntries,
      launches: w.launches,
      open_now: w.openNow,
      max_open: w.maxOpen,
      hold_hist: JSON.stringify(w.holdHist),
      hour_hist: JSON.stringify(w.hourHist),
      days: JSON.stringify(w.days),
      hour_opens: JSON.stringify(w.hourOpens),
      archetypes: w.archetypes.join(','),
      updated_at: Math.floor(Date.now() / 1000),
    });
  }

  setArchetypes(wallet: string, archetypes: string[]): void {
    this.st('setArchetypes').run(archetypes.join(','), wallet);
  }

  loadPosition(wallet: string, mint: string): Record<string, any> | undefined {
    return this.st('positionGet').get(this.id(wallet), this.id(mint)) as Record<string, any> | undefined;
  }

  /** Open positions untouched since `beforeTs` on coins with no trade since then either. */
  abandonedPositions(beforeTs: number, limit: number): { wallet: string; mint: string; price: number | null }[] {
    return this.st('abandoned').all(beforeTs, beforeTs, limit) as { wallet: string; mint: string; price: number | null }[];
  }

  savePosition(p: PositionState): void {
    this.st('positionPut').run({
      wallet_id: this.id(p.wallet),
      mint_id: this.id(p.mint),
      tokens: p.tokens,
      peak_tokens: p.peakTokens,
      basis_sol: p.basisSol,
      cost_sol: p.costSol,
      proceeds_sol: p.proceedsSol,
      realized_sol: p.realizedSol,
      buys: p.buys,
      sells: p.sells,
      first_ts: p.firstTs,
      last_ts: p.lastTs,
      closed_ts: p.closedTs,
      entry_delay: p.entryDelay,
      complete: p.complete ? 1 : 0,
    });
  }

  savePool(p: PoolRow): void {
    this.st('poolPut').run(p.pool, p.coinMint, p.quote, p.inverted ? 1 : 0, p.tracked ? 1 : 0);
  }

  loadPools(): PoolRow[] {
    return (this.st('poolAll').all() as Record<string, any>[]).map((r) => ({
      pool: r.pool,
      coinMint: r.coin_mint,
      quote: r.quote,
      inverted: r.inverted === 1,
      tracked: r.tracked === 1,
    }));
  }

  signal(ts: number, kind: string, mint: string | null, wallet: string | null, detail: Record<string, unknown>): void {
    this.st('signal').run(ts, kind, mint, wallet, JSON.stringify(detail));
  }

  setMeta(key: string, value: unknown): void {
    this.st('metaPut').run(key, JSON.stringify(value));
  }

  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  /** Deletes raw trades and closed positions past their retention window. */
  prune(nowTs: number, tradeDays: number, positionDays: number): { trades: number; positions: number; signals: number } {
    const trades = this.db.prepare('DELETE FROM trades WHERE ts < ?').run(nowTs - tradeDays * 86400).changes;
    const positions = this.db
      .prepare('DELETE FROM positions WHERE closed_ts IS NOT NULL AND last_ts < ?')
      .run(nowTs - positionDays * 86400).changes;
    const signals = this.db.prepare('DELETE FROM signals WHERE ts < ?').run(nowTs - 30 * 86400).changes;
    return { trades: Number(trades), positions: Number(positions), signals: Number(signals) };
  }

  close(): void {
    this.db.close();
  }
}
