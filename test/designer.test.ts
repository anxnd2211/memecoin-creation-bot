import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DesignError,
  UploadError,
  buildDraft,
  buildUploadForm,
  checkCompliance,
  describePost,
  fetchPost,
  ipfsUploadUrl,
  parseOEmbed,
  parsePost,
  sniffImage,
  uploadMetadata,
  type DraftInputs,
} from '../src/live/designer.ts';
import type { CoinDraft, PostInfo } from '../src/live/types.ts';

/** A post ID made at unix second `sec` (X IDs are snowflakes: milliseconds since 2010-11-04 in the top bits). */
const idAt = (sec: number) => String((BigInt(sec * 1000) - 1288834974657n) << 22n);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const image = { bytes: PNG, mime: 'image/png', filename: 'pepe.png' };

/** The oEmbed answer for a real public post, as publish.x.com returned it on 2026-10-28. */
const INTERIOR_OEMBED = JSON.parse(
  '{"url":"https:\\/\\/x.com\\/Interior\\/status\\/507185938620219395","author_name":"U.S. Department of the Interior","author_url":"https:\\/\\/x.com\\/Interior","html":"\\u003Cblockquote class=\\"twitter-tweet\\" data-dnt=\\"true\\"\\u003E\\u003Cp lang=\\"en\\" dir=\\"ltr\\"\\u003EHappy 50th anniversary to the Wilderness Act! Here&#39;s a great wilderness photo from \\u003Ca href=\\"https:\\/\\/x.com\\/YosemiteNPS?ref_src=twsrc%5Etfw\\"\\u003E@YosemiteNPS\\u003C\\/a\\u003E. \\u003Ca href=\\"https:\\/\\/x.com\\/hashtag\\/Wilderness50?src=hash&amp;ref_src=twsrc%5Etfw\\"\\u003E#Wilderness50\\u003C\\/a\\u003E \\u003Ca href=\\"http:\\/\\/t.co\\/HMhbyTg18X\\"\\u003Epic.twitter.com\\/HMhbyTg18X\\u003C\\/a\\u003E\\u003C\\/p\\u003E&mdash; U.S. Department of the Interior (@Interior) \\u003Ca href=\\"https:\\/\\/x.com\\/Interior\\/status\\/507185938620219395?ref_src=twsrc%5Etfw\\"\\u003ESeptember 3, 2014\\u003C\\/a\\u003E\\u003C\\/blockquote\\u003E\\n\\n","width":550,"height":null,"type":"rich","cache_age":"3153600000","provider_name":"X","provider_url":"https:\\/\\/x.com","version":"1.0"}',
);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const post = (o: Partial<PostInfo> = {}): PostInfo => ({
  url: 'https://x.com/Interior/status/507185938620219395',
  handle: 'Interior',
  postId: '507185938620219395',
  postedAt: 1409757525,
  authorName: 'U.S. Department of the Interior',
  text: "Happy 50th anniversary to the Wilderness Act! Here's a great wilderness photo from @YosemiteNPS.",
  ...o,
});

const draft = (o: Partial<CoinDraft> = {}): CoinDraft => ({
  name: 'Wilderness Bear',
  symbol: 'WBEAR',
  description: 'A bear enjoying fifty years of wilderness.',
  postUrl: 'https://x.com/Interior/status/507185938620219395',
  website: 'https://www.nps.gov/yose/index.htm',
  image,
  ...o,
});

test('parsePost reads the account, ID and post time from a link to a post', () => {
  const p = parsePost('https://x.com/Interior/status/507185938620219395');
  assert.deepEqual(p, { url: 'https://x.com/Interior/status/507185938620219395', handle: 'Interior', postId: '507185938620219395', postedAt: 1409757525 });
  // Tracking parameters, twitter.com, mobile links, media suffixes and missing schemes give the same canonical link.
  for (const link of [
    'https://twitter.com/Interior/status/507185938620219395?s=46&t=abcDEF',
    'http://mobile.twitter.com/Interior/statuses/507185938620219395',
    'x.com/Interior/status/507185938620219395/photo/1',
    '  https://www.x.com/Interior/status/507185938620219395#m  ',
  ]) {
    assert.equal(parsePost(link).url, 'https://x.com/Interior/status/507185938620219395', link);
  }
  const now = 1_793_145_600;
  assert.equal(parsePost(`https://x.com/someone/status/${idAt(now)}`).postedAt, now);
});

