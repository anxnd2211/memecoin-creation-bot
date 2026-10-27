import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  MAYHEM_PROGRAM_ID,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  getGlobalParamsPda,
  getSolVaultPda,
  quoteAta,
} from '@pump-fun/pump-sdk';
import { redactUrl } from '../config.ts';

/**
 * A read-only copy of the mainnet accounts pump.fun's create, buy and sell instructions read, cached on disk so the
 * paper fork (fork.ts) can load it without touching the network again. Nothing here signs or sends a transaction:
 * the only RPC calls are getMultipleAccounts and getAccountInfo.
 */

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LEGACY_LOADER = 'BPFLoader2111111111111111111111111111111111';
/** ProgramData header: 4-byte tag, 8-byte deploy slot, 1-byte option and 32-byte upgrade authority. */
const PROGRAM_DATA_HEADER = 45;

/** Programs the launch path runs, loaded from their mainnet binaries so results and compute units match mainnet. */
export const FORK_PROGRAMS = [PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MAYHEM_PROGRAM_ID, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM];

export interface SnapshotAccount {
  lamports: bigint;
  owner: string;
  executable: boolean;
  data: Buffer;
}

export interface SnapshotProgram {
  /** The loader that owns the program on mainnet. */
  loader: string;
  elf: Buffer;
  /** Slot the binary was deployed at (upgradeable programs only). */
  deploySlot: number | null;
}

export interface Snapshot {
  fetchedAt: string;
  slot: number;
  programs: Map<string, SnapshotProgram>;
  /** Data accounts by address; null where the account does not exist on mainnet. */
  accounts: Map<string, SnapshotAccount | null>;
  /** The protocol fee recipient and buyback fee recipient the fork's trades pay (fixed, so runs are repeatable). */
  feeRecipient: string;
  buybackFeeRecipient: string;
}

