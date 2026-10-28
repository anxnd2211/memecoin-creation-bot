import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PinError, metadataJson, pinMetadata } from '../src/live/ipfs.ts';
import type { CoinDraft } from '../src/live/types.ts';

const draft: CoinDraft = {
  name: 'Capybara Senate', symbol: 'CAPY', description: '"a capybara walked into the Senate" via @news',
  postUrl: 'https://x.com/news/status/1983000000000000000', website: 'https://www.bbc.com/news/x',
  image: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', filename: 'capy.png' },
};
const IMG = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const META = 'bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function fakePinata(o: { gatewayFails?: number; metaName?: string; pinStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let gatewayTries = 0;
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/pinFileToIPFS')) return new Response(JSON.stringify({ IpfsHash: IMG }), { status: o.pinStatus ?? 200 });
    if (url.endsWith('/pinJSONToIPFS')) return new Response(JSON.stringify({ IpfsHash: META }));
    if (url === `https://ipfs.io/ipfs/${META}`) {
      if (gatewayTries++ < (o.gatewayFails ?? 0)) return new Response('not yet', { status: 504 });
      return new Response(JSON.stringify({ name: o.metaName ?? draft.name, symbol: draft.symbol }));
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { f, calls };
}

test('the metadata links the post and the source and points at the pinned image', () => {
  const m = metadataJson(draft, `https://ipfs.io/ipfs/${IMG}`);
  assert.equal(m.twitter, draft.postUrl);
  assert.equal(m.website, draft.website);
  assert.equal(m.image, `https://ipfs.io/ipfs/${IMG}`);
  assert.equal('createdOn' in m, false);
});

test('pins image and metadata, waits for the public gateway, returns an ipfs.io URI', async () => {
  const { f, calls } = fakePinata({ gatewayFails: 2 });
  const uri = await pinMetadata(draft, { jwt: 'j', fetchImpl: f, verifyTimeoutMs: 10_000 });
  assert.equal(uri, `https://ipfs.io/ipfs/${META}`);
  const meta = JSON.parse(calls.find((c) => c.url.endsWith('/pinJSONToIPFS'))!.init!.body as string);
  assert.equal(meta.pinataContent.image, `https://ipfs.io/ipfs/${IMG}`);
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, 'Bearer j');
});

test('a failed pin, a gateway that never serves it, or different metadata all block the launch', async () => {
  await assert.rejects(pinMetadata(draft, { jwt: 'j', fetchImpl: fakePinata({ pinStatus: 401 }).f }), PinError);
  await assert.rejects(pinMetadata(draft, { jwt: 'j', fetchImpl: fakePinata({ gatewayFails: 99 }).f, verifyTimeoutMs: 1_500 }), /did not serve it in time/);
  await assert.rejects(pinMetadata(draft, { jwt: 'j', fetchImpl: fakePinata({ metaName: 'Other' }).f }), /different metadata/);
});
