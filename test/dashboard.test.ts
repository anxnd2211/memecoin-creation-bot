import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSnapshot, type Extras } from '../src/dashboard/snapshot.ts';
import { startDashboard } from '../src/dashboard/server.ts';
import { Store } from '../src/store/db.ts';

const NOW = 1_800_000_000;

function seeded(): Store {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'dash-')), 'observer.db'));
  const day = NOW - (NOW % 86400);
  store.db
    .prepare(
      `INSERT INTO coins (mint, symbol, name, quote, creator, created_ts, create_sig, total_supply, twitter, is_mayhem, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1e9, ?, ?, ?)`,
    )
    .run('MintA', 'AAA', 'Coin A', 'SOL', 'devX', NOW - 30, 'sigA', 'https://x.com/a/status/19830', 0, NOW);
  store.db
    .prepare(
      `INSERT INTO coins (mint, symbol, name, quote, created_ts, total_supply, is_mayhem, updated_at)
       VALUES (?, ?, ?, ?, ?, 1e9, 1, ?)`,
    )
    .run('MintB', 'BBB', 'Coin B', 'SOL', NOW - 4000, NOW);
  store.db.prepare('INSERT INTO ids (address) VALUES (?), (?), (?)').run('MintA', 'walletX', 'devX');
  // The dev's launch-slot buy (slot 1), then an outside buy later: the feed's dev buy must read 2.0, not 2.5.
  store.db.prepare('INSERT INTO trades (ts, slot, mint_id, wallet_id, is_buy, venue, sol, coins) VALUES (?, 1, 1, 3, 1, 0, 2.0, 100)').run(NOW - 30);
  store.db.prepare('INSERT INTO trades (ts, slot, mint_id, wallet_id, is_buy, venue, sol, coins) VALUES (?, 9, 1, 2, 1, 0, 0.5, 100)').run(NOW - 2);
  store.db
    .prepare(
      `INSERT INTO our_launches (mint, mode, created_ts, playbook, dev_buy_sol, exit_plan, source_post, pnl_sol, drew)
       VALUES (?, 'live', ?, 3, 2.025, 'flow', 'https://x.com/a/status/19830', ?, ?)`,
    )
    .run('MintA', day + 100, 1.2, 1);
  store.db
    .prepare(
      `INSERT INTO our_launches (mint, mode, created_ts, playbook, dev_buy_sol, exit_plan, pnl_sol, drew)
       VALUES (?, 'live', ?, 3, 2.025, 'flow', NULL, NULL)`,
    )
    .run('MintInFlight', NOW - 20);
  store.db.prepare(`INSERT INTO signals (ts, kind, mint, detail) VALUES (?, 'smart_buy', 'MintA', '{"symbol":"AAA","sol":1.5}')`).run(NOW - 5);
  return store;
}

const extras: Extras = {
  wallets: [{ label: 'launch', address: 'Addr111', balanceSol: 2.5 }],
  balancesTs: NOW,
  killed: false,
  launcherPid: 4242,
  mintPool: 20,
  watcher: 'ready',
  limits: { maxLaunchesPerDay: 10, maxDailyLossSol: 1.5, pauseAfterDeadInARow: 3 },
  minGapSec: 600,
  now: NOW,
};

test('the snapshot reads launches, the feed, signals and today the way the board does', () => {
  const store = seeded();
  const s = buildSnapshot(store.db, extras);
  assert.equal(s.observer.lastTradeTs, NOW - 2);
  assert.equal(s.observer.launches5m, 1);
  assert.equal(s.observer.trades1m, 2);
  assert.equal(s.feed.find((f) => f.mint === 'MintA')?.devBuySol, 2.0);
  assert.equal(s.today?.launches, 2);
  assert.equal(s.today?.pnlSol, 1.2);
  assert.equal(s.today?.deadInARow, 0);
  assert.equal(s.launches.length, 2);
  const flight = s.launches[0]!;
  assert.equal(flight.mint, 'MintInFlight');
  assert.equal(flight.pnlSol, null);
  const done = s.launches[1]!;
  assert.equal(done.symbol, 'AAA');
  assert.equal(done.createSig, 'sigA');
  assert.equal(done.pnlSol, 1.2);
  const feedA = s.feed.find((f) => f.mint === 'MintA')!;
  assert.equal(feedA.followable, true);
  const feedB = s.feed.find((f) => f.mint === 'MintB')!;
  assert.equal(feedB.followable, false);
  assert.equal(s.signals[0]?.headline, '1.50 SOL');
  assert.equal(s.launcher.running, true);
  assert.equal(s.minGapSec, 600);
  store.db.close();
});

test('a database the dashboard cannot read degrades to nulls, not a crash', () => {
  const store = seeded();
  store.db.exec('DROP TABLE signals');
  const s = buildSnapshot(store.db, extras);
  assert.deepEqual(s.signals, []);
  assert.equal(s.observer.launches5m, 1);
  store.db.close();
});

test('the server serves the page, the snapshot and one live event', async () => {
  const page = readFileSync(new URL('../src/dashboard/page.html', import.meta.url), 'utf8');
  const { server, port } = await startDashboard({ snapshot: () => ({ ok: 1 }), page, intervalMs: 50 }, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('Launch Desk'));
  const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as { ok: number };
  assert.equal(snap.ok, 1);
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes('retry:'));
  let data = first;
  while (!data.includes('data:')) data += new TextDecoder().decode((await reader.read()).value);
  assert.ok(data.includes('{"ok":1}'));
  await reader.cancel();
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  server.close();
});
