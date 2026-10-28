import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAYBOOK } from '../src/playbook.ts';
import { Store } from '../src/store/db.ts';
import { sellLeftoverBags } from '../src/live/recover.ts';
import type { Notifier, Venue } from '../src/live/types.ts';

test('bags left by an earlier run are sold on start, and failures are reported', async () => {
  const store = new Store(':memory:');
  const db = store.db;
  const now = 1_800_000_000;
  const add = db.prepare(`INSERT INTO our_launches (mint, mode, created_ts, playbook, dev_buy_sol, exit_plan) VALUES (?, ?, ?, 3, 5.0625, 'flow')`);
  add.run('HELD', 'live', now - 600);
  add.run('EMPTY', 'live', now - 500);
  add.run('STUCK', 'live', now - 400);
  add.run('NEVER', 'live', now - 300);
  add.run('PAPER', 'fork', now - 200);
  const sold: string[] = [];
  const venue = {
    mode: 'live',
    tokenBalance: async (m: string) => {
      if (m === 'NEVER') throw new Error('no token account');
      return m === 'EMPTY' ? 0n : 1000n;
    },
    sellAll: async (m: string) => {
      if (m === 'STUCK') throw new Error('SELL FAILED, BAG STILL HELD');
      sold.push(m);
      return { signature: 's', landedAt: 0, tokensSold: 1000n, lamportsReceived: 4_900_000_000n, networkFeeLamports: 5000n, attempts: 1, simulated: false };
    },
  } as unknown as Venue;
  const messages: string[] = [];
  const notifier: Notifier = { send: async (t) => void messages.push(t), askApproval: async () => ({ approved: false, by: 'timeout', at: 0 }) };
  const r = await sellLeftoverBags(db, venue, notifier, PLAYBOOK, { now });
  assert.equal(r.checked, 4);
  assert.deepEqual(r.sold, ['HELD']);
  // An RPC error while checking is not "no bag": NEVER could not be checked, so it counts as failed too.
  assert.deepEqual(r.failed, ['STUCK', 'NEVER']);
  assert.ok(messages.some((m) => m.includes('STUCK') && m.includes('by hand')));
  assert.ok(messages.some((m) => m.includes('NEVER') && m.includes('stays paused')));
  assert.ok((db.prepare(`SELECT notes FROM our_launches WHERE mint = 'HELD'`).get() as { notes: string }).notes.includes('leftover bag sold'));
});
