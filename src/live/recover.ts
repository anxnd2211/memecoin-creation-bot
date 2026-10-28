import type { DatabaseSync } from 'node:sqlite';
import type { Playbook } from '../playbook.ts';
import type { Notifier, Venue } from './types.ts';

/**
 * Sells any bag a previous run left behind. If the launcher stops between a launch and its sell (a crash, a restart,
 * the Mac sleeping), the dev buy is still in the coin; on the next start every recent launch of ours in this mode is
 * checked for tokens still held, and those are sold at once. An unsold bag is the one way a launch can lose more than
 * the fees.
 */
export async function sellLeftoverBags(
  db: DatabaseSync,
  venue: Venue,
  notifier: Notifier,
  playbook: Playbook,
  opts: { sinceSec?: number; now?: number } = {},
): Promise<{ checked: number; sold: string[]; failed: string[] }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(`SELECT mint FROM our_launches WHERE mode = ? AND created_ts >= ? ORDER BY created_ts`)
    .all(venue.mode, now - (opts.sinceSec ?? 7 * 86400)) as { mint: string }[];
  const out = { checked: 0, sold: [] as string[], failed: [] as string[] };
  for (const { mint } of rows) {
    out.checked++;
    let held: bigint;
    try {
      held = await venue.tokenBalance(mint);
    } catch {
      // A launch that never landed has no token account: nothing to sell.
      continue;
    }
    if (held <= 0n) continue;
    try {
      const fill = await venue.sellAll(mint, { maxSlippage: playbook.sellMaxSlippage, ladder: [0.2, 0.35, 0.6] });
      out.sold.push(mint);
      db.prepare(`UPDATE our_launches SET notes = COALESCE(notes, '') || ? WHERE mint = ?`).run(
        `; leftover bag sold on restart for ${(Number(fill.lamportsReceived) / 1e9).toFixed(4)} SOL`,
        mint,
      );
      await notifier.send(`Sold a bag left from an earlier run: ${mint}, ${(Number(fill.lamportsReceived) / 1e9).toFixed(4)} SOL.`);
    } catch (e) {
      out.failed.push(mint);
      await notifier.send(`A bag from an earlier run could not be sold: ${mint} (${(e as Error).message}). Sell it by hand now.`);
    }
  }
  return out;
}
