import { readFileSync, statSync } from 'node:fs';
import { BN, BorshCoder, utils, type Idl } from '@coral-xyz/anchor';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type SimulatedTransactionAccountInfo,
  type TokenBalance,
  type TransactionError,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { getTransactionDecoder, type Address } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import {
  OnlinePumpSdk,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  MAYHEM_PROGRAM_ID,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  creatorVaultPda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getGlobalParamsPda,
  getSellSolAmountFromTokenAmount,
  getSolVaultPda,
  quoteAta,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import { config, redactUrl } from '../config.ts';
import { log } from '../log.ts';
import { extractProgramData } from '../chain/decoder.ts';
import { ForkTxError, PumpFork, SIGNATURE_FEE, solToLamports, type ForkOptions } from '../paper/fork.ts';
import { ATA_PROGRAM, NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../paper/snapshot.ts';
import { PreflightError, type LaunchFill, type LaunchParams, type Mode, type SellFill, type Venue } from './types.ts';

/**
 * Where the live launcher launches and sells (the `Venue` interface in types.ts), three ways:
 *
 *   ForkVenue     the local copy of pump.fun (src/paper/fork.ts) with an in-memory dev wallet. The launch and sell
 *                 transactions are built by the same functions as on mainnet and run on pump.fun's real programs, so
 *                 the fork checks the mainnet builders too. Fills are exact and marked `simulated`.
 *   MainnetVenue  mainnet, from the owner's keypair file (LAUNCH_KEYPAIR_PATH). Every launch is simulated first and
 *                 not sent if the simulation fails; sends rebroadcast the same signed bytes until they confirm or their
 *                 blockhash expires, so nothing is re-signed and re-sent while the first copy could still land (if the
 *                 RPC cannot tell, the error says the outcome is unknown).
 *   DryVenue      MainnetVenue that never signs or sends: launches are simulated against mainnet as the owner's public
 *                 key (LAUNCH_PUBKEY) and the fill is read from the simulation; sells are filled at the quote.
 *
 * The launch is what pump.fun's site sends today (see fork.ts and its replay of a site launch): compute budget,
 * `create_v2` (Token-2022, normal mode: `mayhemMode: false` is passed explicitly because Global.mayhem_mode_enabled is
 * true on mainnet), the dev's Token-2022 token account (create-if-missing) and `buy_v2` for the tokens `devBuySol`
 * buys on a fresh curve, capped at `devBuySol` + 1%, in one v0 transaction through pump.fun's address lookup table.
 * The sell is `sell_v2` for the whole bag with a minimum out of the quote less the slippage limit.
 *
 * Helius Sender (SENDER_URL, https://www.helius.dev/docs/sending-transactions/sender, read 2026-10-28) is optional.
 * What this module relies on: every transaction sent to it carries a compute-unit price instruction and a SOL transfer
 * to one of Sender's designated tip accounts (SENDER_TIP_ACCOUNTS; Sender's own list, not Jito's), at least 5,000
 * lamports (1,000,000 and up enters its priority buffer; less is sent best-effort on fewer paths); the request is
 * JSON-RPC `sendTransaction` with base64 encoding, `skipPreflight: true` and `maxRetries: 0`; without an API key Sender
 * accepts 1 request per second per IP, so rebroadcasts to it are spaced 1.1 s apart (0.4 s with `api-key=` in the URL).
 * Without SENDER_URL no tip is added and transactions go to SOLANA_RPC_HTTP only.
 */

/** pump.fun's address lookup table, used by its site's launch transactions (184 accounts on 2026-10-28). */
export const PUMP_LOOKUP_TABLE = new PublicKey('Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP');
/**
 * Compute units depend on the mint: the programs search for each PDA's bump, and every miss costs about 1,500 units.
 * Over 300 random mints on the fork a 5.0625 SOL launch used 203,533 to 257,533 units (median 217,033; the recorded
 * site launch used 221,882), so a fixed 250,000 limit would fail about 2% of launches. A launch is therefore simulated
 * with MAX_LAUNCH_COMPUTE_UNITS and sent asking for what it used plus 10% (pump.fun's site asks for +5%), and mainnet
 * charges the priority fee on that limit. Sells used 68,251 to 102,751 units over the same mints; they are not
 * simulated first (that costs time in a dump), so they ask for a fixed SELL_COMPUTE_UNITS, doubled on the next attempt
 * if one ever runs out.
 */
export const MAX_LAUNCH_COMPUTE_UNITS = 400_000;
export const SELL_COMPUTE_UNITS = 150_000;
/** The unit limit a launch is sent with, given the units its simulation used. */
export const launchUnitLimit = (used: number): number => Math.min(MAX_LAUNCH_COMPUTE_UNITS, Math.ceil((used * 1.1) / 1_000) * 1_000);
/** Helius Sender's designated tip accounts (mainnet-beta), from its documentation. */
export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((k) => new PublicKey(k));
/** Largest dev buy a launch may make: a guard against a mistyped amount, well above the playbook's 5.0625 SOL. */
export const MAX_DEV_BUY_SOL = 10;
/** How long a launch waits for getTransaction before returning a fill from the built transaction. */
export const LAUNCH_FILL_WAIT_MS = 2_000;
/** Rent a launch puts into new accounts (mint, curve, token accounts, creator vault), measured on mainnet's rent. */
export const LAUNCH_RENT_ESTIMATE_LAMPORTS = 9_265_920n;
/** Largest priority fee plus tip one transaction may carry (0.1 SOL), whatever the settings say. */
const MAX_NETWORK_FEE_LAMPORTS = 100_000_000n;
/** The dev buy may cost up to this much over `devBuySol` (100 bps, as pump.fun's site). */
const DEV_BUY_SLIPPAGE_BPS = 100n;
/** Global and FeeConfig (and the lookup table) are re-read after this long. */
const STATE_TTL_MS = 3 * 60_000;
const REBROADCAST_MS = 400;
const SENDER_KEYLESS_INTERVAL_MS = 1_100;
const HEIGHT_CHECK_MS = 2_000;
/** Give up waiting for a confirmation after this long even if the blockhash expiry could not be checked. */
const CONFIRM_TIMEOUT_MS = 90_000;
/** How long to keep asking getTransaction for a landed transaction before reading the fill from balances. */
const FETCH_TX_TIMEOUT_MS = 30_000;
/** Simulations replace the blockhash; this placeholder only fills the field. */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();
/** The Rent sysvar's terms (mainnet on 2026-10-28: 5,080 lamports per byte-year, exempt at one year). */
export interface RentTerms {
  lamportsPerByteYear: bigint;
  exemptionThreshold: number;
}

/** Rent-exempt minimum of an account with `dataLength` bytes, as the runtime computes it (128 bytes of overhead). */
export function rentExempt(rent: RentTerms, dataLength: number): bigint {
  return BigInt(Math.floor(Number(BigInt(128 + dataLength) * rent.lamportsPerByteYear) * rent.exemptionThreshold));
}

const PUMP_IDL = JSON.parse(readFileSync(new URL('../../idl/pump.json', import.meta.url), 'utf8')) as Idl;
const eventCoder = new BorshCoder(PUMP_IDL).events;
const PUMP_ERRORS = new Map((PUMP_IDL.errors ?? []).map((e) => [e.code, e]));
const txDecoder = getTransactionDecoder();
const MINT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('mint-authority')], PUMP_PROGRAM_ID)[0];
const big = (v: { toString(): string } | undefined | null): bigint => (v === undefined || v === null ? 0n : BigInt(v.toString()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(6);

// ---------------------------------------------------------------------------------------------------------------
// Errors

/** A transaction that did not land: its blockhash expired unconfirmed, or (when `uncertain`) its fate is unknown. */
export class NotLandedError extends Error {
  readonly signature: string;
  /** The expiry could not be checked (RPC down): the transaction might still land. */
  readonly uncertain: boolean;
  constructor(message: string, signature: string, uncertain: boolean) {
    super(message);
    this.name = 'NotLandedError';
    this.signature = signature;
    this.uncertain = uncertain;
  }
}

/** A launch that landed on chain but failed: no coin was created, the network fee was spent. */
export class LaunchFailedError extends Error {
  readonly signature: string;
  constructor(message: string, signature: string) {
    super(message);
    this.name = 'LaunchFailedError';
    this.signature = signature;
  }
}

/** Every sell attempt failed: the bag is still held. The message says so in capitals; never swallow this. */
export class SellFailedError extends Error {
  readonly mint: string;
  readonly failures: string[];
  constructor(message: string, mint: string, failures: string[]) {
    super(message);
    this.name = 'SellFailedError';
    this.mint = mint;
    this.failures = failures;
  }
}

/** One sell attempt failed; the ladder re-quotes and tries the next limit unless `fatal`. */
class SellAttemptError extends Error {
  readonly slippage: boolean;
  readonly fatal: boolean;
  /** It ran out of compute units: the next attempt asks for twice as many. */
  readonly budget: boolean;
  constructor(message: string, opts: { slippage?: boolean; fatal?: boolean; budget?: boolean } = {}) {
    super(message);
    this.name = 'SellAttemptError';
    this.slippage = opts.slippage ?? false;
    this.fatal = opts.fatal ?? false;
    this.budget = opts.budget ?? false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transaction building (shared by all three venues)

/** What building a pump.fun transaction needs; mainnet reads it from chain, the fork from its snapshot. */
export interface BuildContext {
  dev: PublicKey;
  global: Global;
  feeConfig: FeeConfig;
  /** pump.fun's lookup table on mainnet, the fork's own on the fork; null builds without one. */
  lookupTable: AddressLookupTableAccount | null;
  blockhash: string;
  priorityMicroLamports: number;
  /** Lamports tipped to a Sender tip account; null adds no tip (not sending through Sender). */
  tipLamports: number | null;
  /** Fee recipients to pay; when absent they are picked from Global, preferring ones in the lookup table. */
  feeRecipient?: PublicKey;
  buybackFeeRecipient?: PublicKey;
  /** Sender tip account; picked at random from SENDER_TIP_ACCOUNTS when absent. */
  tipAccount?: PublicKey;
}

/** An unsigned transaction and what it will cost besides the trade itself. */
export interface BuiltTx {
  tx: VersionedTransaction;
  /** Serialized size in bytes (the limit is 1,232). */
  size: number;
  computeUnitLimit: number;
  priorityMicroLamports: number;
  /** Signature fees, the priority fee (charged on the unit limit) and the Sender tip. */
  networkFeeLamports: bigint;
  tip: { account: PublicKey; lamports: bigint } | null;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

export interface BuiltLaunch extends BuiltTx {
  mint: PublicKey;
  bondingCurve: PublicKey;
  /** Tokens the dev buy asks for (exact: the buy is the first trade on a fresh curve). */
  devTokens: bigint;
  /** The dev buy's cost cap, fees included. */
  maxCostLamports: bigint;
}

export interface BuiltSell extends BuiltTx {
  mint: PublicKey;
  tokens: bigint;
  minLamportsOut: bigint;
}

/** Associated token account, create-if-missing (data [1]); pump.fun's site sends this before the dev buy. */
export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: quoteAta(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/**
 * A fee recipient from `keys` (zero keys and the dev skipped), at random like pump.fun's SDK, preferring those whose
 * wallet and wrapped-SOL account are both in the lookup table (the ones pump.fun's site pays), which keeps the
 * transaction small.
 */
function pickRecipient(keys: PublicKey[], ctx: BuildContext, what: string): PublicKey {
  const inTable = new Set((ctx.lookupTable?.state.addresses ?? []).map((a) => a.toBase58()));
  const usable = keys.filter((k) => !k.equals(PublicKey.default) && !k.equals(ctx.dev));
  const cheap = usable.filter((k) => inTable.has(k.toBase58()) && inTable.has(quoteAta(k, NATIVE_MINT, TOKEN_PROGRAM).toBase58()));
  const pool = cheap.length ? cheap : usable;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) throw new PreflightError(`pump.fun's Global lists no ${what}`, []);
  return pick;
}

/** The protocol and buyback fee recipients a trade pays (Mayhem coins pay the reserved recipients). */
function recipients(ctx: BuildContext, mayhem: boolean): { feeRecipient: PublicKey; buybackFeeRecipient: PublicKey } {
  const g = ctx.global;
  const fee = mayhem ? [g.reservedFeeRecipient, ...g.reservedFeeRecipients] : [g.feeRecipient, ...g.feeRecipients];
  return {
    feeRecipient: ctx.feeRecipient ?? pickRecipient(fee, ctx, 'fee recipient'),
    buybackFeeRecipient: ctx.buybackFeeRecipient ?? pickRecipient(g.buybackFeeRecipients, ctx, 'buyback fee recipient'),
  };
}

function checkPriority(microLamports: number): void {
  if (!Number.isInteger(microLamports) || microLamports < 0 || microLamports > 50_000_000) {
    throw new PreflightError(`priority fee must be a whole number of micro-lamports from 0 to 50,000,000, got ${microLamports}`, []);
  }
}

/** Priority fee in lamports: the unit price times the unit limit, rounded up, as the runtime charges it. */
export function priorityFeeLamports(microLamports: number, units: number): bigint {
  return (BigInt(microLamports) * BigInt(units) + 999_999n) / 1_000_000n;
}

/** Compute budget first, then the instructions, then the Sender tip; compiled to v0 through the lookup table. */
function compile(
  ctx: BuildContext,
  units: number,
  ixs: TransactionInstruction[],
  fees: { feeRecipient: PublicKey; buybackFeeRecipient: PublicKey },
): BuiltTx {
  checkPriority(ctx.priorityMicroLamports);
  if (!Number.isInteger(units) || units < 1 || units > 1_400_000) throw new PreflightError(`bad compute unit limit ${units}`, []);
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ctx.priorityMicroLamports }),
    ...ixs,
  ];
  let tip: BuiltTx['tip'] = null;
  if (ctx.tipLamports !== null) {
    if (!Number.isInteger(ctx.tipLamports) || ctx.tipLamports < 5_000) {
      throw new PreflightError(`Sender tip must be at least 5,000 lamports, got ${ctx.tipLamports}`, []);
    }
    const account = ctx.tipAccount ?? SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)]!;
    all.push(SystemProgram.transfer({ fromPubkey: ctx.dev, toPubkey: account, lamports: ctx.tipLamports }));
    tip = { account, lamports: BigInt(ctx.tipLamports) };
  }
  const message = new TransactionMessage({ payerKey: ctx.dev, recentBlockhash: ctx.blockhash, instructions: all }).compileToV0Message(
    ctx.lookupTable ? [ctx.lookupTable] : [],
  );
  const tx = new VersionedTransaction(message);
  let size: number;
  try {
    size = tx.serialize().length;
  } catch {
    size = Infinity;
  }
  if (size > PACKET_DATA_SIZE) {
    throw new PreflightError(`transaction too large (over ${PACKET_DATA_SIZE} bytes): shorten the name, symbol or metadata URI`, []);
  }
  const signatureFees = SIGNATURE_FEE * BigInt(message.header.numRequiredSignatures);
  const extra = priorityFeeLamports(ctx.priorityMicroLamports, units) + (tip?.lamports ?? 0n);
  if (extra > MAX_NETWORK_FEE_LAMPORTS) throw new PreflightError(`priority fee plus tip of ${sol(extra)} SOL is over the 0.1 SOL guard`, []);
  const networkFeeLamports = signatureFees + extra;
  return { tx, size, computeUnitLimit: units, priorityMicroLamports: ctx.priorityMicroLamports, networkFeeLamports, tip, ...fees };
}

