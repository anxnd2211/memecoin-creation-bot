import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CURVE_FEE_RATE, CURVE_REAL_TOKENS, Curve, PROTOCOL_FEE_RATE, maxDevBuyLoss } from '../src/chain/curve.ts';
import { config } from '../src/config.ts';
import { ForkTxError, PumpFork, type TradeResult } from '../src/paper/fork.ts';
import { replayOnFork, type ReplayFixture } from '../src/paper/replay.ts';
import { loadOrFetchSnapshot, snapshotExists, type Snapshot } from '../src/paper/snapshot.ts';

/**
 * src/chain/curve.ts against pump.fun's real program, run on the local fork (src/paper/fork.ts). Needs the cached
 * mainnet snapshot in data/fork/, or network access to fetch it once; skipped otherwise.
 */

const DIR = fileURLToPath(new URL('../data/fork', import.meta.url));
const L = 1e9;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok || res.status === 429;
  } catch {
    return false;
  }
}

let snapshot: Snapshot | null = null;
let skip: string | false = false;
if (!snapshotExists(DIR) && !(await reachable(config.rpcHttp))) {
  skip = 'no pump.fun fork snapshot in data/fork and no network to fetch one: run "npm run paper-fork" once online';
} else {
  try {
    snapshot = await loadOrFetchSnapshot(DIR, config.rpcHttp);
  } catch (err) {
    skip = `could not fetch the pump.fun fork snapshot: ${(err as Error).message}`;
  }
}
const fork = () => new PumpFork(snapshot!);

/** Deterministic random numbers (mulberry32), so a failing sequence can be re-run. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The accounting every fork trade must satisfy, whatever curve.ts says. */
function assertBalanced(r: TradeResult): void {
  assert.equal(r.unexplained, 0n, 'every lamport the trader paid or received is explained');
  assert.equal(r.received.feeRecipient + r.received.buybackRecipient, r.protocolFee, 'protocol fee = fee recipient + buyback wallet');
  assert.equal(r.received.buybackRecipient, r.buybackFee);
  assert.equal(r.received.creatorVault, r.creatorFee, 'the creator fee lands in the creator vault');
}

const MEASURE = process.env.FORK_TEST_MEASURE === '1';
const worst = { buyTokensLamports: 0, sellLamports: 0, feeLamports: 0, driftLamports: 0 };

/**
 * Feeds one fork trade to curve.ts (free-running from launch, as the backtest uses it) and compares the results.
 * Worst seen over these sequences: tokens 1.6 lamports' worth, sell proceeds 5.8 lamports, fees 1 lamport, reserves
 * 15 lamports after 41 trades (the program rounds every amount to whole units; curve.ts does not round).
 */
function compare(curve: Curve, r: TradeResult, trades: number): void {
  const price = curve.price;
  if (r.side === 'buy') {
    const paid = r.curveSol + r.protocolFee + r.creatorFee;
    const p = curve.buy(Number(paid) / L);
    // A token difference valued at the curve's price, in lamports.
    const tokensOff = Math.abs((p.tokens * 1e6 - Number(r.tokenDelta)) / 1e6) * price * L;
    const net = p.sol / (1 + CURVE_FEE_RATE);
    const feeOff = Math.max(Math.abs(p.creatorFee * L - Number(r.creatorFee)), Math.abs(net * PROTOCOL_FEE_RATE * L - Number(r.protocolFee)));
    worst.buyTokensLamports = Math.max(worst.buyTokensLamports, tokensOff);
    worst.feeLamports = Math.max(worst.feeLamports, feeOff);
    if (!MEASURE) {
      assert.ok(tokensOff <= 4, `buy of ${Number(paid) / L} SOL: tokens off by ${tokensOff.toFixed(2)} lamports' worth`);
      assert.ok(feeOff <= 1.5, `buy fees off by ${feeOff.toFixed(2)} lamports`);
    }
  } else {
    const p = curve.sell(Number(-r.tokenDelta) / 1e6);
    const got = Number(r.curveSol - r.protocolFee - r.creatorFee);
    const gross = p.sol / (1 - CURVE_FEE_RATE);
    const solOff = Math.abs(p.sol * L - got);
    const feeOff = Math.max(Math.abs(p.creatorFee * L - Number(r.creatorFee)), Math.abs(gross * PROTOCOL_FEE_RATE * L - Number(r.protocolFee)));
    worst.sellLamports = Math.max(worst.sellLamports, solOff);
    worst.feeLamports = Math.max(worst.feeLamports, feeOff);
    if (!MEASURE) {
      assert.ok(solOff <= 12, `sell: SOL received off by ${solOff.toFixed(2)} lamports`);
      assert.ok(feeOff <= 1.5, `sell fees off by ${feeOff.toFixed(2)} lamports`);
    }
  }
  const drift = Math.abs(curve.vSol * L - Number(r.curveAfter.virtualSol));
  worst.driftLamports = Math.max(worst.driftLamports, drift);
  if (!MEASURE) assert.ok(drift <= 2 + trades, `curve reserves drifted ${drift.toFixed(2)} lamports from the program's after ${trades} trades`);
}

