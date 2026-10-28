import { existsSync, readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.ts';
import { buildSnapshot, type WalletView } from '../dashboard/snapshot.ts';
import { startDashboard } from '../dashboard/server.ts';
import { DEFAULT_LIMITS } from '../live/board.ts';
import { launchPublicKey } from '../live/venue.ts';
import { vanityLeft } from '../live/vanity.ts';
import { log } from '../log.ts';
import { PLAYBOOK } from '../playbook.ts';
import { Store } from '../store/db.ts';

/**
 * The owner's live window into the bot: `npm run dashboard`, then open http://localhost:8788. One page shows what is
 * happening before a launch (the feed, the X watcher, the hunt), during one (the in-flight bag and its exit) and
 * after (every launch's result, today's totals against the hard limits). Read-only end to end: it opens the database
 * read-only, holds no keys, and has no route that could launch, sell or approve anything, so it is safe to leave
 * open during a session — on this Mac, or on a phone with `--host 0.0.0.0` (same Wi-Fi; anyone on the network can
 * then see it, so keep that to networks you trust).
 */

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const port = Number(arg('port') ?? process.env.DASHBOARD_PORT ?? 8788);
const host = arg('host') ?? process.env.DASHBOARD_HOST ?? '127.0.0.1';

// The wallets shown: the launch wallet, plus any extra public keys in DASHBOARD_WALLETS ("label:pubkey,label:pubkey").
const wallets: WalletView[] = [];
try {
  wallets.push({ label: 'launch', address: launchPublicKey().toBase58(), balanceSol: null });
} catch {
  log.warn('no launch wallet configured; balances panel will be empty');
}
for (const entry of (process.env.DASHBOARD_WALLETS ?? '').split(',')) {
  const [label, address] = entry.split(':').map((s) => s.trim());
  if (!label || !address || wallets.some((w) => w.address === address)) continue;
  try {
    new PublicKey(address);
    wallets.push({ label, address, balanceSol: null });
  } catch {
    log.warn(`DASHBOARD_WALLETS entry "${label}" is not a valid public key; skipped`);
  }
}

let balancesTs: number | null = null;
const conn = new Connection(config.rpcHttp, 'confirmed');
async function refreshBalances(): Promise<void> {
  try {
    const got = await Promise.all(wallets.map((w) => conn.getBalance(new PublicKey(w.address))));
    got.forEach((lamports, i) => (wallets[i]!.balanceSol = lamports / 1e9));
    balancesTs = Math.floor(Date.now() / 1000);
  } catch (e) {
    log.warn(`balance refresh failed: ${(e as Error).message}`);
  }
}

/** The pid in data/live.lock when that process is alive: the same file the launcher takes as its lock. */
function launcherPid(): number | null {
  try {
    const pid = Number(readFileSync('data/live.lock', 'utf8').trim());
    if (!Number.isInteger(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The X watcher's state the way src/cli/live.ts decides it at startup. */
function watcherState(): string {
  if (!process.env.X_BEARER_TOKEN) return 'off (no X_BEARER_TOKEN)';
  if (!existsSync('data/watchlist.json')) return 'off (no watchlist)';
  return 'ready';
}

const store = new Store(config.dbPath, { readOnly: true });
const page = readFileSync(new URL('../dashboard/page.html', import.meta.url), 'utf8');

const snapshot = () =>
  buildSnapshot(store.db, {
    wallets,
    balancesTs,
    killed: existsSync('data/KILL'),
    launcherPid: launcherPid(),
    mintPool: vanityLeft(),
    watcher: watcherState(),
    limits: {
      maxLaunchesPerDay: DEFAULT_LIMITS.maxLaunchesPerDay,
      maxDailyLossSol: DEFAULT_LIMITS.maxDailyLossSol,
      pauseAfterDeadInARow: PLAYBOOK.pauseAfterDeadInARow,
    },
    minGapSec: PLAYBOOK.minGapBetweenLaunchesSec,
  });

await refreshBalances();
const timer = setInterval(refreshBalances, 15_000);
const { server, port: bound } = await startDashboard({ snapshot, page }, port, host);
log.info(`dashboard on http://${host === '0.0.0.0' ? 'localhost' : host}:${bound}`, {
  wallets: wallets.map((w) => w.label),
  phone: host === '0.0.0.0' ? 'open http://<this Mac’s IP>:' + bound + ' on the same Wi-Fi' : 'run with --host 0.0.0.0 to open it from your phone',
});

process.on('SIGINT', () => {
  clearInterval(timer);
  server.close();
  store.db.close();
  process.exit(0);
});
