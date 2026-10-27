import type { DatabaseSync } from 'node:sqlite';
import type { Playbook } from '../playbook.ts';
import type { ExitDecision, LaunchFill, Mode, PostInfo, SellFill } from './types.ts';

/**
 * Each of our launches gets one row in `our_launches` (src/store/db.ts): what was launched and why, written before the
 * launch, then what happened, written after the sell and again when the result settles. The post-mortem
 * (npm run postmortem) reads these rows, never memory.
 */

const LAMPORTS = 1e9;

/** Buyers other than the dev after the launch window that make a launch count as having drawn buyers. */
export const DREW_BUYERS = 10;

export interface LaunchPlan {
  mint: string;
  mode: Mode;
  createdTs: number;
  playbook: Playbook;
  post: PostInfo;
  narrative: string;
  postAgeSec: number;
  firstOnPost: boolean;
  exitPlan: string;
  feedLagSec: number | null;
}

/** Writes the row before the launch transaction is sent, so a crash mid-launch still leaves a record. */
export function recordPlan(db: DatabaseSync, p: LaunchPlan): void {
  db.prepare(
    `INSERT OR REPLACE INTO our_launches (mint, mode, created_ts, playbook, narrative, source_post, post_age_sec,
       first_on_post, dev_buy_sol, exit_plan, feed_lag_sec, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.mint,
    p.mode,
    p.createdTs,
    p.playbook.version,
    p.narrative,
    p.post.url,
    p.postAgeSec,
    p.firstOnPost ? 1 : 0,
    p.playbook.devBuySol,
    p.exitPlan,
    p.feedLagSec,
    'planned',
  );
}

export interface LaunchOutcome {
  launch: LaunchFill;
  sell: SellFill | null;
  exit: ExitDecision | null;
  /** Creator vault lamports before the launch and at settlement. */
  vaultBefore: bigint;
  vaultAfter: bigint;
  /** Other wallets that bought after the launch window. */
  laterBuyers: number;
  note: string;
}

/**
 * The launch's result in SOL: sell proceeds minus everything the launch cost (dev buy with fees, rent, network fees,
 * tips) plus the creator fees it earned. Rent on the dev's token account stays locked until it is closed, so it counts
 * as a cost here.
 */
export function launchPnl(o: LaunchOutcome): number {
  const spent = o.launch.lamportsSpent + o.launch.rentLamports + o.launch.networkFeeLamports;
  const back = (o.sell?.lamportsReceived ?? 0n) - (o.sell?.networkFeeLamports ?? 0n);
  const fees = o.vaultAfter - o.vaultBefore;
  return Number(back - spent + fees) / LAMPORTS;
}

/** Writes the result; called after the sell and again when the coin's trading has settled. */
export function recordOutcome(db: DatabaseSync, mint: string, o: LaunchOutcome): void {
  db.prepare(
    `UPDATE our_launches SET pnl_sol = ?, drew = ?, first_sell_sec = ?, notes = ? WHERE mint = ?`,
  ).run(launchPnl(o), o.laterBuyers >= DREW_BUYERS ? 1 : 0, o.exit?.ageSec ?? null, o.note, mint);
}
