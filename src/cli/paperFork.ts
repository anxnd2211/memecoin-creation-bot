import type { Address } from '@solana/kit';
import { CREATOR_FEE_RATE, CURVE_FEE_RATE, Curve, PROTOCOL_FEE_RATE, maxDevBuyLoss } from '../chain/curve.ts';
import { config } from '../config.ts';
import { ForkTxError, PumpFork, type LaunchResult, type TradeResult } from '../paper/fork.ts';
import { fetchReplay, replayOnFork } from '../paper/replay.ts';

/**
 * Paper launch on a local fork of pump.fun (src/paper/fork.ts): creates a coin with a dev buy, lets other in-memory
 * wallets buy, optionally sells the dev's whole bag, and prints the exact on-chain results next to what
 * src/chain/curve.ts predicts. Never signs or sends a mainnet transaction.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('help')) {
  console.log(`usage: npm run paper-fork -- [--dev-buy 3] [--outside 2,1.5,3] [--sell-all [--close-account]]
                          [--priority <micro-lamports per CU>] [--name ..] [--symbol ..] [--uri ..] [--json] [--logs]
       npm run paper-fork -- --replay <signature>
       npm run paper-fork -- --refresh | --offline

Launches a coin on a local copy of pump.fun (the real program binaries and accounts, fetched read-only from mainnet
once and cached in data/fork/) with a dev buy of --dev-buy SOL, has a fresh local wallet buy each --outside amount,
and with --sell-all sells the dev's whole bag. Prints exact SOL, tokens, fees, rent and compute units next to
src/chain/curve.ts. --replay re-runs a landed mainnet transaction on the fork and compares every balance change and
the compute units with mainnet. --refresh re-fetches the snapshot; --offline never touches the network.`);
  process.exit(0);
}

const num = (name: string, fallback: number): number => {
  const v = opt(name);
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} expects a number, got ${v}`);
    process.exit(1);
  }
  return n;
};

const devBuySol = num('dev-buy', 3);
const outside = (opt('outside') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
if (outside.some((n) => !Number.isFinite(n) || n <= 0)) {
  console.error(`--outside expects SOL amounts separated by commas, such as 2,1.5,3`);
  process.exit(1);
}
const priority = { microLamports: num('priority', 0) };

const L = 1e9;
const sol = (lamports: bigint | number) => (Number(lamports) / L).toFixed(9);
const tok = (raw: bigint | number) => (Number(raw) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
/** Fork minus prediction, in lamports. */
const lamportDiff = (fork: bigint, predictedSol: number) => {
  const d = Number(fork) - predictedSol * L;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)} lamports`;
};
const row = (label: string, fork: string, predicted = '', diff = '') =>
  console.log(`  ${label.padEnd(40)} ${fork.padStart(26)} ${predicted.padStart(26)}   ${diff}`);
const header = (title: string) => {
  console.log(`\n${title}`);
  row('', 'fork (exact)', 'curve.ts', 'fork - curve.ts');
};

async function openFork(): Promise<PumpFork> {
  return PumpFork.open({ offline: flag('offline'), refresh: flag('refresh'), log: (m) => console.error(m) });
}

function describeSnapshot(fork: PumpFork): void {
  const s = fork.snapshot;
  const ageH = (Date.now() - Date.parse(s.fetchedAt)) / 3.6e6;
  console.log(`pump.fun paper fork: mainnet snapshot at slot ${s.slot}, fetched ${s.fetchedAt} (${ageH.toFixed(1)} h ago)`);
  const pump = s.programs.get('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  console.log(`  pump.fun program deployed at slot ${pump?.deploySlot}; refresh with --refresh after pump.fun upgrades it`);
  const tier = fork.feeConfig.feeTiers[0]?.fees;
  console.log(
    `  fees: protocol ${tier?.protocolFeeBps} bps (${fork.global.buybackBasisPoints.toNumber() / 100}% of it to a buyback wallet), ` +
      `creator ${tier?.creatorFeeBps} bps, ${fork.feeConfig.feeTiers.length} market-cap tier(s); rent ${fork.svm.minimumBalanceForRentExemption(0n) / 128n} lamports per byte`,
  );
}

async function replay(sig: string): Promise<void> {
  const probe = await openFork();
  describeSnapshot(probe);
  const fx = await fetchReplay(config.rpcHttp, sig, (k) => probe.svm.getAccount(k as Address).exists);
  const newer = [...probe.snapshot.programs].filter(([, p]) => p.deploySlot !== null && p.deploySlot > fx.slot);
  for (const [id, p] of newer) console.log(`  note: ${id} was upgraded at slot ${p.deploySlot}, after this transaction (slot ${fx.slot})`);
  const r = replayOnFork(new PumpFork(probe.snapshot), fx);
  console.log(`\nReplay of ${sig} (slot ${fx.slot}) on the fork`);
  if (r.error) console.log(`  fork failed: ${r.error}\n  ${r.logs.join('\n  ')}`);
  console.log(`  compute units: fork ${r.computeUnits.fork}, mainnet ${r.computeUnits.mainnet}`);
  for (const b of r.balances) {
    console.log(`  ${b.key.padEnd(44)} fork ${sol(b.fork).padStart(14)}  mainnet ${sol(b.mainnet).padStart(14)}  ${b.fork === b.mainnet ? 'same' : 'DIFFERENT'}`);
  }
  console.log(r.mismatches === 0 ? '  Exact match.' : `  ${r.mismatches} difference(s).`);
  process.exit(r.mismatches === 0 ? 0 : 1);
}

function printTrade(label: string, r: TradeResult, predicted: { sol: number; tokens?: number; creatorFee: number }) {
  const net = predicted.sol / (1 + CURVE_FEE_RATE);
  if (r.side === 'buy') {
    row(`${label}: SOL into the curve`, sol(r.curveSol), sol(net * L), lamportDiff(r.curveSol, net));
    row(`  protocol fee`, sol(r.protocolFee), sol(net * PROTOCOL_FEE_RATE * L), lamportDiff(r.protocolFee, net * PROTOCOL_FEE_RATE));
    row(`  creator fee`, sol(r.creatorFee), sol(predicted.creatorFee * L), lamportDiff(r.creatorFee, predicted.creatorFee));
    const tokens = (predicted.tokens ?? 0) * 1e6;
    row(`  tokens bought`, tok(r.tokenDelta), tok(tokens), `${tok(Number(r.tokenDelta) - tokens)} tokens`);
  } else {
    const gross = predicted.sol / (1 - CURVE_FEE_RATE);
    row(`${label}: SOL out of the curve`, sol(r.curveSol), sol(gross * L), lamportDiff(r.curveSol, gross));
    row(`  protocol fee`, sol(r.protocolFee), sol(gross * PROTOCOL_FEE_RATE * L), lamportDiff(r.protocolFee, gross * PROTOCOL_FEE_RATE));
    row(`  creator fee`, sol(r.creatorFee), sol(predicted.creatorFee * L), lamportDiff(r.creatorFee, predicted.creatorFee));
    const got = r.curveSol - r.protocolFee - r.creatorFee;
    row(`  SOL received after fees`, sol(got), sol(predicted.sol * L), lamportDiff(got, predicted.sol));
  }
  row(`  rent`, sol(r.rentPaid - r.rentRefunded), '-');
  for (const a of r.rentAccounts) row(`    ${a.label}`, sol(a.lamports));
  row(`  network fee`, sol(r.networkFee), '-');
  row(`  wallet SOL change`, sol(r.solDelta), sol((r.side === 'buy' ? -predicted.sol : predicted.sol) * L));
  const units = r.instructionUnits.map((u) => u.units.toLocaleString('en-US')).join(' + ');
  row(`  compute units`, `${r.computeUnits.toLocaleString('en-US')}`, '', r.instructionUnits.length > 1 ? `(${units})` : '');
  if (r.unexplained !== 0n) row(`  UNEXPLAINED balance change`, sol(r.unexplained));
  if (flag('logs')) console.log(`    ${r.logs.join('\n    ')}`);
}

async function main(): Promise<void> {
  const replaySig = opt('replay');
  if (replaySig) return replay(replaySig);

  const fork = await openFork();
  const curve = new Curve();
  const dev = fork.wallet(devBuySol + 1);
  const name = opt('name') ?? 'Paper Coin';
  const symbol = opt('symbol') ?? 'PAPER';
  const uri = opt('uri') ?? 'https://ipfs.io/ipfs/bafkreipaperforkexamplemetadata';

  const launch: LaunchResult = await fork.launch({ name, symbol, uri, devBuySol, dev, priority });
  const launchPred = curve.buy(devBuySol);
  const buys = [];
  for (const amount of outside) {
    const w = fork.wallet(amount + 1);
    buys.push({ amount, r: await fork.buy(w, launch.mint, amount, { priority }), p: curve.buy(amount) });
  }
  const devTokens = fork.tokens(dev.publicKey, launch.mint);
  const predDevTokens = launchPred.tokens;
  const sell =
    flag('sell-all') && devTokens > 0n ? await fork.sell(dev, launch.mint, undefined, { priority, closeAccount: flag('close-account') }) : null;
  const bagValuePred = curve.sellValue(predDevTokens);
  const sellPred = sell ? curve.sell(predDevTokens) : { sol: 0, creatorFee: 0 };
  const creatorFees = fork.creatorVaultBalance(dev.publicKey);
  const predCreatorFees = launchPred.creatorFee + buys.reduce((s, b) => s + b.p.creatorFee, 0) + sellPred.creatorFee;

  if (flag('json')) {
    const slim = (r: TradeResult) => ({ ...r, logs: flag('logs') ? r.logs : undefined });
    const out = {
      snapshot: { slot: fork.snapshot.slot, fetchedAt: fork.snapshot.fetchedAt },
      launch: slim(launch),
      outside: buys.map((b) => ({ sol: b.amount, fork: slim(b.r), curve: b.p })),
      sell: sell ? slim(sell) : null,
      devBagValue: sell || devTokens === 0n ? null : fork.quoteSell(launch.mint, devTokens),
      creatorFees,
      curve: { launch: launchPred, sell: sell ? sellPred : null, devBagValue: bagValuePred, creatorFees: predCreatorFees, maxDevBuyLoss: maxDevBuyLoss(devBuySol) },
    };
    console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  describeSnapshot(fork);
  console.log(`  create path: create_v2 (Token-2022 coin, normal mode) + dev token account + buy_v2, one transaction`);
  console.log(`  coin ${launch.mint} "${name}" (${symbol}); dev ${launch.creator} (in-memory keypair, fork only)`);

  header(`Launch with a ${devBuySol} SOL dev buy`);
  printTrade('dev buy', launch, launchPred);
  buys.forEach((b, i) => {
    header(`Outside buy ${i + 1}: ${b.amount} SOL from a fresh wallet`);
    printTrade(`buy ${i + 1}`, b.r, b.p);
  });

  if (sell) {
    header(`Dev sells the whole bag (${tok(-sell.tokenDelta)} tokens)`);
    printTrade('dev sell', sell, sellPred);
  } else {
    console.log(`\nDev bag (not sold; add --sell-all)`);
    row('', 'fork (SDK quote)', 'curve.ts');
    row('tokens held', tok(devTokens), tok(predDevTokens * 1e6));
    if (devTokens > 0n) row('SOL from selling it all now', sol(fork.quoteSell(launch.mint, devTokens)), sol(bagValuePred * L));
  }

  const after = fork.curve(launch.mint);
  console.log(`\nCurve after the run: ${sol(after.virtualSol)} virtual SOL against ${tok(after.virtualTokens)} virtual tokens (curve.ts ${curve.vSol.toFixed(9)} / ${curve.vTokens.toLocaleString('en-US', { maximumFractionDigits: 6 })})${after.complete ? ', complete' : ''}`);

  if (sell) {
    const wallet = launch.solDelta + sell.solDelta;
    const rent = launch.rentPaid - launch.rentRefunded + sell.rentPaid - sell.rentRefunded;
    const network = launch.networkFee + sell.networkFee;
    const predWallet = sellPred.sol - devBuySol;
    header('Dev result');
    row('SOL out (launch transaction)', sol(-launch.solDelta), sol(devBuySol * L), lamportDiff(-launch.solDelta, devBuySol));
    row('SOL in (sell transaction)', sol(sell.solDelta), sol(sellPred.sol * L), lamportDiff(sell.solDelta, sellPred.sol));
    row('net wallet change', sol(wallet), sol(predWallet * L), lamportDiff(wallet, predWallet));
    row('  of which rent (still locked)', sol(-rent), '-');
    row('  of which network fees', sol(-network), '-');
    row('net excluding rent and network fees', sol(wallet + rent + network), sol(predWallet * L), lamportDiff(wallet + rent + network, predWallet));
    row('creator fees in the dev\'s vault', sol(creatorFees), sol(predCreatorFees * L), lamportDiff(creatorFees, predCreatorFees));
    row('net including creator fees', sol(wallet + creatorFees), sol((predWallet + predCreatorFees) * L), lamportDiff(wallet + creatorFees, predWallet + predCreatorFees));
    if (outside.length === 0) {
      const tradeLoss = -(wallet + creatorFees) - rent - network;
      row('trading loss (fees only)', sol(tradeLoss), sol(maxDevBuyLoss(devBuySol) * L), `${lamportDiff(tradeLoss, maxDevBuyLoss(devBuySol))} vs maxDevBuyLoss`);
    }
    console.log(`  Creator fees: ${(CREATOR_FEE_RATE * 100).toFixed(2)}% of every trade, claimable from the vault later (one more transaction).`);
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof ForkTxError) {
    console.error(`${err.message}\n  ${err.logs.join('\n  ')}`);
    process.exit(1);
  }
  throw err;
}
