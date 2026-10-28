import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BorshCoder, utils, type Idl } from '@coral-xyz/anchor';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { getTransactionDecoder, type Address } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import { PUMP_FEE_CONFIG_PDA, GLOBAL_PDA, PUMP_PROGRAM_ID, PUMP_SDK, quoteAta } from '@pump-fun/pump-sdk';
import { Curve, maxDevBuyLoss } from '../src/chain/curve.ts';
import { config } from '../src/config.ts';
import { PumpFork, SIGNATURE_FEE } from '../src/paper/fork.ts';
import { ATA_PROGRAM, TOKEN_2022_PROGRAM, loadOrFetchSnapshot, snapshotExists, type Snapshot } from '../src/paper/snapshot.ts';
import { PLAYBOOK } from '../src/playbook.ts';
import { PreflightError } from '../src/live/types.ts';
import {
  DryVenue,
  ForkVenue,
  MAX_LAUNCH_COMPUTE_UNITS,
  launchUnitLimit,
  MainnetVenue,
  PUMP_LOOKUP_TABLE,
  SELL_COMPUTE_UNITS,
  SENDER_TIP_ACCOUNTS,
  SellFailedError,
  buildLaunchTransaction,
  buildSellTransaction,
  explainTxError,
  loadKeypair,
  minOut,
  priorityFeeLamports,
  rentExempt,
  slippageLimits,
  type BuildContext,
  type PumpState,
} from '../src/live/venue.ts';

/**
 * src/live/venue.ts. The fork venue runs launches and sells end to end on the local copy of pump.fun (needs the cached
 * snapshot in data/fork/, or network access to fetch it once). The mainnet builders are checked offline against
 * pump.fun's real lookup table (recorded in the replay fixture). Mainnet simulation runs only when the RPC is reachable;
 * nothing here signs or sends a mainnet transaction.
 */

const DIR = fileURLToPath(new URL('../data/fork', import.meta.url));
const L = 1e9;
const COIN = { name: 'Venue Test', symbol: 'VTEST', uri: 'https://ipfs.io/ipfs/bafkreianmtpjdcloaekgmkeifrhdlsbbtepg7j4dyb6kg6oqfndj42xyfu' };
const txDecoder = getTransactionDecoder();
const pumpCoder = new BorshCoder(JSON.parse(readFileSync(new URL('../idl/pump.json', import.meta.url), 'utf8')) as Idl).instruction;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const online = await reachable(config.rpcHttp);
let snapshot: Snapshot | null = null;
let skip: string | false = false;
if (!snapshotExists(DIR) && !online) {
  skip = 'no pump.fun fork snapshot in data/fork and no network to fetch one: run "npm run paper-fork" once online';
} else {
  try {
    snapshot = await loadOrFetchSnapshot(DIR, config.rpcHttp);
  } catch (err) {
    skip = `could not fetch the pump.fun fork snapshot: ${(err as Error).message}`;
  }
}
const fork = () => new PumpFork(snapshot!);
const offline = online ? false : `${config.rpcHttp} not reachable`;

/** The recorded site launch's copy of pump.fun's lookup table. */
function siteLookupTable(): AddressLookupTableAccount {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/fork-replay-launch.json', import.meta.url), 'utf8')) as {
    accounts: Record<string, { data: string } | null>;
  };
  const acc = fx.accounts[PUMP_LOOKUP_TABLE.toBase58()];
  assert.ok(acc, 'the replay fixture holds pump.fun lookup table');
  return new AddressLookupTableAccount({ key: PUMP_LOOKUP_TABLE, state: AddressLookupTableAccount.deserialize(Buffer.from(acc.data, 'base64')) });
}

const programOf = (ix: TransactionInstruction) => ix.programId.toBase58();
const ixName = (ix: TransactionInstruction) => pumpCoder.decode(Buffer.from(ix.data))?.name;
const ixArgs = (ix: TransactionInstruction) => pumpCoder.decode(Buffer.from(ix.data))!.data as Record<string, { toString(): string }>;
const CB = ComputeBudgetProgram.programId.toBase58();
const PUMP = PUMP_PROGRAM_ID.toBase58();

