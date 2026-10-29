import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followLaunch, triggerFlow, watchTrigger, type FollowerOptions } from '../src/live/follower.ts';
import { SLOT_SEC } from '../src/sim/simulate.ts';
import type { LiveLaunch } from '../src/live/stream.ts';

const NOW = Math.floor((472784042358 + 1288834974657) / 1000) + 20; // 20 s after the post in the snowflake below
const POST = 'https://x.com/news/status/1983000000000000000';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const launch = (o: Partial<LiveLaunch> = {}): LiveLaunch => ({
  mint: 'TRIG', sig: 's', slot: 1, chainTs: NOW - 2, receivedAt: NOW * 1000, name: 'Trigger', symbol: 'TRIG',
  uri: 'https://ipfs.io/ipfs/meta', creator: 'c', signer: 'c', quote: 'SOL', price: 30 / 1.073e9,
  isMayhem: false, devBuySol: 2.025, devTokens: 1, ...o,
});

function fake(meta: Record<string, unknown> | null, image = true): FollowerOptions {
  const fetchImpl = (async (url: string) => {
    if (url.includes('/ipfs/meta')) return meta ? new Response(JSON.stringify(meta)) : new Response('no', { status: 429 });
    if (url.includes('/ipfs/img')) return image ? new Response(PNG) : new Response('x', { status: 404 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { gateways: ['https://ipfs.io/ipfs/'], fetchImpl, now: () => NOW };
}

test('a first launch on a fresh post becomes a candidate with the post and its image', async () => {
  const { candidate, reason } = await followLaunch(launch(), fake({ twitter: POST, image: 'https://ipfs.io/ipfs/img' }));
  assert.equal(reason, 'followable');
  assert.equal(candidate!.post.url, POST);
  assert.equal(candidate!.post.handle, 'news');
  assert.deepEqual(candidate!.image!.mime, 'image/png');
  assert.equal(candidate!.trigger.mint, 'TRIG');
});

test('mayhem, dust buys, old posts, profile links and unreadable metadata are not followed', async () => {
  const cases: [LiveLaunch, FollowerOptions, string][] = [
    [launch({ isMayhem: true }), fake({ twitter: POST }), 'mayhem or not SOL'],
    [launch({ devBuySol: 0.05 }), fake({ twitter: POST }), 'trigger dev buy too small'],
    [launch(), fake({ twitter: 'https://x.com/news' }), 'no post link in the metadata'],
    [launch(), fake(null), 'metadata unreadable'],
    [launch(), { ...fake({ twitter: POST }), now: () => NOW + 300 }, 'post is 320 s old'],
  ];
  for (const [l, o, want] of cases) {
    const { candidate, reason } = await followLaunch(l, o);
    assert.equal(candidate, null, want);
    assert.equal(reason, want);
  }
});

test('a post image that cannot be read still yields the candidate, with image null', async () => {
  const { candidate } = await followLaunch(launch(), fake({ twitter: POST, image: 'https://ipfs.io/ipfs/img' }, false));
  assert.ok(candidate);
  assert.equal(candidate!.image, null);
});

test('trigger flow counts other wallets\' buys after the create slot and within the window only', () => {
  const at = (slot: number, sol: number, o: { dev?: boolean; isBuy?: boolean } = {}) => ({ slot, sol, dev: o.dev ?? false, isBuy: o.isBuy ?? true });
  const inWindow = 1 + Math.floor(3 / SLOT_SEC);
  const trades = [
    at(1, 5), // the create slot: a bundle lands here, left out
    at(1, 2, { dev: true }),
    at(2, 0.6),
    at(inWindow, 0.5),
    at(inWindow + 1, 9), // after 3 s
    at(3, 0.4, { dev: true }), // the trigger's dev
    at(3, 0.7, { isBuy: false }), // a sell
  ];
  assert.equal(triggerFlow(trades, 1), 1.1);
});

test('the trigger watch subscribes to the launch, collects its trades, and unsubscribes when the window closes', async () => {
  let handler: ((t: never) => void) | null = null;
  let subscribed: { mint: string; dev: string | readonly string[] } | null = null;
  let unsubscribed = false;
  const feed = {
    subscribe: (mint: string, dev: string | readonly string[], h: (t: never) => void) => {
      subscribed = { mint, dev };
      handler = h;
      return () => void (unsubscribed = true);
    },
  };
  let fire: (() => void) | null = null;
  let waitMs = 0;
  const done = watchTrigger(feed, launch({ slot: 1, creator: 'c', signer: 's' }), {
    setTimer: (fn, ms) => {
      fire = fn;
      waitMs = ms;
    },
  });
  assert.deepEqual(subscribed, { mint: 'TRIG', dev: ['c', 's'] });
  const t = (slot: number, sol: number) => ({ slot, sol, isBuy: true, dev: false }) as never;
  handler!(t(1, 3));
  handler!(t(2, 0.8));
  handler!(t(4, 0.4));
  assert.equal(waitMs, 4500);
  fire!();
  assert.equal(Math.round((await done) * 100) / 100, 1.2);
  assert.equal(unsubscribed, true);
});
