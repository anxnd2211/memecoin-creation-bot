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
  tradeRetentionDays: num('TRADE_RETENTION_DAYS', 3),
  positionRetentionDays: num('POSITION_RETENTION_DAYS', 7),
  minFreeDiskGb: num('MIN_FREE_DISK_GB', 3),

  metadataMinBuyers: num('METADATA_MIN_BUYERS', 8),
  metadataSampleRate: num('METADATA_SAMPLE_RATE', 0.05),
  ipfsGateways: list('IPFS_GATEWAYS', 'https://ipfs.io/ipfs/,https://dweb.link/ipfs/,https://gateway.pinata.cloud/ipfs/'),

  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || null,

  logLevel: str('LOG_LEVEL', 'info'),
};

/** Strips query strings (API keys) from URLs before they are logged. */
export function redactUrl(url: string): string {
  return url.replace(/\?.*$/, '?…');
}
