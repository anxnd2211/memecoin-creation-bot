import type { DatabaseSync } from 'node:sqlite';
import type { Playbook } from '../playbook.ts';
import { websiteKind } from '../sim/traits.ts';
import type { CoinDraft, PostInfo } from './types.ts';

/**
 * The launch board: every launch passes the same gates, in a fixed order, and a gate that cannot be evaluated (data
 * missing, the observer behind, no preflight yet) blocks the launch; it is never treated as a pass. The rules come
 * from the playbook (docs/PLAYBOOK.md); the money limits are the owner's.
 */

/** The owner's hard limits for live launches. */
export interface Limits {
  maxLaunchesPerDay: number;
  /** Stop for the day once today's launches have lost this much SOL in total. */
  maxDailyLossSol: number;
  /** The most SOL one dev buy may spend, fees included. */
  maxDevBuySol: number;
  /** SOL kept in the wallet beyond the dev buy, for rent, network fees, tips and a retried sell. */
  reserveSol: number;
  /** The observer must have recorded a trade this recently, or first-on-post cannot be checked. */
  maxObserverStaleSec: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxLaunchesPerDay: 10,
  maxDailyLossSol: 1.5,
  maxDevBuySol: 5.1,
  reserveSol: 0.15,
  maxObserverStaleSec: 15,
};

/** What the board knows about the market and about our own launches; null means it could not be found out. */
export interface BoardState {
  /** Unix seconds. */
  now: number;
  observerLastTradeTs: number | null;
  /** Launches that already link this post (any dev). */
  postLaunches: number | null;
  /** Launches made since the post whose metadata the observer has not fetched yet: one could link this post. */
  pendingLaunches: number | null;
  /** Launches linking a post by the same X account in the last hour. */
  accountLaunchesLastHour: number | null;
  /** Launches with the same ticker in the last 10 minutes. */
  tickerLaunchesLast10m: number | null;
  ours: { lastLaunchTs: number | null; launchesToday: number; pnlTodaySol: number; deadInARow: number } | null;
  balanceLamports: bigint | null;
  killed: boolean;
}

export interface BoardInput {
  playbook: Playbook;
  limits: Limits;
  post: PostInfo;
  draft: CoinDraft;
  state: BoardState;
  /** Blocking problems from the designer's compliance check. */
  compliance: string[];
  /** 'ok', the reason the simulation failed, or null when it has not run. */
  preflight: string | null;
  /** The owner's answer; null before asking. */
  approved: boolean | null;
}

export interface Gate {
  name: string;
  pass: boolean;
  detail: string;
}

const LAMPORTS = 1e9;

/**
 * Runs every gate, in order, and passes only if all pass. `upTo` stops before the preflight and approval gates, for
 * the first check made before simulating and asking the owner.
 */
