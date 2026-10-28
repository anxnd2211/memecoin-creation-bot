import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Curve } from '../src/chain/curve.ts';
import { PLAYBOOK } from '../src/playbook.ts';
import { Store } from '../src/store/db.ts';
import { DEFAULT_LIMITS } from '../src/live/board.ts';
import { runLaunch, type LaunchDeps } from '../src/live/launcher.ts';
import type { CoinDraft, LaunchFill, LiveTrade, Notifier, PostInfo, Venue } from '../src/live/types.ts';
import { LaunchFailedError, NotLandedError } from '../src/live/venue.ts';

const NOW = 1_800_000_000;
const post: PostInfo = { url: 'https://x.com/news/status/1983000000000000000', handle: 'news', postId: '1983000000000000000', postedAt: NOW - 20, authorName: 'News', text: 'something happened' };
const draft: CoinDraft = {
  name: 'Something', symbol: 'SMTH', description: 'something happened, via @news', postUrl: post.url,
  website: 'https://www.bbc.com/news/x', image: { bytes: new Uint8Array([1]), mime: 'image/png', filename: 'a.png' },
};

/** A venue on curve.ts: launches and sells on one in-memory curve. */
function curveVenue(o: { preflightError?: string; sellFails?: boolean } = {}): Venue & { curve: Curve } {
  const curve = new Curve();
  let tokens = 0;
  return {
    mode: 'fork', dev: 'DEV', curve,
    balanceLamports: async () => 6_000_000_000n,
    preflightLaunch: async () => {
      if (o.preflightError) throw new Error(o.preflightError);
      return { computeUnits: 210_000, logs: [] };
    },
    launch: async (p) => {
      const r = curve.buy(p.devBuySol);
      tokens = r.tokens;
      return { mint: 'M', signature: 'S', slot: 1, landedAt: Date.now(), devTokens: BigInt(Math.round(r.tokens * 1e6)),
        lamportsSpent: BigInt(Math.round(r.sol * 1e9)), rentLamports: 9_000_000n, networkFeeLamports: 15_000n, simulated: true } satisfies LaunchFill;
    },
    quoteSell: async () => BigInt(Math.round(curve.sellValue(tokens) * 1e9)),
    tokenBalance: async () => BigInt(Math.round(tokens * 1e6)),
    sellAll: async () => {
      if (o.sellFails) throw new Error('slippage exceeded on every attempt');
      const r = curve.sell(tokens);
      tokens = 0;
      return { signature: 'T', landedAt: Date.now(), tokensSold: 1n, lamportsReceived: BigInt(Math.round(r.sol * 1e9)), networkFeeLamports: 5_000n, attempts: 1, simulated: true };
    },
    creatorVaultLamports: async () => 0n,
  };
}

const paused: string[] = [];

function setup(o: { approve?: boolean; preflightError?: string; sellFails?: boolean; postLaunch?: boolean } = {}) {
  const store = new Store(':memory:');
  const db = store.db;
  db.prepare('INSERT INTO trades (ts, slot, mint_id, wallet_id, is_buy, venue, sol, coins) VALUES (?, 1, 1, 1, 1, 0, 1, 1)').run(NOW - 1);
  const messages: string[] = [];
  const notifier: Notifier = {
    send: async (t) => void messages.push(t),
    askApproval: async () => ({ approved: o.approve ?? true, by: 'owner', at: Date.now() }),
  };
  const venue = curveVenue(o);
  let calls = 0;
  const deps: LaunchDeps = {
    venue, notifier, db, playbook: PLAYBOOK, limits: DEFAULT_LIMITS,
    now: () => NOW, killed: () => false, feedLag: () => 0.8,
    checkCompliance: () => [],
    uploadMetadata: async () => 'https://ipfs.io/ipfs/placeholder',
    watch: (_mint, _landing, onTrade) => {
      // Three outside buys arrive, then quiet.
      const trades: LiveTrade[] = [2, 1.5, 3].map((sol, i) => ({ slot: 2 + i, chainTs: NOW, receivedAt: Date.now() + 3000, wallet: `W${i}`, isBuy: true, sol, tokens: 1, dev: false }));
      for (const t of trades) {
        venue.curve.buy(t.sol);
        onTrade(t);
      }
      return () => {};
    },
    // A stand-in exit: sell on the second clock tick.
    makeExit: () => ({ onTrade: () => null, onTick: (now) => (++calls >= 2 ? { reason: 'stall', at: now, ageSec: 12 } : null), kill: (now) => ({ reason: 'kill', at: now, ageSec: 0 }) }),
    approvalTimeoutSec: 1, tickMs: 1, settleSec: 0, retryDelayMs: 1,
    pause: (reason) => void paused.push(reason),
  };
  if (o.postLaunch) {
    db.prepare("INSERT INTO coins (mint, symbol, quote, created_ts, meta_status, twitter, total_supply, updated_at) VALUES ('X', 'OTHER', 'SOL', ?, 'done', ?, 1e9, 0)").run(NOW - 10, post.url);
  }
  return { deps, db, messages, venue };
}

