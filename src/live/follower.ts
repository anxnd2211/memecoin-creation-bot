import { tweetTs, xHandle } from '../intel/xlinks.ts';
import { candidateUrls, parseMeta } from '../market/metadata.ts';
import { sniffImage } from './designer.ts';
import type { LiveLaunch } from './stream.ts';
import type { PostInfo } from './types.ts';

/**
 * The launch-follower: full automation without an X API key. Other devs' bots watch X and launch within seconds of a
 * post; the first launch on a post is therefore itself the freshest possible signal that the post exists. The
 * follower watches the live feed for new launches, reads each one's metadata, and when it is the first launch on a
 * post young enough for the playbook, hands the post over as a launch candidate, so ours becomes the second launch on
 * the post. On recorded data, second launches arriving within 60 s of the first on a post under 3 minutes old made
 * +1.14 SOL at a 2 SOL bag (65% profitable, about 16 chances an hour); first launches made +1.34. The coin's image is
 * the post's image, read from the trigger launch's metadata, as every launch on a post uses the post's image.
 */

export interface FollowCandidate {
  post: PostInfo;
  /** The trigger: the first launch on the post. */
  trigger: { mint: string; symbol: string; devBuySol: number; ageSec: number };
  image: { bytes: Uint8Array; mime: string; filename: string } | null;
  /** Local ms when the trigger launch arrived on the feed. */
  seenAt: number;
}

export interface FollowerOptions {
  /** Follow only posts at most this old when the trigger launch is seen (the playbook allows 120 s at our launch). */
  maxPostAgeSec?: number;
  /** Ignore trigger launches whose dev put in less than this (SOL into the curve): dust and spam launches. */
  minTriggerBuySol?: number;
  /** IPFS gateways for the metadata and image (config.ipfsGateways). */
  gateways: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const META_TIMEOUT_MS = 6_000;
const IMAGE_TIMEOUT_MS = 6_000;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** Fetches a launch's metadata JSON through every gateway at once; null when none serves it in time. */
async function readMeta(uri: string, o: FollowerOptions): Promise<ReturnType<typeof parseMeta> | null> {
  const f = o.fetchImpl ?? fetch;
  const tries = candidateUrls(uri, o.gateways).map(async (url) => {
    const res = await f(url, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseMeta((await res.json()) as Record<string, unknown>);
  });
  return tries.length ? Promise.any(tries).catch(() => null) : null;
}

/** Fetches the post's image (the trigger's metadata image); null when it cannot be read or is not an image. */
async function readImage(uri: string | null, o: FollowerOptions): Promise<FollowCandidate['image']> {
  if (!uri) return null;
  const f = o.fetchImpl ?? fetch;
  const tries = candidateUrls(uri, o.gateways).map(async (url) => {
    const res = await f(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime || bytes.length > IMAGE_MAX_BYTES) throw new Error('not a usable image');
    return { bytes, mime, filename: `post.${mime.split('/')[1]}` };
  });
  return tries.length ? Promise.any(tries).catch(() => null) : null;
}

/**
 * Looks at one new launch from the feed and returns the post to follow, or null with the reason it is not followable.
 * The caller still runs the launch board (which checks first-on-post against the database, the account's heat, our
 * limits) and the owner still approves; this only turns a trigger launch into a candidate.
 */
export async function followLaunch(
  l: LiveLaunch,
  o: FollowerOptions,
): Promise<{ candidate: FollowCandidate | null; reason: string }> {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  if (l.isMayhem || l.quote !== 'SOL') return { candidate: null, reason: 'mayhem or not SOL' };
  if (l.devBuySol / 1.0125 < (o.minTriggerBuySol ?? 0.1)) return { candidate: null, reason: 'trigger dev buy too small' };
  const meta = await readMeta(l.uri, o);
  if (!meta) return { candidate: null, reason: 'metadata unreadable' };
  const postedAt = tweetTs(meta.twitter);
  const handle = xHandle(meta.twitter);
  if (postedAt === null || !handle) return { candidate: null, reason: 'no post link in the metadata' };
  const age = now() - postedAt;
  if (age > (o.maxPostAgeSec ?? 90) || age < -5) return { candidate: null, reason: `post is ${Math.round(age)} s old` };
  const postId = meta.twitter!.match(/\/status(?:es)?\/(\d+)/)![1]!;
  const image = await readImage(meta.image, o);
  return {
    candidate: {
      post: { url: `https://x.com/${handle}/status/${postId}`, handle, postId, postedAt, authorName: null, text: null },
      trigger: { mint: l.mint, symbol: l.symbol, devBuySol: l.devBuySol, ageSec: now() - l.chainTs },
      image,
      seenAt: l.receivedAt,
    },
    reason: 'followable',
  };
}
