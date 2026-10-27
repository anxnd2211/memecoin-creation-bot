import type { DatabaseSync } from 'node:sqlite';
import { SNIPE_WINDOW_SEC, medianHoldSec, tradesPerDay } from './classify.ts';
import { walletFromRow, type Checkpoint } from './state.ts';

/** Organic buyers in the first five minutes that count as traction (matches the live traction signal). */
export const TRACTION_BUYERS = 25;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function share(xs: boolean[]): number | null {
  return xs.length ? xs.filter(Boolean).length / xs.length : null;
}

interface CoinRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  creator: string | null;
  /** The signer when recorded, else the creator. */
  dev: string | null;
  created_ts: number;
  unique_buyers: number;
  early_buyers: number;
  volume_sol: number;
  peak_mcap_sol: number;
  peak_ts: number | null;
  last_mcap_sol: number | null;
  dev_bought: number;
  dev_first_sell_ts: number | null;
  dev_sold_all_ts: number | null;
  graduated_ts: number | null;
  smart_buys: number;
  checkpoints: string;
  twitter: string | null;
  website: string | null;
  description: string | null;
}

function organicAt(c: CoinRow, sec: number): number | null {
  const cp = (JSON.parse(c.checkpoints) as Record<string, Checkpoint>)[String(sec)];
  return cp ? Math.max(0, cp.buyers - c.early_buyers) : null;
}

/**
 * A coin whose whole curve was bought in its launch second, usually by its launcher with large capital. It
 * "graduates" instantly without traders choosing it, so it is reported apart from organic winners.
 */
export function isBuyout(c: { graduated_ts: number | null; created_ts: number }): boolean {
  return c.graduated_ts !== null && c.graduated_ts - c.created_ts <= SNIPE_WINDOW_SEC;
}

function launchedCoins(db: DatabaseSync, sinceTs: number): CoinRow[] {
  return db
    .prepare(
      `SELECT mint, name, symbol, creator, COALESCE(launcher, creator) AS dev, created_ts, unique_buyers, early_buyers, volume_sol, peak_mcap_sol, peak_ts,
        last_mcap_sol, dev_bought, dev_first_sell_ts, dev_sold_all_ts, graduated_ts, smart_buys, checkpoints, twitter,
        website, description
       FROM coins WHERE created_ts >= ?`,
    )
    .all(sinceTs) as unknown as CoinRow[];
}

export function observerStatus(db: DatabaseSync): Record<string, any> | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'observer_status'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function marketSummary(db: DatabaseSync, sinceTs: number) {
  const coins = launchedCoins(db, sinceTs);
  const settled = coins.filter((c) => c.checkpoints.includes('"300"'));
  const organic5 = settled.map((c) => organicAt(c, 300) ?? 0);
  const traded = coins.filter((c) => c.graduated_ts !== null && !isBuyout(c));
  return {
    launches: coins.length,
    boughtOutAtLaunch: coins.filter(isBuyout).length,
    graduatedThroughTrading: traded.length,
    medianSecondsToGraduate: median(traded.map((c) => c.graduated_ts! - c.created_ts)),
    tractionShare: share(organic5.map((n) => n >= TRACTION_BUYERS)),
    medianOrganicBuyers5m: median(organic5),
    bundledShare: share(coins.map((c) => c.early_buyers >= 5)),
    devBoughtShare: share(coins.map((c) => c.dev_bought > 0)),
    devSoldWithin60sShare: share(
      coins.filter((c) => c.dev_bought > 0).map((c) => c.dev_first_sell_ts !== null && c.dev_first_sell_ts - c.created_ts <= 60),
    ),
  };
}

/** Best coins by peak market cap, excluding launch buyouts. */
export function topCoins(db: DatabaseSync, sinceTs: number, limit: number) {
  return launchedCoins(db, sinceTs)
    .filter((c) => !isBuyout(c))
    .sort((a, b) => b.peak_mcap_sol - a.peak_mcap_sol)
    .slice(0, limit)
    .map((c) => ({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      peakMcapSol: c.peak_mcap_sol,
      secondsToPeak: c.peak_ts !== null ? c.peak_ts - c.created_ts : null,
      lastMcapSol: c.last_mcap_sol,
      buyers: c.unique_buyers,
      earlyBuyers: c.early_buyers,
      organic5m: organicAt(c, 300),
      volumeSol: c.volume_sol,
      smartBuys: c.smart_buys,
      devFirstSellSec: c.dev_first_sell_ts !== null ? c.dev_first_sell_ts - c.created_ts : null,
      graduated: c.graduated_ts !== null,
      twitter: c.twitter,
    }));
}

