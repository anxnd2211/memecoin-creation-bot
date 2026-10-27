import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postMortem, wilson, type LaunchOutcome } from '../src/postmortem.ts';

const launch = (pnl: number, drew: boolean, planPnl: number, postAgeSec = 10): LaunchOutcome => ({
  mint: `m${pnl}`,
  symbol: 'T',
  pnl,
  drew,
  planPnl,
  postAgeSec,
  firstOnPost: true,
});

test('the gap splits exactly into picking, coins and execution', () => {
  const batch = [launch(2, true, 2.5), launch(-0.1, false, -0.1), launch(1, true, 1.2), launch(-0.1, false, -0.1)];
  const exp = { launches: 50, hitRate: 0.7, meanBusy: 3, meanDead: -0.1 };
  const pm = postMortem(batch, exp, new Map(), 3);
  const sum = pm.gap.picking + pm.gap.coins + pm.gap.execution;
  assert.ok(Math.abs(sum - (pm.mean - pm.expectedMean)) < 1e-12);
  assert.ok(Math.abs(pm.gap.execution - (-0.7 / 4)) < 1e-12);
  assert.ok(pm.actions.some((a) => a.startsWith('Execution')));
});

test('a batch whose hit rate is clearly below expectation gets a picking action, and dead streaks pause', () => {
  const batch = Array.from({ length: 10 }, (_, i) => launch(-0.1, i === 0, i === 0 ? 1 : -0.1, 90));
  const pm = postMortem(batch, { launches: 50, hitRate: 0.7, meanBusy: 3, meanDead: -0.1 }, new Map(), 3);
  assert.ok(pm.hitRateHi < 0.7);
  assert.equal(pm.deadInARow, 9);
  assert.ok(pm.actions[0]!.startsWith('Pause'));
  assert.ok(pm.actions.some((a) => a.startsWith('Picking') && a.includes('9 came over 30 s')));
});

test('a batch within noise gets no change, and a hindsight exit needs to win beyond noise', () => {
  const batch = [launch(1, true, 1), launch(1.1, true, 1.1), launch(-0.1, false, -0.1)];
  const exp = { launches: 50, hitRate: 0.6, meanBusy: 1, meanDead: -0.1 };
  assert.deepEqual(postMortem(batch, exp, new Map([['other', [1.05, 1.0, -0.1]]]), 3).actions.length, 1);
  assert.equal(postMortem(batch, exp, new Map([['other', [1.05, 1.0, -0.1]]]), 3).exitHindsight, null);
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo < 0.5 && hi > 0.5 && lo > 0.2 && hi < 0.8);
});