test('fork venue: 5.0625 SOL launch, three outside buys and a whole-bag sell, against curve.ts', { skip }, async (t) => {
  const f = fork();
  const venue = new ForkVenue(f, { devSol: 10 });
  const devBuySol = PLAYBOOK.devBuySol;
  const start = await venue.balanceLamports();

  const pre = await venue.preflightLaunch({ ...COIN, devBuySol });
  assert.ok(pre.computeUnits > 150_000 && pre.computeUnits < 300_000, `preflight used ${pre.computeUnits} units`);

  const launch = await venue.launch({ ...COIN, devBuySol });
  assert.equal(launch.simulated, true);
  assert.equal(await venue.tokenBalance(launch.mint), launch.devTokens);
  const afterLaunch = await venue.balanceLamports();
  assert.equal(afterLaunch - start, -(launch.lamportsSpent + launch.rentLamports + launch.networkFeeLamports), 'every lamport of the launch is in the fill');
  assert.ok(launch.lamportsSpent <= BigInt(devBuySol * L) && launch.lamportsSpent > BigInt(devBuySol * L) - 1_000n, `spent ${launch.lamportsSpent}`);

  // curve.ts, fed the same trades, to a few lamports.
  const curve = new Curve();
  const p = curve.buy(Number(launch.lamportsSpent) / L);
  const tokensOff = Math.abs(p.tokens * 1e6 - Number(launch.devTokens)) / 1e6 * curve.price * L;
  assert.ok(tokensOff <= 4, `dev tokens off curve.ts by ${tokensOff.toFixed(2)} lamports' worth`);

  const outside = [2, 1.5, 3];
  let creatorFees = 0n;
  for (const s of outside) {
    const r = await f.buy(f.wallet(s + 1), launch.mint, s);
    curve.buy(Number(r.curveSol + r.protocolFee + r.creatorFee) / L);
    creatorFees += r.creatorFee;
  }

  const quote = await venue.quoteSell(launch.mint, launch.devTokens);
  const sell = await venue.sellAll(launch.mint, { maxSlippage: PLAYBOOK.sellMaxSlippage });
  const end = await venue.balanceLamports();
  assert.equal(sell.attempts, 1);
  assert.equal(sell.simulated, true);
  assert.equal(sell.tokensSold, launch.devTokens);
  assert.equal(await venue.tokenBalance(launch.mint), 0n);
  assert.equal(sell.lamportsReceived, quote, 'nothing traded between the quote and the sell');
  assert.equal(end - afterLaunch, sell.lamportsReceived - sell.networkFeeLamports, 'every lamport of the sell is in the fill');
  const expected = curve.sell(Number(sell.tokensSold) / 1e6).sol * L;
  assert.ok(Math.abs(expected - Number(sell.lamportsReceived)) <= 12, `sell off curve.ts by ${expected - Number(sell.lamportsReceived)} lamports`);

  const vault = await venue.creatorVaultLamports();
  assert.ok(vault > creatorFees, 'the creator vault holds the dev and outside creator fees');
  const net = end - start + vault;
  t.diagnostic(
    `launch ${devBuySol} SOL: ${launch.devTokens} tokens for ${launch.lamportsSpent} lamports, rent ${launch.rentLamports}, ` +
      `network ${launch.networkFeeLamports}, ${pre.computeUnits} CU; outside buys ${outside.join(', ')} SOL; ` +
      `sell ${sell.tokensSold} tokens for ${sell.lamportsReceived} (quote ${quote}, curve.ts ${Math.round(expected)}), ` +
      `network ${sell.networkFeeLamports}; creator vault ${vault}; dev net incl. vault ${net} lamports (${(Number(net) / L).toFixed(6)} SOL)`,
  );
  assert.ok(net > 0n, 'three outside buys after the dev make the round trip profitable');
});

test('fork venue: with no outside buyers the round trip loses only the protocol fees (maxDevBuyLoss)', { skip }, async (t) => {
  const f = fork();
  const venue = new ForkVenue(f, { devSol: 10 });
  const start = await venue.balanceLamports();
  const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
  const sell = await venue.sellAll(launch.mint, { maxSlippage: PLAYBOOK.sellMaxSlippage });
  const vault = await venue.creatorVaultLamports();
  const end = await venue.balanceLamports();
  const loss = launch.lamportsSpent - sell.lamportsReceived - vault;
  const bound = maxDevBuyLoss(Number(launch.lamportsSpent) / L) * L;
  assert.ok(Math.abs(Number(loss) - bound) <= 4, `loss ${loss} vs maxDevBuyLoss ${bound.toFixed(0)}`);
  const outOfPocket = start - end - vault;
  assert.equal(outOfPocket, loss + launch.rentLamports + launch.networkFeeLamports + sell.networkFeeLamports);
  t.diagnostic(
    `no buyers: trading loss ${loss} lamports (bound ${bound.toFixed(0)}), rent ${launch.rentLamports}, ` +
      `network ${launch.networkFeeLamports + sell.networkFeeLamports}; out of pocket ${outOfPocket} (${(Number(outOfPocket) / L).toFixed(6)} SOL)`,
  );
});

test('fork venue: a dump between quote and sell fails the first attempt; the ladder re-quotes and sells', { skip }, async (t) => {
  const f = fork();
  const venue = new ForkVenue(f, { devSol: 10 });
  const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
  const whale = f.wallet(4);
  await f.buy(whale, launch.mint, 3);
  venue.beforeSellSend = async (attempt) => {
    if (attempt === 1) await f.sell(whale, launch.mint);
  };
  const quoteBefore = await venue.quoteSell(launch.mint, launch.devTokens);
  const sell = await venue.sellAll(launch.mint, { maxSlippage: 0.001, ladder: [0.2, 0.35] });
  assert.equal(sell.attempts, 2);
  assert.equal(sell.tokensSold, launch.devTokens);
  assert.equal(await venue.tokenBalance(launch.mint), 0n);
  assert.ok(sell.lamportsReceived < minOut(quoteBefore, 0.001), 'the second attempt sold below the first limit');
  t.diagnostic(`quote ${quoteBefore} before the dump, sold for ${sell.lamportsReceived} on attempt ${sell.attempts}`);
});

