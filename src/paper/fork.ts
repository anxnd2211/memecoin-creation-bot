import { readFileSync } from 'node:fs';
import { BN, BorshCoder, utils, type Idl } from '@coral-xyz/anchor';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import { getTransactionDecoder, type Address } from '@solana/kit';
import { Clock, FailedTransactionMetadata, LiteSVM, Rent } from 'litesvm';
import {
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
  getBuyTokenAmountFromSolAmount,
  getGlobalParamsPda,
  getSellSolAmountFromTokenAmount,
  getSolVaultPda,
  quoteAta,
  userVolumeAccumulatorPda,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import { config } from '../config.ts';
import { extractProgramData } from '../chain/decoder.ts';
import {
  ATA_PROGRAM,
  NATIVE_MINT,
  RENT_SYSVAR,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  UPGRADEABLE_LOADER,
  loadOrFetchSnapshot,
  loadSnapshot,
  snapshotExists,
  type Snapshot,
} from './snapshot.ts';

/**
 * A local copy of pump.fun on mainnet: LiteSVM running pump.fun's real program binaries (bonding curve, fee program,
 * Mayhem program, Token-2022, SPL Token, Associated Token) against read-only copies of the accounts they read
 * (snapshot.ts). Launches and trades here run the same code as mainnet and return exact lamports, tokens, fees, rent
 * and compute units; replay.ts checks this by re-running landed mainnet transactions. Every signer is an in-memory
 * keypair that exists only on this fork, and nothing is ever sent to a real cluster.
 *
 * The launch is what pump.fun's own site sends today: `create_v2` (a Token-2022 coin, normal mode, never Mayhem), the
 * dev's token account, and the dev buy as `buy_v2`, in one transaction. Other wallets buy with `buy_v2` and sell with
 * `sell_v2`.
 */

/** Base fee per signature on mainnet (and in LiteSVM). */
export const SIGNATURE_FEE = 5_000n;

const PUMP_IDL = JSON.parse(readFileSync(new URL('../../idl/pump.json', import.meta.url), 'utf8')) as Idl;
const eventCoder = new BorshCoder(PUMP_IDL).events;
const txDecoder = getTransactionDecoder();
const addr = (k: PublicKey | string) => (typeof k === 'string' ? k : k.toBase58()) as Address;
const big = (v: { toString(): string } | undefined): bigint => (v === undefined ? 0n : BigInt(v.toString()));
const MINT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('mint-authority')], PUMP_PROGRAM_ID)[0];

export interface ForkOptions {
  /** Where the mainnet snapshot is cached (default `data/fork`). */
  dir?: string;
  /** RPC used only when the cache is missing or `refresh` is set (default: SOLANA_RPC_HTTP from config). */
  rpcUrl?: string;
  /** Re-fetch the snapshot from mainnet even when a cached one exists. */
  refresh?: boolean;
  /** Never touch the network; fail if there is no cached snapshot. */
  offline?: boolean;
  log?: (msg: string) => void;
}

/** Priority fee for a transaction; without a price no compute-budget instructions are added. */
export interface Priority {
  /** Micro-lamports per compute unit. */
  microLamports?: number;
  /** Compute-unit limit; mainnet charges the priority fee on the limit, not on the units used. */
  units?: number;
}

/** A bonding curve's reserves, raw (lamports and 6-decimal token units). */
export interface CurveState {
  virtualSol: bigint;
  virtualTokens: bigint;
  realSol: bigint;
  realTokens: bigint;
  complete: boolean;
  creator: string;
}

/** An account a transaction created (rent paid, positive) or closed (rent returned, negative). */
export interface RentAccount {
  address: string;
  label: string;
  lamports: bigint;
}

