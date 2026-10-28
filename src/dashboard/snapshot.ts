import type { DatabaseSync } from 'node:sqlite';

/**
 * Everything the dashboard page shows, assembled fresh from the observer's database plus what the caller knows
 * (balances, the kill switch, the launcher's lock). Reads only: the dashboard never writes, and every query is
 * wrapped so a briefly locked database degrades a panel to "unknown" instead of killing the page.
 */

export interface WalletView {
  label: string;
  address: string;
  balanceSol: number | null;
}

export interface Extras {
  wallets: WalletView[];
  /** Unix seconds of the last successful balance fetch; null before the first. */
  balancesTs: number | null;
  killed: boolean;
  /** The pid in data/live.lock when that process is alive, else null. */
  launcherPid: number | null;
  mintPool: number;
  /** The X watcher's state as the launcher would report it: "ready" or "off (reason)". */
  watcher: string;
  /** The board's hard limits and the playbook's pause, for the page's progress readouts. */
  limits: { maxLaunchesPerDay: number; maxDailyLossSol: number; pauseAfterDeadInARow: number };
  /** Seconds between our launches (the playbook's spacing), for the cooldown readout. */
  minGapSec: number;
  now?: number;
}

export interface OurLaunchView {
  mint: string;
  mode: string;
  createdTs: number;
  devBuySol: number;
  postUrl: string | null;
  postAgeSec: number | null;
  pnlSol: number | null;
  drew: boolean | null;
  firstSellSec: number | null;
  notes: string | null;
  symbol: string | null;
  name: string | null;
  createSig: string | null;
  peakMcapSol: number | null;
  uniqueBuyers: number | null;
  creatorFeesSol: number | null;
}

export interface FeedCoinView {
  mint: string;
  symbol: string | null;
  createdTs: number;
  devBuySol: number;
  isMayhem: boolean;
  quote: string;
  post: string | null;
  followable: boolean;
}

export interface SignalView {
  ts: number;
  kind: string;
  symbol: string | null;
  mint: string | null;
  headline: string;
}

export interface Snapshot {
  now: number;
  observer: { lastTradeTs: number | null; launches5m: number | null; launches1h: number | null; trades1m: number | null; coinsTotal: number | null };
  launcher: { running: boolean; pid: number | null; killed: boolean; mintPool: number; watcher: string };
  limits: Extras['limits'];
  minGapSec: number;
  wallets: WalletView[];
  balancesTs: number | null;
  today: { launches: number; pnlSol: number; deadInARow: number; lastLaunchTs: number | null } | null;
  launches: OurLaunchView[];
  feed: FeedCoinView[];
  signals: SignalView[];
}

const dayStart = (ts: number) => ts - (ts % 86400);

function one<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** One line for a signal row the way the observer logs it: the number a human skims for. */
function headline(kind: string, detail: Record<string, unknown>): string {
  if (kind === 'smart_buy' && typeof detail.sol === 'number') return `${(detail.sol as number).toFixed(2)} SOL`;
  if (kind === 'traction' && typeof detail.buyers === 'number') return `${detail.buyers} buyers`;
  return '';
}

