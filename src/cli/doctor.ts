import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, redactUrl } from '../config.ts';
import { PLAYBOOK } from '../playbook.ts';
import { DEFAULT_LIMITS } from '../live/board.ts';
import { LiveFeed } from '../live/stream.ts';
import { vanityLeft } from '../live/vanity.ts';
import { withFees } from '../live/devbuy.ts';
import { pinMetadata } from '../live/ipfs.ts';
import { launchPublicKey } from '../live/venue.ts';

/**
 * Checks everything a live session needs, before it starts: keys present (values are never printed), the RPC and
 * its speed, the feed's lag, Telegram, Pinata, the X API, the launch wallet's balance, the observer, the ground
 * "pump" addresses and the kill switch. Each line is OK, WARN (works, but worse) or FAIL (live mode will not run, or
 * every launch will be blocked).
 */

if (process.argv.includes('--help')) {
  console.log('usage: npm run doctor [--pin]\n\nChecks the setup for a live session (docs/LIVE-RUNBOOK.md). Prints no secrets. --pin also\npins a tiny test image and metadata to your Pinata account and checks a gateway serves them, as a launch would.');
  process.exit(0);
}

type Level = 'OK' | 'WARN' | 'FAIL';
const results: { level: Level; what: string; detail: string }[] = [];
const say = (level: Level, what: string, detail: string) => {
  results.push({ level, what, detail });
  console.log(`${level.padEnd(4)}  ${what}: ${detail}`);
};
const env = (k: string) => process.env[k]?.trim() || null;
const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = Date.now();
  const v = await f();
  return [v, Date.now() - t];
};

// RPC
const conn = new Connection(config.rpcHttp, 'confirmed');
try {
  const [slot, ms] = await timed(() => conn.getSlot());
  const publicRpc = /api\.mainnet-beta\.solana\.com/.test(config.rpcHttp);
  say(publicRpc ? 'WARN' : ms > 500 ? 'WARN' : 'OK', 'RPC', `${redactUrl(config.rpcHttp)} answered slot ${slot} in ${ms} ms${publicRpc ? ' (the free public RPC: get a Helius key)' : ''}`);
} catch (e) {
  say('FAIL', 'RPC', `${redactUrl(config.rpcHttp)} did not answer: ${(e as Error).message}`);
}

// Sender: tips and staked routes land launches and sells sooner; without it they go through the RPC only.
say(
  config.senderUrl ? 'OK' : 'WARN',
  'Sender',
  config.senderUrl
    ? `${redactUrl(config.senderUrl)}, tip ${(config.senderTipLamports / 1e9).toFixed(4)} SOL per transaction`
    : 'SENDER_URL not set: launches and sells go through the RPC alone, with no tip (successful devs tip about 0.005 SOL)',
);

// Feed lag
{
  const feed = new LiveFeed();
  feed.start();
  await new Promise((r) => setTimeout(r, 15_000));
  const lag = feed.lag.estimate(Date.now());
  feed.stop();
  if (lag === null) say('FAIL', 'feed', 'no lag estimate after 15 s: the websocket delivered too little');
  else {
    const exit = lag <= PLAYBOOK.maxFeedLagSec ? 'the flow exit' : `the ${PLAYBOOK.slowFeedExit.maxHoldSec} s timer`;
    say(lag <= PLAYBOOK.maxFeedLagSec ? 'OK' : 'WARN', 'feed', `p95 lag ${lag.toFixed(2)} s: launches would use ${exit}`);
  }
}