test('a launch that passes runs to the sell and records its result', async () => {
  const { deps, db, messages } = setup();
  const r = await runLaunch(deps, post, draft, 'something happened');
  assert.equal(r.status, 'launched');
  const row = db.prepare('SELECT * FROM our_launches').get() as Record<string, number | string>;
  assert.equal(row.mode, 'fork');
  assert.equal(row.playbook, PLAYBOOK.version);
  assert.equal(row.drew, 0);
  assert.equal(row.first_sell_sec, 12);
  // 6.5 SOL of outside buying into a 5 SOL bag: the result is positive and matches curve.ts.
  assert.ok((row.pnl_sol as number) > 1, String(row.pnl_sol));
  assert.ok(messages.some((m) => m.startsWith('Launched $SMTH')));
});

test('the board, the simulation and the owner each stop a launch before any SOL moves', async () => {
  const taken = await runLaunch(setup({ postLaunch: true }).deps, post, draft, 'x');
  assert.deepEqual([taken.status, taken.status === 'blocked' && taken.stage], ['blocked', 'board']);
  const sim = await runLaunch(setup({ preflightError: 'custom program error: 0x1772' }).deps, post, draft, 'x');
  assert.deepEqual([sim.status, sim.status === 'blocked' && sim.stage], ['blocked', 'preflight']);
  const s = setup({ approve: false });
  const no = await runLaunch(s.deps, post, draft, 'x');
  assert.deepEqual([no.status, no.status === 'blocked' && no.stage], ['blocked', 'approval']);
  assert.equal(s.venue.curve.vSol, 30);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM our_launches').get()!.n, 0);
});

test('a sell that fails every attempt alerts the owner and is recorded', async () => {
  const { deps, db, messages } = setup({ sellFails: true });
  const r = await runLaunch(deps, post, draft, 'x');
  assert.equal(r.status, 'launched');
  assert.ok(messages.some((m) => m.includes('FAILED') && m.includes('by hand')));
  const row = db.prepare('SELECT notes FROM our_launches').get() as { notes: string };
  assert.ok(row.notes.startsWith('SELL FAILED'));
  assert.ok(paused.length >= 1, 'launching is paused after a failed sell');
});

test('a launch whose outcome is unknown pauses launching, finds the bag and sells it', async () => {
  const s = setup();
  const launch = s.venue.launch.bind(s.venue);
  s.venue.launch = async (prm) => {
    await launch(prm); // it landed...
    throw new NotLandedError('RPC unreachable for 90 s', 'sig', true); // ...but the venue could not tell
  };
  const r = await runLaunch(s.deps, post, draft, 'x');
  assert.equal(r.status === 'launched' && r.exit?.reason, 'recovery');
  assert.ok(paused.some((p) => p.includes('uncertain')));
  assert.equal(s.venue.curve.vSol < 30.001 + 6.5, true);
  const row = s.db.prepare('SELECT notes FROM our_launches').get() as { notes: string };
  assert.ok(row.notes.includes('recovery'), row.notes);
});

test('a launch that certainly did not land, or landed and failed, stops without pausing', async () => {
  for (const err of [new NotLandedError('blockhash expired', 'sig', false), new LaunchFailedError('custom program error', 'sig')]) {
    const s = setup();
    paused.length = 0;
    s.venue.launch = async () => {
      throw err;
    };
    const r = await runLaunch(s.deps, post, draft, 'x');
    assert.deepEqual([r.status, r.status === 'failed' && r.stage], ['failed', 'launch']);
    assert.equal(paused.length, 0);
  }
});

test('the bag is sold before the curve completes', async () => {
  const { deps, db } = setup();
  // Heavy buying: about 75 SOL in, which takes the curve near completion before the stand-in exit would sell.
  deps.watch = (_mint, _landing, onTrade) => {
    for (let i = 0; i < 15; i++) onTrade({ slot: 2 + i, chainTs: NOW, receivedAt: Date.now() + 3000, wallet: `W${i}`, isBuy: true, sol: 5, tokens: 1, dev: false });
    return () => {};
  };
  deps.makeExit = () => ({ onTrade: () => null, onTick: () => null, kill: (now) => ({ reason: 'kill', at: now, ageSec: 0 }) });
  const r = await runLaunch(deps, post, draft, 'x');
  assert.equal(r.status === 'launched' && r.exit?.reason, 'near graduation');
  const row = db.prepare('SELECT notes FROM our_launches').get() as { notes: string };
  assert.ok(row.notes.includes('near graduation'));
});

test('a failed metadata upload stops the launch after approval, before any SOL moves', async () => {
  const s = setup();
  s.deps.uploadMetadata = async () => {
    throw new Error('gateway did not serve it in time');
  };
  const r = await runLaunch(s.deps, post, draft, 'x');
  assert.deepEqual([r.status, r.status === 'blocked' && r.stage], ['blocked', 'metadata']);
  assert.equal(s.venue.curve.vSol, 30);
});

test('a ground "pump" address is used for the launch and only taken once the launch is going ahead', async () => {
  const { Keypair } = await import('@solana/web3.js');
  const ground = Keypair.generate();
  let taken = 0;
  const ok = setup();
  ok.deps.nextMint = () => (taken++, ground.secretKey);
  await runLaunch(ok.deps, post, draft, 'x');
  const row = ok.db.prepare('SELECT mint FROM our_launches').get() as { mint: string };
  assert.equal(row.mint, ground.publicKey.toBase58());
  const no = setup({ approve: false });
  no.deps.nextMint = () => (taken++, ground.secretKey);
  await runLaunch(no.deps, post, draft, 'x');
  assert.equal(taken, 1);
});