test('fork venue: when every attempt fails the sell throws and the bag is still held', { skip }, async () => {
  const f = fork();
  const venue = new ForkVenue(f, { devSol: 10 });
  const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
  const dumpers = [f.wallet(3), f.wallet(3)];
  for (const w of dumpers) await f.buy(w, launch.mint, 2);
  venue.beforeSellSend = async (attempt) => {
    await f.sell(dumpers[attempt - 1]!, launch.mint);
  };
  const before = await venue.balanceLamports();
  await assert.rejects(venue.sellAll(launch.mint, { maxSlippage: 0.001, ladder: [0.002] }), (err: unknown) => {
    assert.ok(err instanceof SellFailedError);
    assert.match(err.message, /BAG STILL HELD/);
    assert.equal(err.failures.length, 2);
    assert.ok(err.failures.every((m) => /TooLittleSolReceived/.test(m)), err.failures.join('\n'));
    return true;
  });
  assert.equal(await venue.tokenBalance(launch.mint), launch.devTokens, 'the bag is untouched');
  const feeEach = SIGNATURE_FEE + priorityFeeLamports(venue.priorityMicroLamports, SELL_COMPUTE_UNITS);
  assert.equal(before - (await venue.balanceLamports()), 2n * feeEach, 'each failed attempt costs its network fee, as on mainnet');
});

test('fork venue: preflight rejects a launch the wallet cannot pay for, cleanly', { skip }, async () => {
  const venue = new ForkVenue(fork(), { devSol: 1 });
  await assert.rejects(venue.preflightLaunch({ ...COIN, devBuySol: 5 }), (err: unknown) => {
    assert.ok(err instanceof PreflightError);
    assert.ok(err.logs.length > 0);
    return true;
  });
  await assert.rejects(venue.launch({ ...COIN, devBuySol: 50 }), /dev buy must be from 0 to 10 SOL/);
});

test('keypair files: a Solana CLI keypair loads; a bad file fails without quoting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-test-'));
  try {
    const kp = Keypair.generate(); // a throwaway in-memory key, never funded
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    assert.ok(loadKeypair(good).publicKey.equals(kp.publicKey));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'SECRETWORDS not json', { mode: 0o600 });
    assert.throws(() => loadKeypair(bad), (err: Error) => !err.message.includes('SECRETWORDS') && /not a Solana CLI keypair/.test(err.message));
    const short = join(dir, 'short.json');
    writeFileSync(short, JSON.stringify([...kp.secretKey].slice(0, 32)), { mode: 0o600 });
    assert.throws(() => loadKeypair(short), /not a Solana CLI keypair/);
    const mismatched = join(dir, 'mismatched.json');
    writeFileSync(mismatched, JSON.stringify([...kp.secretKey.slice(0, 32), ...Keypair.generate().publicKey.toBytes()]), { mode: 0o600 });
    assert.throws(() => loadKeypair(mismatched), (err: Error) => /invalid key/.test(err.message) && !err.message.includes(String(kp.secretKey[0])));
    assert.throws(() => loadKeypair(join(dir, 'missing.json')), /cannot read the launch keypair file .* \(ENOENT\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transaction errors read as words: unfunded wallet, pump.fun error names', () => {
  const dev = Keypair.generate().publicKey.toBase58();
  assert.match(explainTxError('AccountNotFound', [], dev), /does not exist on mainnet/);
  assert.match(explainTxError({ InstructionError: [4, { Custom: 6002 }] }, [], dev), /instruction 4 failed: TooMuchSolRequired \(6002\)/);
  assert.match(explainTxError({ InstructionError: [5, { Custom: 1 }] }, ['Transfer: insufficient lamports 5, need 200000'], dev), /insufficient lamports/);
});

test('sell ladder limits: max first, then only wider limits', () => {
  assert.deepEqual(slippageLimits(0.1, [0.2, 0.15, 0.35, 0.35]), [0.1, 0.2, 0.35]);
  assert.deepEqual(slippageLimits(0.1), [0.1]);
  assert.throws(() => slippageLimits(1.2));
  assert.throws(() => slippageLimits(0.1, [Number.NaN]));
  assert.equal(minOut(1_000_000_000n, 0.1), 900_000_000n);
});

/** Build context for mainnet transactions: Global and FeeConfig from the fork snapshot, the site's lookup table. */
function mainnetCtx(dev: PublicKey, tipLamports: number | null): BuildContext {
  const f = fork();
  return {
    dev,
    global: f.global,
    feeConfig: f.feeConfig,
    lookupTable: siteLookupTable(),
    blockhash: Keypair.generate().publicKey.toBase58(),
    priorityMicroLamports: 200_000,
    tipLamports,
  };
}