test('parsePost refuses anything that is not a link to one post', () => {
  for (const link of [
    'https://x.com/Interior',
    'https://x.com/i/communities/1234567890123456789',
    'https://x.com/i/status/507185938620219395',
    'https://x.com/search?q=pepe',
    'https://www.instagram.com/p/abc/',
    'https://x.com/Interior/status/20',
    'not a link',
    '',
  ]) {
    assert.throws(() => parsePost(link), DesignError, link);
  }
  assert.throws(() => parsePost('https://x.com/i/status/507185938620219395'), /no account name/);
  assert.throws(() => parsePost('https://x.com/Interior'), /not to a post/);
});

test('fetchPost reads the author and plain text from oEmbed', async () => {
  const urls: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return jsonResponse(INTERIOR_OEMBED);
  }) as typeof fetch;
  const p = await fetchPost('https://twitter.com/Interior/status/507185938620219395?s=20', { fetch: fake });
  assert.equal(p.authorName, 'U.S. Department of the Interior');
  assert.equal(p.handle, 'Interior');
  assert.equal(p.postedAt, 1409757525);
  assert.equal(
    p.text,
    "Happy 50th anniversary to the Wilderness Act! Here's a great wilderness photo from @YosemiteNPS. #Wilderness50 pic.twitter.com/HMhbyTg18X",
  );
  const q = new URL(urls[0]!);
  assert.equal(q.origin + q.pathname, 'https://publish.x.com/oembed');
  assert.equal(q.searchParams.get('url'), 'https://x.com/Interior/status/507185938620219395');
  assert.equal(q.searchParams.get('omit_script'), '1');
  assert.equal(q.searchParams.get('dnt'), 'true');
});

test('fetchPost credits the real author when the link names the wrong account', async () => {
  const fake = (async () => jsonResponse(INTERIOR_OEMBED)) as unknown as typeof fetch;
  const p = await fetchPost('https://x.com/elonmusk/status/507185938620219395', { fetch: fake });
  assert.equal(p.handle, 'Interior');
  assert.equal(p.url, 'https://x.com/Interior/status/507185938620219395');
});

