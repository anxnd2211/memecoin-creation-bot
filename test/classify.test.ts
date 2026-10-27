import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestWindow, classify, isSmartMoney, medianHoldSec, tradesPerDay } from '../src/intel/classify.ts';
import { HOLD_BUCKETS, newWallet } from '../src/intel/state.ts';

const NOW = 1_800_000_000;

test('median hold returns the bucket bound holding the middle close', () => {
  const hist = HOLD_BUCKETS.map(() => 0);
  hist[0] = 2; // <=5s
  hist[3] = 3; // <=60s
  hist[6] = 1; // <=30m
  assert.equal(medianHoldSec(hist), 60);
  assert.equal(medianHoldSec(HOLD_BUCKETS.map(() => 0)), null);
});

test('best trading window wraps around midnight', () => {
  const hours = new Array(24).fill(0);
  hours[23] = 10;
  hours[0] = 10;
  hours[1] = 10;
  hours[12] = 3;
  const w = bestWindow(hours);
  assert.equal(w.startHour, 23);
  assert.ok(Math.abs(w.share - 30 / 33) < 1e-9);
});

test('decayed trade count approximates trades per day', () => {
  const w = newWallet('w', NOW);
  w.tradesDecayed = 100;
  w.decayTs = NOW;
  assert.ok(Math.abs(tradesPerDay(w, NOW) - 69.3) < 0.1);
  assert.ok(Math.abs(tradesPerDay(w, NOW + 86_400) - 34.66) < 0.1);
});

test('classifies a profitable flipper that snipes', () => {
  const w = newWallet('w', NOW);
  Object.assign(w, { closed: 20, wins: 12, realizedSol: 15, pnlDecayed: 3, decayTs: NOW, knownEntries: 20, snipes: 15 });
  w.holdHist[2] = 15; // <=30s
  w.holdHist[5] = 5;
  const a = classify(w, NOW);
  assert.ok(a.includes('top_performer'));
  assert.ok(a.includes('flipper'));
  assert.ok(a.includes('sniper'));
  assert.ok(!a.includes('whale'));
});

test('a profitable wallet out of form is not a top performer', () => {
  const w = newWallet('w', NOW);
  Object.assign(w, { closed: 20, wins: 12, realizedSol: 15, pnlDecayed: -2, decayTs: NOW });
  assert.ok(!classify(w, NOW).includes('top_performer'));
});

test('classifies whales, scheduled traders and serial creators', () => {
  const w = newWallet('w', NOW);
  Object.assign(w, { buys: 4, buySol: 40, largeBuys: 3, trades: 60, launches: 5, days: [1, 2, 3, 4] });
  w.hourHist[14] = 50;
  w.hourHist[3] = 10;
  const a = classify(w, NOW);
  assert.ok(a.includes('whale'));
  assert.ok(a.includes('scheduled'));
  assert.ok(a.includes('serial_creator'));
});

test('one huge buy, such as a launch buyout, does not make a whale', () => {
  const w = newWallet('w', NOW);
  Object.assign(w, { buys: 1, buySol: 3939, maxBuySol: 3939, largeBuys: 0 });
  assert.ok(!classify(w, NOW).includes('whale'));
  Object.assign(w, { buys: 3, buySol: 40, largeBuys: 2 });
  assert.ok(!classify(w, NOW).includes('whale'));
});

test('smart money excludes snipers and bots even when profitable', () => {
  assert.equal(isSmartMoney(['top_performer']), true);
  assert.equal(isSmartMoney(['whale', 'multi_coin']), true);
  assert.equal(isSmartMoney(['top_performer', 'flipper', 'sniper', 'serial_creator']), false);
  assert.equal(isSmartMoney(['whale', 'bot_like']), false);
  assert.equal(isSmartMoney(['flipper']), false);
});