export function buildSnapshot(db: DatabaseSync, x: Extras): Snapshot {
  const now = x.now ?? Math.floor(Date.now() / 1000);

  const observer = one<Snapshot['observer']>(
    () => {
      const last = db.prepare('SELECT MAX(ts) AS t FROM trades').get() as { t: number | null };
      const l5 = db.prepare('SELECT COUNT(*) AS n FROM coins WHERE created_ts >= ?').get(now - 300) as { n: number };
      const l1h = db.prepare('SELECT COUNT(*) AS n FROM coins WHERE created_ts >= ?').get(now - 3600) as { n: number };
      const t1 = db.prepare('SELECT COUNT(*) AS n FROM trades WHERE ts >= ?').get(now - 60) as { n: number };
      const total = db.prepare('SELECT COUNT(*) AS n FROM coins').get() as { n: number };
      return { lastTradeTs: last.t, launches5m: l5.n, launches1h: l1h.n, trades1m: t1.n, coinsTotal: total.n };
    },
    { lastTradeTs: null, launches5m: null, launches1h: null, trades1m: null, coinsTotal: null },
  );

  // The same window and dead-streak reading the launch board uses (src/live/board.ts), so the two never disagree.
  const today = one(() => {
    const last = db.prepare(`SELECT MAX(created_ts) AS t FROM our_launches WHERE mode = 'live'`).get() as { t: number | null };
    const day = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol), 0) AS pnl FROM our_launches WHERE mode = 'live' AND created_ts >= ?`)
      .get(dayStart(now)) as { n: number; pnl: number };
    const recent = db
      .prepare(`SELECT drew FROM our_launches WHERE mode = 'live' AND drew IS NOT NULL ORDER BY created_ts DESC LIMIT 20`)
      .all() as { drew: number }[];
    let dead = 0;
    for (const r of recent) {
      if (r.drew) break;
      dead++;
    }
    return { launches: day.n, pnlSol: day.pnl, deadInARow: dead, lastLaunchTs: last.t };
  }, null);

  const launches = one(
    () =>
      (
        db
          .prepare(
            `SELECT o.mint, o.mode, o.created_ts, o.dev_buy_sol, o.source_post, o.post_age_sec, o.pnl_sol, o.drew,
                    o.first_sell_sec, o.notes, c.symbol, c.name, c.create_sig, c.peak_mcap_sol, c.unique_buyers, c.creator_fees_sol
             FROM our_launches o LEFT JOIN coins c ON c.mint = o.mint
             ORDER BY o.created_ts DESC LIMIT 60`,
          )
          .all() as Record<string, unknown>[]
      ).map(
        (r): OurLaunchView => ({
          mint: r.mint as string,
          mode: r.mode as string,
          createdTs: r.created_ts as number,
          devBuySol: r.dev_buy_sol as number,
          postUrl: (r.source_post as string | null) ?? null,
          postAgeSec: (r.post_age_sec as number | null) ?? null,
          pnlSol: (r.pnl_sol as number | null) ?? null,
          drew: r.drew === null ? null : Boolean(r.drew),
          firstSellSec: (r.first_sell_sec as number | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          symbol: (r.symbol as string | null) ?? null,
          name: (r.name as string | null) ?? null,
          createSig: (r.create_sig as string | null) ?? null,
          peakMcapSol: (r.peak_mcap_sol as number | null) ?? null,
          uniqueBuyers: (r.unique_buyers as number | null) ?? null,
          creatorFeesSol: (r.creator_fees_sol as number | null) ?? null,
        }),
      ),
    [] as OurLaunchView[],
  );

  const feed = one(
    () => {
      // The dev buy in SOL the way the backtest reads it (src/sim/backtest.ts): the creator's buys in the launch slot.
      const devBuy = db.prepare(
        `SELECT COALESCE(SUM(t.sol), 0) AS sol FROM trades t
         WHERE t.mint_id = (SELECT id FROM ids WHERE address = ?)
           AND t.wallet_id = (SELECT id FROM ids WHERE address = ?)
           AND t.is_buy = 1
           AND t.slot = (SELECT MIN(slot) FROM trades WHERE mint_id = (SELECT id FROM ids WHERE address = ?))`,
      );
      return (
        db
          .prepare(
            `SELECT mint, symbol, creator, created_ts, is_mayhem, quote, twitter
             FROM coins ORDER BY created_ts DESC LIMIT 14`,
          )
          .all() as Record<string, unknown>[]
      ).map((r): FeedCoinView => {
        const post = typeof r.twitter === 'string' && /\/status(?:es)?\/\d+/.test(r.twitter) ? (r.twitter as string) : null;
        const buy = one(() => (devBuy.get(r.mint as string, (r.creator as string | null) ?? '', r.mint as string) as { sol: number }).sol, 0);
        return {
          mint: r.mint as string,
          symbol: (r.symbol as string | null) ?? null,
          createdTs: (r.created_ts as number) ?? 0,
          devBuySol: buy,
          isMayhem: Boolean(r.is_mayhem),
          quote: r.quote as string,
          post,
          followable: post !== null && !r.is_mayhem && r.quote === 'SOL' && buy >= 0.1,
        };
      });
    },
    [] as FeedCoinView[],
  );

  const signals = one(
    () =>
      (db.prepare('SELECT ts, kind, mint, detail FROM signals ORDER BY ts DESC LIMIT 12').all() as Record<string, unknown>[]).map(
        (r): SignalView => {
          let detail: Record<string, unknown> = {};
          try {
            detail = JSON.parse((r.detail as string) ?? '{}') as Record<string, unknown>;
          } catch {
            /* a malformed row only loses its headline */
          }
          return {
            ts: r.ts as number,
            kind: r.kind as string,
            symbol: typeof detail.symbol === 'string' ? detail.symbol : null,
            mint: (r.mint as string | null) ?? null,
            headline: headline(r.kind as string, detail),
          };
        },
      ),
    [] as SignalView[],
  );

  return {
    now,
    observer,
    launcher: { running: x.launcherPid !== null, pid: x.launcherPid, killed: x.killed, mintPool: x.mintPool, watcher: x.watcher },
    limits: x.limits,
    minGapSec: x.minGapSec,
    wallets: x.wallets,
    balancesTs: x.balancesTs,
    today,
    launches,
    feed,
    signals,
  };
}
