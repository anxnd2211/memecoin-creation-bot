import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolTrade } from '../src/chain/events.ts';
import { classifyPool, toTrade } from '../src/chain/pools.ts';
import { DEFAULT_PUBKEY, SOL, USDC_MINT, WSOL_MINT } from '../src/chain/programs.ts';

const COIN = 'Ebf7TyKQZrzwNkXd8B8k5NCY7gfREyGp5UWDYMzDpump';

const pt = (o: Partial<PoolTrade>): PoolTrade => ({
  kind: 'pool_trade',
  sig: 's',
  slot: 1,
  ts: 2,
  pool: 'P',
  wallet: 'W',
  baseBuy: true,
  baseAmountRaw: 1_000_000_000, // 1,000 coins
  quoteAmountRaw: 1_010_000_000, // 1.01 SOL paid incl. fees
  quoteAmountNoFeeRaw: 1_000_000_000,
  ...o,
});

test('a migrated pump coin pool is tracked with the coin as base', () => {
  const row = classifyPool('P', COIN, WSOL_MINT, 'Creator1111111111111111111111111111111111');
  assert.deepEqual(row, { pool: 'P', coinMint: COIN, quote: SOL, inverted: false, tracked: true });
});

test('pools without a pump coin are ignored', () => {
  const row = classifyPool('P', USDC_MINT, WSOL_MINT, DEFAULT_PUBKEY);
  assert.equal(row.tracked, false);
});

test('pool buys become coin buys priced without fees', () => {
  const row = classifyPool('P', COIN, WSOL_MINT, 'Creator1111111111111111111111111111111111');
  const t = toTrade(row, pt({}));
  assert.ok(t);
  assert.equal(t.isBuy, true);
  assert.equal(t.coinAmount, 1000);
  assert.equal(t.quoteAmount, 1.01);
  assert.equal(t.price, 0.001);
});

test('an inverted pool (SOL as base) flips the trade direction', () => {
  const row = classifyPool('P', WSOL_MINT, COIN, DEFAULT_PUBKEY);
  assert.equal(row.inverted, true);
  // Buying the SOL base with coins is a coin sell.
  const t = toTrade(row, pt({ baseBuy: true, baseAmountRaw: 2_000_000_000, quoteAmountRaw: 5_000_000 }));
  assert.ok(t);
  assert.equal(t.isBuy, false);
  assert.equal(t.coinAmount, 5);
  assert.equal(t.quoteAmount, 2);
});