interface RpcAccount {
  lamports: number;
  owner: string;
  executable: boolean;
  data: [string, 'base64'];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One JSON-RPC call with backoff on 429, 5xx and network errors (the free public RPC throttles hard). */
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let lastError = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      lastError = (err as Error).message;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    const body = (await res.json()) as { result: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  throw new Error(`${method} failed after retries (${lastError}) on ${redactUrl(url)}`);
}

function toAccount(a: RpcAccount | null): SnapshotAccount | null {
  if (!a) return null;
  return { lamports: BigInt(a.lamports), owner: a.owner, executable: a.executable, data: Buffer.from(a.data[0], 'base64') };
}

async function getMany(url: string, keys: string[]): Promise<{ slot: number; accounts: (SnapshotAccount | null)[] }> {
  const res = await rpc<{ context: { slot: number }; value: (RpcAccount | null)[] }>(url, 'getMultipleAccounts', [
    keys,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);
  return { slot: res.context.slot, accounts: res.value.map(toAccount) };
}

/**
 * Fetches every account the fork needs, once, sequentially. The first batch names the programs and the fixed
 * pump.fun accounts (Global, the fee config, the volume accumulator, the Mayhem program's global accounts); the
 * upgradeable programs' binaries come from their ProgramData accounts; the last batch is the fee recipients Global
 * names and their wrapped-SOL accounts.
 */
export async function fetchSnapshot(url: string, log: (msg: string) => void = () => {}): Promise<Snapshot> {
  const programIds = FORK_PROGRAMS.map((p) => p.toBase58());
  const fixed = [
    GLOBAL_PDA,
    PUMP_FEE_CONFIG_PDA,
    GLOBAL_VOLUME_ACCUMULATOR_PDA,
    PUMP_EVENT_AUTHORITY_PDA,
    getGlobalParamsPda(),
    getSolVaultPda(),
    NATIVE_MINT,
  ]
    .map((p) => p.toBase58())
    .concat(RENT_SYSVAR);
  log(`fetching ${programIds.length} programs and ${fixed.length} accounts from ${redactUrl(url)}`);
  const first = await getMany(url, [...programIds, ...fixed]);
  const programs = new Map<string, SnapshotProgram>();
  for (const [i, id] of programIds.entries()) {
    const acc = first.accounts[i];
    if (!acc?.executable) throw new Error(`program ${id} not found or not executable on mainnet`);
    if (acc.owner === UPGRADEABLE_LOADER) {
      const programData = new PublicKey(acc.data.subarray(4, 36)).toBase58();
      await sleep(500);
      const pd = toAccount(
        (
          await rpc<{ value: RpcAccount | null }>(url, 'getAccountInfo', [
            programData,
            { encoding: 'base64', commitment: 'confirmed' },
          ])
        ).value,
      );
      if (!pd) throw new Error(`ProgramData ${programData} of ${id} not found`);
      const elf = pd.data.subarray(PROGRAM_DATA_HEADER);
      programs.set(id, { loader: UPGRADEABLE_LOADER, elf, deploySlot: Number(pd.data.readBigUInt64LE(4)) });
      log(`  ${id}: ${(elf.length / 1024).toFixed(0)} KiB, deployed at slot ${pd.data.readBigUInt64LE(4)}`);
    } else if (acc.owner === LEGACY_LOADER) {
      programs.set(id, { loader: LEGACY_LOADER, elf: acc.data, deploySlot: null });
      log(`  ${id}: ${(acc.data.length / 1024).toFixed(0)} KiB (non-upgradeable)`);
    } else {
      throw new Error(`program ${id} is owned by unsupported loader ${acc.owner}`);
    }
  }
  const accounts = new Map<string, SnapshotAccount | null>();
  fixed.forEach((k, i) => accounts.set(k, first.accounts[programIds.length + i] ?? null));

  const globalAcc = accounts.get(GLOBAL_PDA.toBase58());
  if (!globalAcc) throw new Error('pump.fun Global account not found');
  const global = PUMP_SDK.decodeGlobal({ data: globalAcc.data } as AccountInfo<Buffer>);
  const feeRecipient = global.feeRecipient;
  const buyback = global.buybackFeeRecipients.find((k) => !k.equals(PublicKey.default));
  if (!buyback) throw new Error('Global lists no buyback fee recipient');
  const recipients = [
    feeRecipient,
    buyback,
    quoteAta(feeRecipient, NATIVE_MINT, TOKEN_PROGRAM),
    quoteAta(buyback, NATIVE_MINT, TOKEN_PROGRAM),
  ].map((p) => p.toBase58());
  await sleep(500);
  const last = await getMany(url, recipients);
  recipients.forEach((k, i) => accounts.set(k, last.accounts[i] ?? null));
  log(`  fee recipient ${recipients[0]}, buyback fee recipient ${recipients[1]}`);

  return {
    fetchedAt: new Date().toISOString(),
    slot: first.slot,
    programs,
    accounts,
    feeRecipient: recipients[0]!,
    buybackFeeRecipient: recipients[1]!,
  };
}

interface SnapshotFile {
  version: 1;
  fetchedAt: string;
  slot: number;
  feeRecipient: string;
  buybackFeeRecipient: string;
  programs: Record<string, { loader: string; file: string; deploySlot: number | null }>;
  accounts: Record<string, { lamports: string; owner: string; executable: boolean; data: string } | null>;
}

const MANIFEST = 'snapshot.json';

export function snapshotExists(dir: string): boolean {
  return existsSync(join(dir, MANIFEST));
}

/** Writes the snapshot as a JSON manifest plus one `.so` file per program binary. */
export function saveSnapshot(dir: string, snap: Snapshot): void {
  mkdirSync(dir, { recursive: true });
  const file: SnapshotFile = {
    version: 1,
    fetchedAt: snap.fetchedAt,
    slot: snap.slot,
    feeRecipient: snap.feeRecipient,
    buybackFeeRecipient: snap.buybackFeeRecipient,
    programs: {},
    accounts: {},
  };
  for (const [id, p] of snap.programs) {
    const name = `${id}.so`;
    writeFileSync(join(dir, name), p.elf);
    file.programs[id] = { loader: p.loader, file: name, deploySlot: p.deploySlot };
  }
  for (const [k, a] of snap.accounts) {
    file.accounts[k] = a
      ? { lamports: a.lamports.toString(), owner: a.owner, executable: a.executable, data: a.data.toString('base64') }
      : null;
  }
  writeFileSync(join(dir, MANIFEST), JSON.stringify(file, null, 1) + '\n');
}

export function loadSnapshot(dir: string): Snapshot {
  const file = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as SnapshotFile;
  if (file.version !== 1) throw new Error(`unsupported fork snapshot version ${file.version} in ${dir}`);
  const programs = new Map<string, SnapshotProgram>();
  for (const [id, p] of Object.entries(file.programs)) {
    programs.set(id, { loader: p.loader, elf: readFileSync(join(dir, p.file)), deploySlot: p.deploySlot });
  }
  const accounts = new Map<string, SnapshotAccount | null>();
  for (const [k, a] of Object.entries(file.accounts)) {
    accounts.set(
      k,
      a ? { lamports: BigInt(a.lamports), owner: a.owner, executable: a.executable, data: Buffer.from(a.data, 'base64') } : null,
    );
  }
  return {
    fetchedAt: file.fetchedAt,
    slot: file.slot,
    programs,
    accounts,
    feeRecipient: file.feeRecipient,
    buybackFeeRecipient: file.buybackFeeRecipient,
  };
}

/** The cached snapshot, or a fresh one fetched from `url` and cached when there is none (or `refresh` is set). */
export async function loadOrFetchSnapshot(
  dir: string,
  url: string,
  opts: { refresh?: boolean; log?: (msg: string) => void } = {},
): Promise<Snapshot> {
  if (!opts.refresh && snapshotExists(dir)) return loadSnapshot(dir);
  const snap = await fetchSnapshot(url, opts.log);
  saveSnapshot(dir, snap);
  return snap;
}
