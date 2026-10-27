import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAYBOOK, PLAYBOOKS, exitFor, matchesPlaybook } from '../src/playbook.ts';
import type { BacktestCoin } from '../src/sim/backtest.ts';
import { devBuyBand, launchTool, traitTable, xLinkKind, type LaunchTraits } from '../src/sim/traits.ts';

test('launch tools are told apart by where the metadata is hosted', () => {
  assert.equal(launchTool('https://ipfs.io/ipfs/bafkrei'), 'ipfs.io');
  assert.equal(launchTool('https://metadata.j7tracker.io/metadata/6'), 'j7tracker');
  assert.equal(launchTool('https://vdrp.public.blob.vercel-storage.com/tokens/x'), 'vercel-blob');
  assert.equal(launchTool('https://gateway.pinata.cloud/ipfs/x'), 'pinata');
  assert.equal(launchTool('https://example.com/x.json'), 'other');
  assert.equal(launchTool(null), 'other');
});

test('X links are classed by what they point to', () => {
  assert.equal(xLinkKind(false, 'https://x.com/a/status/1'), 'unknown');
  assert.equal(xLinkKind(true, null), 'none');
  assert.equal(xLinkKind(true, 'https://x.com/elonmusk/status/123'), 'tweet');
  assert.equal(xLinkKind(true, 'https://x.com/i/communities/456'), 'community');
  assert.equal(xLinkKind(true, 'https://x.com/somecoin'), 'profile');
  assert.equal(devBuyBand(0.5), '<1');
  assert.equal(devBuyBand(3.0375), '2.95-4.5');
  assert.equal(devBuyBand(5.06), '>=4.5');
});

const traits = (o: Partial<LaunchTraits>): LaunchTraits => ({
  tool: 'ipfs.io',
  devBuy: '2.95-4.5',
  xLink: 'tweet',
  website: 'yes',
  tickerWave: 'none',
  devHistory: 'first seen',
  hourUtc: '04',
  ...o,
});

test('the playbook requires its dev buy band and links, and its latest version is current', () => {
  assert.equal(PLAYBOOK, PLAYBOOKS.at(-1));
  assert.ok(PLAYBOOKS.every((p, i) => p.version === i && p.mayhem === false));
  assert.equal(matchesPlaybook(PLAYBOOK, traits({})), true);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ website: 'no' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ xLink: 'none' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ xLink: 'profile' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ devBuy: '1-2.95' })), false);
  assert.equal(matchesPlaybook(PLAYBOOKS[0]!, traits({ xLink: 'unknown', website: 'unknown' })), true);
});

test('a slow or unknown feed falls back to the timed exit', () => {
  assert.equal(exitFor(PLAYBOOK, 0.8), PLAYBOOK.exit);
  assert.equal(exitFor(PLAYBOOK, 5), PLAYBOOK.slowFeedExit);
  assert.equal(exitFor(PLAYBOOK, null), PLAYBOOK.slowFeedExit);
  assert.equal(PLAYBOOK.slowFeedExit.stall ?? null, null);
});

test('the trait table splits each value into earlier and later halves', () => {
  const coin = (mint: string, active: boolean): BacktestCoin =>
    ({ mint, active, createdTs: 0, trades: [], launchBuySol: 3, dev: 'd' }) as unknown as BacktestCoin;
  const coins = [coin('a', true), coin('b', false), coin('c', true), coin('d', true)];
  const t = new Map(coins.map((c, i) => [c.mint, traits({ website: i % 2 ? 'no' : 'yes' })]));
  const rows = traitTable(coins, [1, -0.1, 2, 0.5], t);
  const yes = rows.find((r) => r.trait === 'website' && r.value === 'yes')!;
  assert.equal(yes.launches, 2);
  assert.equal(yes.busyShare, 1);
  assert.equal(yes.meanPnl, 1.5);
  assert.equal(yes.firstHalf.launches, 1);
  assert.equal(yes.secondHalf.meanPnl, 2);
  const no = rows.find((r) => r.trait === 'website' && r.value === 'no')!;
  assert.equal(no.busyShare, 0.5);
});
