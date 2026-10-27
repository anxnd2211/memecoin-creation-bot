import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LaunchEvent, TradeEvent } from '../src/chain/events.ts';
import { Engine, type Signal } from '../src/intel/engine.ts';
import type { PriceBook } from '../src/market/prices.ts';
import { Store } from '../src/store/db.ts';

const T0 = 1_800_000_000;
const MINT = 'Mint1111111111111111111111111111111111pump';
const DEV = 'Dev11111111111111111111111111111111111111';

const prices = { solUsd: 100, toSol: (q: string, a: number) => (q === 'SOL' ? a : null) } as unknown as PriceBook;

function launch(): LaunchEvent {
  return {
    kind: 'launch',
    sig: 'c',
    slot: 1,
    ts: T0,
    mint: MINT,
    name: 'Test Coin',
    symbol: 'TEST',
    uri: 'https://example.invalid/meta.json',
    creator: DEV,
    user: DEV,
    quote: 'SOL',
    totalSupply: 1_000_000_000,
    price: 0.00000003,
    isMayhem: false,
    isHolderReward: false,
  };
}

function trade(wallet: string, ts: number, isBuy: boolean, sol: number, coins: number, price: number): TradeEvent {
  return { kind: 'trade', sig: `${wallet}${ts}`, slot: 1, ts, venue: 'curve', mint: MINT, wallet, isBuy, quote: 'SOL', quoteAmount: sol, coinAmount: coins, price };
}

function setup() {
  const store = new Store(':memory:');
  const signals: Signal[] = [];
  const engine = new Engine(store, prices, {
    storeTrades: 'curve',
    metadataMinBuyers: 1000,
    metadataSampleRate: 0,
    tractionBuyers: 5,
    onSignal: (s) => signals.push(s),
  });
  return { store, engine, signals };
}

test('launch, organic buying and a dev exit produce coin stats, signals and positions', () => {
  const { store, engine, signals } = setup();
  engine.handle(launch());
  engine.handle(trade(DEV, T0, true, 1, 30_000_000, 0.00000004));
  // Two launch-second snipers, then six organic buyers.
  engine.handle(trade('Sniper1', T0 + 1, true, 0.5, 15_000_000, 0.00000005));
  engine.handle(trade('Sniper2', T0 + 2, true, 0.5, 14_000_000, 0.00000006));
  for (let i = 0; i < 6; i++) engine.handle(trade(`Buyer${i}`, T0 + 20 + i, true, 0.2, 3_000_000, 0.00000007));
  engine.handle(trade('Sniper1', T0 + 40, false, 0.9, 15_000_000, 0.00000006));
  engine.handle(trade(DEV, T0 + 70, false, 1.6, 30_000_000, 0.00000005));
  engine.handle(trade('Buyer0', T0 + 400, true, 0.1, 1_000_000, 0.00000005)); // after the 1m and 5m checkpoints
  engine.flush();

  const coin = store.loadCoin(MINT)!;
  assert.equal(coin.unique_buyers, 9);
  assert.equal(coin.early_buyers, 3); // dev + 2 snipers, all within 3s of launch
  assert.equal(coin.dev_first_sell_ts, T0 + 70);
  assert.equal(coin.dev_sold_all_ts, T0 + 70);
  assert.ok(Math.abs(coin.peak_mcap_sol - 70) < 1e-6);
  const cps = JSON.parse(coin.checkpoints);
  assert.equal(cps['60'].buyers, 9);
  assert.equal(cps['300'].trades, 11);

  const kinds = signals.map((s) => s.kind);
  assert.ok(kinds.includes('traction'));
  assert.ok(kinds.includes('dev_sold_all'));

  const sniper = store.loadWallet('Sniper1')!;
  assert.equal(sniper.closed, 1);
  assert.equal(sniper.wins, 1);
  assert.ok(Math.abs(sniper.realized_sol - 0.4) < 1e-9);
  assert.equal(sniper.snipes, 1);

  const dev = store.loadWallet(DEV)!;
  assert.equal(dev.launches, 1);
  assert.ok(Math.abs(dev.realized_sol - 0.6) < 1e-9);

  const n = store.db.prepare('SELECT COUNT(*) n FROM trades').get() as { n: number };
  assert.equal(n.n, 12);
});

