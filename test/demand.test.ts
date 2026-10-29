import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundledSol, copiedMints, createSlotReach, fakeDemand, type DemandCoin } from '../src/sim/demand.ts';

const buy = (slot: number, wallet: number, sol: number, dev = false) => ({ slot, wallet, isBuy: true, sol, dev });

// Wallet 100 buys five different devs' create slots: an independent sniper bot. Wallet 7 only ever buys dev A's.
const coins: DemandCoin[] = [
  { mint: 'A1', dev: 'A', trades: [buy(10, 1, 2, true), buy(10, 7, 1.5), buy(10, 100, 0.8), buy(11, 200, 0.4)] },
  { mint: 'A2', dev: 'A', trades: [buy(20, 1, 2, true), buy(20, 7, 1.2), buy(22, 300, 0.3)] },
  ...['B', 'C', 'D', 'E'].map((dev, i) => ({ mint: `${dev}1`, dev, trades: [buy(30 + i, 2 + i, 2, true), buy(30 + i, 100, 0.5)] })),
];

test('create-slot buyers reaching many devs are bots; one-dev create-slot buyers are the dev’s bundle', () => {
  const reach = createSlotReach(coins);
  assert.equal(reach.get(100)?.size, 5);
  assert.equal(reach.get(7)?.size, 1);
  assert.equal(reach.has(200), false, 'a buy after the create slot is not a create-slot buy');
  assert.equal(bundledSol(coins[0]!, reach), 1.5, 'only wallet 7 counts; the bot and the later buy do not');
  assert.equal(bundledSol(coins[2]!, reach), 0, 'a launch only the bot bought in its create slot is not bundled');
});

test('copy launches share a metadata URI; fake demand is a copy or a bundle', () => {
  const copied = copiedMints([['A1', 'u1'], ['X1', 'u1'], ['B1', 'u2'], ['C1', null]]);
  assert.deepEqual([...copied].sort(), ['A1', 'X1']);
  const reach = createSlotReach(coins);
  assert.equal(fakeDemand(coins[1]!, reach, new Set()), true, 'A2 carries 1.2 SOL of its own bundle');
  assert.equal(fakeDemand(coins[2]!, reach, new Set()), false);
  assert.equal(fakeDemand(coins[2]!, reach, new Set(['B1'])), true, 'a copy launch is fake whatever its buyers');
});