test('fetchPost keeps going without text when oEmbed fails, and still refuses non-post links', async () => {
  const notFound = (async () =>
    new Response('<!DOCTYPE html><title>X / ?</title>', { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const otherPost = (async () => jsonResponse({ ...INTERIOR_OEMBED, url: 'https://x.com/Interior/status/1111111111111111111' })) as unknown as typeof fetch;
  for (const f of [notFound, down, otherPost]) {
    const p = await fetchPost('https://x.com/Interior/status/507185938620219395', { fetch: f });
    assert.deepEqual(
      { authorName: p.authorName, text: p.text, handle: p.handle, postedAt: p.postedAt },
      { authorName: null, text: null, handle: 'Interior', postedAt: 1409757525 },
    );
  }
  await assert.rejects(fetchPost('https://x.com/Interior', { fetch: down }), DesignError);
});

test('oEmbed HTML becomes plain text with line breaks and entities decoded', () => {
  const o = parseOEmbed(
    {
      url: 'https://twitter.com/someone/status/1983000000000000000',
      author_name: 'Some One',
      author_url: 'https://twitter.com/someone',
      html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">BREAKING: cats &amp; dogs<br>agree &lt;3 &#128054; &quot;finally&quot;<br><br><br>more <a href="https://t.co/x">https://t.co/x</a></p>&mdash; Some One (@someone) <a href="#">Oct 28, 2026</a></blockquote>',
    },
    '1983000000000000000',
  );
  assert.deepEqual(o, { authorName: 'Some One', handle: 'someone', text: 'BREAKING: cats & dogs\nagree <3 🐶 "finally"\n\nmore https://t.co/x' });
  assert.equal(parseOEmbed({ url: 'https://x.com/a/status/1', html: '' }, '2'), null);
  assert.equal(parseOEmbed('nope', '2'), null);
});

test('buildDraft takes the owner inputs, quotes the post when there is no description, and links post and source', () => {
  const d = buildDraft(post({ text: "Happy 50th anniversary to the Wilderness Act! pic.twitter.com/HMhbyTg18X" }), {
    name: '  Wilderness   Bear ',
    ticker: '$WBEAR',
    sourceUrl: 'https://www.nps.gov/yose/index.htm',
    image,
  });
  assert.equal(d.name, 'Wilderness Bear');
  assert.equal(d.symbol, 'WBEAR');
  assert.equal(d.description, '“Happy 50th anniversary to the Wilderness Act!” via @Interior');
  assert.equal(d.postUrl, 'https://x.com/Interior/status/507185938620219395');
  assert.equal(d.website, 'https://www.nps.gov/yose/index.htm');
  assert.equal(d.telegram, undefined);
  assert.deepEqual(d.image, image);

  // No source: the website is the post. The owner's description wins. The mime comes from the bytes.
  const d2 = buildDraft(post(), { name: 'Bear', ticker: 'bear', description: 'my words', image: { bytes: JPEG, mime: 'image/png', filename: 'x' } });
  assert.equal(d2.website, 'https://x.com/Interior/status/507185938620219395');
  assert.equal(d2.description, 'my words');
  assert.deepEqual([d2.image.mime, d2.image.filename], ['image/jpeg', 'image.jpg']);
});

test('descriptions built from the post are short, quoted and credited, or neutral without text', () => {
  const long = 'word '.repeat(80);
  const d = describePost({ handle: 'someone', text: long });
  assert.ok(d.startsWith('“word word'));
  assert.ok(d.endsWith('…” via @someone'));
  assert.ok(Array.from(d).length <= 160 + '“” via @someone'.length);
  assert.equal(describePost({ handle: 'someone', text: null }), 'Meme coin inspired by a post from @someone.');
  assert.equal(describePost({ handle: 'someone', text: 'pic.twitter.com/abc https://t.co/xyz' }), 'Meme coin inspired by a post from @someone.');
});

test('buildDraft enforces pump.fun limits and requires an image', () => {
  const ok: DraftInputs = { name: 'Bear', ticker: 'BEAR', image };
  assert.doesNotThrow(() => buildDraft(post(), ok));
  assert.doesNotThrow(() => buildDraft(post(), { ...ok, name: 'x'.repeat(32), ticker: 'ABCDEFGHIJ' }));
  const problems = (inputs: DraftInputs): string[] => {
    try {
      buildDraft(post(), inputs);
      return [];
    } catch (e) {
      assert.ok(e instanceof DesignError);
      return e.problems;
    }
  };
  assert.match(problems({ ...ok, name: 'x'.repeat(33) }).join(), /33 bytes/);
  assert.match(problems({ ...ok, name: 'é'.repeat(17) }).join(), /34 bytes/);
  assert.match(problems({ ...ok, name: '   ' }).join(), /name is empty/);
  assert.match(problems({ ...ok, ticker: 'ABCDEFGHIJK' }).join(), /ticker/);
  assert.match(problems({ ...ok, ticker: 'PE-PE' }).join(), /ticker/);
  assert.match(problems({ ...ok, ticker: '' }).join(), /ticker/);
  assert.match(problems({ ...ok, image: null }).join(), /no image/);
  assert.match(problems({ ...ok, image: undefined }).join(), /no image/);
  assert.match(problems({ ...ok, image: { bytes: new Uint8Array(), mime: 'image/png', filename: 'a.png' } }).join(), /no image/);
  assert.match(problems({ ...ok, image: { bytes: new TextEncoder().encode('<svg/>'), mime: 'image/png', filename: 'a.png' } }).join(), /not a PNG/);
  assert.match(problems({ ...ok, sourceUrl: 'javascript:alert(1)' }).join(), /not an http/);
  assert.match(problems({ ...ok, description: 'x'.repeat(1001) }).join(), /1001 characters/);
  // Every problem is reported at once.
  assert.equal(problems({ name: '', ticker: '!!', image: null }).length, 3);
});

test('a clean draft passes compliance', () => {
  assert.deepEqual(checkCompliance(draft(), post()), []);
  assert.deepEqual(checkCompliance(draft({ website: 'https://x.com/Interior/status/507185938620219395' }), post()), []);
  assert.deepEqual(checkCompliance(draft({ name: "Interior's Bear Hat", telegram: 'https://t.me/wbear' }), post()), []);
  assert.deepEqual(checkCompliance(draft({ name: 'Unofficial Bear', description: 'Not affiliated with anyone.' }), post()), []);
});

test('compliance blocks claims of officialness, endorsement and returns', () => {
  const blocked = (o: Partial<CoinDraft>, re: RegExp) => {
    const problems = checkCompliance(draft(o), post());
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(o)} -> ${JSON.stringify(problems)}`);
  };
  blocked({ name: 'Official Bear' }, /official/);
  blocked({ symbol: 'OFFICIALB' }, /ticker claims "official"/);
  blocked({ name: 'OfficialBear' }, /name claims "official"/);
  blocked({ description: 'The verified bear coin' }, /verified/);
  blocked({ description: 'Endorsed by the park rangers' }, /endorsed/);
  blocked({ description: 'In partnership with Yosemite' }, /partnered/);
  blocked({ description: 'Sponsored bear' }, /sponsored/);
  blocked({ description: 'Affiliated with the Department' }, /affiliated/);
  blocked({ description: 'Backed by the Interior' }, /backed by/);
  blocked({ name: 'The Real Bear' }, /the real/);
  blocked({ description: 'Launched by the Interior team' }, /made by someone/);
  blocked({ description: 'Their own token' }, /own coin/);
  blocked({ description: 'Guaranteed 100x' }, /guaranteed/);
  blocked({ description: 'Totally risk-free' }, /risk-free/);
});

test('compliance blocks impersonating the post author, but not meme references', () => {
  const p = post();
  const imp = (o: Partial<CoinDraft>, q: PostInfo = p) => checkCompliance(draft(o), q).some((x) => /presents the coin as|is @|calls the coin/.test(x));
  assert.equal(imp({ name: 'Interior' }), true);
  assert.equal(imp({ name: 'Interior Coin' }), true);
  assert.equal(imp({ name: 'U.S. Department of the Interior' }), true);
  assert.equal(imp({ name: 'US Department of the Interior Token' }), true);
  assert.equal(imp({ symbol: 'INTERIOR' }), true);
  assert.equal(imp({ description: "@Interior's new coin" }), true);
  assert.equal(imp({ description: "U.S. Department of the Interior's token for the parks" }), true);
  assert.equal(imp({ name: "Interior's Bear" }), false);
  assert.equal(imp({ name: 'Wilderness Bear', symbol: 'BEAR' }), false);

  const elon = post({ handle: 'elonmusk', authorName: 'Elon Musk', url: 'https://x.com/elonmusk/status/507185938620219395' });
  const e = (o: Partial<CoinDraft>) => imp({ postUrl: elon.url, ...o }, elon);
  assert.equal(e({ name: 'Elon Musk' }), true);
  assert.equal(e({ name: 'The Real Elon Musk' }), true);
  assert.equal(e({ symbol: 'ELONMUSK' }), true);
  assert.equal(e({ name: "Elon's Dog", symbol: 'EDOG' }), false);
  assert.equal(e({ name: 'Mars Hat', symbol: 'ELON' }), false);

  const trump = post({ handle: 'realDonaldTrump', authorName: 'Donald J. Trump', url: 'https://x.com/realDonaldTrump/status/507185938620219395' });
  assert.equal(imp({ postUrl: trump.url, name: 'Donald Trump' }, trump), true);
  assert.equal(imp({ postUrl: trump.url, name: 'Trump Golf Cart' }, trump), false);
  // Without oEmbed the handle alone is still checked.
  assert.equal(imp({ name: 'Interior' }, post({ authorName: null, text: null })), true);
});

test('compliance blocks promo websites, X pages that are not posts, bad links, a different post and a missing image', () => {
  const has = (o: Partial<CoinDraft>, re: RegExp) => assert.ok(checkCompliance(draft(o), post()).some((p) => re.test(p)), JSON.stringify(o));
  has({ website: 'https://otcdesks.cash/r/abc' }, /promo/);
  has({ website: 'https://axiom.trade/meme/xyz' }, /promo/);
  has({ website: 'https://pump.fun/coin/abc' }, /promo/);
  has({ website: 'https://x.com/Interior' }, /X page that is not a post/);
  has({ website: 'ftp://example.com/a' }, /not an http/);
  has({ website: 'javascript:alert(1)' }, /not an http/);
  has({ postUrl: 'https://x.com/Interior/status/1983000000000000000' }, /not the post/);
  has({ postUrl: 'https://x.com/elonmusk/status/507185938620219395' }, /names @elonmusk/);
  has({ postUrl: 'mailto:a@b.c' }, /X link/);
  has({ telegram: 'https://otcdesks.cash/tg' }, /not a t\.me link/);
  has({ description: 'Trade at https://axiom.trade/x' }, /description links a promo/);
  has({ image: { bytes: new Uint8Array(), mime: 'image/png', filename: 'a.png' } }, /no image/);
  has({ image: undefined as unknown as CoinDraft['image'] }, /no image/);
  has({ image: { bytes: PNG, mime: 'image/jpeg', filename: 'a.jpg' } }, /labelled image\/jpeg/);
  has({ name: 'x'.repeat(40) }, /bytes/);
});

test('images are recognised from their bytes', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(new TextEncoder().encode('<svg></svg>')), null);
  assert.equal(sniffImage(new Uint8Array()), null);
});

test('the upload form carries the image and every metadata field pump.fun takes', async () => {
  const d = draft({ telegram: 'https://t.me/wbear' });
  const form = buildUploadForm(d);
  assert.deepEqual(
    [...form.keys()],
    ['file', 'name', 'symbol', 'description', 'twitter', 'telegram', 'website', 'showName'],
  );
  const file = form.get('file') as File;
  assert.equal(file.name, 'pepe.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG);
  assert.equal(form.get('name'), 'Wilderness Bear');
  assert.equal(form.get('symbol'), 'WBEAR');
  assert.equal(form.get('description'), 'A bear enjoying fifty years of wilderness.');
  assert.equal(form.get('twitter'), 'https://x.com/Interior/status/507185938620219395');
  assert.equal(form.get('telegram'), 'https://t.me/wbear');
  assert.equal(form.get('website'), 'https://www.nps.gov/yose/index.htm');
  assert.equal(form.get('showName'), 'true');
  assert.equal(buildUploadForm(draft()).get('telegram'), '');
});

test('uploadMetadata posts the form and returns the metadata URI', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return jsonResponse({
      metadata: { name: 'Wilderness Bear', symbol: 'WBEAR', description: 'x', image: 'https://ipfs.io/ipfs/bafyimg', showName: true },
      metadataUri: 'https://ipfs.io/ipfs/bafkreimetadata',
    });
  }) as typeof fetch;
  const uri = await uploadMetadata(draft(), { fetch: fake });
  assert.equal(uri, 'https://ipfs.io/ipfs/bafkreimetadata');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://pump.fun/api/ipfs');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'manual');
  const body = calls[0]!.init.body as FormData;
  assert.ok(body instanceof FormData);
  assert.equal(body.get('symbol'), 'WBEAR');
  assert.equal(body.get('showName'), 'true');
});

test('uploadMetadata fails closed on a bot challenge, 403, HTML, redirects and bad answers', async () => {
  const respond = (r: () => Response) => (async () => r()) as unknown as typeof fetch;
  const challenge = () =>
    new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', {
      status: 403,
      headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
    });
  await assert.rejects(uploadMetadata(draft(), { fetch: respond(challenge) }), (e: unknown) => {
    assert.ok(e instanceof UploadError);
    assert.match(e.message, /bot challenge \(HTTP 403\); not retrying/);
    assert.equal(e.status, 403);
    return true;
  });
  const cases: [() => Response, RegExp][] = [
    [() => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }), /bot challenge/],
    [() => new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } }), /refused the upload \(HTTP 403\)/],
    [() => new Response('<html>ok?</html>', { status: 200, headers: { 'content-type': 'text/html' } }), /not JSON/],
    [() => new Response('{"metadataUri":', { status: 200, headers: { 'content-type': 'application/json' } }), /malformed JSON/],
    [() => jsonResponse({ error: 'nope' }), /without a usable metadataUri/],
    [() => jsonResponse({ metadataUri: 'http://ipfs.io/ipfs/x' }), /without a usable metadataUri/],
    [() => jsonResponse({ metadataUri: 'javascript:alert(1)' }), /without a usable metadataUri/],
    [() => jsonResponse({ metadataUri: 'https://ipfs.io/ipfs/x', metadata: { name: 'Other', symbol: 'WBEAR' } }), /different metadata/],
    [() => jsonResponse({ message: 'rate limited' }, 429), /HTTP 429/],
    [() => new Response(null, { status: 302, headers: { location: 'https://pump.fun/challenge' } }), /redirected/],
  ];
  for (const [r, re] of cases) await assert.rejects(uploadMetadata(draft(), { fetch: respond(r) }), re);
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await assert.rejects(uploadMetadata(draft(), { fetch: down }), /failed: fetch failed/);
});

test('uploadMetadata refuses insecure endpoints and drafts that are not uploadable, before any request', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return jsonResponse({ metadataUri: 'https://ipfs.io/ipfs/x' });
  }) as unknown as typeof fetch;
  await assert.rejects(uploadMetadata(draft(), { fetch: fake, url: 'http://pump.fun/api/ipfs' }), /must be https/);
  await assert.rejects(uploadMetadata(draft({ image: { bytes: new Uint8Array(), mime: 'image/png', filename: 'a' } }), { fetch: fake }), /no image/);
  await assert.rejects(uploadMetadata(draft({ symbol: 'TOO-LONG-TICKER' }), { fetch: fake }), /ticker/);
  assert.equal(calls, 0);
});

test('the upload URL can be configured with PUMP_IPFS_URL', async () => {
  const before = process.env.PUMP_IPFS_URL;
  try {
    delete process.env.PUMP_IPFS_URL;
    assert.equal(ipfsUploadUrl(), 'https://pump.fun/api/ipfs');
    process.env.PUMP_IPFS_URL = 'https://uploads.example.com/api/ipfs';
    assert.equal(ipfsUploadUrl(), 'https://uploads.example.com/api/ipfs');
    let seen = '';
    const fake = (async (input: string | URL | Request) => {
      seen = String(input);
      return jsonResponse({ metadataUri: 'https://ipfs.io/ipfs/x' });
    }) as typeof fetch;
    await uploadMetadata(draft(), { fetch: fake });
    assert.equal(seen, 'https://uploads.example.com/api/ipfs');
  } finally {
    if (before === undefined) delete process.env.PUMP_IPFS_URL;
    else process.env.PUMP_IPFS_URL = before;
  }
});