test('mainnet launch transaction: create_v2 (normal mode), ATA, buy_v2, through pump.fun lookup table', { skip }, async (t) => {
  const dev = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const table = siteLookupTable();
  const tableKeys = new Set(table.state.addresses.map((a) => a.toBase58()));
  for (const tip of [null, 200_000]) {
    const built = await buildLaunchTransaction(mainnetCtx(dev, tip), { ...COIN, devBuySol: PLAYBOOK.devBuySol }, mint);
    const msg = built.tx.message;
    assert.equal(msg.header.numRequiredSignatures, 2, 'signed by the dev and the mint');
    assert.ok(msg.staticAccountKeys[0]!.equals(dev), 'the dev pays');
    assert.ok(msg.staticAccountKeys[1]!.equals(mint));
    assert.equal(msg.addressTableLookups.length, 1);
    assert.ok(msg.addressTableLookups[0]!.accountKey.equals(PUMP_LOOKUP_TABLE), "pump.fun's lookup table");
    assert.ok(built.size <= 1232, `${built.size} bytes`);
    assert.ok(tableKeys.has(built.feeRecipient.toBase58()) && tableKeys.has(built.buybackFeeRecipient.toBase58()), 'fee recipients from the table');

    const ixs = TransactionMessage.decompile(msg, { addressLookupTableAccounts: [table] }).instructions;
    const programs = ixs.map(programOf);
    const expected = [CB, CB, PUMP, ATA_PROGRAM.toBase58(), PUMP];
    assert.deepEqual(programs, tip === null ? expected : [...expected, SystemProgram.programId.toBase58()]);
    assert.equal(Buffer.from(ixs[0]!.data).readUInt32LE(1), MAX_LAUNCH_COMPUTE_UNITS, 'built at the simulation limit');
    assert.equal(Buffer.from(ixs[1]!.data).readBigUInt64LE(1), 200_000n);

    assert.equal(ixName(ixs[2]!), 'create_v2');
    const create = ixArgs(ixs[2]!) as unknown as { name: string; symbol: string; uri: string; creator: PublicKey; is_mayhem_mode: boolean };
    assert.equal(create.is_mayhem_mode, false, 'never Mayhem mode');
    assert.ok(create.creator.equals(dev));
    assert.equal(create.name, COIN.name);

    assert.deepEqual([...ixs[3]!.data], [1], 'create-if-missing');
    assert.ok(ixs[3]!.keys[1]!.pubkey.equals(quoteAta(dev, mint, TOKEN_2022_PROGRAM)), "the dev's Token-2022 account");
    assert.ok(ixs[3]!.keys[5]!.pubkey.equals(TOKEN_2022_PROGRAM));

    assert.equal(ixName(ixs[4]!), 'buy_v2');
    const buy = ixArgs(ixs[4]!);
    assert.equal(BigInt(buy.amount!.toString()), built.devTokens);
    const lamports = BigInt(Math.round(PLAYBOOK.devBuySol * L));
    assert.equal(BigInt(buy.max_sol_cost!.toString()), lamports + lamports / 100n, 'cost cap: dev buy + 1%');
    assert.equal(built.maxCostLamports, lamports + lamports / 100n);

    if (tip === null) {
      assert.equal(built.tip, null);
      assert.equal(built.networkFeeLamports, 10_000n + priorityFeeLamports(200_000, MAX_LAUNCH_COMPUTE_UNITS));
    } else {
      const transfer = ixs[5]!;
      assert.equal(Buffer.from(transfer.data).readUInt32LE(0), 2, 'system transfer');
      assert.equal(Buffer.from(transfer.data).readBigUInt64LE(4), 200_000n);
      assert.ok(SENDER_TIP_ACCOUNTS.some((k) => k.equals(transfer.keys[1]!.pubkey)), 'to a Sender tip account');
      assert.ok(transfer.keys[0]!.pubkey.equals(dev));
      assert.equal(built.networkFeeLamports, 10_000n + priorityFeeLamports(200_000, MAX_LAUNCH_COMPUTE_UNITS) + 200_000n);
    }
    t.diagnostic(`launch transaction ${tip === null ? 'without' : 'with'} the Sender tip: ${built.size} bytes, ${built.devTokens} tokens`);
  }
});

test('mainnet sell transaction: sell_v2 of the whole bag at the minimum out, tip only with Sender', { skip }, async (t) => {
  const dev = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const table = siteLookupTable();
  for (const tip of [null, 200_000]) {
    const built = await buildSellTransaction(mainnetCtx(dev, tip), { mint, creator: dev, tokens: 123_456_789_000n, minLamportsOut: 4_500_000_000n, mayhem: false });
    const msg = built.tx.message;
    assert.equal(msg.header.numRequiredSignatures, 1);
    assert.ok(msg.staticAccountKeys[0]!.equals(dev));
    assert.ok(built.size <= 1232);
    const ixs = TransactionMessage.decompile(msg, { addressLookupTableAccounts: [table] }).instructions;
    assert.deepEqual(ixs.map(programOf), tip === null ? [CB, CB, PUMP] : [CB, CB, PUMP, SystemProgram.programId.toBase58()]);
    assert.equal(Buffer.from(ixs[0]!.data).readUInt32LE(1), SELL_COMPUTE_UNITS);
    assert.equal(ixName(ixs[2]!), 'sell_v2');
    const args = ixArgs(ixs[2]!);
    assert.equal(BigInt(args.amount!.toString()), 123_456_789_000n);
    assert.equal(BigInt(args.min_sol_output!.toString()), 4_500_000_000n);
    t.diagnostic(`sell transaction ${tip === null ? 'without' : 'with'} the Sender tip: ${built.size} bytes`);
  }
});

