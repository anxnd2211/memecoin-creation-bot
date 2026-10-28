import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followLaunch, type FollowerOptions } from '../src/live/follower.ts';
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