test('the fork replays a recorded pump.fun launch exactly (balances and compute units)', { skip }, (t) => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/fork-replay-launch.json', import.meta.url), 'utf8')) as ReplayFixture;
  const upgraded = [...snapshot!.programs].filter(([, p]) => p.deploySlot !== null && p.deploySlot > fx.slot);
  if (upgraded.length) {
    t.skip(`${upgraded.map(([id]) => id).join(', ')} upgraded after the recorded launch; re-record it with --replay`);
    return;
  }
  const r = replayOnFork(fork(), fx);
  assert.equal(r.error, null);
  assert.equal(r.computeUnits.fork, r.computeUnits.mainnet);
  assert.equal(r.mismatches, 0, JSON.stringify(r.balances, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
});

test('curve.ts matches the program on random buy and sell sequences, to a few lamports', { skip }, async () => {
  for (const seed of [1, 2, 3, 4]) {
    const rand = rng(seed);
    const f = fork();
    const curve = new Curve();
    const wallets = [f.wallet(100), f.wallet(100), f.wallet(100), f.wallet(100)];
    const launch = await f.launch({ name: 'Paper', symbol: 'PPR', uri: 'https://example.com/m.json', devBuySol: 0.5 + rand() * 4.5, dev: wallets[0]! });
    assertBalanced(launch);
    compare(curve, launch, 1);
    for (let i = 0; i < 40; i++) {
      const w = wallets[Math.floor(rand() * wallets.length)]!;
      const held = f.tokens(w.publicKey, launch.mint);
      let r: TradeResult;
      if (held > 0n && rand() < 0.4) {
        const all = rand() < 0.3;
        r = await f.sell(w, launch.mint, all ? held : BigInt(Math.max(1, Math.floor(Number(held) * rand()))), { closeAccount: all });
      } else {
        r = await f.buy(w, launch.mint, 0.001 + Math.round(rand() * 3e9) / L);
      }
      assertBalanced(r);
      compare(curve, r, i + 2);
    }
  }
  if (MEASURE) console.log('worst differences (lamports):', worst);
});

test('a dev who sells the whole bag at once loses exactly the protocol fees (maxDevBuyLoss)', { skip }, async () => {
  for (const devBuy of [0.5, 3, 5]) {
    const f = fork();
    const dev = f.wallet(devBuy + 1);
    const launch = await f.launch({ name: 'Paper', symbol: 'PPR', uri: 'https://example.com/m.json', devBuySol: devBuy, dev });
    const sell = await f.sell(dev, launch.mint);
    const creatorFees = f.creatorVaultBalance(dev.publicKey);
    assert.equal(creatorFees, launch.creatorFee + sell.creatorFee);
    const loss = -(launch.solDelta + sell.solDelta) - creatorFees - (launch.rentPaid + sell.rentPaid) - (launch.networkFee + sell.networkFee);
    assert.equal(loss, launch.protocolFee + sell.protocolFee + (launch.curveSol - sell.curveSol), 'fees plus the rounding left in the curve');
    assert.ok(Math.abs(Number(loss) - maxDevBuyLoss(devBuy) * L) <= 4, `loss ${loss} vs maxDevBuyLoss ${maxDevBuyLoss(devBuy) * L}`);
  }
});

test('the last buy fills only what the curve has left, and the completed curve refuses buys', { skip }, async () => {
  const f = fork();
  const curve = new Curve();
  const dev = f.wallet(2);
  const whale = f.wallet(200);
  const launch = await f.launch({ name: 'Paper', symbol: 'PPR', uri: 'https://example.com/m.json', devBuySol: 1, dev });
  compare(curve, launch, 1);
  const left = f.curve(launch.mint).realTokens;
  const r = await f.buy(whale, launch.mint, 100);
  assertBalanced(r);
  assert.equal(r.tokenDelta, left, 'the whale gets exactly the tokens left');
  assert.equal(r.curveAfter.complete, true);
  const p = curve.buy(100);
  assert.ok(curve.complete);
  assert.ok(Math.abs(p.tokens * 1e6 - Number(left)) / Number(left) < 1e-9, `curve.ts filled ${p.tokens} tokens`);
  const paid = Number(r.curveSol + r.protocolFee + r.creatorFee);
  assert.ok(Math.abs(p.sol * L - paid) <= 50, `completion cost off by ${p.sol * L - paid} lamports`);
  assert.ok(paid < 100 * L, 'only the tokens left are paid for');
  assert.equal(Number(launch.tokenDelta + r.tokenDelta), CURVE_REAL_TOKENS * 1e6);

  await assert.rejects(f.buy(f.wallet(2), launch.mint, 1), (err: unknown) => {
    assert.ok(err instanceof ForkTxError);
    assert.ok(err.logs.some((l) => l.includes('BondingCurveComplete')), err.logs.join('\n'));
    return true;
  });
  assert.equal(curve.buy(1).tokens, 0);
});