/**
 * The launch transaction, unsigned (signers: the dev, who pays and is the creator, and the mint): compute budget,
 * `create_v2` in normal mode, the dev's Token-2022 account and `buy_v2` for the tokens `devBuySol` (fees included)
 * buys on a fresh curve, capped at `devBuySol` + 1%; then the Sender tip when `ctx.tipLamports` is set. A zero dev buy
 * sends `create_v2` alone. `computeUnits` is the limit: MAX_LAUNCH_COMPUTE_UNITS to simulate, then `launchUnitLimit`.
 */
export async function buildLaunchTransaction(
  ctx: BuildContext,
  p: { name: string; symbol: string; uri: string; devBuySol: number },
  mint: PublicKey,
  computeUnits = MAX_LAUNCH_COMPUTE_UNITS,
): Promise<BuiltLaunch> {
  if (!(p.devBuySol >= 0) || p.devBuySol > MAX_DEV_BUY_SOL) {
    throw new PreflightError(`dev buy must be from 0 to ${MAX_DEV_BUY_SOL} SOL, got ${p.devBuySol}`, []);
  }
  if (!p.name || !p.symbol || !p.uri) throw new PreflightError('a launch needs a name, a symbol and a metadata URI', []);
  const dev = ctx.dev;
  const lamports = solToLamports(p.devBuySol);
  const fees = recipients(ctx, false);
  const ixs = [
    await PUMP_SDK.createV2Instruction({ mint, name: p.name, symbol: p.symbol, uri: p.uri, creator: dev, user: dev, mayhemMode: false }),
  ];
  let devTokens = 0n;
  let maxCostLamports = 0n;
  if (lamports > 0n) {
    devTokens = big(
      getBuyTokenAmountFromSolAmount({
        global: ctx.global,
        feeConfig: ctx.feeConfig,
        mintSupply: null,
        bondingCurve: null,
        amount: new BN(lamports.toString()),
        quoteMint: NATIVE_MINT,
      }),
    );
    if (devTokens <= 0n) throw new PreflightError(`a ${p.devBuySol} SOL dev buy buys no tokens`, []);
    maxCostLamports = lamports + (lamports * DEV_BUY_SLIPPAGE_BPS) / 10_000n;
    ixs.push(createAtaIdempotent(dev, dev, mint, TOKEN_2022_PROGRAM));
    ixs.push(
      await PUMP_SDK.getBuyV2InstructionRaw({
        user: dev,
        mint,
        creator: dev,
        amount: new BN(devTokens.toString()),
        quoteAmount: new BN(maxCostLamports.toString()),
        ...fees,
      }),
    );
  }
  const built = compile(ctx, computeUnits, ixs, fees);
  return { ...built, mint, bondingCurve: bondingCurvePda(mint), devTokens, maxCostLamports };
}

/**
 * The same launch asking for `computeUnits`: same mint, fee recipients and tip account, so the units a simulation of
 * `probe` used hold for it.
 */