export function launchBoard(i: BoardInput, upTo: 'all' | 'before preflight' = 'all'): { pass: boolean; gates: Gate[] } {
  const { playbook: p, limits: l, post, draft, state: s } = i;
  const gates: Gate[] = [];
  const gate = (name: string, pass: boolean, detail: string) => gates.push({ name, pass, detail });
  const known = <T>(v: T | null): v is T => v !== null;

  gate('kill switch off', !s.killed, s.killed ? 'the kill switch is on' : 'off');
  gate('normal mode', p.mayhem === false, 'never Mayhem');
  const age = s.now - post.postedAt;
  gate(
    'post fresh',
    p.require.maxPostAgeSec === null || (age >= -5 && age <= p.require.maxPostAgeSec),
    `post is ${Math.round(age)} s old (limit ${p.require.maxPostAgeSec ?? 'none'} s)`,
  );
  const stale = known(s.observerLastTradeTs) ? s.now - s.observerLastTradeTs : null;
  gate(
    'observer current',
    stale !== null && stale <= l.maxObserverStaleSec,
    stale === null ? 'no trades recorded' : `last trade recorded ${Math.round(stale)} s ago`,
  );
  if (p.require.firstOnPost) {
    // 0 prior launches normally; the launch-follower allows exactly 1 (the trigger launch it is following).
    const maxPrior = p.require.maxPriorLaunchesOnPost ?? 0;
    gate(
      maxPrior ? `at most ${maxPrior + 1} launches on the post` : 'first on the post',
      known(s.postLaunches) && known(s.pendingLaunches) && s.postLaunches <= maxPrior && s.pendingLaunches === 0,
      !known(s.postLaunches) || !known(s.pendingLaunches)
        ? 'could not check'
        : `${s.postLaunches} launches already link it; ${s.pendingLaunches} recent launches not yet checked`,
    );
  }
  if (p.require.skipFarmedAccounts) {
    gate(
      'account not farmed',
      known(s.accountLaunchesLastHour) && s.accountLaunchesLastHour < 3,
      known(s.accountLaunchesLastHour) ? `${s.accountLaunchesLastHour} launches on @${post.handle} in the last hour` : 'could not check',
    );
  }
  gate(
    'ticker not crowded',
    known(s.tickerLaunchesLast10m) && s.tickerLaunchesLast10m < 3,
    known(s.tickerLaunchesLast10m) ? `${s.tickerLaunchesLast10m} launches of $${draft.symbol} in the last 10 min` : 'could not check',
  );
  gate('X link is the post', draft.postUrl === post.url, draft.postUrl);
  if (p.require.website) {
    const kind = websiteKind(draft.website);
    gate('website is the source', kind === 'yes', `${draft.website || 'none'} (${kind})`);
  }
  gate('compliance', i.compliance.length === 0, i.compliance.length ? i.compliance.join('; ') : 'no problems');
  const ours = s.ours;
  gate(
    'spacing',
    known(ours) && (ours.lastLaunchTs === null || s.now - ours.lastLaunchTs >= p.minGapBetweenLaunchesSec),
    !known(ours) ? 'could not read our launches' : ours.lastLaunchTs === null ? 'first launch' : `last launch ${Math.round(s.now - ours.lastLaunchTs)} s ago (minimum ${p.minGapBetweenLaunchesSec} s)`,
  );
  gate(
    'daily launches',
    known(ours) && ours.launchesToday < l.maxLaunchesPerDay,
    known(ours) ? `${ours.launchesToday} of ${l.maxLaunchesPerDay} today` : 'could not read our launches',
  );
  gate(
    'daily loss',
    known(ours) && ours.pnlTodaySol > -l.maxDailyLossSol,
    known(ours) ? `${ours.pnlTodaySol.toFixed(3)} SOL today (stop at -${l.maxDailyLossSol})` : 'could not read our launches',
  );
  gate(
    'dead streak',
    known(ours) && ours.deadInARow < p.pauseAfterDeadInARow,
    known(ours) ? `${ours.deadInARow} dead in a row (pause at ${p.pauseAfterDeadInARow})` : 'could not read our launches',
  );
  gate('dev buy within limit', p.devBuySol <= l.maxDevBuySol, `${p.devBuySol} SOL (limit ${l.maxDevBuySol})`);
  const need = p.devBuySol + l.reserveSol;
  gate(
    'wallet balance',
    known(s.balanceLamports) && Number(s.balanceLamports) / LAMPORTS >= need,
    known(s.balanceLamports) ? `${(Number(s.balanceLamports) / LAMPORTS).toFixed(4)} SOL (need ${need.toFixed(4)})` : 'could not read the balance',
  );
  if (upTo === 'all') {
    gate('preflight simulation', i.preflight === 'ok', i.preflight ?? 'not run');
    gate('owner approval', i.approved === true, i.approved === null ? 'not asked' : i.approved ? 'approved' : 'rejected');
  }
  return { pass: gates.every((g) => g.pass), gates };
}

