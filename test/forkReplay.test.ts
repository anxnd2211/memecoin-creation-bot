import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Curve } from '../src/chain/curve.ts';
import { PumpFork } from '../src/paper/fork.ts';
import { loadSnapshot, snapshotExists } from '../src/paper/snapshot.ts';
import { replayOnFork } from '../src/live/forkReplay.ts';
import type { FlowTrade } from '../src/sim/flow.ts';
import type { LiveTrade } from '../src/live/types.ts';

const DIR = fileURLToPath(new URL('../data/fork', import.meta.url));
const skip = snapshotExists(DIR) ? false : 'no pump.fun fork snapshot in data/fork: run "npm run paper-fork" once online';

const trade = (slot: number, wallet: number, isBuy: boolean, sol: number, tokens: number, o: Partial<FlowTrade> = {}): FlowTrade =>
  ({ ts: 0, slot, wallet, isBuy, sol, tokens, dev: false, reaction: false, ...o });

test('a recorded launch replays on the fork, with reaction sells held until we sell', { skip }, async () => {
  const fork = new PumpFork(loadSnapshot(DIR));
  const dev = fork.wallet(10);
  const launch = await fork.launch({ name: 'Replay', symbol: 'RPL', uri: 'https://ipfs.io/ipfs/x', devBuySol: 5.0625, dev });
  const mint = launch.mint;
  // On record: the dev bought, three wallets bought, wallet 6 sold half, the dev sold and wallet 5 dumped with it.
  const trades = [
    trade(100, 1, true, 5.0625, 150e6, { dev: true }),
    trade(101, 5, true, 2, 50e6),
    trade(102, 6, true, 1.5, 30e6),
    trade(104, 7, true, 3, 50e6),
    trade(110, 6, false, 0.7, 15e6),
    trade(120, 1, false, 6, 150e6, { dev: true }),
    trade(121, 5, false, 2.2, 50e6, { reaction: true }),
    trade(130, 8, true, 0.5, 8e6),
  ];
  const seen: LiveTrade[] = [];
  let sold = false;
  const stats = await replayOnFork(fork, mint, trades, {
    speed: 1000,
    launchChainTs: 1_800_000_000,
    onTrade: (t) => {
      seen.push(t);
      // We sell as soon as wallet 8's buy (the last) arrives, before the deferred dump.
      if (t.sol < 0.6 && t.isBuy) sold = true;
    },
    sold: () => sold,
    stop: () => false,
  });
  assert.equal(stats.failed, 0, stats.errors.join('; '));
  assert.equal(stats.replayed, 6);
  assert.deepEqual(seen.map((t) => t.isBuy), [true, true, true, false, true, false]);
  assert.ok(seen.every((t) => !t.dev));
  assert.equal(seen[0]!.chainTs, 1_800_000_000);
  // Wallet 6 sold half of what it held; wallet 5 sold everything after our sell.
  assert.ok(Math.abs(seen[3]!.tokens - seen[1]!.tokens / 2) / seen[1]!.tokens < 1e-6);
  assert.ok(Math.abs(seen[5]!.tokens - seen[0]!.tokens) / seen[0]!.tokens < 1e-6);
  // The fork's curve matches curve.ts for the same sequence (our bag still in, since the replay does not sell it).
  const c = new Curve();
  c.buy(5.0625);
  c.buy(2);
  c.buy(1.5);
  c.buy(3);
  c.sell(seen[3]!.tokens);
  c.buy(0.5);
  c.sell(seen[5]!.tokens);
  const vSol = Number(fork.curve(mint).virtualSol) / 1e9;
  assert.ok(Math.abs(vSol - c.vSol) < 1e-6, `${vSol} vs ${c.vSol}`);
});
