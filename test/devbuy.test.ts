import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devBuyFor, parseDevBuy, withFees } from '../src/live/devbuy.ts';

test('a fixed tier buys exactly that much into the curve', () => {
  assert.ok(Math.abs(devBuyFor(2, 2.5) - 2.025) < 1e-12);
  assert.ok(Math.abs(devBuyFor(5, 0.1) - 5.0625) < 1e-12);
});

test('auto buys 2 SOL until the wallet holds 5 SOL plus the reserve and a buffer, then 5', () => {
  assert.equal(devBuyFor('auto', 2.5), withFees(2));
  assert.equal(devBuyFor('auto', null), withFees(2));
  assert.equal(devBuyFor('auto', 5.5), withFees(2));
  assert.equal(devBuyFor('auto', 5.52), withFees(5));
  assert.equal(devBuyFor('auto', 8), withFees(5));
});

test('only the sniper tiers or auto are accepted', () => {
  assert.equal(parseDevBuy('2'), 2);
  assert.equal(parseDevBuy('auto'), 'auto');
  assert.equal(parseDevBuy('2.4'), null);
  assert.equal(parseDevBuy('10'), null);
  assert.equal(parseDevBuy(undefined), null);
});