export function boughtOutCoins(db: DatabaseSync, sinceTs: number, limit: number) {
  return launchedCoins(db, sinceTs)
    .filter(isBuyout)
    .sort((a, b) => b.peak_mcap_sol - a.peak_mcap_sol)
    .slice(0, limit)
    .map((c) => ({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      creator: c.creator,
      peakMcapSol: c.peak_mcap_sol,
      lastMcapSol: c.last_mcap_sol,
      buyersAfterLaunch: c.unique_buyers - c.early_buyers,
      volumeSol: c.volume_sol,
    }));
}

const ARCHETYPE_ORDER: Record<string, string> = {
  top_performer: 'realized_sol DESC',
  whale: 'large_buys DESC',
  aggressive: 'trades_decayed DESC',
  flipper: 'closed DESC',
  sniper: 'snipes DESC',
  multi_coin: 'max_open DESC',
  scheduled: 'trades DESC',
  bot_like: 'trades_decayed DESC',
  serial_creator: 'launches DESC',
};

export function walletsByArchetype(db: DatabaseSync, sinceTs: number, nowTs: number, limit: number) {
  const out: Record<string, ReturnType<typeof walletSummary>[]> = {};
  for (const [archetype, order] of Object.entries(ARCHETYPE_ORDER)) {
    const rows = db
      .prepare(
        `SELECT * FROM wallet_stats WHERE last_ts >= ? AND (',' || archetypes || ',') LIKE ? ORDER BY ${order} LIMIT ?`,
      )
      .all(sinceTs, `%,${archetype},%`, limit) as Record<string, any>[];
    out[archetype] = rows.map((r) => walletSummary(r, nowTs));
  }
  return out;
}

export function walletSummary(row: Record<string, any>, nowTs: number) {
  const w = walletFromRow(row);
  return {
    wallet: w.wallet,
    archetypes: w.archetypes,
    realizedSol: w.realizedSol,
    winRate: w.closed ? w.wins / w.closed : null,
    closed: w.closed,
    trades: w.trades,
    tradesPerDay: tradesPerDay(w, nowTs),
    avgBuySol: w.buys ? w.buySol / w.buys : null,
    maxBuySol: w.maxBuySol,
    largeBuys: w.largeBuys,
    medianHoldSec: medianHoldSec(w.holdHist),
    snipeShare: w.knownEntries ? w.snipes / w.knownEntries : null,
    maxOpen: w.maxOpen,
    launches: w.launches,
    activeDays: w.days.length,
    lastTs: w.lastTs,
  };
}

/**
 * How buyers respond to a creator's visible history: coins grouped by how many earlier launches their creator had
 * (within the observed window) and how often the creator sold within five minutes on those earlier launches.
 */
export function creatorResponse(db: DatabaseSync, sinceTs: number) {
  const rows = db
    .prepare(
      `WITH c AS (
         SELECT mint, created_ts, unique_buyers, early_buyers, graduated_ts, peak_mcap_sol, checkpoints,
           COUNT(*) OVER w AS prior_launches,
           SUM(CASE WHEN dev_first_sell_ts IS NOT NULL AND dev_first_sell_ts - created_ts <= 300 THEN 1 ELSE 0 END)
             OVER w AS prior_quick_sells
         FROM coins WHERE created_ts IS NOT NULL AND creator IS NOT NULL
         WINDOW w AS (PARTITION BY creator ORDER BY created_ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
       )
       SELECT * FROM c WHERE created_ts >= ?`,
    )
    .all(sinceTs) as Record<string, any>[];

  const bucketOf = (r: Record<string, any>): string => {
    const prior = r.prior_launches as number;
    if (prior === 0) return '1. first launch';
    const quick = (r.prior_quick_sells ?? 0) / prior > 0.5 ? 'mostly sold <5m' : 'mostly held >5m';
    if (prior <= 2) return `2. 1-2 prior, ${quick}`;
    if (prior <= 9) return `3. 3-9 prior, ${quick}`;
    return `4. 10+ prior, ${quick}`;
  };
  const groups = new Map<string, Record<string, any>[]>();
  for (const r of rows) {
    const k = bucketOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, rs]) => {
      const organic = rs
        .map((r) => organicAt(r as unknown as CoinRow, 300))
        .filter((n): n is number => n !== null);
      return {
        bucket,
        coins: rs.length,
        medianOrganic5m: median(organic),
        tractionShare: share(organic.map((n) => n >= TRACTION_BUYERS)),
        graduatedShare: share(rs.map((r) => r.graduated_ts !== null)),
        medianPeakMcapSol: median(rs.map((r) => r.peak_mcap_sol)),
      };
    });
}