test('mainnet venues: the Sender tip follows SENDER_URL, and only a live venue with a keypair can send', { skip }, async () => {
  const f = fork();
  const rent = { lamportsPerByteYear: 5_080n, exemptionThreshold: 1 };
  assert.equal(rentExempt(rent, 165), f.svm.minimumBalanceForRentExemption(165n), "rentExempt matches the fork's (mainnet's) Rent sysvar");
  const state: PumpState = { at: Date.now(), global: f.global, feeConfig: f.feeConfig, lookupTable: siteLookupTable(), rent };
  const dev = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const p = { ...COIN, devBuySol: PLAYBOOK.devBuySol };
  const plain = await new DryVenue(dev, { state, senderUrl: null }).buildLaunch(p, mint);
  assert.equal(plain.tip, null);
  const viaSender = await new DryVenue(dev, { state, senderUrl: 'https://sender.helius-rpc.com/fast', tipLamports: 300_000 }).buildLaunch(p, mint);
  assert.equal(viaSender.tip?.lamports, 300_000n);
  assert.throws(() => new MainnetVenue(dev, { mode: 'live' }), /needs the launch keypair/);
  // A dry venue never signs: its send path refuses before touching the network.
  const dry = new DryVenue(dev, { state, rpcUrl: 'http://127.0.0.1:9' });
  await assert.rejects(MainnetVenue.prototype.launch.call(dry, p), /never signs or sends/);
  await assert.rejects(MainnetVenue.prototype.sellAll.call(dry, mint.toBase58(), { maxSlippage: 0.1 }), /never signs or sends/);
});

test('dry venue: simulating a launch from an unfunded wallet fails with a clean PreflightError', { skip: offline }, async () => {
  const venue = new DryVenue(Keypair.generate().publicKey);
  await assert.rejects(venue.preflightLaunch({ ...COIN, devBuySol: PLAYBOOK.devBuySol }), (err: unknown) => {
    assert.ok(err instanceof PreflightError, String(err));
    assert.match(err.message, /does not exist on mainnet|cannot pay|lacks SOL|insufficient/i);
    assert.doesNotMatch(err.message, /\n/);
    return true;
  });
});

test('dry venue: a 5.0625 SOL launch simulated on mainnet matches the fork', { skip: offline || skip }, async (t) => {
  // Simulation (no signature checks) needs a payer that exists with enough SOL: one of pump.fun's fee wallets.
  const connection = new Connection(config.rpcHttp, 'confirmed');
  const [g] = await connection.getMultipleAccountsInfo([GLOBAL_PDA, PUMP_FEE_CONFIG_PDA]);
  const global = PUMP_SDK.decodeGlobal(g!);
  const candidates = [global.feeRecipient, ...global.feeRecipients].filter((k) => !k.equals(PublicKey.default));
  const infos = await connection.getMultipleAccountsInfo(candidates);
  const i = infos.findIndex((a) => a && a.owner.equals(SystemProgram.programId) && a.data.length === 0 && a.lamports > 20 * L);
  if (i < 0) {
    t.skip('no funded system wallet among the fee recipients');
    return;
  }
  const payer = candidates[i]!;
  const venue = new DryVenue(payer);
  const p = { ...COIN, devBuySol: PLAYBOOK.devBuySol };
  const fill = await venue.launch(p);
  assert.equal(fill.simulated, true);
  assert.match(fill.signature, /^dry:/);

  const forkVenue = new ForkVenue(fork(), { devSol: 10 });
  const forkFill = await forkVenue.launch(p);
  assert.equal(fill.devTokens, forkFill.devTokens, 'same tokens as the fork (same Global and fee config)');
  assert.equal(fill.lamportsSpent, forkFill.lamportsSpent);
  // The fork's dev is new; the fee wallet may already have a volume account, so its rent can only be lower.
  assert.ok(fill.rentLamports > 0n && fill.rentLamports <= forkFill.rentLamports, `dry rent ${fill.rentLamports}, fork ${forkFill.rentLamports}`);
  assert.equal(await venue.tokenBalance(fill.mint), fill.devTokens, 'the dry bag is remembered');

  const sell = await venue.sellAll(fill.mint, { maxSlippage: 0.1 });
  assert.equal(sell.simulated, true);
  assert.equal(sell.tokensSold, fill.devTokens);
  const loss = Number(fill.lamportsSpent - sell.lamportsReceived);
  const bound = maxDevBuyLoss(Number(fill.lamportsSpent) / L) * L;
  // The dry sell keeps the creator fee on both legs out of the received amount, as the fork does.
  assert.ok(loss > bound && loss < bound * 1.4, `dry round trip lost ${loss} (protocol-fee bound ${bound.toFixed(0)})`);
  t.diagnostic(
    `dry launch as ${payer.toBase58()}: ${fill.devTokens} tokens for ${fill.lamportsSpent} lamports, rent ${fill.rentLamports}, ` +
      `network ${fill.networkFeeLamports}; dry sell ${sell.lamportsReceived}`,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The live path (MainnetVenue in mode 'live') against a local JSON-RPC endpoint backed by the fork

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Every signature on the transaction is valid for its message (the fork runs with signature checks off). */
function signaturesValid(tx: VersionedTransaction): boolean {
  const msg = Buffer.from(tx.message.serialize());
  return tx.signatures.every((sig, i) => {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, tx.message.staticAccountKeys[i]!.toBuffer()]), format: 'der', type: 'spki' });
    return verify(null, msg, key, Buffer.from(sig));
  });
}

/** A LiteSVM error in the RPC's JSON form, for the errors these tests produce. */
function rpcError(err: { toString(): string }): unknown {
  const m = /index: (\d+), error: InstructionErrorCustom \{ code: (\d+) \}/.exec(err.toString());
  return m ? { InstructionError: [Number(m[1]), { Custom: Number(m[2]) }] } : err.toString();
}