/** Exact outcome of one fork transaction, from the trader's side. All amounts are lamports or raw token units. */
export interface TradeResult {
  signature: string;
  side: 'buy' | 'sell';
  trader: string;
  mint: string;
  /** Change in the trader's SOL balance: everything the transaction cost or paid out. */
  solDelta: bigint;
  /** Change in the trader's token balance. */
  tokenDelta: bigint;
  /** SOL that entered (buy) or left (sell) the curve, before fees: the trade event's `sol_amount`. */
  curveSol: bigint;
  /**
   * Fees from the trade event, charged on top of a buy and taken out of a sell. The protocol fee includes the buyback
   * fee: pump.fun pays that share of it to a buyback wallet instead of its fee recipient.
   */
  protocolFee: bigint;
  creatorFee: bigint;
  buybackFee: bigint;
  /** What the fee accounts actually received, from their balances, as a check on the event. */
  received: { feeRecipient: bigint; creatorVault: bigint; buybackRecipient: bigint };
  /** Signature fees plus the priority fee. */
  networkFee: bigint;
  /** Lamports put into accounts this transaction created, and taken back from accounts it closed. */
  rentPaid: bigint;
  rentRefunded: bigint;
  rentAccounts: RentAccount[];
  computeUnits: number;
  /** Compute units per top-level instruction, in order (compute-budget instructions left out). */
  instructionUnits: { program: string; units: number }[];
  /**
   * Trader balance change not explained by the curve SOL, fees, rent and network fee. Zero when the accounting is
   * complete; anything else is a cost this module does not know about.
   */
  unexplained: bigint;
  curveAfter: CurveState;
  logs: string[];
}

export interface LaunchResult extends TradeResult {
  bondingCurve: string;
  /** The creator, who receives creator fees: the dev, who also signs. */
  creator: string;
  name: string;
  symbol: string;
  uri: string;
}

/** A fork transaction the programs rejected; carries the program logs. */
export class ForkTxError extends Error {
  readonly logs: string[];
  readonly computeUnits: number;
  constructor(message: string, logs: string[], computeUnits: number) {
    super(message);
    this.name = 'ForkTxError';
    this.logs = logs;
    this.computeUnits = computeUnits;
  }
}

interface AccountView {
  exists: boolean;
  lamports: bigint;
  data: Uint8Array;
}

interface Sent {
  signature: string;
  logs: string[];
  computeUnits: number;
  networkFee: bigint;
  keys: string[];
  pre: Map<string, AccountView>;
  post: Map<string, AccountView>;
}

/** Token amount of an SPL Token or Token-2022 account (the base layout is the same). */
function tokenAmount(data: Uint8Array): bigint {
  return data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n;
}

/** Compute units per top-level instruction, from the runtime's `consumed` log lines at invoke depth 1. */
function topLevelUnits(logs: string[]): { program: string; units: number }[] {
  const out: { program: string; units: number }[] = [];
  let depth = 0;
  for (const line of logs) {
    const inv = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (inv) {
      depth = Number(inv[2]);
      continue;
    }
    const used = /^Program (\w+) consumed (\d+) of \d+ compute units$/.exec(line);
    if (used && depth === 1) out.push({ program: used[1]!, units: Number(used[2]) });
    if (/^Program \w+ (success|failed)/.test(line)) depth--;
  }
  return out;
}

/** Associated token account, create-if-missing (pump.fun's site sends this before the dev buy). */
function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
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

/** Token program CloseAccount: returns an empty token account's rent to its owner. */
function closeTokenAccount(account: PublicKey, owner: PublicKey, tokenProgram: PublicKey) {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

/** Address lookup table layout: a 56-byte header (state tag, deactivation slot, last extension, authority), then keys. */
const LOOKUP_TABLE_META_SIZE = 56;

/**
 * Account data of an active lookup table holding `keys`. A launch names about 35 accounts, more than fit in one
 * transaction without a table; pump.fun's site uses one the same way.
 */
function lookupTableData(keys: PublicKey[]): Buffer {
  const data = Buffer.alloc(LOOKUP_TABLE_META_SIZE + 32 * keys.length);
  data.writeUInt32LE(1, 0); // initialized lookup table
  data.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4); // never deactivated
  data.writeBigUInt64LE(0n, 12); // last extended at slot 0, so every key is usable now
  keys.forEach((k, i) => k.toBuffer().copy(data, LOOKUP_TABLE_META_SIZE + 32 * i));
  return data;
}

/** Whole SOL (a number, as typed on the CLI) to lamports. */
export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new Error(`bad SOL amount ${sol}`);
  return BigInt(Math.round(sol * 1e9));
}

export class PumpFork {
  readonly svm: LiteSVM;
  readonly snapshot: Snapshot;
  readonly global: Global;
  readonly feeConfig: FeeConfig;
  /** The protocol fee recipient and buyback wallet this fork's trades pay (fixed, so runs repeat exactly). */
  readonly feeRecipient: PublicKey;
  readonly buybackRecipient: PublicKey;
  private readonly lookupTable: AddressLookupTableAccount;

