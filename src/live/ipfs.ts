import type { CoinDraft } from './types.ts';

/**
 * Coin metadata pinned to IPFS with the owner's own Pinata account, linked the way pump.fun's site links its coins
 * (`https://ipfs.io/ipfs/<cid>`). pump.fun's own upload endpoint sits behind a Cloudflare bot check, and the bot does
 * not work around that. Sniper bots read a new coin's metadata within a second or two, so the upload is only accepted
 * once the public gateway serves it back; until then the launch is blocked.
 *
 * API: https://docs.pinata.cloud/api-reference/endpoint/pin-file-to-ipfs and pin-json-to-ipfs (JWT from the Pinata
 * dashboard, scoped to pinning).
 */

const PINATA = 'https://api.pinata.cloud/pinning';
export const PUBLIC_GATEWAY = 'https://ipfs.io/ipfs/';

export class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinError';
  }
}

export interface PinOptions {
  jwt: string;
  fetchImpl?: typeof fetch;
  /** Gateway the metadata must load from before the launch (the URI's host). */
  gateway?: string;
  /** How long to keep trying the gateway, in ms. */
  verifyTimeoutMs?: number;
}

/** The metadata JSON, in the fields pump.fun's site writes (without claiming the coin was made there). */
export function metadataJson(draft: CoinDraft, imageUri: string): Record<string, unknown> {
  return {
    name: draft.name,
    symbol: draft.symbol,
    description: draft.description,
    image: imageUri,
    showName: true,
    twitter: draft.postUrl,
    website: draft.website,
    ...(draft.telegram ? { telegram: draft.telegram } : {}),
  };
}

async function pinned(res: Response, what: string): Promise<string> {
  const body = await res.text();
  if (!res.ok) throw new PinError(`Pinata ${what} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  let cid: unknown;
  try {
    cid = (JSON.parse(body) as { IpfsHash?: unknown }).IpfsHash;
  } catch {
    throw new PinError(`Pinata ${what} answered with something that is not JSON`);
  }
  if (typeof cid !== 'string' || !/^[a-zA-Z0-9]{40,100}$/.test(cid)) throw new PinError(`Pinata ${what} returned no CID`);
  return cid;
}

/** Pins the image and the metadata, checks the gateway serves the metadata, and returns the metadata URI. */
export async function pinMetadata(draft: CoinDraft, o: PinOptions): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const gateway = o.gateway ?? PUBLIC_GATEWAY;
  const auth = { authorization: `Bearer ${o.jwt}` };
  const options = JSON.stringify({ cidVersion: 1 });

  const form = new FormData();
  form.append('file', new Blob([draft.image.bytes], { type: draft.image.mime }), draft.image.filename);
  form.append('pinataMetadata', JSON.stringify({ name: `${draft.symbol} image` }));
  form.append('pinataOptions', options);
  const imageCid = await pinned(await f(`${PINATA}/pinFileToIPFS`, { method: 'POST', headers: auth, body: form }), 'image pin');

  const json = metadataJson(draft, `${gateway}${imageCid}`);
  const metaCid = await pinned(
    await f(`${PINATA}/pinJSONToIPFS`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ pinataContent: json, pinataMetadata: { name: `${draft.symbol} metadata` }, pinataOptions: { cidVersion: 1 } }),
    }),
    'metadata pin',
  );
  const uri = `${gateway}${metaCid}`;

  // The launch waits until the public gateway serves the metadata back, as sniper bots will fetch it.
  const deadline = Date.now() + (o.verifyTimeoutMs ?? 20_000);
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await f(uri, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const got = (await res.json()) as { name?: string; symbol?: string };
        if (got.name === draft.name && got.symbol === draft.symbol) return uri;
        throw new PinError(`the gateway served different metadata for ${metaCid}`);
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof PinError) throw e;
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new PinError(`pinned as ${metaCid}, but ${gateway} did not serve it in time (${last}); the launch is blocked`);
}