interface Executed {
  slot: number;
  err: unknown;
  json: unknown;
  /** Compute units used, and the limit the transaction asked for. */
  units: number;
  limit: number;
}

type ForkAccount = ReturnType<PumpFork['svm']['getAccount']>;

/**
 * A JSON-RPC endpoint on 127.0.0.1 backed by a fork: the calls MainnetVenue makes to launch and sell, so the live
 * send, rebroadcast, confirmation and fill code runs against pump.fun's real programs and never near mainnet. Like the
 * cluster it executes a signature once however often it is sent and checks every signature; it can drop the next
 * sends (to let a blockhash expire), hide landed transactions from getTransaction, and run a hook before executing a
 * transaction (to have another wallet trade first). `/sender` stands in for Helius Sender.
 */
class ForkRpc {
  readonly fork: PumpFork;
  readonly server: Server;
  url = '';
  height = 1_000;
  slot = 9_000;
  sends = 0;
  senderSends = 0;
  dropNext = 0;
  hideTransactions = false;
  beforeExecute: (() => Promise<void> | void) | null = null;
  readonly landed = new Map<string, Executed>();
  private readonly dropped = new Set<string>();

  constructor(fork: PumpFork) {
    this.fork = fork;
    // Simulations carry a placeholder blockhash and no signatures; this endpoint checks signatures itself on send.
    fork.svm.withSigverify(false).withBlockhashCheck(false);
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        this.handle(req.url ?? '/', method, params)
          .then((result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result })))
          .catch((err: Error) => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } })));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  private account(key: string) {
    const a = this.fork.svm.getAccount(key as Address);
    if (!a.exists) return null;
    return {
      data: [Buffer.from(a.data).toString('base64'), 'base64'],
      executable: a.executable,
      lamports: Number(a.lamports),
      owner: a.programAddress,
      rentEpoch: 0,
      space: a.data.length,
    };
  }

  private table(key: PublicKey): AddressLookupTableAccount {
    const a = this.fork.svm.getAccount(key.toBase58() as Address);
    assert.ok(a.exists, `lookup table ${key.toBase58()} on the fork`);
    return new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(a.data) });
  }

  private tokenBalances(views: ForkAccount[]) {
    const out = [];
    for (const [i, a] of views.entries()) {
      if (!a.exists || a.programAddress !== TOKEN_2022_PROGRAM.toBase58() || a.data.length < 165) continue;
      const d = Buffer.from(a.data);
      const amount = d.readBigUInt64LE(64).toString();
      out.push({
        accountIndex: i,
        mint: new PublicKey(d.subarray(0, 32)).toBase58(),
        owner: new PublicKey(d.subarray(32, 64)).toBase58(),
        programId: TOKEN_2022_PROGRAM.toBase58(),
        uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
      });
    }
    return out;
  }

  private execute(tx: VersionedTransaction, wire: Buffer): Executed {
    const msg = tx.message;
    const tables = msg.addressTableLookups.map((l) => this.table(l.accountKey));
    const keySet = msg.getAccountKeys({ addressLookupTableAccounts: tables });
    const keys = keySet.keySegments().flat().map((k) => k.toBase58());
    const pre = keys.map((k) => this.fork.svm.getAccount(k as Address));
    const res = this.fork.svm.sendTransaction(txDecoder.decode(wire));
    const failed = res instanceof FailedTransactionMetadata;
    const meta = failed ? res.meta() : res;
    const post = keys.map((k) => this.fork.svm.getAccount(k as Address));
    let units = 200_000;
    let price = 0n;
    for (const ix of TransactionMessage.decompile(msg, { addressLookupTableAccounts: tables }).instructions) {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
      const d = Buffer.from(ix.data);
      if (d[0] === 2) units = d.readUInt32LE(1);
      if (d[0] === 3) price = d.readBigUInt64LE(1);
    }
    const fee = SIGNATURE_FEE * BigInt(msg.header.numRequiredSignatures) + priorityFeeLamports(Number(price), units);
    const err = failed ? rpcError(res.err()) : null;
    const slot = ++this.slot;
    const lamports = (v: ForkAccount) => (v.exists ? Number(v.lamports) : 0);
    const json = {
      slot,
      blockTime: null,
      version: 0,
      transaction: {
        signatures: tx.signatures.map((s) => utils.bytes.bs58.encode(s)),
        message: {
          header: msg.header,
          accountKeys: msg.staticAccountKeys.map((k) => k.toBase58()),
          recentBlockhash: msg.recentBlockhash,
          instructions: msg.compiledInstructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accounts: ix.accountKeyIndexes,
            data: utils.bytes.bs58.encode(Buffer.from(ix.data)),
          })),
          addressTableLookups: msg.addressTableLookups.map((l) => ({
            accountKey: l.accountKey.toBase58(),
            writableIndexes: l.writableIndexes,
            readonlyIndexes: l.readonlyIndexes,
          })),
        },
      },
      meta: {
        err,
        fee: Number(fee),
        preBalances: pre.map(lamports),
        postBalances: post.map(lamports),
        preTokenBalances: this.tokenBalances(pre),
        postTokenBalances: this.tokenBalances(post),
        logMessages: meta.logs(),
        loadedAddresses: {
          writable: keySet.accountKeysFromLookups?.writable.map((k) => k.toBase58()) ?? [],
          readonly: keySet.accountKeysFromLookups?.readonly.map((k) => k.toBase58()) ?? [],
        },
        computeUnitsConsumed: Number(meta.computeUnitsConsumed()),
        innerInstructions: [],
      },
    };
    return { slot, err, json, units: Number(meta.computeUnitsConsumed()), limit: units };
  }

  private async handle(path: string, method: string, params: unknown[]): Promise<unknown> {
    const context = { slot: this.slot };
    switch (method) {
      case 'getMultipleAccounts':
        return { context, value: (params[0] as string[]).map((k) => this.account(k)) };
      case 'getAccountInfo':
        return { context, value: this.account(params[0] as string) };
      case 'getBalance':
        return { context, value: this.account(params[0] as string)?.lamports ?? 0 };
      case 'getLatestBlockhash':
        return { context, value: { blockhash: this.fork.svm.latestBlockhash(), lastValidBlockHeight: this.height + 150 } };
      case 'getBlockHeight':
        this.height += this.dropped.size ? 100 : 1;
        return this.height;
      case 'simulateTransaction': {
        const res = this.fork.svm.simulateTransaction(txDecoder.decode(Buffer.from(params[0] as string, 'base64')));
        const meta = res.meta();
        const err = res instanceof FailedTransactionMetadata ? rpcError(res.err()) : null;
        return { context, value: { err, logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()), accounts: null, returnData: null } };
      }
      case 'sendTransaction': {
        if (path.startsWith('/sender')) this.senderSends++;
        else this.sends++;
        const wire = Buffer.from(params[0] as string, 'base64');
        const tx = VersionedTransaction.deserialize(wire);
        const sig = utils.bytes.bs58.encode(tx.signatures[0]!);
        if (this.landed.has(sig) || this.dropped.has(sig)) return sig;
        if (!signaturesValid(tx)) throw new Error('Transaction signature verification failure');
        if (this.dropNext > 0) {
          this.dropNext--;
          this.dropped.add(sig);
          return sig;
        }
        if (this.beforeExecute) await this.beforeExecute();
        this.landed.set(sig, this.execute(tx, wire));
        return sig;
      }
      case 'getSignatureStatuses': {
        const value = (params[0] as string[]).map((s) => {
          const l = this.landed.get(s);
          return l ? { slot: l.slot, confirmations: null, err: l.err, confirmationStatus: 'confirmed' } : null;
        });
        return { context, value };
      }
      case 'getTransaction':
        return this.hideTransactions ? null : (this.landed.get(params[0] as string)?.json ?? null);
      default:
        throw new Error(`method ${method} not mocked`);
    }
  }
}