  /** Starts a fork from a snapshot; `open` loads or fetches the snapshot first. */
  constructor(snapshot: Snapshot) {
    this.snapshot = snapshot;
    // Standard LiteSVM (builtins, sysvars, bundled SPL programs), then mainnet's binaries over the bundled ones.
    this.svm = new LiteSVM().withLogBytesLimit(undefined).withTransactionHistory(0n);
    for (const [id, p] of snapshot.programs) {
      if (p.loader === UPGRADEABLE_LOADER) this.svm.addProgram(addr(id), p.elf);
      else this.svm.addProgramWithLoader(addr(id), p.elf, addr(p.loader));
    }
    for (const [k, a] of snapshot.accounts) {
      if (!a) continue;
      if (k === RENT_SYSVAR) {
        // Mainnet's rent (lamports per byte, exemption threshold, burn share), in case LiteSVM's default lags it.
        this.svm.setRent(new Rent(a.data.readBigUInt64LE(0), a.data.readDoubleLE(8), a.data[16]!));
        continue;
      }
      this.setAccount(k, a.lamports, a.owner, a.data, a.executable);
    }
    // The snapshot's slot and today's time (volume tracking and token incentives read the clock).
    const slot = BigInt(snapshot.slot);
    const epoch = slot / 432_000n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    this.svm.setClock(new Clock(slot, this.svm.getClock().epochStartTimestamp, epoch, epoch + 1n, now));

    this.global = PUMP_SDK.decodeGlobal(this.info(GLOBAL_PDA));
    this.feeConfig = PUMP_SDK.decodeFeeConfig(this.info(PUMP_FEE_CONFIG_PDA));
    this.feeRecipient = new PublicKey(snapshot.feeRecipient);
    this.buybackRecipient = new PublicKey(snapshot.buybackFeeRecipient);

    // The fixed accounts every launch and trade names, in a lookup table that exists only on the fork.
    const tableKey = PublicKey.findProgramAddressSync([Buffer.from('paper-fork')], AddressLookupTableProgram.programId)[0];
    const tableData = lookupTableData([
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
      this.feeRecipient,
      this.buybackRecipient,
      quoteAta(this.feeRecipient, NATIVE_MINT, TOKEN_PROGRAM),
      quoteAta(this.buybackRecipient, NATIVE_MINT, TOKEN_PROGRAM),
    ]);
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(tableData.length));
    this.setAccount(tableKey.toBase58(), rent, AddressLookupTableProgram.programId.toBase58(), tableData);
    this.lookupTable = new AddressLookupTableAccount({ key: tableKey, state: AddressLookupTableAccount.deserialize(tableData) });
  }

  /** Loads the cached mainnet snapshot (fetching and caching it first if there is none) and starts a fork. */
  static async open(opts: ForkOptions = {}): Promise<PumpFork> {
    const dir = opts.dir ?? 'data/fork';
    if (opts.offline) {
      if (!snapshotExists(dir)) throw new Error(`no fork snapshot in ${dir}; run once with network access`);
      return new PumpFork(loadSnapshot(dir));
    }
    const url = opts.rpcUrl ?? config.rpcHttp;
    return new PumpFork(await loadOrFetchSnapshot(dir, url, { refresh: opts.refresh, log: opts.log }));
  }

  private setAccount(key: string, lamports: bigint, owner: string, data: Uint8Array, executable = false): void {
    this.svm.setAccount({
      address: addr(key),
      lamports: lamports as never,
      programAddress: addr(owner),
      executable,
      data,
      space: BigInt(data.length),
    });
  }

  private info(key: PublicKey): AccountInfo<Buffer> {
    const a = this.svm.getAccount(addr(key));
    if (!a.exists) throw new Error(`account ${key.toBase58()} missing on the fork`);
    return { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.programAddress) };
  }

  private view(key: string): AccountView {
    const a = this.svm.getAccount(addr(key));
    return a.exists ? { exists: true, lamports: BigInt(a.lamports), data: a.data } : { exists: false, lamports: 0n, data: new Uint8Array() };
  }

  /** A new in-memory keypair holding `sol` SOL, on the fork only. */
  wallet(sol: number): Keypair {
    const kp = Keypair.generate();
    this.setAccount(kp.publicKey.toBase58(), solToLamports(sol), SystemProgram.programId.toBase58(), new Uint8Array());
    return kp;
  }

  balance(key: PublicKey): bigint {
    return this.view(key.toBase58()).lamports;
  }

  /** The wallet's balance of `mint`, in raw units. */
  tokens(owner: PublicKey, mint: PublicKey | string): bigint {
    return tokenAmount(this.view(quoteAta(owner, new PublicKey(mint), TOKEN_2022_PROGRAM).toBase58()).data);
  }

  /** Creator fees waiting in the creator's vault, above the vault's rent-exempt minimum. */
  creatorVaultBalance(creator: PublicKey): bigint {
    const v = this.view(creatorVaultPda(creator).toBase58());
    return v.exists ? v.lamports - this.svm.minimumBalanceForRentExemption(0n) : 0n;
  }

  private bondingCurve(mint: PublicKey): BondingCurve {
    return PUMP_SDK.decodeBondingCurve(this.info(bondingCurvePda(mint)));
  }

  /** The coin's bonding curve as it stands on the fork. */
  curve(mint: PublicKey | string): CurveState {
    const c = this.bondingCurve(new PublicKey(mint));
    return {
      virtualSol: big(c.virtualQuoteReserves),
      virtualTokens: big(c.virtualTokenReserves),
      realSol: big(c.realQuoteReserves),
      realTokens: big(c.realTokenReserves),
      complete: c.complete,
      creator: c.creator.toBase58(),
    };
  }

  /** Tokens `lamports` (fees included) buys on the coin's curve now, as pump.fun's SDK quotes it. */
  quoteBuy(mint: PublicKey | string, lamports: bigint): bigint {
    const curve = this.bondingCurve(new PublicKey(mint));
    return big(
      getBuyTokenAmountFromSolAmount({
        global: this.global,
        feeConfig: this.feeConfig,
        mintSupply: curve.tokenTotalSupply,
        bondingCurve: curve,
        amount: new BN(lamports.toString()),
        quoteMint: NATIVE_MINT,
      }),
    );
  }

  /** Lamports selling `tokens` returns now after fees, as pump.fun's SDK quotes it. */
  quoteSell(mint: PublicKey | string, tokens: bigint): bigint {
    const curve = this.bondingCurve(new PublicKey(mint));
    return big(
      getSellSolAmountFromTokenAmount({
        global: this.global,
        feeConfig: this.feeConfig,
        mintSupply: curve.tokenTotalSupply,
        bondingCurve: curve,
        amount: new BN(tokens.toString()),
      }),
    );
  }

  /**
   * Creates a coin and makes the dev buy in one transaction, as pump.fun's site does: `create_v2` (normal mode), the
   * dev's token account, then `buy_v2` for the tokens `devBuySol` buys on a fresh curve, capped at `devBuySol` plus
   * `slippageBps`. The dev is both signer and creator. A zero dev buy sends `create_v2` alone.
   */
  async launch(p: {
    name: string;
    symbol: string;
    uri: string;
    devBuySol: number;
    dev: Keypair;
    mint?: Keypair;
    slippageBps?: number;
    priority?: Priority;
  }): Promise<LaunchResult> {
    const mint = p.mint ?? Keypair.generate();
    const dev = p.dev.publicKey;
    const lamports = solToLamports(p.devBuySol);
    const ixs = [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: p.name,
        symbol: p.symbol,
        uri: p.uri,
        creator: dev,
        user: dev,
        mayhemMode: false,
      }),
    ];
    if (lamports > 0n) {
      const tokens = big(
        getBuyTokenAmountFromSolAmount({
          global: this.global,
          feeConfig: this.feeConfig,
          mintSupply: null,
          bondingCurve: null,
          amount: new BN(lamports.toString()),
          quoteMint: NATIVE_MINT,
        }),
      );
      ixs.push(createAtaIdempotent(dev, dev, mint.publicKey, TOKEN_2022_PROGRAM));
      ixs.push(await this.buyIx(dev, mint.publicKey, dev, tokens, lamports + (lamports * BigInt(p.slippageBps ?? 100)) / 10_000n));
    }
    const sent = this.send(p.dev, [mint], ixs, { units: 300_000, ...p.priority });
    const result = this.settle(sent, dev, mint.publicKey, 'buy');
    return { ...result, bondingCurve: bondingCurvePda(mint.publicKey).toBase58(), creator: dev.toBase58(), name: p.name, symbol: p.symbol, uri: p.uri };
  }

  /**
   * Buys with `sol` SOL, fees included: `buy_v2` for the tokens the SDK quotes for that budget, capped at the budget
   * plus `slippageBps`. Near the end of the curve the quote is the tokens left, and only those are paid for.
   */
  async buy(
    wallet: Keypair,
    mint: PublicKey | string,
    sol: number | bigint,
    opts: { slippageBps?: number; priority?: Priority } = {},
  ): Promise<TradeResult> {
    const m = new PublicKey(mint);
    const lamports = typeof sol === 'bigint' ? sol : solToLamports(sol);
    const tokens = this.quoteBuy(m, lamports);
    const creator = this.bondingCurve(m).creator;
    const ixs = [
      createAtaIdempotent(wallet.publicKey, wallet.publicKey, m, TOKEN_2022_PROGRAM),
      await this.buyIx(wallet.publicKey, m, creator, tokens, lamports + (lamports * BigInt(opts.slippageBps ?? 100)) / 10_000n),
    ];
    return this.settle(this.send(wallet, [], ixs, { units: 150_000, ...opts.priority }), wallet.publicKey, m, 'buy');
  }

  /**
   * Sells `tokens` (default: the wallet's whole balance) with `sell_v2`, accepting down to the SDK quote less
   * `slippageBps`. `closeAccount` also closes the emptied token account and takes its rent back.
   */
  async sell(
    wallet: Keypair,
    mint: PublicKey | string,
    tokens?: bigint,
    opts: { slippageBps?: number; priority?: Priority; closeAccount?: boolean } = {},
  ): Promise<TradeResult> {
    const m = new PublicKey(mint);
    const held = this.tokens(wallet.publicKey, m);
    const amount = tokens ?? held;
    if (amount <= 0n || amount > held) throw new Error(`cannot sell ${amount} tokens; the wallet holds ${held}`);
    const minOut = this.quoteSell(m, amount);
    const ixs = [
      await PUMP_SDK.getSellV2InstructionRaw({
        user: wallet.publicKey,
        mint: m,
        creator: this.bondingCurve(m).creator,
        amount: new BN(amount.toString()),
        quoteAmount: new BN((minOut - (minOut * BigInt(opts.slippageBps ?? 100)) / 10_000n).toString()),
        feeRecipient: this.feeRecipient,
        buybackFeeRecipient: this.buybackRecipient,
      }),
    ];
    if (opts.closeAccount && amount === held) {
      ixs.push(closeTokenAccount(quoteAta(wallet.publicKey, m, TOKEN_2022_PROGRAM), wallet.publicKey, TOKEN_2022_PROGRAM));
    }
    return this.settle(this.send(wallet, [], ixs, { units: 150_000, ...opts.priority }), wallet.publicKey, m, 'sell');
  }

  private async buyIx(user: PublicKey, mint: PublicKey, creator: PublicKey, tokens: bigint, maxLamports: bigint) {
    return PUMP_SDK.getBuyV2InstructionRaw({
      user,
      mint,
      creator,
      amount: new BN(tokens.toString()),
      quoteAmount: new BN(maxLamports.toString()),
      feeRecipient: this.feeRecipient,
      buybackFeeRecipient: this.buybackRecipient,
    });
  }

  /** Signs with in-memory keypairs and executes on the fork; throws ForkTxError (with the logs) when it fails. */
  private send(payer: Keypair, signers: Keypair[], ixs: TransactionInstruction[], priority: Priority = {}): Sent {
    const all: TransactionInstruction[] = [];
    let priorityFee = 0n;
    if (priority.microLamports) {
      const units = priority.units ?? 200_000;
      all.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
      all.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority.microLamports }));
      priorityFee = (BigInt(priority.microLamports) * BigInt(units) + 999_999n) / 1_000_000n;
    }
    all.push(...ixs);
    // A fresh blockhash per transaction, so two identical trades are not rejected as a replay.
    this.svm.expireBlockhash();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: this.svm.latestBlockhash(),
      instructions: all,
    }).compileToV0Message([this.lookupTable]);
    const tx = new VersionedTransaction(message);
    tx.sign([payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))]);
    const keys = message
      .getAccountKeys({ addressLookupTableAccounts: [this.lookupTable] })
      .keySegments()
      .flat()
      .map((k) => k.toBase58());
    const pre = new Map(keys.map((k) => [k, this.view(k)]));
    const res = this.svm.sendTransaction(txDecoder.decode(tx.serialize()));
    if (res instanceof FailedTransactionMetadata) {
      const meta = res.meta();
      throw new ForkTxError(`fork transaction failed: ${res.err().toString()}`, meta.logs(), Number(meta.computeUnitsConsumed()));
    }
    return {
      signature: utils.bytes.bs58.encode(res.signature()),
      logs: res.logs(),
      computeUnits: Number(res.computeUnitsConsumed()),
      networkFee: SIGNATURE_FEE * BigInt(message.header.numRequiredSignatures) + priorityFee,
      keys,
      pre,
      post: new Map(keys.map((k) => [k, this.view(k)])),
    };
  }

  /** Names for the accounts a launch or trade can create, for the rent breakdown. */
  private labels(mint: PublicKey, trader: PublicKey, creator: PublicKey): Map<string, string> {
    const curve = bondingCurvePda(mint);
    return new Map([
      [mint.toBase58(), 'mint'],
      [curve.toBase58(), 'bonding curve'],
      [quoteAta(curve, mint, TOKEN_2022_PROGRAM).toBase58(), 'curve token account'],
      [quoteAta(trader, mint, TOKEN_2022_PROGRAM).toBase58(), 'trader token account'],
      [userVolumeAccumulatorPda(trader).toBase58(), 'volume account (once per wallet)'],
      [creatorVaultPda(creator).toBase58(), 'creator vault (once per creator)'],
    ]);
  }

  /** Turns balance changes and the trade event into a TradeResult for `trader`. */
  private settle(sent: Sent, trader: PublicKey, mint: PublicKey, side: 'buy' | 'sell'): TradeResult {
    let ev: Record<string, { toString(): string }> | null = null;
    for (const item of extractProgramData(sent.logs).items) {
      if (item.program !== PUMP_PROGRAM_ID.toBase58()) continue;
      const decoded = eventCoder.decode(item.data);
      if (decoded?.name === 'TradeEvent') ev = decoded.data as Record<string, { toString(): string }>;
    }
    const me = trader.toBase58();
    const creator = this.bondingCurve(mint).creator;
    const creatorVault = creatorVaultPda(creator).toBase58();
    const labels = this.labels(mint, trader, creator);
    const lamports = (m: Map<string, AccountView>, k: string) => m.get(k)?.lamports ?? 0n;
    const delta = (k: string) => lamports(sent.post, k) - lamports(sent.pre, k);
    const tokensOf = (m: Map<string, AccountView>, k: string) => tokenAmount(m.get(k)?.data ?? new Uint8Array());

    // Rent: every account that appeared (at its rent-exempt minimum) or disappeared (its whole balance returned).
    const rentAccounts: RentAccount[] = [];
    let rentPaid = 0n;
    let rentRefunded = 0n;
    let vaultRent = 0n;
    for (const k of sent.keys) {
      const before = sent.pre.get(k)!;
      const after = sent.post.get(k)!;
      if (!before.exists && after.exists) {
        const rent = this.svm.minimumBalanceForRentExemption(BigInt(after.data.length));
        rentPaid += rent;
        if (k === creatorVault) vaultRent = rent;
        rentAccounts.push({ address: k, label: labels.get(k) ?? 'other', lamports: rent });
      } else if (before.exists && !after.exists && k !== me) {
        rentRefunded += before.lamports;
        rentAccounts.push({ address: k, label: `${labels.get(k) ?? 'other'} (closed)`, lamports: -before.lamports });
      }
    }

    const curveSol = big(ev?.sol_amount);
    const protocolFee = big(ev?.fee);
    const creatorFee = big(ev?.creator_fee);
    const tradeFlow = side === 'buy' ? -(curveSol + protocolFee + creatorFee) : curveSol - protocolFee - creatorFee;
    const solDelta = delta(me);
    const ata = quoteAta(trader, mint, TOKEN_2022_PROGRAM).toBase58();
    return {
      signature: sent.signature,
      side,
      trader: me,
      mint: mint.toBase58(),
      solDelta,
      tokenDelta: tokensOf(sent.post, ata) - tokensOf(sent.pre, ata),
      curveSol,
      protocolFee,
      creatorFee,
      buybackFee: big(ev?.buyback_fee),
      received: {
        feeRecipient: delta(this.feeRecipient.toBase58()),
        creatorVault: delta(creatorVault) - vaultRent,
        buybackRecipient: delta(this.buybackRecipient.toBase58()),
      },
      networkFee: sent.networkFee,
      rentPaid,
      rentRefunded,
      rentAccounts,
      computeUnits: sent.computeUnits,
      instructionUnits: topLevelUnits(sent.logs).filter((u) => u.program !== ComputeBudgetProgram.programId.toBase58()),
      unexplained: solDelta - (tradeFlow - rentPaid + rentRefunded - sent.networkFee),
      curveAfter: this.curve(mint),
      logs: sent.logs,
    };
  }
}