export async function resizeLaunch(
  ctx: BuildContext,
  p: { name: string; symbol: string; uri: string; devBuySol: number },
  probe: BuiltLaunch,
  computeUnits: number,
): Promise<BuiltLaunch> {
  const same = { ...ctx, feeRecipient: probe.feeRecipient, buybackFeeRecipient: probe.buybackFeeRecipient, tipAccount: probe.tip?.account };
  return buildLaunchTransaction(same, p, probe.mint, computeUnits);
}

/** The sell transaction, unsigned (signer: the dev): compute budget, `sell_v2` of `tokens` for at least `minLamportsOut`, tip. */
export async function buildSellTransaction(
  ctx: BuildContext,
  s: { mint: PublicKey; creator: PublicKey; tokens: bigint; minLamportsOut: bigint; mayhem: boolean },
  computeUnits = SELL_COMPUTE_UNITS,
): Promise<BuiltSell> {
  if (s.tokens <= 0n) throw new SellAttemptError('nothing to sell', { fatal: true });
  const fees = recipients(ctx, s.mayhem);
  const ix = await PUMP_SDK.getSellV2InstructionRaw({
    user: ctx.dev,
    mint: s.mint,
    creator: s.creator,
    amount: new BN(s.tokens.toString()),
    quoteAmount: new BN((s.minLamportsOut < 0n ? 0n : s.minLamportsOut).toString()),
    ...fees,
  });
  const built = compile(ctx, computeUnits, [ix], fees);
  return { ...built, mint: s.mint, tokens: s.tokens, minLamportsOut: s.minLamportsOut };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers: quotes, slippage, the sell ladder, events and errors

/** Lamports selling `tokens` into `curve` returns after fees, as pump.fun's SDK quotes it. */
export function quoteSellOnCurve(global: Global, feeConfig: FeeConfig, curve: BondingCurve, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  return big(
    getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: new BN(tokens.toString()),
    }),
  );
}

/** The quote less `slippage` (a fraction, 0.1 = 10%), rounded down to the basis point. */
export function minOut(quote: bigint, slippage: number): bigint {
  return quote - (quote * BigInt(Math.round(slippage * 10_000))) / 10_000n;
}

/** The limits a sell tries in order: `maxSlippage`, then each strictly wider one in `ladder`. */
export function slippageLimits(maxSlippage: number, ladder: number[] = []): number[] {
  const ok = (s: number) => Number.isFinite(s) && s >= 0 && s < 1;
  if (!ok(maxSlippage)) throw new Error(`maxSlippage must be a fraction from 0 to under 1, got ${maxSlippage}`);
  const limits = [maxSlippage];
  for (const s of ladder) {
    if (!ok(s)) throw new Error(`sell ladder limits must be fractions from 0 to under 1, got ${s}`);
    if (s > limits[limits.length - 1]!) limits.push(s);
  }
  return limits;
}

const pct = (s: number) => `${(s * 100).toFixed(1)}%`;

/**
 * Runs sell attempts at each limit until one lands. An attempt that fails on slippage, does not land or fails for
 * another retryable reason is followed by a fresh quote at the next wider limit; a fatal failure (nothing to sell, a
 * graduated curve) stops at once; one that ran out of compute units doubles the unit limit for the next. If every
 * attempt fails, throws SellFailedError: the bag is still held.
 */
async function sellLadder(
  mint: string,
  opts: { maxSlippage: number; ladder?: number[] },
  attempt: (slippage: number, n: number, computeUnits: number) => Promise<Omit<SellFill, 'attempts'>>,
): Promise<SellFill> {
  const limits = slippageLimits(opts.maxSlippage, opts.ladder);
  const failures: string[] = [];
  let units = SELL_COMPUTE_UNITS;
  for (const [i, slippage] of limits.entries()) {
    try {
      const fill = await attempt(slippage, i + 1, units);
      if (i > 0) log.info(`sell of ${mint} landed on attempt ${i + 1} (limit ${pct(slippage)})`);
      return { ...fill, attempts: i + 1 };
    } catch (err) {
      const msg = (err as Error).message;
      failures.push(`attempt ${i + 1} (limit ${pct(slippage)}): ${msg}`);
      if (err instanceof SellAttemptError && err.fatal) break;
      if (err instanceof SellAttemptError && err.budget) units = Math.min(1_400_000, units * 2);
      if (!(err instanceof SellAttemptError) && !(err instanceof NotLandedError)) {
        // An unexpected error (RPC, decoding): still retry, since the bag must not be left unsold.
        log.warn(`sell of ${mint}: attempt ${i + 1} hit an unexpected error: ${msg}`);
      }
      log.warn(`sell of ${mint}: attempt ${i + 1} at ${pct(slippage)} failed: ${msg}${i + 1 < limits.length ? '; re-quoting' : ''}`);
    }
  }
  const message = `SELL FAILED, BAG STILL HELD: ${mint} unsold after ${failures.length} attempt(s): ${failures.join(' | ')}`;
  log.error(message);
  throw new SellFailedError(message, mint, failures);
}

/** A pump.fun trade event from a transaction's logs. */
export interface TradeEventFill {
  user: string;
  isBuy: boolean;
  /** SOL into (buy) or out of (sell) the curve, before fees. */
  solAmount: bigint;
  tokenAmount: bigint;
  /** Protocol fee (buyback share included) and creator fee: charged on top of a buy, taken out of a sell. */
  fee: bigint;
  creatorFee: bigint;
}

/** The last pump.fun TradeEvent by `user` in `logs`, or null (no event, or the logs were truncated before it). */
export function lastTradeEvent(logs: string[], user: string): TradeEventFill | null {
  let found: TradeEventFill | null = null;
  for (const item of extractProgramData(logs).items) {
    if (item.program !== PUMP_PROGRAM_ID.toBase58()) continue;
    let decoded;
    try {
      decoded = eventCoder.decode(item.data);
    } catch {
      continue;
    }
    if (decoded?.name !== 'TradeEvent') continue;
    const d = decoded.data as Record<string, { toString(): string } | boolean>;
    if (String(d.user) !== user) continue;
    found = {
      user,
      isBuy: d.is_buy === true,
      solAmount: big(d.sol_amount as { toString(): string }),
      tokenAmount: big(d.token_amount as { toString(): string }),
      fee: big(d.fee as { toString(): string }),
      creatorFee: big(d.creator_fee as { toString(): string }),
    };
  }
  return found;
}

/** The pump.fun custom error code an instruction failed with, from a transaction error (null if not one). */
export function customErrorCode(err: unknown): number | null {
  if (err && typeof err === 'object' && 'InstructionError' in err) {
    const inner = (err as { InstructionError: [number, unknown] }).InstructionError[1];
    if (inner && typeof inner === 'object' && 'Custom' in inner) return Number((inner as { Custom: number }).Custom);
  }
  return null;
}

/** Sell slippage: pump.fun's TooLittleSolReceived (6003), from the error code or the program logs. */
function isSellSlippage(err: unknown, logs: string[]): boolean {
  return customErrorCode(err) === 6003 || logs.some((l) => /TooLittleSolReceived|Error Number: 6003\b/.test(l));
}

/** The transaction ran out of compute units. */
function isBudgetExceeded(err: unknown, logs: string[]): boolean {
  const ix = err && typeof err === 'object' && 'InstructionError' in err ? (err as { InstructionError: [number, unknown] }) : null;
  const inner = ix ? ix.InstructionError[1] : err;
  return String(inner).includes('ComputationalBudgetExceeded') || logs.some((l) => /Computational budget exceeded|exceeded CUs meter/i.test(l));
}

/** The sell attempt failure for a transaction error: slippage, out of compute units, or other. */
function sellFailure(message: string, err: unknown, logs: string[]): SellAttemptError {
  return new SellAttemptError(message, { slippage: isSellSlippage(err, logs), budget: isBudgetExceeded(err, logs) });
}

/** A transaction error in words, with pump.fun's error names and the most telling log lines. */
export function explainTxError(err: TransactionError | string | unknown, logs: string[], dev: string): string {
  let text: string;
  if (err === 'AccountNotFound') {
    text = `the dev wallet ${dev} does not exist on mainnet (it has never held SOL): fund it before launching`;
  } else if (err === 'InsufficientFundsForFee') {
    text = `the dev wallet ${dev} cannot pay the network fee`;
  } else if (err && typeof err === 'object' && 'InsufficientFundsForRent' in err) {
    text = `an account would be left below its rent-exempt minimum (${JSON.stringify(err)}); the dev wallet probably lacks SOL`;
  } else if (err && typeof err === 'object' && 'InstructionError' in err) {
    const [index, inner] = (err as { InstructionError: [number, unknown] }).InstructionError;
    const code = customErrorCode(err);
    const known = code !== null ? PUMP_ERRORS.get(code) : undefined;
    text = known
      ? `instruction ${index} failed: ${known.name} (${code})${known.msg ? `: ${known.msg}` : ''}`
      : `instruction ${index} failed: ${typeof inner === 'string' ? inner : JSON.stringify(inner)}`;
  } else if (err === null || err === undefined) {
    text = '';
  } else {
    text = typeof err === 'string' ? err : JSON.stringify(err);
  }
  const hints = logs.filter((l) => /insufficient|Error Message|failed:|exceeded/i.test(l)).slice(-2);
  return hints.length ? `${text}${text ? ' ' : ''}[${hints.join(' | ')}]` : text;
}