/** A fork whose pump.fun lookup table address holds the fork's own table, behind a local RPC. */
async function forkRpc(): Promise<ForkRpc> {
  const f = fork();
  new ForkVenue(f, { devSol: 0 }); // installs the fork's lookup table at its own address
  const forkTable = PublicKey.findProgramAddressSync([Buffer.from('fork-venue')], AddressLookupTableProgram.programId)[0];
  const t = f.svm.getAccount(forkTable.toBase58() as Address);
  assert.ok(t.exists);
  f.svm.setAccount({ ...t, address: PUMP_LOOKUP_TABLE.toBase58() as Address });
  return new ForkRpc(f).start();
}

test('live venue on a local fork RPC: launch, outside buys and sell through the mainnet send and fill code', { skip }, async (t) => {
  const rpc = await forkRpc();
  try {
    const f = rpc.fork;
    const wallet = f.wallet(10);
    const venue = new MainnetVenue(wallet, { mode: 'live', rpcUrl: rpc.url, senderUrl: null });
    const start = f.balance(wallet.publicKey);
    const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
    assert.equal(launch.simulated, false);
    assert.equal(rpc.landed.size, 1, 'executed once');
    assert.equal(launch.devTokens, f.tokens(wallet.publicKey, launch.mint));
    assert.equal(launch.devTokens, 153_285_714_259_436n);
    assert.equal(f.balance(wallet.publicKey) - start, -(launch.lamportsSpent + launch.rentLamports + launch.networkFeeLamports));
    const exec = rpc.landed.get(launch.signature)!;
    assert.equal(exec.limit, launchUnitLimit(exec.units), 'the unit limit is what the preflight used plus 10%');
    assert.ok(exec.units < exec.limit);
    assert.equal(launch.networkFeeLamports, 10_000n + priorityFeeLamports(config.priorityMicroLamports, exec.limit));
    assert.equal(await venue.tokenBalance(launch.mint), launch.devTokens);

    for (const s of [2, 1.5, 3]) await f.buy(f.wallet(s + 1), launch.mint, s);
    const quote = await venue.quoteSell(launch.mint, launch.devTokens);
    const before = f.balance(wallet.publicKey);
    const sell = await venue.sellAll(launch.mint, { maxSlippage: PLAYBOOK.sellMaxSlippage, ladder: [0.2] });
    assert.equal(sell.attempts, 1);
    assert.equal(sell.simulated, false);
    assert.equal(sell.tokensSold, launch.devTokens);
    assert.equal(sell.lamportsReceived, quote);
    assert.equal(f.balance(wallet.publicKey) - before, sell.lamportsReceived - sell.networkFeeLamports);
    assert.equal(await venue.tokenBalance(launch.mint), 0n);
    assert.ok((await venue.creatorVaultLamports()) > 0n);
    assert.equal(rpc.senderSends, 0, 'no Sender without SENDER_URL');
    t.diagnostic(
      `live path: launch ${launch.devTokens} tokens for ${launch.lamportsSpent}, rent ${launch.rentLamports}, network ${launch.networkFeeLamports}; ` +
        `sell ${sell.lamportsReceived}, network ${sell.networkFeeLamports}; ${rpc.sends} RPC sends for 2 transactions`,
    );
  } finally {
    rpc.close();
  }
});