test('launch-second buys count neither as large buys nor as smart-money entries', () => {
  const { store, engine, signals } = setup();
  // An established whale: three large buys earlier, labelled on flush.
  const whale = 'Whale111111111111111111111111111111111111';
  for (let i = 0; i < 3; i++) {
    const mint = `Old${i}111111111111111111111111111111111pump`;
    engine.handle({ ...launch(), mint, ts: T0 - 1000 });
    engine.handle({ ...trade(whale, T0 - 900, true, 6, 1_000_000, 0.000001), mint });
  }
  engine.flush();
  assert.deepEqual(store.loadWallet(whale)!.archetypes, 'whale');

  engine.handle(launch());
  engine.handle(trade(whale, T0 + 1, true, 8, 1_000_000, 0.000001)); // launch second
  engine.handle(trade('Buyout', T0, true, 86, 793_000_000, 0.0000003)); // whole curve at launch
  engine.flush();
  assert.equal(signals.filter((s) => s.kind === 'smart_buy').length, 0);
  assert.equal(store.loadWallet(whale)!.large_buys, 3);
  assert.equal(store.loadWallet('Buyout')!.large_buys, 0);
  assert.equal(store.loadWallet('Buyout')!.archetypes, '');

  // The same whale entering another coin 20 s after launch is a smart-money entry.
  const mint = 'Late1111111111111111111111111111111111pump';
  engine.handle({ ...launch(), mint });
  engine.handle({ ...trade(whale, T0 + 20, true, 6, 1_000_000, 0.000001), mint });
  assert.equal(signals.filter((s) => s.kind === 'smart_buy').length, 1);
});

test('state survives eviction and reload', () => {
  const { store, engine } = setup();
  engine.handle(launch());
  engine.handle(trade('A', T0 + 10, true, 1, 10_000_000, 0.0000001));
  engine.flush();
  engine.sweep({ coinIdleMs: -1, walletIdleMs: -1, positionIdleMs: -1 });
  assert.equal(engine.positions.size, 0);
  engine.handle(trade('A', T0 + 100, false, 2, 10_000_000, 0.0000002));
  engine.flush();
  const w = store.loadWallet('A')!;
  assert.equal(w.closed, 1);
  assert.ok(Math.abs(w.realized_sol - 1) < 1e-9);
});

test('a bag abandoned on a dead coin is closed as a loss at its last value', () => {
  const { store, engine } = setup();
  engine.handle(launch());
  // Winner: bought and sold at a profit. Loser: bought and never sold; the coin then dies.
  engine.handle(trade('Trader', T0 + 10, true, 1, 10_000_000, 0.0000001));
  engine.handle(trade('Trader', T0 + 20, false, 2, 10_000_000, 0.0000002));
  const DEAD = 'Dead111111111111111111111111111111111111pump';
  engine.handle({ ...launch(), mint: DEAD });
  engine.handle({ ...trade('Trader', T0 + 30, true, 3, 30_000_000, 0.00000001), mint: DEAD });
  engine.flush();
  assert.equal(store.loadWallet('Trader')!.closed, 1);
  assert.equal(store.loadWallet('Trader')!.wins, 1);

  // Too soon: nothing is written off.
  assert.equal(engine.writeOffAbandoned(T0 + 600), 0);

  const later = T0 + 3 * 3600;
  assert.equal(engine.writeOffAbandoned(later), 1); // only the open bag; the closed winner is left alone
  const w = store.loadWallet('Trader')!;
  assert.equal(w.closed, 2);
  assert.equal(w.wins, 1);
  // 30M tokens at 1e-8 SOL are worth 0.3 SOL against a 3 SOL basis.
  assert.ok(Math.abs(w.realized_sol - (1 - 2.7)) < 1e-9);
  assert.equal(engine.writeOffAbandoned(later + 60), 0);
});