// Telegram
const token = env('TELEGRAM_BOT_TOKEN');
const chat = env('TELEGRAM_CHAT_ID');
if (!token || !chat) say('FAIL', 'Telegram', 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set');
else {
  try {
    const api = (method: string, q = '') =>
      fetch(`https://api.telegram.org/bot${token}/${method}${q}`, { signal: AbortSignal.timeout(8_000) }).then(
        (r) => r.json() as Promise<{ ok: boolean; result?: Record<string, unknown>; description?: string }>,
      );
    const me = await api('getMe');
    if (!me.ok) say('FAIL', 'Telegram', `token rejected (${me.description ?? 'no description'})`);
    else {
      const [hook, chatInfo] = await Promise.all([api('getWebhookInfo'), api('getChat', `?chat_id=${encodeURIComponent(chat)}`)]);
      const webhook = String(hook.result?.url ?? '');
      const group = Number(chat) < 0;
      if (webhook) say('FAIL', 'Telegram', `a webhook is set (${webhook.replace(/\/\/[^/]+/, '//…')}): approvals would never arrive; remove it with deleteWebhook`);
      else if (!chatInfo.ok) say('FAIL', 'Telegram', `the bot cannot see chat ${chat} (${chatInfo.description ?? 'unknown'}): send the bot a message first, then check TELEGRAM_CHAT_ID`);
      else if (group && !env('TELEGRAM_OWNER_ID')) say('FAIL', 'Telegram', 'the chat is a group: set TELEGRAM_OWNER_ID so only you can approve');
      else say('OK', 'Telegram', `bot @${String(me.result?.username)} can reach ${group ? 'the group' : 'your chat'}; no webhook`);
    }
  } catch (e) {
    say('FAIL', 'Telegram', `could not reach the Bot API: ${(e as Error).message}`);
  }
}

// Pinata
const jwt = env('PINATA_JWT');
if (!jwt) say('FAIL', 'Pinata', 'PINATA_JWT is not set: live launches cannot upload metadata');
else {
  try {
    const res = await fetch('https://api.pinata.cloud/data/testAuthentication', { headers: { authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(8_000) });
    say(res.ok ? 'OK' : 'FAIL', 'Pinata', res.ok ? 'JWT accepted' : `JWT rejected (HTTP ${res.status})`);
  } catch (e) {
    say('FAIL', 'Pinata', `could not reach Pinata: ${(e as Error).message}`);
  }
}

// X API
const bearer = env('X_BEARER_TOKEN');
if (!bearer) say('WARN', 'X API', 'X_BEARER_TOKEN not set: no X watcher; send posts with /launch');
else {
  try {
    const res = await fetch('https://api.x.com/2/tweets/search/stream/rules', { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8_000) });
    say(res.ok ? 'OK' : 'WARN', 'X API', res.ok ? 'filtered stream rules readable' : `HTTP ${res.status}: the X watcher will not run`);
  } catch (e) {
    say('WARN', 'X API', `could not reach X: ${(e as Error).message}`);
  }
}
say(existsSync('data/watchlist.json') ? 'OK' : 'WARN', 'watchlist', existsSync('data/watchlist.json') ? 'data/watchlist.json present' : 'run python3 ml/watchlist.py');

// Launch wallet
let wallet: PublicKey | null = null;
try {
  wallet = launchPublicKey();
} catch (e) {
  say('FAIL', 'launch wallet', (e as Error).message);
}
if (wallet) {
  const keyFile = config.launchKeypairPath;
  if (!keyFile) say('WARN', 'launch keypair', 'LAUNCH_KEYPAIR_PATH not set: dry mode only');
  else {
    const mode = statSync(keyFile).mode & 0o777;
    say(mode & 0o077 ? 'WARN' : 'OK', 'launch keypair', `file present, permissions ${mode.toString(8)}${mode & 0o077 ? ' (run chmod 600 on it)' : ''}`);
  }
  try {
    const sol = (await conn.getBalance(wallet)) / 1e9;
    const need5 = PLAYBOOK.devBuySol + DEFAULT_LIMITS.reserveSol;
    const need2 = withFees(2) + DEFAULT_LIMITS.reserveSol;
    say(
      sol >= need5 ? 'OK' : sol >= need2 ? 'WARN' : 'FAIL',
      'balance',
      `${wallet.toBase58()} holds ${sol.toFixed(4)} SOL: ` +
        (sol >= need5
          ? `enough for the playbook's 5 SOL launches (${need5.toFixed(2)} each; a batch of 10 wants about 8)`
          : sol >= need2
            ? `start with --dev-buy auto or --dev-buy 2 (2 SOL launches need ${need2.toFixed(2)}; 5 SOL needs ${need5.toFixed(2)})`
            : `too little for any launch (2 SOL launches need ${need2.toFixed(2)})`),
    );
  } catch (e) {
    say('FAIL', 'balance', `could not read: ${(e as Error).message}`);
  }
}

// Observer
if (!existsSync(config.dbPath)) say('FAIL', 'observer', `no database at ${config.dbPath}`);
else {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const last = (db.prepare('SELECT MAX(ts) AS t FROM trades WHERE ts >= ?').get(Math.floor(Date.now() / 1000) - 3600) as { t: number | null }).t;
  const stale = last === null ? null : Math.floor(Date.now() / 1000) - last;
  say(stale !== null && stale <= DEFAULT_LIMITS.maxObserverStaleSec ? 'OK' : 'FAIL', 'observer', stale === null ? 'nothing recorded in the last hour: start npm run observe' : `last trade recorded ${stale} s ago`);
}

// IPFS gateways: the upload check and the first-on-post check need at least one that answers from this machine.
if (existsSync(config.dbPath)) {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const row = db.prepare(`SELECT uri FROM coins WHERE uri LIKE '%/ipfs/%' AND meta_status = 'done' ORDER BY created_ts DESC LIMIT 1`).get() as
    | { uri: string }
    | undefined;
  if (!row) say('WARN', 'IPFS', 'no recent IPFS metadata in the database to test the gateways with');
  else {
    const cid = row.uri.slice(row.uri.indexOf('/ipfs/') + 6);
    const results = await Promise.all(
      config.ipfsGateways.map(async (g) => {
        try {
          const res = await fetch(g + cid, { signal: AbortSignal.timeout(6_000) });
          return `${new URL(g).host} ${res.ok ? 'ok' : res.status}`;
        } catch {
          return `${new URL(g).host} timeout`;
        }
      }),
    );
    const ok = results.filter((r) => r.endsWith(' ok')).length;
    say(ok ? 'OK' : 'FAIL', 'IPFS', `${ok} of ${results.length} gateways answer: ${results.join(', ')}`);
  }
}

// Pinata upload rehearsal (--pin): pins a tiny test image and metadata on the owner's account and checks a gateway
// serves it back, the same path a launch takes. It publishes only the test files, under the owner's Pinata account.
if (process.argv.includes('--pin')) {
  if (!jwt) say('FAIL', 'Pinata upload', 'PINATA_JWT is not set');
  else {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const t = Date.now();
    try {
      const uri = await pinMetadata(
        {
          name: 'Launcher check',
          symbol: 'CHECK',
          description: `upload check ${new Date().toISOString()}`,
          postUrl: 'https://x.com/x/status/1',
          website: 'https://example.com',
          image: { bytes: png, mime: 'image/png', filename: 'check.png' },
        },
        { jwt, checkGateways: config.ipfsGateways },
      );
      say('OK', 'Pinata upload', `pinned and served back in ${((Date.now() - t) / 1000).toFixed(1)} s: ${uri}`);
    } catch (e) {
      say('FAIL', 'Pinata upload', `${(e as Error).message} (the key needs the pinFileToIPFS and pinJSONToIPFS scopes)`);
    }
  }
} else say('OK', 'Pinata upload', 'not rehearsed (npm run doctor -- --pin pins a tiny test file to check the whole upload)');

// Mint addresses, kill switch, playbook
const left = vanityLeft();
say(left >= 10 ? 'OK' : left > 0 ? 'WARN' : 'WARN', 'pump addresses', `${left} ground${left < 10 ? ' (npm run grind -- --count 20)' : ''}`);
say(existsSync('data/KILL') ? 'WARN' : 'OK', 'kill switch', existsSync('data/KILL') ? 'ON (data/KILL exists): no launches until /resume' : 'off');
say('OK', 'playbook', `v${PLAYBOOK.version}: dev buy ${PLAYBOOK.devBuySol} SOL, exit "${PLAYBOOK.exit.name}", limits ${DEFAULT_LIMITS.maxLaunchesPerDay} launches and -${DEFAULT_LIMITS.maxDailyLossSol} SOL a day`);

const fails = results.filter((r) => r.level === 'FAIL').length;
console.log(`\n${fails ? `${fails} check(s) failed: fix them before npm run live -- --mode live.` : 'Ready for a dry run, then live.'}`);
process.exitCode = fails ? 1 : 0;