/** One line per gate, for the console and the approval card. */
export function formatGates(gates: Gate[]): string {
  return gates.map((g) => `${g.pass ? 'PASS' : 'FAIL'}  ${g.name}: ${g.detail}`).join('\n');
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Midnight UTC of the day `ts` falls in. */
const dayStart = (ts: number) => ts - (ts % 86400);

/**
 * Reads the board's market and own-launch state from the observer's database. Each query that fails leaves its
 * field null, which blocks the launch.
 */
export function boardState(
  db: DatabaseSync,
  post: PostInfo,
  symbol: string,
  now: number,
  extra: { balanceLamports: bigint | null; killed: boolean; wallet?: string },
): BoardState {
  const one = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  const num = (sql: string, ...args: (string | number)[]) =>
    one(() => Number((db.prepare(sql).get(...args) as Record<string, number | null> | undefined)?.n ?? 0));
  const handle = post.handle.toLowerCase();
  return {
    now,
    observerLastTradeTs: one(() => (db.prepare('SELECT MAX(ts) AS t FROM trades WHERE ts >= ?').get(now - 3600) as { t: number | null }).t),
    postLaunches: num(`SELECT COUNT(*) AS n FROM coins WHERE twitter LIKE ?`, `%/status%/${post.postId}%`),
    // The observer fetches each launch's metadata within seconds; one made since the post and not fetched yet could
    // link it. A launch made before the post cannot.
    pendingLaunches: num(
      `SELECT COUNT(*) AS n FROM coins WHERE created_ts >= ? AND quote = 'SOL' AND meta_status NOT IN ('done', 'failed')`,
      Math.max(now - 120, post.postedAt - 2),
    ),
    accountLaunchesLastHour: one(() => {
      const rows = db
        .prepare(`SELECT twitter FROM coins WHERE created_ts >= ? AND twitter LIKE '%/status%'`)
        .all(now - 3600) as { twitter: string }[];
      return rows.filter((r) => new RegExp(`(?:x|twitter)\\.com/${handle.replace(/[^a-z0-9_]/g, '')}/status`, 'i').test(r.twitter)).length;
    }),
    tickerLaunchesLast10m: one(() => {
      const rows = db.prepare(`SELECT symbol FROM coins WHERE created_ts >= ?`).all(now - 600) as { symbol: string | null }[];
      return rows.filter((r) => norm(r.symbol ?? '') === norm(symbol)).length;
    }),
    ours: one(() => {
      const last = db.prepare(`SELECT MAX(created_ts) AS t FROM our_launches WHERE mode = 'live'`).get() as { t: number | null };
      const today = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol), 0) AS pnl FROM our_launches WHERE mode = 'live' AND created_ts >= ?`)
        .get(dayStart(now)) as { n: number; pnl: number };
      // The dead streak is the launching wallet's own (snipers judge a wallet by its record); the daily limits stay
      // across wallets, as they protect the owner's money.
      const recent = db
        .prepare(
          `SELECT drew FROM our_launches WHERE mode = 'live' AND drew IS NOT NULL AND (? IS NULL OR wallet = ?)
           ORDER BY created_ts DESC LIMIT 20`,
        )
        .all(extra.wallet ?? null, extra.wallet ?? null) as { drew: number }[];
      let dead = 0;
      for (const r of recent) {
        if (r.drew) break;
        dead++;
      }
      return { lastLaunchTs: last.t, launchesToday: today.n, pnlTodaySol: today.pnl, deadInARow: dead };
    }),
    balanceLamports: extra.balanceLamports,
    killed: extra.killed,
  };
}

/**
 * The X account's record in the observer's data: launches that linked its posts, how many drew buyers, and how many
 * posts they covered. Shown on the launch card; accounts with 3+ earlier launches and 60%+ busy made the most.
 */
export function accountRecord(db: DatabaseSync, handle: string): { launches: number; busy: number; posts: number } | null {
  try {
    const h = handle.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const rows = db
      .prepare(`SELECT twitter, unique_buyers - early_buyers >= 10 AS busy FROM coins WHERE twitter LIKE ?`)
      .all(`%/${h}/status/%`) as { twitter: string; busy: number }[];
    const mine = rows.filter((r) => new RegExp(`(?:x|twitter)\\.com/${h}/status/(\\d+)`, 'i').test(r.twitter));
    const posts = new Set(mine.map((r) => r.twitter.match(/status\/(\d+)/)?.[1]));
    return { launches: mine.length, busy: mine.filter((r) => r.busy).length, posts: posts.size };
  } catch {
    return null;
  }
}

/** Launches made since the post whose metadata the observer has not fetched yet, with their metadata URIs. */
export function pendingLaunchUris(db: DatabaseSync, post: PostInfo, now: number): { mint: string; uri: string | null }[] {
  return db
    .prepare(
      `SELECT mint, uri FROM coins WHERE created_ts >= ? AND quote = 'SOL' AND meta_status NOT IN ('done', 'failed')`,
    )
    .all(Math.max(now - 120, post.postedAt - 2)) as { mint: string; uri: string | null }[];
}
