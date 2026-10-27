import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAYBOOK, PLAYBOOKS, exitFor, matchesPlaybook } from '../src/playbook.ts';
import type { BacktestCoin } from '../src/sim/backtest.ts';
import { devBuyBand, launchTool, postAgeBucket, traitTable, websiteKind, xLinkKind, type LaunchTraits } from '../src/sim/traits.ts';
import { tweetTs, xHandle } from '../src/intel/xlinks.ts';

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
  assert.equal(devBuyBand(3), '2.95-3.05');
  assert.equal(devBuyBand(3.0375), '2.95-3.05');
  assert.equal(devBuyBand(5.0625), '4.9-5.1');
  assert.equal(devBuyBand(10), '>=5.1');
  assert.equal(postAgeBucket(null), 'no post');
  assert.equal(postAgeBucket(0), '<=30s');
  assert.equal(postAgeBucket(120), '30s-2m');
  assert.equal(postAgeBucket(4000), '>15m');
  assert.equal(websiteKind('https://www.nypost.com/x'), 'yes');
  assert.equal(websiteKind('https://otcdesks.cash/r/abc'), 'promo');
  assert.equal(websiteKind('axiom.trade'), 'promo');
  assert.equal(websiteKind(''), 'no');
  assert.equal(websiteKind('not a link'), 'no');
});

const traits = (o: Partial<LaunchTraits>): LaunchTraits => ({
  tool: 'ipfs.io',
  devBuy: '4.9-5.1',
  xLink: 'tweet',
  website: 'yes',
  tickerWave: 'none',
  postAge: '<=30s',
  postOrder: 'first',
  sourceHeat: '0-2',
  devGap: '10m+',
  devHistory: 'first seen',
  hourUtc: '04',
  ...o,
});

test('the playbook requires its dev buy band and links, and its latest version is current', () => {
  assert.equal(PLAYBOOK, PLAYBOOKS.at(-1));
  assert.ok(PLAYBOOKS.every((p, i) => p.version === i && p.mayhem === false));
  assert.equal(matchesPlaybook(PLAYBOOK, traits({})), true);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ postAge: '30s-2m', devGap: 'first seen' })), true);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ website: 'no' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ website: 'promo' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ sourceHeat: '3+' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ devGap: 'under 10m' })), false);
  assert.equal(matchesPlaybook(PLAYBOOKS[2]!, traits({ website: 'no', sourceHeat: '3+', devGap: 'under 10m' })), true);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ postAge: '2-15m' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ postAge: 'unknown' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ postOrder: 'later' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ xLink: 'none', postAge: 'no post', postOrder: 'no post' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ xLink: 'profile' })), false);
  assert.equal(matchesPlaybook(PLAYBOOK, traits({ devBuy: '2.95-3.05' })), false);
  assert.equal(matchesPlaybook(PLAYBOOKS[1]!, traits({ devBuy: '2.95-3.05', postAge: '>15m', postOrder: 'later' })), true);
  assert.equal(matchesPlaybook(PLAYBOOKS[1]!, traits({ devBuy: '2.95-3.05', website: 'no' })), false);
  assert.equal(matchesPlaybook(PLAYBOOKS[0]!, traits({ devBuy: '3.05-4.9', xLink: 'unknown', website: 'unknown' })), true);
});

test('X links give the account and, for a post, when it was made', () => {
  assert.equal(xHandle('https://x.com/ElonMusk/status/1983000000000000000'), 'elonmusk');
  assert.equal(xHandle('https://twitter.com/i/communities/456'), null);
  assert.equal(xHandle('https://example.com/x'), null);
  // 1983000000000000000 >> 22 = 472784042358 ms after the X epoch (2010-11-04T01:42:54.657Z).
  assert.equal(tweetTs('https://x.com/a/status/1983000000000000000'), Math.floor((472784042358 + 1288834974657) / 1000));
  assert.equal(tweetTs('https://x.com/a'), null);
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