/** Token amount (raw units) of an SPL Token or Token-2022 account's data. */
function tokenAmount(data: Uint8Array): bigint {
  return data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n;
}

function tokenBalanceOf(balances: TokenBalance[] | null | undefined, owner: string, mint: string): bigint {
  const b = balances?.find((t) => t.owner === owner && t.mint === mint);
  return b ? BigInt(b.uiTokenAmount.amount) : 0n;
}

/** Account keys a v0 message writes to, with the lookup table resolved. */
function writableKeys(tx: VersionedTransaction, table: AddressLookupTableAccount | null): string[] {
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: table ? [table] : [] });
  const out: string[] = [];
  for (let i = 0; i < keys.length; i++) if (msg.isAccountWritable(i)) out.push(keys.get(i)!.toBase58());
  return out;
}

/** The dev wallet's keypair from a Solana CLI JSON file. Error messages never quote the file. */
export function loadKeypair(path: string): Keypair {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the launch keypair file ${path} (${(err as NodeJS.ErrnoException).code ?? 'read error'})`);
  }
  const bad = `the launch keypair file ${path} is not a Solana CLI keypair (a JSON array of 64 numbers)`;
  let bytes: unknown;
  try {
    bytes = JSON.parse(raw);
  } catch {
    throw new Error(bad);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error(bad);
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    throw new Error(`the launch keypair file ${path} holds an invalid key`);
  }
  try {
    if (statSync(path).mode & 0o077) log.warn(`the launch keypair file ${path} is readable by other users; chmod 600 it`);
  } catch {
    // permissions are advisory
  }
  return kp;
}

/** The launch wallet's public key from LAUNCH_PUBKEY or the keypair file; both must agree when both are set. */
export function launchPublicKey(): PublicKey {
  const fromFile = config.launchKeypairPath ? loadKeypair(config.launchKeypairPath).publicKey : null;
  let fromEnv: PublicKey | null = null;
  if (config.launchPubkey) {
    try {
      fromEnv = new PublicKey(config.launchPubkey);
    } catch {
      throw new Error(`LAUNCH_PUBKEY is not a valid public key`);
    }
  }
  if (fromFile && fromEnv && !fromFile.equals(fromEnv)) {
    throw new Error(`LAUNCH_PUBKEY ${fromEnv.toBase58()} is not the key in LAUNCH_KEYPAIR_PATH (${fromFile.toBase58()})`);
  }
  const key = fromEnv ?? fromFile;
  if (!key) throw new Error('set LAUNCH_PUBKEY (dry mode) or LAUNCH_KEYPAIR_PATH (live mode) in .env');
  return key;
}

// ---------------------------------------------------------------------------------------------------------------
// ForkVenue

/** Address lookup table account data holding `keys`: a 56-byte header (active, never deactivated), then the keys. */
function lookupTableData(keys: PublicKey[]): Buffer {
  const data = Buffer.alloc(56 + 32 * keys.length);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4);
  data.writeBigUInt64LE(0n, 12);
  keys.forEach((k, i) => k.toBuffer().copy(data, 56 + 32 * i));
  return data;
}

interface ForkView {
  exists: boolean;
  lamports: bigint;
  data: Uint8Array;
}

interface ForkSent {
  signature: string;
  logs: string[];
  computeUnits: number;
  keys: string[];
  pre: Map<string, ForkView>;
  post: Map<string, ForkView>;
}

/**
 * The venue on the local fork of pump.fun. The dev is an in-memory keypair funded on the fork only. Launches and sells
 * are built by `buildLaunchTransaction` / `buildSellTransaction` (the mainnet builders, minus the Sender tip) and run
 * on pump.fun's real programs; the fork's own lookup table stands in for pump.fun's. `fork` is exposed so tests and
 * the paper loop can have other local wallets trade the coin.
 */
export class ForkVenue implements Venue {
  readonly mode: Mode = 'fork';
  readonly fork: PumpFork;
  readonly wallet: Keypair;
  readonly dev: string;
  priorityMicroLamports: number;
  /**
   * For tests and paper runs: called after a sell attempt's quote and before it is sent, e.g. to have another wallet
   * dump in between and make the attempt fail on slippage.
   */
  beforeSellSend: ((attempt: number, mint: string) => void | Promise<void>) | null = null;
  private readonly table: AddressLookupTableAccount;

  constructor(fork: PumpFork, opts: { devSol?: number; priorityMicroLamports?: number } = {}) {
    this.fork = fork;
    this.wallet = fork.wallet(opts.devSol ?? 20);
    this.dev = this.wallet.publicKey.toBase58();
    this.priorityMicroLamports = opts.priorityMicroLamports ?? config.priorityMicroLamports;
    const tableKey = PublicKey.findProgramAddressSync([Buffer.from('fork-venue')], AddressLookupTableProgram.programId)[0];
    const data = lookupTableData([
      GLOBAL_PDA,
      PUMP_FEE_CONFIG_PDA,
      PUMP_FEE_PROGRAM_ID,
      GLOBAL_VOLUME_ACCUMULATOR_PDA,
      PUMP_EVENT_AUTHORITY_PDA,
      PUMP_PROGRAM_ID,
      MAYHEM_PROGRAM_ID,
      getGlobalParamsPda(),
      getSolVaultPda(),
      MINT_AUTHORITY,
      SystemProgram.programId,
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM,
      ATA_PROGRAM,
      NATIVE_MINT,
      fork.feeRecipient,
      fork.buybackRecipient,
      quoteAta(fork.feeRecipient, NATIVE_MINT, TOKEN_PROGRAM),
      quoteAta(fork.buybackRecipient, NATIVE_MINT, TOKEN_PROGRAM),
    ]);
    fork.svm.setAccount({
      address: tableKey.toBase58() as Address,
      lamports: fork.svm.minimumBalanceForRentExemption(BigInt(data.length)) as never,
      programAddress: AddressLookupTableProgram.programId.toBase58() as Address,
      executable: false,
      data,
      space: BigInt(data.length),
    });
    this.table = new AddressLookupTableAccount({ key: tableKey, state: AddressLookupTableAccount.deserialize(data) });
  }

  /** Opens the fork (cached mainnet snapshot, fetched once if missing) and funds a fresh dev wallet with `devSol`. */
  static async open(opts: ForkOptions & { devSol?: number; priorityMicroLamports?: number } = {}): Promise<ForkVenue> {
    return new ForkVenue(await PumpFork.open(opts), opts);
  }

  private ctx(priority?: number): BuildContext {
    this.fork.svm.expireBlockhash(); // a fresh blockhash per transaction, so a repeated one is not a replay
    return {
      dev: this.wallet.publicKey,
      global: this.fork.global,
      feeConfig: this.fork.feeConfig,
      lookupTable: this.table,
      blockhash: this.fork.svm.latestBlockhash(),
      priorityMicroLamports: priority ?? this.priorityMicroLamports,
      tipLamports: null,
      feeRecipient: this.fork.feeRecipient,
      buybackFeeRecipient: this.fork.buybackRecipient,
    };
  }

  private view(key: string): ForkView {
    const a = this.fork.svm.getAccount(key as Address);
    if (!a.exists) return { exists: false, lamports: 0n, data: new Uint8Array() };
    return { exists: true, lamports: BigInt(a.lamports), data: a.data };
  }

  private simulate(tx: VersionedTransaction): { computeUnits: number; logs: string[] } {
    const res = this.fork.svm.simulateTransaction(txDecoder.decode(tx.serialize()));
    const meta = res.meta();
    const logs = meta.logs();
    if (res instanceof FailedTransactionMetadata) {
      throw new PreflightError(`launch would fail on the fork: ${res.err().toString()} ${explainTxError(null, logs, this.dev)}`, logs);
    }
    return { computeUnits: Number(meta.computeUnitsConsumed()), logs };
  }

  private execute(tx: VersionedTransaction): ForkSent {
    const keys = tx.message
      .getAccountKeys({ addressLookupTableAccounts: [this.table] })
      .keySegments()
      .flat()
      .map((k) => k.toBase58());
    const pre = new Map(keys.map((k) => [k, this.view(k)]));
    const res = this.fork.svm.sendTransaction(txDecoder.decode(tx.serialize()));
    if (res instanceof FailedTransactionMetadata) {
      const meta = res.meta();
      throw new ForkTxError(`fork transaction failed: ${res.err().toString()}`, meta.logs(), Number(meta.computeUnitsConsumed()));
    }
    return {
      signature: utils.bytes.bs58.encode(res.signature()),
      logs: res.logs(),
      computeUnits: Number(res.computeUnitsConsumed()),
      keys,
      pre,
      post: new Map(keys.map((k) => [k, this.view(k)])),
    };
  }

  async balanceLamports(): Promise<bigint> {
    return this.fork.balance(this.wallet.publicKey);
  }

  /** Simulates the launch at the maximum unit limit, then builds it asking for what it used plus 10%, signed. */
  private async preflight(p: LaunchParams, mint: Keypair): Promise<{ built: BuiltLaunch; computeUnits: number; logs: string[] }> {
    const ctx = this.ctx(p.priorityMicroLamports);
    const probe = await buildLaunchTransaction(ctx, p, mint.publicKey);
    probe.tx.sign([this.wallet, mint]);
    const sim = this.simulate(probe.tx);
    if (sim.computeUnits > MAX_LAUNCH_COMPUTE_UNITS * 0.97) {
      throw new PreflightError(`launch used ${sim.computeUnits} of its ${MAX_LAUNCH_COMPUTE_UNITS} compute units`, sim.logs);
    }
    const built = await resizeLaunch(ctx, p, probe, launchUnitLimit(sim.computeUnits));
    built.tx.sign([this.wallet, mint]);
    return { built, ...sim };
  }

  async preflightLaunch(p: LaunchParams): Promise<{ computeUnits: number; logs: string[] }> {
    const { computeUnits, logs } = await this.preflight(p, p.mintSecret ? Keypair.fromSecretKey(p.mintSecret) : Keypair.generate());
    return { computeUnits, logs };
  }

  /** Preflights, then runs the launch on the fork; the fill is exact (rent from the accounts the launch created). */
  async launch(p: LaunchParams): Promise<LaunchFill> {
    const mint = p.mintSecret ? Keypair.fromSecretKey(p.mintSecret) : Keypair.generate();
    const { built } = await this.preflight(p, mint);
    let sent: ForkSent;
    try {
      sent = this.execute(built.tx);
    } catch (err) {
      if (err instanceof ForkTxError) throw new PreflightError(`launch failed on the fork: ${err.message}`, err.logs);
      throw err;
    }
    const ata = quoteAta(this.wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM).toBase58();
    const devTokens = tokenAmount(sent.post.get(ata)?.data ?? new Uint8Array()) - tokenAmount(sent.pre.get(ata)?.data ?? new Uint8Array());
    let rent = 0n;
    for (const k of sent.keys) {
      const before = sent.pre.get(k)!;
      const after = sent.post.get(k)!;
      if (!before.exists && after.exists) rent += this.fork.svm.minimumBalanceForRentExemption(BigInt(after.data.length));
    }
    const ev = lastTradeEvent(sent.logs, this.dev);
    const spent = ev ? ev.solAmount + ev.fee + ev.creatorFee : 0n;
    const delta = sent.post.get(this.dev)!.lamports - sent.pre.get(this.dev)!.lamports;
    const unexplained = delta + spent + rent + built.networkFeeLamports;
    if (unexplained !== 0n) log.warn(`fork launch: ${unexplained} lamports of the dev's balance change are unexplained`);
    return {
      mint: mint.publicKey.toBase58(),
      signature: sent.signature,
      slot: Number(this.fork.svm.getClock().slot),
      landedAt: Date.now(),
      devTokens,
      lamportsSpent: spent,
      rentLamports: rent,
      networkFeeLamports: built.networkFeeLamports,
      simulated: true,
    };
  }

  async quoteSell(mint: string, tokens: bigint): Promise<bigint> {
    return tokens > 0n ? this.fork.quoteSell(mint, tokens) : 0n;
  }

  async tokenBalance(mint: string): Promise<bigint> {
    return this.fork.tokens(this.wallet.publicKey, mint);
  }

  async sellAll(mint: string, opts: { maxSlippage: number; ladder?: number[]; priorityMicroLamports?: number }): Promise<SellFill> {
    const m = new PublicKey(mint);
    return sellLadder(mint, opts, async (slippage, attempt, units) => {
      const tokens = this.fork.tokens(this.wallet.publicKey, m);
      if (tokens <= 0n) throw new SellAttemptError(`the dev holds no ${mint} tokens`, { fatal: true });
      const curve = this.fork.curve(m);
      if (curve.complete) throw new SellAttemptError('the bonding curve is complete (graduated); sell on PumpSwap', { fatal: true });
      const limit = minOut(this.fork.quoteSell(m, tokens), slippage);
      if (this.beforeSellSend) await this.beforeSellSend(attempt, mint);
      const built = await buildSellTransaction(
        this.ctx(opts.priorityMicroLamports),
        { mint: m, creator: new PublicKey(curve.creator), tokens, minLamportsOut: limit, mayhem: false },
        units,
      );
      built.tx.sign([this.wallet]);
      let sent: ForkSent;
      try {
        sent = this.execute(built.tx);
      } catch (err) {
        if (!(err instanceof ForkTxError)) throw err;
        throw sellFailure(`${err.message} ${explainTxError(null, err.logs, this.dev)}`, err.message, err.logs);
      }
      const ata = quoteAta(this.wallet.publicKey, m, TOKEN_2022_PROGRAM).toBase58();
      const tokensSold = tokenAmount(sent.pre.get(ata)!.data) - tokenAmount(sent.post.get(ata)!.data);
      const delta = sent.post.get(this.dev)!.lamports - sent.pre.get(this.dev)!.lamports;
      const ev = lastTradeEvent(sent.logs, this.dev);
      return {
        signature: sent.signature,
        landedAt: Date.now(),
        tokensSold,
        lamportsReceived: ev ? ev.solAmount - ev.fee - ev.creatorFee : delta + built.networkFeeLamports,
        networkFeeLamports: built.networkFeeLamports,
        simulated: true,
      };
    });
  }

  async creatorVaultLamports(): Promise<bigint> {
    return this.fork.creatorVaultBalance(this.wallet.publicKey);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MainnetVenue and DryVenue

/** Global, FeeConfig, pump.fun's lookup table and the Rent sysvar, as read from mainnet. */
export interface PumpState {
  at: number;
  global: Global;
  feeConfig: FeeConfig;
  lookupTable: AddressLookupTableAccount;
  rent: RentTerms;
}

export interface MainnetVenueOptions {
  /** Default SOLANA_RPC_HTTP. */
  rpcUrl?: string;
  /** Default SENDER_URL; null sends to the RPC only, without a tip. */
  senderUrl?: string | null;
  /** Default SENDER_TIP_LAMPORTS. */
  tipLamports?: number;
  /** Default PRIORITY_MICROLAMPORTS. */
  priorityMicroLamports?: number;
  /** pump.fun state to start from (e.g. to build transactions offline in tests); re-read from mainnet when it ages out. */
  state?: PumpState;
  /** How long to ask getTransaction for a landed transaction before reading the fill from balances (default 30 s). */
  fillTimeoutMs?: number;
}

interface Landed {
  signature: string;
  slot: number;
  err: TransactionError | null;
  landedAt: number;
}

/** One JSON-RPC POST with a timeout and no retries (the send loop rebroadcasts on its own schedule). */
async function postJson(url: string, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/**
 * Mainnet: launches and sells from the owner's wallet. Reads use SOLANA_RPC_HTTP; sends go to it and, when set, to
 * Helius Sender. Global, FeeConfig and pump.fun's lookup table are cached for three minutes. Nothing is ever sent
 * unless the venue was made with the owner's keypair in mode 'live'.
 */
export class MainnetVenue implements Venue {
  readonly mode: Mode;
  readonly dev: string;
  readonly devKey: PublicKey;
  readonly connection: Connection;
  protected readonly rpcUrl: string;
  protected readonly senderUrl: string | null;
  protected readonly tipLamports: number;
  protected readonly priorityMicroLamports: number;
  private readonly fillTimeoutMs: number;
  /** Only a live venue holds the owner's keypair; dry and shadow venues hold the public key alone. */
  readonly #signer: Keypair | null;
  private state: PumpState | null = null;

  constructor(wallet: Keypair | PublicKey, opts: MainnetVenueOptions & { mode?: Mode } = {}) {
    this.mode = opts.mode ?? 'live';
    if (this.mode === 'fork') throw new Error('MainnetVenue cannot run in fork mode; use ForkVenue');
    if (this.mode === 'live' && !(wallet instanceof Keypair)) throw new Error('a live venue needs the launch keypair');
    this.#signer = this.mode === 'live' && wallet instanceof Keypair ? wallet : null;
    this.devKey = wallet instanceof Keypair ? wallet.publicKey : wallet;
    this.dev = this.devKey.toBase58();
    this.rpcUrl = opts.rpcUrl ?? config.rpcHttp;
    this.connection = new Connection(this.rpcUrl, { commitment: 'confirmed' });
    this.senderUrl = opts.senderUrl === undefined ? config.senderUrl : opts.senderUrl;
    this.tipLamports = opts.tipLamports ?? config.senderTipLamports;
    this.priorityMicroLamports = opts.priorityMicroLamports ?? config.priorityMicroLamports;
    this.state = opts.state ?? null;
    this.fillTimeoutMs = opts.fillTimeoutMs ?? FETCH_TX_TIMEOUT_MS;
    if (this.senderUrl && this.tipLamports < 1_000_000 && !/swqos_only=true/.test(this.senderUrl)) {
      log.warn(`Sender tip ${this.tipLamports} lamports is under the 1,000,000 its priority routing wants: sent best-effort`);
    }
  }

  /** The live venue from LAUNCH_KEYPAIR_PATH (checked against LAUNCH_PUBKEY when that is set too). */
  static fromConfig(opts: MainnetVenueOptions = {}): MainnetVenue {
    if (!config.launchKeypairPath) throw new Error('live mode needs LAUNCH_KEYPAIR_PATH in .env');
    const kp = loadKeypair(config.launchKeypairPath);
    if (!launchPublicKey().equals(kp.publicKey)) throw new Error('LAUNCH_PUBKEY does not match the launch keypair');
    return new MainnetVenue(kp, { ...opts, mode: 'live' });
  }

  private requireSigner(): Keypair {
    if (this.mode !== 'live' || !this.#signer) throw new Error(`a ${this.mode} venue never signs or sends transactions`);
    return this.#signer;
  }

  /** Global, FeeConfig, the lookup table and Rent in one read; a stale copy is used for sells if the refresh fails. */
  protected async pumpState(opts: { allowStale?: boolean } = {}): Promise<PumpState> {
    if (this.state && Date.now() - this.state.at < STATE_TTL_MS) return this.state;
    try {
      const [g, f, t, r] = await this.connection.getMultipleAccountsInfo(
        [GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_LOOKUP_TABLE, SYSVAR_RENT_PUBKEY],
        'confirmed',
      );
      if (!g || !f) throw new Error('pump.fun Global or FeeConfig account not found');
      if (!t || !t.owner.equals(AddressLookupTableProgram.programId)) {
        throw new Error(`pump.fun's lookup table ${PUMP_LOOKUP_TABLE.toBase58()} not found`);
      }
      if (!r || r.data.length < 17) throw new Error('Rent sysvar not found');
      const lookupTable = new AddressLookupTableAccount({ key: PUMP_LOOKUP_TABLE, state: AddressLookupTableAccount.deserialize(t.data) });
      if (!lookupTable.isActive()) throw new Error(`pump.fun's lookup table ${PUMP_LOOKUP_TABLE.toBase58()} is deactivated`);
      const global = PUMP_SDK.decodeGlobal(g);
      if (!global.createV2Enabled) throw new Error('pump.fun has create_v2 disabled');
      const rent = { lamportsPerByteYear: r.data.readBigUInt64LE(0), exemptionThreshold: r.data.readDoubleLE(8) };
      this.state = { at: Date.now(), global, feeConfig: PUMP_SDK.decodeFeeConfig(f), lookupTable, rent };
      return this.state;
    } catch (err) {
      if (opts.allowStale && this.state) {
        log.warn(`using pump.fun state from ${Math.round((Date.now() - this.state.at) / 1000)} s ago: ${(err as Error).message}`);
        return this.state;
      }
      throw err;
    }
  }

  protected ctx(state: PumpState, blockhash: string, priority?: number): BuildContext {
    return {
      dev: this.devKey,
      global: state.global,
      feeConfig: state.feeConfig,
      lookupTable: state.lookupTable,
      blockhash,
      priorityMicroLamports: priority ?? this.priorityMicroLamports,
      tipLamports: this.senderUrl ? this.tipLamports : null,
    };
  }

  /** Builds the launch at the maximum unit limit (and checks its size and fees) without signing it. */
  async buildLaunch(p: LaunchParams, mint: PublicKey, blockhash = PLACEHOLDER_BLOCKHASH): Promise<BuiltLaunch> {
    return buildLaunchTransaction(this.ctx(await this.pumpState(), blockhash, p.priorityMicroLamports), p, mint);
  }

  /**
   * The launch preflight: simulates it at MAX_LAUNCH_COMPUTE_UNITS and returns it rebuilt (same mint, recipients and
   * tip account, unsigned) asking for the units the simulation used plus 10%.
   */
  protected async preflight(
    p: LaunchParams,
    mint: PublicKey,
    blockhash = PLACEHOLDER_BLOCKHASH,
    addresses: string[] = [],
  ): Promise<{ built: BuiltLaunch; sim: Awaited<ReturnType<MainnetVenue['simulate']>> }> {
    const ctx = this.ctx(await this.pumpState(), blockhash, p.priorityMicroLamports);
    const probe = await buildLaunchTransaction(ctx, p, mint);
    const sim = await this.simulate(probe, 'launch', addresses);
    return { built: await resizeLaunch(ctx, p, probe, launchUnitLimit(sim.computeUnits)), sim };
  }

  /**
   * simulateTransaction against mainnet (signatures not checked, latest blockhash substituted). Throws PreflightError
   * with the logs if it fails, if the RPC cannot simulate, or if it needs within 3% of the unit limit.
   */
  protected async simulate(
    built: BuiltTx,
    what: string,
    addresses: string[] = [],
  ): Promise<{ computeUnits: number; logs: string[]; accounts: (SimulatedTransactionAccountInfo | null)[]; slot: number }> {
    let res;
    try {
      res = await this.connection.simulateTransaction(built.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        ...(addresses.length ? { accounts: { encoding: 'base64' as const, addresses } } : {}),
      });
    } catch (err) {
      throw new PreflightError(`${what} could not be simulated (${redactUrl(this.rpcUrl)}): ${(err as Error).message}`, []);
    }
    const logs = res.value.logs ?? [];
    if (res.value.err) throw new PreflightError(`${what} would fail: ${explainTxError(res.value.err, logs, this.dev)}`, logs);
    const computeUnits = res.value.unitsConsumed ?? 0;
    if (!(computeUnits > 0) || computeUnits > built.computeUnitLimit * 0.97) {
      throw new PreflightError(`${what} used ${computeUnits} of its ${built.computeUnitLimit} compute units`, logs);
    }
    return { computeUnits, logs, accounts: res.value.accounts ?? [], slot: res.context.slot };
  }

  async preflightLaunch(p: LaunchParams): Promise<{ computeUnits: number; logs: string[] }> {
    const mint = p.mintSecret ? Keypair.fromSecretKey(p.mintSecret).publicKey : Keypair.generate().publicKey;
    const { sim } = await this.preflight(p, mint);
    return { computeUnits: sim.computeUnits, logs: sim.logs };
  }

  async balanceLamports(): Promise<bigint> {
    return BigInt(await this.connection.getBalance(this.devKey, 'confirmed'));
  }

  /**
   * Preflights the transaction it will send (fail closed; only the unit limit is then set from the simulation), signs
   * it with the dev and mint keys, sends it with skipPreflight and no RPC retries, rebroadcasts the same bytes every
   * 0.4 s until it confirms or its blockhash expires, then reads the fill from getTransaction. Throws NotLandedError
   * (nothing was created, unless `uncertain`) or LaunchFailedError (it landed and failed: no coin, fee spent).
   */
  async launch(p: LaunchParams): Promise<LaunchFill> {
    const signer = this.requireSigner();
    const mint = p.mintSecret ? Keypair.fromSecretKey(p.mintSecret) : Keypair.generate();
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const { built, sim } = await this.preflight(p, mint.publicKey, blockhash);
    log.info(
      `launch preflight passed: ${sim.computeUnits} compute units (limit ${built.computeUnitLimit}), ${built.size} bytes; ` +
        `sending ${mint.publicKey.toBase58()}`,
    );
    built.tx.sign([signer, mint]);
    const landed = await this.sendAndConfirm(built.tx, lastValidBlockHeight, `launch of ${mint.publicKey.toBase58()}`);
    if (landed.err) {
      throw new LaunchFailedError(
        `launch ${landed.signature} landed but failed (${explainTxError(landed.err, [], this.dev)}): no coin was created`,
        landed.signature,
      );
    }
    return this.launchFill(built, landed);
  }

  /**
   * The launch fill from the landed transaction if the RPC has it within `LAUNCH_FILL_WAIT_MS`, else from what was
   * built: the exit must start at once (it runs from the moment the launch lands), so the launch never waits longer for
   * its exact accounting, and nothing after the landing can throw (a throw would look like no launch while the bag is
   * held). The fallback's dev tokens are exact (buy_v2 buys a set amount); its rent is the measured figure.
   */
  private async launchFill(built: BuiltLaunch, landed: Landed): Promise<LaunchFill> {
    const mint = built.mint.toBase58();
    const base = { mint, signature: landed.signature, slot: landed.slot, landedAt: landed.landedAt, simulated: false };
    const tip = built.tip?.lamports ?? 0n;
    const tx = await this.fetchTransaction(landed.signature, LAUNCH_FILL_WAIT_MS).catch(() => null);
    if (tx?.meta) {
      const meta = tx.meta;
      const devTokens = tokenBalanceOf(meta.postTokenBalances, this.dev, mint) - tokenBalanceOf(meta.preTokenBalances, this.dev, mint);
      const delta = BigInt(meta.postBalances[0]!) - BigInt(meta.preBalances[0]!);
      const networkFee = BigInt(meta.fee) + tip;
      const ev = lastTradeEvent(meta.logMessages ?? [], this.dev);
      const spent = ev ? ev.solAmount + ev.fee + ev.creatorFee : this.freshBuyCost(devTokens);
      // Rent is what is left of the dev's balance change: the accounts the launch created.
      return { ...base, devTokens, lamportsSpent: spent, rentLamports: -delta - spent - networkFee, networkFeeLamports: networkFee };
    }
    return {
      ...base,
      devTokens: built.devTokens,
      lamportsSpent: this.freshBuyCost(built.devTokens),
      rentLamports: LAUNCH_RENT_ESTIMATE_LAMPORTS,
      networkFeeLamports: built.networkFeeLamports,
    };
  }

  /** What `tokens` cost as the first buy on a fresh curve, fees included (curve math; used only as a fallback). */
  private freshBuyCost(tokens: bigint): bigint {
    if (!this.state || tokens <= 0n) return 0n;
    return big(
      getBuySolAmountFromTokenAmount({
        global: this.state.global,
        feeConfig: this.state.feeConfig,
        mintSupply: null,
        bondingCurve: null,
        amount: new BN(tokens.toString()),
        quoteMint: NATIVE_MINT,
      }),
    );
  }

  private async fetchTransaction(signature: string, timeoutMs = this.fillTimeoutMs): Promise<VersionedTransactionResponse | null> {
    const deadline = Date.now() + timeoutMs;
    for (let i = 1; Date.now() < deadline; i++) {
      try {
        const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (tx) return tx;
      } catch (err) {
        log.debug(`getTransaction ${signature}: ${(err as Error).message}`);
      }
      await sleep(Math.min(5_000, 1_000 * i, Math.max(0, deadline - Date.now())));
    }
    log.warn(`getTransaction returned nothing for ${signature} in ${timeoutMs / 1000} s; using the built transaction's figures`);
    return null;
  }

  private async status(signature: string, history = false) {
    try {
      const res = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: history });
      return res.value[0] ?? null;
    } catch (err) {
      log.debug(`getSignatureStatuses ${signature}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Sends signed bytes and waits for a confirmed status. The same bytes go out every 0.4 s (Sender: every 1.1 s without
   * an API key) until the signature confirms, the confirmed block height passes `lastValidBlockHeight` (the blockhash
   * expired, so it can never land: NotLandedError), or 90 s pass without the expiry being checkable (NotLandedError
   * with `uncertain`). Returns the landed status, which carries `err` if the transaction failed on chain.
   */
  protected async sendAndConfirm(tx: VersionedTransaction, lastValidBlockHeight: number, label: string): Promise<Landed> {
    this.requireSigner();
    const wire = Buffer.from(tx.serialize()).toString('base64');
    const signature = utils.bytes.bs58.encode(tx.signatures[0]!);
    const params = [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }];
    const senderInterval = this.senderUrl && /[?&]api-key=/.test(this.senderUrl) ? REBROADCAST_MS : SENDER_KEYLESS_INTERVAL_MS;
    const started = Date.now();
    let rpcBusy = false;
    let senderBusy = false;
    let lastSender = -Infinity;
    let lastHeightCheck = started;
    let sends = 0;
    let accepted = 0;
    let lastError = '';
    const failed = (where: string) => (err: unknown) => {
      lastError = `${where}: ${(err as Error).message}`;
      log.debug(`${label}: ${lastError}`);
    };
    const broadcast = () => {
      if (!rpcBusy) {
        rpcBusy = true;
        sends++;
        postJson(this.rpcUrl, 'sendTransaction', params, 5_000)
          .then(() => accepted++, failed('RPC'))
          .finally(() => (rpcBusy = false));
      }
      if (this.senderUrl && !senderBusy && Date.now() - lastSender >= senderInterval) {
        senderBusy = true;
        lastSender = Date.now();
        postJson(this.senderUrl, 'sendTransaction', params, 5_000)
          .then(() => accepted++, failed('Sender'))
          .finally(() => (senderBusy = false));
      }
    };
    const why = () => (accepted ? '' : ` (no endpoint accepted it; last error ${lastError || 'none'})`);
    const landed = (s: { slot: number; err: TransactionError | null; confirmationStatus?: string } | null): Landed | null =>
      s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')
        ? { signature, slot: s.slot, err: s.err, landedAt: Date.now() }
        : null;
    log.info(`${label}: sending ${signature}${this.senderUrl ? ' (RPC and Sender)' : ''}`);
    for (;;) {
      broadcast();
      await sleep(REBROADCAST_MS);
      const done = landed(await this.status(signature));
      if (done) {
        const how = done.err ? 'landed with an error' : 'confirmed';
        log.info(`${label}: ${how} in slot ${done.slot} after ${Date.now() - started} ms (${sends} sends)`);
        return done;
      }
      if (Date.now() - lastHeightCheck >= HEIGHT_CHECK_MS) {
        lastHeightCheck = Date.now();
        const height = await this.connection.getBlockHeight('confirmed').catch(() => null);
        if (height !== null && height > lastValidBlockHeight) {
          const last = landed(await this.status(signature, true));
          if (last) return last;
          throw new NotLandedError(`${label}: ${signature} did not land before its blockhash expired${why()}`, signature, false);
        }
      }
      if (Date.now() - started > CONFIRM_TIMEOUT_MS) {
        const last = landed(await this.status(signature, true));
        if (last) return last;
        throw new NotLandedError(
          `${label}: ${signature} unconfirmed after ${CONFIRM_TIMEOUT_MS / 1000} s and the blockhash expiry could not be checked: ` +
            `its outcome is unknown${why()}`,
          signature,
          true,
        );
      }
    }
  }

  /** The dev's bonding curve read for a sell (processed commitment: the freshest state). */
  protected async fetchCurve(mint: PublicKey): Promise<BondingCurve> {
    const info = await this.connection.getAccountInfo(bondingCurvePda(mint), 'processed');
    if (!info) throw new Error(`no pump.fun bonding curve for ${mint.toBase58()}`);
    return PUMP_SDK.decodeBondingCurve(info);
  }

  async quoteSell(mint: string, tokens: bigint): Promise<bigint> {
    if (tokens <= 0n) return 0n;
    const [curve, state] = await Promise.all([this.fetchCurve(new PublicKey(mint)), this.pumpState({ allowStale: true })]);
    if (curve.complete) throw new Error(`${mint}'s bonding curve is complete (graduated to PumpSwap): no curve quote`);
    return quoteSellOnCurve(state.global, state.feeConfig, curve, tokens);
  }

  async tokenBalance(mint: string): Promise<bigint> {
    const info = await this.connection.getAccountInfo(quoteAta(this.devKey, new PublicKey(mint), TOKEN_2022_PROGRAM), 'confirmed');
    return info ? tokenAmount(info.data) : 0n;
  }

  /**
   * Sells the whole bag: reads the balance, quotes against the freshly read curve, sends `sell_v2` with a minimum of
   * the quote less the limit, and on failure re-quotes at each wider limit in `ladder`. Each attempt waits until its
   * blockhash expires before the next is built, so two attempts can never both land; and every attempt sells the
   * balance read fresh, so a late landing can never oversell. Throws SellFailedError if no attempt lands.
   */
  async sellAll(mint: string, opts: { maxSlippage: number; ladder?: number[]; priorityMicroLamports?: number }): Promise<SellFill> {
    const signer = this.requireSigner();
    const m = new PublicKey(mint);
    const sent: { built: BuiltSell; before: bigint; signature: string }[] = [];
    /** An earlier attempt whose outcome was unknown (RPC trouble) that landed after all. */
    const lateLanding = async (): Promise<Omit<SellFill, 'attempts'> | null> => {
      for (const s of sent) {
        const st = await this.status(s.signature, true);
        if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
          return this.sellFill(s.built, { signature: s.signature, slot: st.slot, err: null, landedAt: Date.now() }, s.before);
        }
      }
      return null;
    };
    try {
      return await this.sellLadderLive(mint, m, opts, signer, sent, lateLanding);
    } catch (err) {
      if (!(err instanceof SellFailedError) || !sent.length) throw err;
      const late = await lateLanding();
      if (!late) throw err;
      log.warn(`sell of ${mint}: ${late.signature} landed after all; the bag is sold`);
      return { ...late, attempts: sent.length };
    }
  }

  private async sellLadderLive(
    mint: string,
    m: PublicKey,
    opts: { maxSlippage: number; ladder?: number[]; priorityMicroLamports?: number },
    signer: Keypair,
    sent: { built: BuiltSell; before: bigint; signature: string }[],
    lateLanding: () => Promise<Omit<SellFill, 'attempts'> | null>,
  ): Promise<SellFill> {
    const read = () =>
      Promise.all([
        this.tokenBalance(mint),
        this.fetchCurve(m),
        this.pumpState({ allowStale: true }),
        this.balanceLamports(),
        this.connection.getLatestBlockhash('confirmed'),
      ]);
    return sellLadder(mint, opts, async (slippage, _attempt, units) => {
      // A failed read retries here, so an RPC hiccup does not use up a slippage limit without sending anything.
      let reads: Awaited<ReturnType<typeof read>> | null = null;
      for (let i = 0; !reads; i++) {
        try {
          reads = await read();
        } catch (err) {
          if (i >= 2) throw err;
          log.warn(`sell of ${mint}: reading the balance and curve failed (${(err as Error).message}); retrying`);
          await sleep(500);
        }
      }
      const [tokens, curve, state, before, { blockhash, lastValidBlockHeight }] = reads;
      if (tokens <= 0n) {
        const late = await lateLanding();
        if (late) return late;
        const earlier = sent.length ? ' and no earlier attempt confirmed' : '';
        throw new SellAttemptError(`the dev holds no ${mint} tokens${earlier}`, { fatal: true });
      }
      if (curve.complete) {
        throw new SellAttemptError(`the bonding curve is complete (graduated to PumpSwap); the ${tokens} tokens must be sold on PumpSwap`, {
          fatal: true,
        });
      }
      const limit = minOut(quoteSellOnCurve(state.global, state.feeConfig, curve, tokens), slippage);
      const built = await buildSellTransaction(
        this.ctx(state, blockhash, opts.priorityMicroLamports),
        { mint: m, creator: curve.creator, tokens, minLamportsOut: limit, mayhem: curve.isMayhemMode },
        units,
      );
      built.tx.sign([signer]);
      const signature = utils.bytes.bs58.encode(built.tx.signatures[0]!);
      sent.push({ built, before, signature });
      const landed = await this.sendAndConfirm(built.tx, lastValidBlockHeight, `sell of ${mint}`);
      if (landed.err) throw sellFailure(`${signature} landed but failed: ${explainTxError(landed.err, [], this.dev)}`, landed.err, []);
      return this.sellFill(built, landed, before);
    });
  }

  private async sellFill(built: BuiltSell, landed: Landed, before: bigint): Promise<Omit<SellFill, 'attempts'>> {
    const base = { signature: landed.signature, landedAt: landed.landedAt, simulated: false };
    const tx = await this.fetchTransaction(landed.signature);
    const mint = built.mint.toBase58();
    if (tx?.meta) {
      const meta = tx.meta;
      const networkFee = BigInt(meta.fee) + (built.tip?.lamports ?? 0n);
      const delta = BigInt(meta.postBalances[0]!) - BigInt(meta.preBalances[0]!);
      const ev = lastTradeEvent(meta.logMessages ?? [], this.dev);
      return {
        ...base,
        tokensSold: tokenBalanceOf(meta.preTokenBalances, this.dev, mint) - tokenBalanceOf(meta.postTokenBalances, this.dev, mint),
        lamportsReceived: ev ? ev.solAmount - ev.fee - ev.creatorFee : delta + networkFee,
        networkFeeLamports: networkFee,
      };
    }
    const after = BigInt(await this.connection.getBalance(this.devKey, { commitment: 'confirmed', minContextSlot: landed.slot }));
    const networkFeeLamports = built.networkFeeLamports;
    return { ...base, tokensSold: built.tokens, lamportsReceived: after - before + networkFeeLamports, networkFeeLamports };
  }

  async creatorVaultLamports(): Promise<bigint> {
    const [lamports, state] = await Promise.all([
      this.connection.getBalance(creatorVaultPda(this.devKey), 'confirmed'),
      this.pumpState({ allowStale: true }),
    ]);
    const floor = rentExempt(state.rent, 0);
    return BigInt(lamports) > floor ? BigInt(lamports) - floor : 0n;
  }

  /**
   * Moves the creator fees waiting in the creator vault to the wallet, with pump.fun's own collect instruction. The
   * transaction is simulated first; a dry venue stops there. Returns null when there is less than `minLamports` to
   * claim (a claim costs a network fee).
   */
  async claimCreatorFees(minLamports = 2_000_000n): Promise<{ signature: string | null; lamports: bigint } | null> {
    const waiting = await this.creatorVaultLamports();
    if (waiting < minLamports) return null;
    const ixs = await new OnlinePumpSdk(this.connection).collectCoinCreatorFeeInstructions(this.devKey, this.devKey);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(
      new TransactionMessage({ payerKey: this.devKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(),
    );
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      throw new PreflightError(`creator fee claim would fail: ${JSON.stringify(sim.value.err)}`, sim.value.logs ?? []);
    }
    if (this.mode !== 'live') return { signature: null, lamports: waiting };
    tx.sign([this.requireSigner()]);
    const landed = await this.sendAndConfirm(tx, lastValidBlockHeight, 'creator fee claim');
    if (landed.err) throw new Error(`creator fee claim ${landed.signature} failed: ${JSON.stringify(landed.err)}`);
    return { signature: landed.signature, lamports: waiting };
  }
}

/**
 * Mainnet simulation that never signs or sends: it holds only the owner's public key. `preflightLaunch` simulates
 * against mainnet exactly as live does; `launch` returns the fill the simulation shows (tokens from the simulated
 * token account, cost from the trade event, rent from the accounts it created) marked `simulated`; the coin does not
 * exist afterwards, so its bag and curve are remembered here and `tokenBalance`, `quoteSell` and `sellAll` use them.
 * `sellAll` fills at the quote.
 */
export class DryVenue extends MainnetVenue {
  private readonly bags = new Map<string, { tokens: bigint; curve: BondingCurve }>();

  constructor(dev: PublicKey, opts: MainnetVenueOptions & { mode?: 'dry' | 'shadow' } = {}) {
    super(dev, { ...opts, mode: opts.mode ?? 'dry' });
  }

  /** The dry venue for LAUNCH_PUBKEY (or the keypair file's public key). */
  static fromConfig(opts: MainnetVenueOptions & { mode?: 'dry' | 'shadow' } = {}): DryVenue {
    return new DryVenue(launchPublicKey(), opts);
  }

  override async launch(p: LaunchParams): Promise<LaunchFill> {
    const mint = p.mintSecret ? Keypair.fromSecretKey(p.mintSecret).publicKey : Keypair.generate().publicKey;
    const state = await this.pumpState();
    const ctx = this.ctx(state, PLACEHOLDER_BLOCKHASH, p.priorityMicroLamports);
    const probe = await buildLaunchTransaction(ctx, p, mint);
    const keys = writableKeys(probe.tx, state.lookupTable);
    const pre = await this.connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)), 'confirmed');
    const sim = await this.simulate(probe, 'launch', keys);
    const built = await resizeLaunch(ctx, p, probe, launchUnitLimit(sim.computeUnits));
    const post = (k: string) => sim.accounts[keys.indexOf(k)] ?? null;
    const data = (a: SimulatedTransactionAccountInfo | null) => (a ? Buffer.from(a.data[0] ?? '', 'base64') : Buffer.alloc(0));
    // Rent: every account the launch creates, at its rent-exempt minimum (the creator vault's fee is not rent).
    let rent = 0n;
    keys.forEach((k, i) => {
      const after = post(k);
      if (!pre[i] && after && after.lamports > 0) rent += rentExempt(state.rent, data(after).length);
    });
    const ata = quoteAta(this.devKey, mint, TOKEN_2022_PROGRAM).toBase58();
    const devTokens = tokenAmount(data(post(ata)));
    const ev = lastTradeEvent(sim.logs, this.dev);
    const curveAcc = post(built.bondingCurve.toBase58());
    if (curveAcc) {
      const curve = PUMP_SDK.decodeBondingCurve({ data: data(curveAcc) } as AccountInfo<Buffer>);
      this.bags.set(mint.toBase58(), { tokens: devTokens, curve });
    }
    log.info(
      `dry launch of ${mint.toBase58()}: ${sim.computeUnits} compute units (limit ${built.computeUnitLimit}), ${built.size} bytes, ` +
        `${devTokens} tokens (not sent)`,
    );
    return {
      mint: mint.toBase58(),
      signature: `dry:${mint.toBase58()}`,
      slot: sim.slot,
      landedAt: Date.now(),
      devTokens,
      lamportsSpent: ev ? ev.solAmount + ev.fee + ev.creatorFee : built.maxCostLamports,
      rentLamports: rent,
      networkFeeLamports: built.networkFeeLamports,
      simulated: true,
    };
  }

  override async tokenBalance(mint: string): Promise<bigint> {
    const bag = this.bags.get(mint);
    return bag ? bag.tokens : super.tokenBalance(mint);
  }

  override async quoteSell(mint: string, tokens: bigint): Promise<bigint> {
    const bag = this.bags.get(mint);
    if (!bag) return super.quoteSell(mint, tokens);
    const state = await this.pumpState({ allowStale: true });
    return quoteSellOnCurve(state.global, state.feeConfig, bag.curve, tokens);
  }

  /** Fills the whole bag at the quote (the dry coin does not exist on chain); a real position is simulated first. */
  override async sellAll(mint: string, opts: { maxSlippage: number; ladder?: number[]; priorityMicroLamports?: number }): Promise<SellFill> {
    slippageLimits(opts.maxSlippage, opts.ladder);
    const bag = this.bags.get(mint);
    const tokens = await this.tokenBalance(mint);
    if (tokens <= 0n) throw new SellFailedError(`SELL FAILED: the dev holds no ${mint} tokens`, mint, []);
    const state = await this.pumpState({ allowStale: true });
    const m = new PublicKey(mint);
    const curve = bag ? bag.curve : await this.fetchCurve(m);
    const quote = quoteSellOnCurve(state.global, state.feeConfig, curve, tokens);
    const built = await buildSellTransaction(this.ctx(state, PLACEHOLDER_BLOCKHASH, opts.priorityMicroLamports), {
      mint: m,
      creator: curve.creator,
      tokens,
      minLamportsOut: minOut(quote, opts.maxSlippage),
      mayhem: curve.isMayhemMode,
    });
    if (!bag) await this.simulate(built, 'sell');
    else bag.tokens = 0n;
    return {
      signature: `dry:sell:${mint}:${Date.now()}`,
      landedAt: Date.now(),
      tokensSold: tokens,
      lamportsReceived: quote,
      networkFeeLamports: built.networkFeeLamports,
      attempts: 1,
      simulated: true,
    };
  }
}

/**
 * The venue for a mode: the fork, mainnet simulation (dry; shadow, which launches nothing and so works without a
 * configured wallet) or mainnet (live, from the keypair file).
 */
export async function openVenue(mode: Mode, opts: { fork?: ForkOptions & { devSol?: number } } = {}): Promise<Venue> {
  switch (mode) {
    case 'fork':
      return ForkVenue.open(opts.fork);
    case 'dry':
      return DryVenue.fromConfig({ mode });
    case 'shadow':
      return new DryVenue(config.launchPubkey || config.launchKeypairPath ? launchPublicKey() : PublicKey.default, { mode });
    case 'live':
      return MainnetVenue.fromConfig();
  }
}
