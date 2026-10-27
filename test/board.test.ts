import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PLAYBOOK } from '../src/playbook.ts';
import { DEFAULT_LIMITS, boardState, launchBoard, type BoardInput, type BoardState } from '../src/live/board.ts';
import type { CoinDraft, PostInfo } from '../src/live/types.ts';

const NOW = 1_800_000_000;
const post: PostInfo = { url: 'https://x.com/someone/status/1983000000000000000', handle: 'someone', postId: '1983000000000000000', postedAt: NOW - 20, authorName: 'Someone', text: 'a thing happened' };
const draft: CoinDraft = {
  name: 'Thing Happened',
  symbol: 'THING',
  description: 'a thing happened, via @someone',
  postUrl: post.url,
  website: 'https://www.nypost.com/2026/10/27/thing',
  image: { bytes: new Uint8Array([1]), mime: 'image/png', filename: 'a.png' },
};
const state: BoardState = {
  now: NOW,
  observerLastTradeTs: NOW - 1,
  postLaunches: 0,
  pendingLaunches: 0,
  accountLaunchesLastHour: 0,
  tickerLaunchesLast10m: 0,
  ours: { lastLaunchTs: null, launchesToday: 0, pnlTodaySol: 0, deadInARow: 0 },
  balanceLamports: 6_000_000_000n,
  killed: false,
};
const input = (o: Partial<BoardInput> = {}, s: Partial<BoardState> = {}): BoardInput => ({
  playbook: PLAYBOOK,
  limits: DEFAULT_LIMITS,
  post,
  draft,
  state: { ...state, ...s },
  compliance: [],
  preflight: 'ok',
  approved: true,
  ...o,
});
const failed = (i: BoardInput) => launchBoard(i).gates.filter((g) => !g.pass).map((g) => g.name);

test('a launch that meets every rule passes, and each rule blocks on its own', () => {
  assert.deepEqual(failed(input()), []);
  assert.deepEqual(failed(input({}, { killed: true })), ['kill switch off']);
  assert.deepEqual(failed(input({}, { now: NOW + 200, observerLastTradeTs: NOW + 199 })), ['post fresh']);
  assert.deepEqual(failed(input({}, { postLaunches: 1 })), ['first on the post']);
  assert.deepEqual(failed(input({}, { pendingLaunches: 2 })), ['first on the post']);
  assert.deepEqual(failed(input({}, { accountLaunchesLastHour: 3 })), ['account not farmed']);
  assert.deepEqual(failed(input({}, { tickerLaunchesLast10m: 3 })), ['ticker not crowded']);
  assert.deepEqual(failed(input({ draft: { ...draft, website: 'https://otcdesks.cash/r/1' } })), ['website is the source']);
  assert.deepEqual(failed(input({ compliance: ['says official'] })), ['compliance']);
  assert.deepEqual(failed(input({}, { ours: { lastLaunchTs: NOW - 300, launchesToday: 1, pnlTodaySol: 0, deadInARow: 0 } })), ['spacing']);
  assert.deepEqual(failed(input({}, { ours: { lastLaunchTs: null, launchesToday: 10, pnlTodaySol: 0, deadInARow: 0 } })), ['daily launches']);
  assert.deepEqual(failed(input({}, { ours: { lastLaunchTs: null, launchesToday: 2, pnlTodaySol: -1.6, deadInARow: 0 } })), ['daily loss']);
  assert.deepEqual(failed(input({}, { ours: { lastLaunchTs: null, launchesToday: 3, pnlTodaySol: -0.3, deadInARow: 3 } })), ['dead streak']);
  assert.deepEqual(failed(input({}, { balanceLamports: 5_000_000_000n })), ['wallet balance']);
  assert.deepEqual(failed(input({ preflight: 'custom program error: 0x1772' })), ['preflight simulation']);
  assert.deepEqual(failed(input({ approved: false })), ['owner approval']);
});

test('anything the board cannot find out blocks the launch', () => {
  const unknown = failed(input({ preflight: null, approved: null }, {
    observerLastTradeTs: null, postLaunches: null, pendingLaunches: null, accountLaunchesLastHour: null,
    tickerLaunchesLast10m: null, ours: null, balanceLamports: null,
  }));
  for (const g of ['observer current', 'first on the post', 'account not farmed', 'ticker not crowded', 'spacing',
    'daily launches', 'daily loss', 'dead streak', 'wallet balance', 'preflight simulation', 'owner approval']) {
    assert.ok(unknown.includes(g), g);
  }
  assert.deepEqual(failed(input({}, { observerLastTradeTs: NOW - 60 })), ['observer current']);
  assert.equal(launchBoard(input({ preflight: null, approved: null }), 'before preflight').pass, true);
});

test('the board reads the observer database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE coins (mint TEXT, symbol TEXT, quote TEXT, created_ts INTEGER, meta_status TEXT, twitter TEXT);
           CREATE TABLE trades (ts INTEGER);
           CREATE TABLE our_launches (mint TEXT, mode TEXT, created_ts INTEGER, pnl_sol REAL, drew INTEGER);`);
  const coin = db.prepare('INSERT INTO coins VALUES (?, ?, ?, ?, ?, ?)');
  coin.run('a', 'THING', 'SOL', NOW - 100, 'done', `https://x.com/someone/status/${post.postId}`);
  coin.run('b', 'thing!', 'SOL', NOW - 50, 'done', 'https://x.com/someone/status/1');
  coin.run('c', 'OTHER', 'SOL', NOW - 5, 'none', null);
  coin.run('d', 'OTHER', 'SOL', NOW - 4000, 'done', 'https://x.com/someone/status/2');
  db.prepare('INSERT INTO trades VALUES (?)').run(NOW - 2);
  const ours = db.prepare('INSERT INTO our_launches VALUES (?, ?, ?, ?, ?)');
  ours.run('x', 'live', NOW - 7200, 1.5, 1);
  ours.run('y', 'live', NOW - 3000, -0.1, 0);
  ours.run('z', 'paper', NOW - 100, -0.1, 0);
  const s = boardState(db, post, 'THING', NOW, { balanceLamports: 1n, killed: false });
  assert.equal(s.observerLastTradeTs, NOW - 2);
  assert.equal(s.postLaunches, 1);
  assert.equal(s.pendingLaunches, 1);
  assert.equal(s.accountLaunchesLastHour, 2);
  assert.equal(s.tickerLaunchesLast10m, 2);
  assert.equal(s.ours!.lastLaunchTs, NOW - 3000);
  assert.equal(s.ours!.deadInARow, 1);
});
