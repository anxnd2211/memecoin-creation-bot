import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/**
 * Mint addresses ending in "pump", like every coin made on pump.fun's site. On 2026-10-27 the 3 SOL+ launches without
 * that ending were almost all from a tool sniper bots skip (sniped 48% of the time against 81%), so the launcher uses
 * a ground address when it has one. Grinding is a search: about 11 million keys per hit (58^4), about 2 minutes on
 * six threads. A pool is ground ahead of time into data/vanity/ (git-ignored); each launch takes one and moves it to
 * data/vanity/used/. These keys only sign the coin's creation; they never hold SOL.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const VANITY_DIR = 'data/vanity';

/** The number the last `suffix.length` base58 digits of an address encode. */
export function suffixValue(suffix: string): number {
  let v = 0;
  for (const ch of suffix) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) throw new Error(`"${ch}" is not a base58 digit`);
    v = v * 58 + d;
  }
  return v;
}

/** Whether a 32-byte public key's base58 form ends with the suffix whose value and length are given. */
export function endsWithSuffix(pub: Uint8Array, value: number, len: number): boolean {
  const mod = 58 ** len;
  let r = 0;
  for (const b of pub) r = (r * 256 + b) % mod;
  return r === value;
}

/** Searches keys until one ends with `suffix`; returns its 64-byte secret key (seed then public key). */
export function grindOne(suffix = 'pump', maxTries = Infinity): Uint8Array | null {
  const value = suffixValue(suffix);
  for (let i = 0; i < maxTries; i++) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const pub = publicKey.subarray(publicKey.length - 32);
    if (endsWithSuffix(pub, value, suffix.length)) {
      const secret = new Uint8Array(64);
      secret.set(privateKey.subarray(privateKey.length - 32), 0);
      secret.set(pub, 32);
      return secret;
    }
  }
  return null;
}

function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/** Saves a ground key in the Solana CLI format (a JSON array of the 64 secret-key bytes), readable by the owner only. */
export function saveVanity(secret: Uint8Array, dir = VANITY_DIR): string {
  mkdirSync(dir, { recursive: true });
  const address = base58(secret.subarray(32));
  const path = join(dir, `${address}.json`);
  writeFileSync(path, JSON.stringify([...secret]));
  chmodSync(path, 0o600);
  return address;
}

/** Takes one unused ground key from the pool (moving it to used/); null when the pool is empty. */
export function takeVanity(dir = VANITY_DIR, suffix = 'pump'): Uint8Array | null {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith(`${suffix}.json`));
  if (!file) return null;
  const used = join(dir, 'used');
  mkdirSync(used, { recursive: true });
  renameSync(join(dir, file), join(used, file));
  return Uint8Array.from(JSON.parse(readFileSync(join(used, file), 'utf8')) as number[]);
}

/** Unused ground keys in the pool. */
export function vanityLeft(dir = VANITY_DIR, suffix = 'pump'): number {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(`${suffix}.json`)).length : 0;
}

/** Grinds `count` keys on `threads` worker threads, saving each as it is found. */
export async function grindPool(count: number, threads: number, onFound: (address: string) => void, suffix = 'pump'): Promise<void> {
  let found = 0;
  const workers: Worker[] = [];
  await new Promise<void>((resolve, reject) => {
    for (let t = 0; t < threads; t++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { suffix } });
      w.on('message', (secret: Uint8Array) => {
        if (found >= count) return;
        found++;
        onFound(saveVanity(secret));
        if (found >= count) {
          for (const x of workers) void x.terminate();
          resolve();
        }
      });
      w.on('error', reject);
      workers.push(w);
    }
  });
}

// Worker thread: grind forever, posting each hit to the parent.
const { isMainThread, parentPort, workerData } = await import('node:worker_threads');
if (!isMainThread && parentPort && workerData?.suffix) {
  for (;;) {
    const secret = grindOne(workerData.suffix as string);
    if (secret) parentPort.postMessage(secret);
  }
}
