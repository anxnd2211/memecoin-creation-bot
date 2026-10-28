import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoDraft } from '../src/live/autodraft.ts';

test('a cashtag in the post becomes the ticker', () => {
  const d = autoDraft('Launching $DOGE2 on Mars next week https://t.co/abc')!;
  assert.equal(d.symbol, 'DOGE2');
  assert.ok(d.name.length >= 1 && d.name.length <= 32);
});

test('otherwise the most distinctive word, with a short name around it', () => {
  const d = autoDraft('BREAKING: a giant Capybara just walked into the Senate chamber')!;
  assert.equal(d.symbol, 'CAPYBARA');
  assert.ok(d.name.includes('Capybara'), d.name);
  assert.ok(d.symbol.length <= 10 && d.name.length <= 32);
});

test('posts without usable words give no draft', () => {
  assert.equal(autoDraft(null), null);
  assert.equal(autoDraft('https://t.co/xyz @someone'), null);
  assert.equal(autoDraft('😂😂😂'), null);
});
