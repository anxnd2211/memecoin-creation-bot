import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBuy, applySell, writeOff } from '../src/intel/positions.ts';
import { newPosition } from '../src/intel/state.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('average-cost PnL across a partial and a full exit', () => {
  const p = newPosition('w', 'm', 100);
  assert.equal(applyBuy(p, 100, 1000, 1).opened, true);
  assert.equal(applyBuy(p, 105, 1000, 3).opened, false); // avg cost 0.002 SOL/token
  const r1 = applySell(p, 110, 500, 2); // basis released 1 SOL
  close(r1.realizedDelta, 1);
  assert.equal(r1.closed, false);
  const r2 = applySell(p, 160, 1500, 1); // basis released 3 SOL
  close(r2.realizedDelta, -2);
  assert.equal(r2.closed, true);
  assert.equal(r2.holdSec, 60);
  close(p.realizedSol, -1);
  assert.equal(p.complete, true);
});

test('a re-entry after a full exit starts a new cycle', () => {
  const p = newPosition('w', 'm', 0);
  applyBuy(p, 0, 100, 1);
  applySell(p, 10, 100, 2);
  assert.notEqual(p.closedTs, null);
  const again = applyBuy(p, 50, 10, 0.5);
  assert.equal(again.opened, true);
  assert.equal(p.closedTs, null);
  assert.equal(p.firstTs, 50);
  close(p.realizedSol, 0);
  close(p.basisSol, 0.5);
});

test('selling tokens bought before the observer started marks the position incomplete', () => {
  const p = newPosition('w', 'm', 0);
  const r = applySell(p, 0, 100, 1);
  assert.equal(r.realizedDelta, 0);
  assert.equal(p.complete, false);
});

test('overselling realizes PnL only on the observed tokens', () => {
  const p = newPosition('w', 'm', 0);
  applyBuy(p, 0, 100, 1);
  const r = applySell(p, 5, 200, 4); // half of the proceeds belong to unobserved tokens
  close(r.realizedDelta, 1);
  assert.equal(r.closed, true);
  assert.equal(p.complete, false);
});

test('an unvalued trade marks the position incomplete but still tracks tokens', () => {
  const p = newPosition('w', 'm', 0);
  applyBuy(p, 0, 100, null);
  assert.equal(p.tokens, 100);
  assert.equal(p.complete, false);
});

test('dust left behind still counts as a full exit', () => {
  const p = newPosition('w', 'm', 0);
  applyBuy(p, 0, 1000, 1);
  const r = applySell(p, 30, 995, 1.5);
  assert.equal(r.closed, true);
});

test('writing off an abandoned position realizes the loss once', () => {
  const p = newPosition('w', 'm', 0);
  applyBuy(p, 0, 1000, 2);
  const res = writeOff(p, 7200, 0.5);
  assert.equal(res.closed, true);
  assert.equal(res.realizedDelta, -1.5);
  assert.equal(p.basisSol, 0);
  assert.equal(writeOff(p, 7300, 0.5).closed, false);
  // Selling the written-off tokens later adds nothing.
  assert.equal(applySell(p, 7400, 1000, 1).realizedDelta, 0);
});
