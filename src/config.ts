import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function str(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function list(name: string, fallback: string): string[] {
  return str(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const rpcHttp = str('SOLANA_RPC_HTTP', 'https://api.mainnet-beta.solana.com');
const commitment = str('COMMITMENT', 'confirmed');
if (commitment !== 'processed' && commitment !== 'confirmed') {
  throw new Error(`COMMITMENT must be "processed" or "confirmed", got "${commitment}"`);
}

/** A whole number within [min, max]; a typo in a fee setting must stop the bot, not spend SOL. */
function int(name: string, fallback: number, min: number, max: number): number {
  const n = num(name, fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${n}`);
  return n;
}

function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

const storeTrades = str('STORE_TRADES', 'curve');
if (!['none', 'curve', 'all'].includes(storeTrades)) {
  throw new Error(`STORE_TRADES must be none, curve or all, got "${storeTrades}"`);
}

export const config = {
  rpcHttp,
  rpcWs: str('SOLANA_RPC_WS', rpcHttp.replace(/^http/, 'ws')),
  commitment: commitment as 'processed' | 'confirmed',
  /**
   * Check each streamed transaction's status before using it. Only for paid RPCs with consistent status lookups:
   * on the public RPC, status lookups trail the log stream by ~15 s and get rate-limited.
   */
  verifyTxs: str('VERIFY_TXS', 'false') === 'true',

  dbPath: str('DB_PATH', 'data/observer.db'),
  /** Which raw trades to keep: `curve` (bonding curve only), `all` (plus PumpSwap, ~15x more rows), or `none`. */
  storeTrades: storeTrades as 'none' | 'curve' | 'all',
  tradeRetentionDays: num('TRADE_RETENTION_DAYS', 14),
  positionRetentionDays: num('POSITION_RETENTION_DAYS', 7),
  minFreeDiskGb: num('MIN_FREE_DISK_GB', 3),

  metadataMinBuyers: num('METADATA_MIN_BUYERS', 8),
  metadataSampleRate: num('METADATA_SAMPLE_RATE', 1),
  ipfsGateways: list(
    'IPFS_GATEWAYS',
    'https://ipfs.io/ipfs/,https://dweb.link/ipfs/,https://gateway.pinata.cloud/ipfs/,https://4everland.io/ipfs/,https://ipfs.filebase.io/ipfs/',
  ),

  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || null,

  logLevel: str('LOG_LEVEL', 'info'),

  /** The launch wallet's keypair file (Solana CLI JSON); read only by live mode, and never logged. */
  launchKeypairPath: optional('LAUNCH_KEYPAIR_PATH'),
  /** The launch wallet's public key, for dry mode (simulation only, no key needed). Must match the keypair if both are set. */
  launchPubkey: optional('LAUNCH_PUBKEY'),
  /**
   * Compute-unit price for launches and sells, in micro-lamports. Charged on the unit limit: 200,000 on a 250,000-unit
   * launch is 0.00005 SOL. Capped at 50,000,000 (0.0125 SOL on that launch) so a typo cannot drain the wallet.
   */
  priorityMicroLamports: int('PRIORITY_MICROLAMPORTS', 200_000, 0, 50_000_000),
  /**
   * Helius Sender endpoint (e.g. https://sender.helius-rpc.com/fast). When set, launches and sells also go to it, with
   * a tip; when unset they go to SOLANA_RPC_HTTP only and carry no tip.
   */
  senderUrl: optional('SENDER_URL'),
  /**
   * Tip per transaction sent through Sender, in lamports. Sender takes 5,000 and up; tips under 1,000,000 (0.001 SOL)
   * are sent best-effort on fewer paths (https://www.helius.dev/docs/sending-transactions/sender). Capped at 0.05 SOL.
   */
  senderTipLamports: int('SENDER_TIP_LAMPORTS', 200_000, 5_000, 50_000_000),
};

/** Strips query strings (API keys) from URLs before they are logged. */
export function redactUrl(url: string): string {
  return url.replace(/\?.*$/, '?…');
}