test('live venue on a local fork RPC: Sender gets the same bytes with a tip, and the tip is in the network fee', { skip }, async () => {
  const rpc = await forkRpc();
  try {
    const f = rpc.fork;
    const wallet = f.wallet(10);
    const tip = 1_000_000; // a tip under the rent-exempt minimum cannot open a fresh account on the fork
    const venue = new MainnetVenue(wallet, { mode: 'live', rpcUrl: rpc.url, senderUrl: `${rpc.url}/sender`, tipLamports: tip });
    const start = f.balance(wallet.publicKey);
    const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
    assert.ok(rpc.senderSends >= 1, 'sent to Sender');
    assert.equal(rpc.landed.size, 1);
    const exec = rpc.landed.get(launch.signature)!;
    assert.equal(launch.networkFeeLamports, 10_000n + priorityFeeLamports(config.priorityMicroLamports, exec.limit) + BigInt(tip));
    assert.equal(f.balance(wallet.publicKey) - start, -(launch.lamportsSpent + launch.rentLamports + launch.networkFeeLamports));
    assert.equal(SENDER_TIP_ACCOUNTS.map((k) => f.balance(k)).reduce((a, b) => a + b, 0n), BigInt(tip));
  } finally {
    rpc.close();
  }
});

test('live venue on a local fork RPC: a sell that never lands waits out its blockhash, then the ladder re-sends', { skip }, async () => {
  const rpc = await forkRpc();
  try {
    const f = rpc.fork;
    const wallet = f.wallet(10);
    const venue = new MainnetVenue(wallet, { mode: 'live', rpcUrl: rpc.url, senderUrl: null });
    const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
    rpc.dropNext = 1;
    const sell = await venue.sellAll(launch.mint, { maxSlippage: 0.1, ladder: [0.2] });
    assert.equal(sell.attempts, 2);
    assert.equal(sell.tokensSold, launch.devTokens);
    assert.equal(rpc.landed.size, 2, 'the launch and one sell executed; the dropped sell never did');
    assert.equal(await venue.tokenBalance(launch.mint), 0n);
  } finally {
    rpc.close();
  }
});

test('live venue on a local fork RPC: a sell that lands with a slippage error is re-quoted at the next limit', { skip }, async () => {
  const rpc = await forkRpc();
  try {
    const f = rpc.fork;
    const wallet = f.wallet(10);
    const venue = new MainnetVenue(wallet, { mode: 'live', rpcUrl: rpc.url, senderUrl: null });
    const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
    const whale = f.wallet(4);
    await f.buy(whale, launch.mint, 3);
    let dumped = false;
    rpc.beforeExecute = async () => {
      if (!dumped) {
        dumped = true;
        await f.sell(whale, launch.mint);
      }
    };
    const sell = await venue.sellAll(launch.mint, { maxSlippage: 0.001, ladder: [0.2] });
    assert.equal(sell.attempts, 2);
    const failed = [...rpc.landed.values()].filter((l) => l.err !== null);
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0]!.err, { InstructionError: [2, { Custom: 6003 }] });
    assert.equal(await venue.tokenBalance(launch.mint), 0n);
  } finally {
    rpc.close();
  }
});

test('live venue on a local fork RPC: without getTransaction the fill comes from balances and curve math', { skip }, async () => {
  const rpc = await forkRpc();
  try {
    const f = rpc.fork;
    const wallet = f.wallet(10);
    const venue = new MainnetVenue(wallet, { mode: 'live', rpcUrl: rpc.url, senderUrl: null, fillTimeoutMs: 300 });
    rpc.hideTransactions = true;
    const start = f.balance(wallet.publicKey);
    const launch = await venue.launch({ ...COIN, devBuySol: PLAYBOOK.devBuySol });
    assert.equal(launch.devTokens, 153_285_714_259_436n);
    assert.ok(launch.lamportsSpent >= 5_062_499_990n && launch.lamportsSpent <= 5_062_500_000n, `spent ${launch.lamportsSpent}`);
    assert.equal(f.balance(wallet.publicKey) - start, -(launch.lamportsSpent + launch.rentLamports + launch.networkFeeLamports));
    const before = f.balance(wallet.publicKey);
    const sell = await venue.sellAll(launch.mint, { maxSlippage: 0.1 });
    assert.equal(sell.tokensSold, launch.devTokens);
    assert.equal(f.balance(wallet.publicKey) - before, sell.lamportsReceived - sell.networkFeeLamports);
  } finally {
    rpc.close();
  }
});
