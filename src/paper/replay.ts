import { getTransactionDecoder, type Address } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import { rpc } from './snapshot.ts';
import type { PumpFork } from './fork.ts';

/**
 * Proof that the fork is an exact copy of mainnet: a real, already-landed pump.fun transaction is run again on the fork
 * (signature checks off, since we hold none of its keys) from the balances it started with, and every balance change
 * and the compute units are compared with what mainnet recorded. Read-only RPC: getTransaction and
 * getMultipleAccounts.
 */

export interface ReplayFixture {
  signature: string;
  slot: number;
  /** The transaction as sent (wire format, base64). */
  tx: string;
  /** Every account it named: static keys, then lookup-table writable and readonly keys, as in the RPC's meta. */
  keys: string[];
  preBalances: string[];
  postBalances: string[];
  computeUnits: number;
  /**
   * Accounts the fork snapshot does not have (lookup tables, the trader, fee recipients, existing vaults), as fetched
   * when the fixture was made. Their lamports are reset to `preBalances` before the replay.
   */
  accounts: Record<string, { lamports: string; owner: string; executable: boolean; data: string } | null>;
}

export interface ReplayResult {
  computeUnits: { fork: number; mainnet: number };
  /** Accounts whose balance changed on mainnet or on the fork, with both changes in lamports. */
  balances: { key: string; fork: bigint; mainnet: bigint }[];
  mismatches: number;
  error: string | null;
  logs: string[];
}

interface RpcTx {
  slot: number;
  transaction: [string, 'base64'] | { message: { accountKeys: string[]; addressTableLookups?: { accountKey: string }[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    computeUnitsConsumed: number;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  };
}

/** Fetches a landed transaction and the accounts the fork needs to replay it. */
export async function fetchReplay(url: string, signature: string, known: (key: string) => boolean): Promise<ReplayFixture> {
  const opts = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
  const raw = await rpc<RpcTx | null>(url, 'getTransaction', [signature, { ...opts, encoding: 'base64' }]);
  const parsed = await rpc<RpcTx | null>(url, 'getTransaction', [signature, { ...opts, encoding: 'json' }]);
  if (!raw || !parsed || Array.isArray(parsed.transaction) || !Array.isArray(raw.transaction)) {
    throw new Error(`transaction ${signature} not found`);
  }
  if (parsed.meta.err) throw new Error(`transaction ${signature} failed on mainnet; only landed transactions replay`);
  const msg = parsed.transaction.message;
  const keys = [...msg.accountKeys, ...(parsed.meta.loadedAddresses?.writable ?? []), ...(parsed.meta.loadedAddresses?.readonly ?? [])];
  const tables = (msg.addressTableLookups ?? []).map((l) => l.accountKey);
  const needed = [...new Set([...tables, ...keys.filter((k, i) => parsed.meta.preBalances[i]! > 0 && !known(k))])];
  const accounts: ReplayFixture['accounts'] = {};
  if (needed.length) {
    const got = await rpc<{ value: ({ lamports: number; owner: string; executable: boolean; data: [string, string] } | null)[] }>(
      url,
      'getMultipleAccounts',
      [needed, { encoding: 'base64', commitment: 'confirmed' }],
    );
    needed.forEach((k, i) => {
      const a = got.value[i];
      accounts[k] = a ? { lamports: String(a.lamports), owner: a.owner, executable: a.executable, data: a.data[0] } : null;
    });
  }
  return {
    signature,
    slot: parsed.slot,
    tx: raw.transaction[0],
    keys,
    preBalances: parsed.meta.preBalances.map(String),
    postBalances: parsed.meta.postBalances.map(String),
    computeUnits: parsed.meta.computeUnitsConsumed,
    accounts,
  };
}

/**
 * Runs the fixture's transaction on `fork` and compares the results with mainnet. Turns off signature and blockhash
 * checks on that fork, so use a fork dedicated to the replay.
 */
export function replayOnFork(fork: PumpFork, fx: ReplayFixture): ReplayResult {
  const svm = fork.svm.withSigverify(false).withBlockhashCheck(false);
  const sys = '11111111111111111111111111111111' as Address;
  for (const [k, a] of Object.entries(fx.accounts)) {
    if (!a) continue;
    const data = Buffer.from(a.data, 'base64');
    svm.setAccount({
      address: k as Address,
      lamports: BigInt(a.lamports) as never,
      programAddress: a.owner as Address,
      executable: a.executable,
      data,
      space: BigInt(data.length),
    });
  }
  // Balances exactly as mainnet had them before the transaction (programs are left as loaded).
  fx.keys.forEach((k, i) => {
    const pre = BigInt(fx.preBalances[i]!);
    const acc = svm.getAccount(k as Address);
    if (acc.exists && !acc.executable) svm.setAccount({ ...acc, lamports: pre as never });
    else if (!acc.exists && pre > 0n) {
      svm.setAccount({ address: k as Address, lamports: pre as never, programAddress: sys, executable: false, data: new Uint8Array(), space: 0n });
    }
  });
  const lamports = (k: string) => {
    const a = svm.getAccount(k as Address);
    return a.exists ? BigInt(a.lamports) : 0n;
  };
  const pre = fx.keys.map(lamports);
  const res = svm.sendTransaction(getTransactionDecoder().decode(Buffer.from(fx.tx, 'base64')));
  const failed = res instanceof FailedTransactionMetadata;
  const meta = failed ? res.meta() : res;
  const balances: ReplayResult['balances'] = [];
  let mismatches = 0;
  fx.keys.forEach((k, i) => {
    const forkDelta = lamports(k) - pre[i]!;
    const mainDelta = BigInt(fx.postBalances[i]!) - BigInt(fx.preBalances[i]!);
    if (forkDelta !== mainDelta) mismatches++;
    if (forkDelta !== 0n || mainDelta !== 0n) balances.push({ key: k, fork: forkDelta, mainnet: mainDelta });
  });
  const computeUnits = Number(meta.computeUnitsConsumed());
  if (computeUnits !== fx.computeUnits) mismatches++;
  return {
    computeUnits: { fork: computeUnits, mainnet: fx.computeUnits },
    balances,
    mismatches,
    error: failed ? res.err().toString() : null,
    logs: meta.logs(),
  };
}