/** Coin outcomes by when the creator first sold. Only coins at least an hour old, so outcomes have played out. */
export function devExitOutcomes(db: DatabaseSync, sinceTs: number, nowTs: number) {
  const coins = launchedCoins(db, sinceTs).filter((c) => c.dev_bought > 0 && nowTs - c.created_ts >= 3600);
  const bucketOf = (c: CoinRow): string => {
    if (c.dev_first_sell_ts === null) return '6. never sold';
    const d = c.dev_first_sell_ts - c.created_ts;
    if (d <= 30) return '1. within 30s';
    if (d <= 300) return '2. 30s-5m';
    if (d <= 1800) return '3. 5m-30m';
    if (d <= 3600) return '4. 30m-1h';
    return '5. after 1h';
  };
  const groups = new Map<string, CoinRow[]>();
  for (const c of coins) groups.set(bucketOf(c), [...(groups.get(bucketOf(c)) ?? []), c]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, cs]) => ({
      bucket,
      coins: cs.length,
      medianOrganic5m: median(cs.map((c) => organicAt(c, 300)).filter((n): n is number => n !== null)),
      medianOrganic60m: median(cs.map((c) => organicAt(c, 3600)).filter((n): n is number => n !== null)),
      graduatedShare: share(cs.map((c) => c.graduated_ts !== null)),
      medianPeakMcapSol: median(cs.map((c) => c.peak_mcap_sol)),
      meanPeakMcapSol: mean(cs.map((c) => c.peak_mcap_sol)),
    }));
}

const STOPWORDS = new Set(['the', 'and', 'coin', 'token', 'for', 'with', 'you', 'this', 'that', 'are', 'not', 'from']);

function words(c: CoinRow): string[] {
  const text = `${c.name ?? ''} ${c.symbol ?? ''}`.toLowerCase();
  return [...new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

/**
 * Words in coin names and tickers that show up more among coins with traction than among all launches.
 * A first, crude read on what the market is buying; Phase 2's narrative engine replaces it.
 */
/**
 * Words over-represented among coins with traction. Counted per dev, not per launch, so one dev relaunching the same
 * name a hundred times reads as one dev, not as a narrative.
 */
export function nameLift(db: DatabaseSync, sinceTs: number, minDevs = 4) {
  const coins = launchedCoins(db, sinceTs).filter((c) => c.checkpoints.includes('"300"'));
  const isHit = (c: CoinRow) => (organicAt(c, 300) ?? 0) >= TRACTION_BUYERS || (c.graduated_ts !== null && !isBuyout(c));
  const devOf = (c: CoinRow) => c.dev ?? c.mint;
  const all = new Map<string, Set<string>>();
  const hit = new Map<string, Set<string>>();
  const launches = new Map<string, number>();
  const add = (m: Map<string, Set<string>>, w: string, dev: string) => m.set(w, (m.get(w) ?? new Set()).add(dev));
  for (const c of coins) {
    for (const w of words(c)) {
      add(all, w, devOf(c));
      launches.set(w, (launches.get(w) ?? 0) + 1);
      if (isHit(c)) add(hit, w, devOf(c));
    }
  }
  const devs = new Set(coins.map(devOf)).size;
  const hitDevs = new Set(coins.filter(isHit).map(devOf)).size;
  if (!hitDevs) return [];
  return [...hit.entries()]
    .filter(([w, d]) => d.size >= 2 && all.get(w)!.size >= minDevs)
    .map(([w, d]) => ({
      word: w,
      devs: all.get(w)!.size,
      launches: launches.get(w)!,
      devsWithTraction: d.size,
      lift: d.size / hitDevs / (all.get(w)!.size / devs),
    }))
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 25);
}
