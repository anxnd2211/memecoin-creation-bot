import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSIFY_VERSION } from '../src/intel/classify.ts';
import { relabelWalletsIfRulesChanged } from '../src/intel/relabel.ts';
import { boughtOutCoins, marketSummary, topCoins } from '../src/intel/reports.ts';
import { newCoin, newWallet } from '../src/intel/state.ts';
import { Store } from '../src/store/db.ts';

const T0 = 1_800_000_000;

function coin(mint: string, graduatedAfter: number | null, peak: number) {
  return {
    ...newCoin(mint, 'SOL'),
    symbol: mint,
    createdTs: T0,
    graduatedTs: graduatedAfter === null ? null : T0 + graduatedAfter,
    peakMcapSol: peak,
  };
}

test('launch buyouts are reported apart from coins that graduated through trading', () => {
  const store = new Store(':memory:');
  store.saveCoin(coin('BUYOUT', 0, 3_000_000));
  store.saveCoin(coin('ORGANIC', 420, 4_000));
  store.saveCoin(coin('DUD', null, 40));

  const m = marketSummary(store.db, T0 - 1);
  assert.equal(m.launches, 3);
  assert.equal(m.boughtOutAtLaunch, 1);
  assert.equal(m.graduatedThroughTrading, 1);
  assert.equal(m.medianSecondsToGraduate, 420);

  assert.deepEqual(
    topCoins(store.db, T0 - 1, 10).map((c) => c.symbol),
    ['ORGANIC', 'DUD'],
  );
  assert.deepEqual(
    boughtOutCoins(store.db, T0 - 1, 10).map((c) => c.symbol),
    ['BUYOUT'],
  );
});

test('wallets labelled under old rules are relabelled once', () => {
  const store = new Store(':memory:');
  const w = { ...newWallet('W', T0), buys: 1, buySol: 3939, maxBuySol: 3939, archetypes: ['whale'] };
  store.saveWallet(w);

  assert.equal(relabelWalletsIfRulesChanged(store, T0), 1);
  assert.equal(store.loadWallet('W')!.archetypes, '');
  assert.equal(store.getMeta('classify_version'), CLASSIFY_VERSION);
  assert.equal(relabelWalletsIfRulesChanged(store, T0), null);
});
