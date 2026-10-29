import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PLAYBOOK } from '../src/playbook.ts';
import { launchPnl, recordOutcome, recordPlan } from '../src/live/dossier.ts';
import { Store } from '../src/store/db.ts';

test('a launch is recorded before it is sent and its result after the sell', () => {
  const store = new Store(':memory:');
  const db: DatabaseSync = store.db;
  const post = { url: 'https://x.com/a/status/1', handle: 'a', postId: '1', postedAt: 100, authorName: null, text: null };
  recordPlan(db, { mint: 'M', mode: 'fork', wallet: 'DevWallet', createdTs: 120, playbook: PLAYBOOK, post, narrative: 'a thing', postAgeSec: 20,
    firstOnPost: true, exitPlan: PLAYBOOK.exit.name, feedLagSec: 0.8 });
  const launch = { mint: 'M', signature: 's', slot: 1, landedAt: 0, devTokens: 1n, lamportsSpent: 5_062_500_000n,
    rentLamports: 9_000_000n, networkFeeLamports: 15_000n, simulated: true };
  const sell = { signature: 't', landedAt: 0, tokensSold: 1n, lamportsReceived: 6_500_000_000n, networkFeeLamports: 5_000n,
    attempts: 1, simulated: true };
  const outcome = { launch, sell, exit: { reason: 'stall' as const, at: 0, ageSec: 14.2 }, vaultBefore: 0n,
    vaultAfter: 40_000_000n, laterBuyers: 25, note: 'sold on stall' };
  // 6.5 - 0.000005 back, 5.0625 + 0.009 + 0.000015 spent, 0.04 of creator fees.
  assert.ok(Math.abs(launchPnl(outcome) - (6.5 - 0.000005 - 5.0625 - 0.009 - 0.000015 + 0.04)) < 1e-9);
  recordOutcome(db, 'M', outcome);
  const row = db.prepare('SELECT * FROM our_launches WHERE mint = ?').get('M') as Record<string, unknown>;
  assert.equal(row.mode, 'fork');
  assert.equal(row.wallet, 'DevWallet');
  assert.equal(row.playbook, PLAYBOOK.version);
  assert.equal(row.drew, 1);
  assert.equal(row.first_sell_sec, 14.2);
  assert.ok(Math.abs((row.pnl_sol as number) - launchPnl(outcome)) < 1e-12);
});
