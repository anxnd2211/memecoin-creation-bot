import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Curve } from '../src/chain/curve.ts';
import { PLAYBOOK } from '../src/playbook.ts';
import { Store } from '../src/store/db.ts';
import { DEFAULT_LIMITS } from '../src/live/board.ts';
import { runLaunch, type LaunchDeps } from '../src/live/launcher.ts';
import type { CoinDraft, LaunchFill, LiveTrade, Notifier, PostInfo, Venue } from '../src/live/types.ts';

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
    makeExit: () => ({ onTrade: () => null, onTick: (now) => (++calls >= 2 ? { reason: 'stall', at: now, ageSec: 12 } : null), kill: () => {} }),
    approvalTimeoutSec: 1, tickMs: 1, settleSec: 0,
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
});
