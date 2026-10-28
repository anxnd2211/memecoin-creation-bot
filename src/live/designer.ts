import { tweetTs, xHandle } from '../intel/xlinks.ts';
import { websiteKind } from '../sim/traits.ts';
import type { CoinDraft, PostInfo } from './types.ts';

/**
 * The coin designer for live launches: reads the X post a coin is built on, turns the owner's inputs into a coin
 * draft, checks the draft against the ground rules (no impersonation, no false claims, no implied endorsement) and
 * uploads its metadata to pump.fun's IPFS. Every check fails closed: a draft that cannot be checked is not launched,
 * and nothing here can be overridden.
 */

/** pump.fun's limits: names up to 32 bytes, tickers up to 10 letters or digits. */
export const NAME_MAX_BYTES = 32;
export const TICKER_RE = /^[A-Za-z0-9]{1,10}$/;
export const DESCRIPTION_MAX = 1_000;
/** How much of the post text goes into a description built from the post. */
export const POST_TEXT_CHARS = 160;
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** X's public oEmbed endpoint (publish.twitter.com redirects here; calling it directly saves a round trip). */
export const OEMBED_URL = 'https://publish.x.com/oembed';
/** pump.fun's metadata upload, as its own site uses it; override with PUMP_IPFS_URL. */
export const PUMP_IPFS_URL = 'https://pump.fun/api/ipfs';

/** A draft or post link that fails validation; `problems` lists every reason. */
export class DesignError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.name = 'DesignError';
    this.problems = problems;
  }
}

/** The metadata upload failed or was refused; never retried around a block. */
export class UploadError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------------------------

const POST_LINK = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:[/?#].*)?$/i;
/** First path segments of x.com that are not accounts. */
const NOT_ACCOUNTS = ['i', 'intent', 'search', 'home', 'hashtag', 'share', 'explore', 'settings', 'messages', 'notifications'];

/** Canonical link to a post: no tracking parameters, x.com, https. */
export function postUrl(handle: string, postId: string): string {
  return `https://x.com/${handle}/status/${postId}`;
}

/**
 * The account, post ID and post time (from the snowflake ID) of a link to an X post. Throws a DesignError for
 * anything that is not a link to a single post: profiles, communities, searches, /i/ links without an account name,
 * other sites.
 */
export function parsePost(url: string): Pick<PostInfo, 'url' | 'handle' | 'postId' | 'postedAt'> {
  const link = url.trim();
  const m = link.match(POST_LINK);
  if (!m) {
    const why = xHandle(link) !== null || /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(link)
      ? 'it is an X link but not to a post (expected https://x.com/<account>/status/<id>)'
      : 'it is not an X post link (expected https://x.com/<account>/status/<id>)';
    throw new DesignError([`"${clip(link, 80)}": ${why}`]);
  }
  const handle = m[1]!;
  const postId = m[2]!;
  if (NOT_ACCOUNTS.includes(handle.toLowerCase())) {
    throw new DesignError([`"${clip(link, 80)}" has no account name: open the post and copy its link (x.com/<account>/status/<id>)`]);
  }
  const postedAt = postId.length >= 15 && BigInt(postId) < 2n ** 63n ? tweetTs(`/status/${postId}`) : null;
  if (postedAt === null) throw new DesignError([`post ID ${postId} is not a snowflake ID, so the post time is unknown`]);
  return { url: postUrl(handle, postId), handle, postId, postedAt };
}

export interface FetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to OEMBED_URL. */
  endpoint?: string;
}

/**
 * The post behind a link, read from X's public oEmbed endpoint (no login, no x.com pages). The handle comes from the
 * post's real author when oEmbed answers, so a link typed with the wrong account name still credits the right one.
 * When oEmbed fails (deleted or protected post, network, rate limit) the author name and text are null and the launch
 * can go ahead on the owner's inputs. Throws a DesignError only for links that are not posts.
 */
export async function fetchPost(url: string, opts: FetchOptions = {}): Promise<PostInfo> {
  const parsed = parsePost(url);
  const base: PostInfo = { ...parsed, authorName: null, text: null };
  try {
    const q = new URL(opts.endpoint ?? OEMBED_URL);
    q.searchParams.set('url', parsed.url);
    q.searchParams.set('omit_script', '1');
    q.searchParams.set('dnt', 'true');
    const res = await (opts.fetch ?? fetch)(q, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4_000),
    });
    if (!res.ok || !/json/i.test(res.headers.get('content-type') ?? '')) return base;
    const o = parseOEmbed(await res.json(), parsed.postId);
    if (!o) return base;
    const handle = o.handle ?? parsed.handle;
    return { ...base, url: postUrl(handle, parsed.postId), handle, authorName: o.authorName, text: o.text };
  } catch {
    return base;
  }
}

/**
 * Author and plain text from an oEmbed answer; null when it is not an answer for `postId`. The text is the post's
 * first paragraph (`<p>` in the embed HTML) with tags removed, line breaks kept and HTML entities decoded.
 */
export function parseOEmbed(
  body: unknown,
  postId: string,
): { authorName: string | null; handle: string | null; text: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const answeredId = (typeof o.url === 'string' ? o.url : '').match(/\/status(?:es)?\/(\d+)/)?.[1];
  if (answeredId !== postId) return null;
  const authorName = typeof o.author_name === 'string' && o.author_name.trim() ? o.author_name.trim() : null;
  const authorHandle = typeof o.author_url === 'string' ? o.author_url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i)?.[1] : null;
  const handle = authorHandle && !NOT_ACCOUNTS.includes(authorHandle.toLowerCase()) ? authorHandle : null;
  const html = typeof o.html === 'string' ? o.html : '';
  const p = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const text = p === undefined ? null : htmlText(p) || null;
  return { authorName, handle, text };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------------------

/** What the owner gives for a coin (from the Telegram /launch command). */
export interface DraftInputs {
  name: string;
  ticker: string;
  /** The narrative's original source; the post itself when absent. */
  sourceUrl?: string | null;
  /** The owner's description; one is built from the post when absent. */
  description?: string | null;
  telegram?: string | null;
  /** Required: no image, no draft. */
  image?: CoinDraft['image'] | null;
}

/** The image's type from its first bytes (PNG, JPEG, GIF or WEBP); null for anything else. */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A short neutral description quoting the start of the post, credited to its account; never a claim. */
export function describePost(post: Pick<PostInfo, 'handle' | 'text'>): string {
  const text = (post.text ?? '')
    .replace(/\bpic\.(?:twitter|x)\.com\/\S+/gi, '')
    .replace(/https?:\/\/t\.co\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return `Meme coin inspired by a post from @${post.handle}.`;
  const chars = Array.from(text);
  const quote = chars.length > POST_TEXT_CHARS ? chars.slice(0, POST_TEXT_CHARS - 1).join('').trimEnd() + '…' : text;
  return `“${quote}” via @${post.handle}`;
}

/**
 * The coin draft from the post and the owner's inputs: name and ticker as given (a leading $ on the ticker is
 * dropped), the owner's description or one quoting the post, the source as the website (the post when there is none),
 * the post as the X link, and the owner's image. Throws a DesignError listing every problem; never fills in an image.
 */
export function buildDraft(post: PostInfo, inputs: DraftInputs): CoinDraft {
  const problems: string[] = [];
  const name = (inputs.name ?? '').trim().replace(/\s+/g, ' ');
  const symbol = (inputs.ticker ?? '').trim().replace(/^\$/, '');
  const description = inputs.description?.trim() ? inputs.description.trim() : describePost(post);
  const website = inputs.sourceUrl?.trim() ? inputs.sourceUrl.trim() : post.url;
  const telegram = inputs.telegram?.trim() || undefined;
  problems.push(...nameProblems(name), ...symbolProblems(symbol), ...descriptionProblems(description));
  if (!httpUrl(website)) problems.push(`website "${clip(website, 80)}" is not an http(s) link`);
  if (telegram !== undefined && !httpUrl(telegram)) problems.push(`telegram "${clip(telegram, 80)}" is not an http(s) link`);
  const image = inputs.image ?? null;
  problems.push(...imageProblems(image));
  if (problems.length) throw new DesignError(problems);
  const mime = sniffImage(image!.bytes)!;
  const filename = /\.(png|jpe?g|gif|webp)$/i.test(image!.filename) ? image!.filename : `image.${EXT[mime]}`;
  return {
    name,
    symbol,
    description,
    postUrl: post.url,
    website,
    ...(telegram !== undefined ? { telegram } : {}),
    image: { bytes: image!.bytes, mime, filename },
  };
}

function nameProblems(name: string): string[] {
  if (!name) return ['name is empty'];
  const out: string[] = [];
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > NAME_MAX_BYTES) out.push(`name is ${bytes} bytes; pump.fun allows ${NAME_MAX_BYTES}`);
  if (/[\p{Cc}\p{Cf}]/u.test(name)) out.push('name contains control or invisible characters');
  return out;
}

function symbolProblems(symbol: string): string[] {
  return TICKER_RE.test(symbol) ? [] : [`ticker "${clip(symbol, 20)}" must be 1-10 letters or digits`];
}

function descriptionProblems(description: string): string[] {
  if (!description) return ['description is empty'];
  return description.length > DESCRIPTION_MAX ? [`description is ${description.length} characters; keep it to ${DESCRIPTION_MAX}`] : [];
}

function imageProblems(image: CoinDraft['image'] | null | undefined): string[] {
  if (!image || !(image.bytes instanceof Uint8Array) || image.bytes.length === 0) return ['no image: attach a photo'];
  if (image.bytes.length > IMAGE_MAX_BYTES) return [`image is ${(image.bytes.length / 1048576).toFixed(1)} MB; the limit is 15 MB`];
  const sniffed = sniffImage(image.bytes);
  if (!sniffed) return ['image is not a PNG, JPEG, GIF or WEBP file'];
  return [];
}

function httpUrl(s: string | null | undefined): URL | null {
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------------------------------------------

/**
 * Words and phrases a draft may not use: claims that the coin is official, verified, endorsed, sponsored or connected
 * to someone, that someone else made it, or promises of returns. Matched on whole words in the name and description,
 * case-insensitively. Disclaimers pass: "unofficial", "not affiliated with". The list is deliberately broad: a quoted
 * post that trips it needs a description written by the owner instead.
 */
export const CLAIM_PATTERNS: { re: RegExp; claim: string }[] = [
  { re: /\bofficial(?:ly)?\b/i, claim: 'official' },
  { re: /\bverified\b/i, claim: 'verified' },
  { re: /\bendors(?:e|ed|es|ing|ement)\b/i, claim: 'endorsed' },
  { re: /\bpartner(?:ed|ing|ship|ships)\b|\bpartners? with\b/i, claim: 'partnered' },
  { re: /\bsponsor(?:ed|s|ship)?\b/i, claim: 'sponsored' },
  { re: /(?<!\bnot\s)(?<!\bno\s)\baffiliat(?:ed|ion)\b/i, claim: 'affiliated' },
  { re: /\bauthori[sz]ed\b/i, claim: 'authorized' },
  { re: /\bcertified\b/i, claim: 'certified' },
  { re: /\blicensed\b/i, claim: 'licensed' },
  { re: /\bauthentic\b/i, claim: 'authentic' },
  { re: /\b(?:approved|backed|supported) by\b/i, claim: 'approved/backed by' },
  { re: /\bthe real\b/i, claim: 'the real' },
  { re: /\b(?:launched|created|deployed|issued|minted|made) by\b/i, claim: 'made by someone' },
  { re: /\b(?:my|our|his|her|their) (?:own |first |new )?(?:meme ?)?(?:coin|token)\b/i, claim: "someone's own coin" },
  { re: /\bguarantee(?:d|s)?\b/i, claim: 'guaranteed' },
  { re: /\brisk[- ]?free\b/i, claim: 'risk-free' },
];

/** The same claims inside names and tickers written without spaces ("OFFICIALPEPE"); "UNOFFICIAL" passes. */
const COMPACT_CLAIMS = /(?<!UN)OFFICIAL|VERIFIED|ENDORSED|SPONSORED|CERTIFIED|AUTHENTIC|(?<!UN)AUTHORI[SZ]ED/;

/** Words that do not change whose coin a name presents it as: "Elon Musk Coin" is still Elon Musk's coin. */
const FILLER = new Set(['the', 'real', 'official', 'coin', 'token', 'memecoin', 'meme', 'on', 'sol', 'solana', 'its', 'iam', 'im']);

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const words = (s: string) => s.toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter(Boolean);

/** Ways the post's author is named: the handle (with "real"/"the"/"official" stripped) and the display name. */
function identities(post: Pick<PostInfo, 'handle' | 'authorName'>): Set<string> {
  const h = norm(post.handle);
  const variants = [h.replace(/^(?:real|the|official|its|iam)/, '').replace(/(?:official|hq|\d+)$/, '')];
  if (post.authorName) {
    const w = words(post.authorName);
    variants.push(w.join(''), w.filter((x) => x.length > 1).join(''), w.filter((x) => !FILLER.has(x)).join(''));
  }
  // Stripped variants shorter than 3 characters would match unrelated tickers.
  return new Set([h, ...variants.filter((v) => v.length >= 3)].filter(Boolean));
}

/** The name as an identity: all its words, and its words without filler. */
function nameCores(name: string): string[] {
  const w = words(name);
  return [w.join(''), w.filter((x) => !FILLER.has(x)).join('')].filter(Boolean);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every reason the draft may not launch; empty means it passes. Blocks, with no override:
 * - claims of officialness, endorsement, sponsorship or affiliation, of someone else making the coin, or of returns
 *   (CLAIM_PATTERNS) in the name, ticker or description;
 * - impersonating the post's author: a name or ticker that is the author's handle or display name, alone or with
 *   filler words ("Elon Musk Coin", "The Real Elon Musk"), or a description calling it the author's coin. A name that
 *   adds its own words ("Elon's Dog") is a meme reference and passes;
 * - a website that is a promo, referral or trading-tool site (websiteKind 'promo'), an X page that is not a post, or
 *   not a link; a promo site linked in the description;
 * - an X link that is not the post the draft was built from;
 * - a missing or unreadable image; any link that is not http(s); a name, ticker or description outside pump.fun's
 *   limits.
 */
export function checkCompliance(draft: CoinDraft, post: PostInfo): string[] {
  const problems: string[] = [];
  const add = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };
  for (const p of [...nameProblems(draft.name), ...symbolProblems(draft.symbol), ...descriptionProblems(draft.description)]) add(p);

  // Claims.
  for (const [field, value] of [['name', draft.name], ['description', draft.description]] as const) {
    for (const { re, claim } of CLAIM_PATTERNS) if (re.test(value)) add(`${field} claims "${claim}" ("${clip(value.match(re)![0], 30)}")`);
  }
  for (const [field, value] of [['name', draft.name], ['ticker', draft.symbol]] as const) {
    const m = value.toUpperCase().replace(/[^A-Z0-9]/g, '').match(COMPACT_CLAIMS);
    const said = m ? `${field} claims "${m[0].toLowerCase()}"` : null;
    if (said && !problems.some((p) => p.startsWith(said))) add(said);
  }

  // Impersonation of the post's author.
  const ids = identities(post);
  const who = `@${post.handle}${post.authorName ? ` (${post.authorName})` : ''}`;
  if (nameCores(draft.name).some((c) => ids.has(c))) add(`name "${draft.name}" presents the coin as ${who}'s own`);
  const ticker = norm(draft.symbol);
  if (ids.has(ticker) || ids.has(ticker.replace(/(?:coin|token)$/, ''))) add(`ticker "${draft.symbol}" is ${who}'s name`);
  const owners = [post.handle, ...(post.authorName ? [post.authorName] : [])].map(escapeRe).join('|');
  const possessive = new RegExp(`(?:@?(?:${owners}))['’]s\\s+(?:own\\s+|first\\s+|new\\s+|official\\s+)?(?:meme\\s?)?(?:coin|token)\\b`, 'i');
  for (const [field, value] of [['name', draft.name], ['description', draft.description]] as const) {
    if (possessive.test(value)) add(`${field} calls the coin ${who}'s coin`);
  }

  // Links.
  const site = httpUrl(draft.website);
  if (!site) add(`website "${clip(draft.website, 80)}" is not an http(s) link`);
  else {
    const kind = websiteKind(draft.website);
    if (kind === 'promo') add(`website ${site.hostname} is a promo, referral or trading-tool site, not the narrative's source`);
    else if (kind === 'no') add(`website "${clip(draft.website, 80)}" has no usable host`);
    if (/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(site.hostname) && tweetTs(draft.website) === null) {
      add('website is an X page that is not a post: link the post or the original source');
    }
  }
  if (!httpUrl(draft.postUrl)) add(`X link "${clip(draft.postUrl, 80)}" is not an http(s) link`);
  else {
    try {
      const linked = parsePost(draft.postUrl);
      if (linked.postId !== post.postId) add(`X link is post ${linked.postId}, not the post ${post.postId} the coin is built on`);
      else if (linked.handle.toLowerCase() !== post.handle.toLowerCase()) add(`X link names @${linked.handle}, but the post is by @${post.handle}`);
    } catch (e) {
      add(`X link: ${(e as Error).message}`);
    }
  }
  if (draft.telegram !== undefined) {
    const tg = httpUrl(draft.telegram);
    if (!tg) add(`telegram "${clip(draft.telegram, 80)}" is not an http(s) link`);
    else if (!/^(?:t|telegram)\.me$/i.test(tg.hostname)) add(`telegram link ${tg.hostname} is not a t.me link`);
  }
  for (const link of draft.description.match(/https?:\/\/\S+/gi) ?? []) {
    if (websiteKind(link) === 'promo') add(`description links a promo or trading-tool site (${clip(link, 60)})`);
  }

  // Image.
  for (const p of imageProblems(draft.image)) add(p);
  if (draft.image?.bytes?.length && sniffImage(draft.image.bytes) !== draft.image.mime) {
    add(`image is labelled ${draft.image.mime} but its bytes are ${sniffImage(draft.image.bytes) ?? 'not an image'}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Metadata upload
// ---------------------------------------------------------------------------------------------------------------

/** The upload endpoint: PUMP_IPFS_URL when set, else pump.fun's. */
export function ipfsUploadUrl(): string {
  return process.env.PUMP_IPFS_URL?.trim() || PUMP_IPFS_URL;
}

/** The multipart form pump.fun's site sends: file, name, symbol, description, twitter, telegram, website, showName. */
export function buildUploadForm(draft: CoinDraft): FormData {
  const form = new FormData();
  form.append('file', new Blob([draft.image.bytes], { type: draft.image.mime }), draft.image.filename);
  form.append('name', draft.name);
  form.append('symbol', draft.symbol);
  form.append('description', draft.description);
  form.append('twitter', draft.postUrl);
  form.append('telegram', draft.telegram ?? '');
  form.append('website', draft.website);
  form.append('showName', 'true');
  return form;
}

export interface UploadOptions {
  /** Defaults to ipfsUploadUrl(). Must be https. */
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Uploads the draft's image and metadata and returns the metadata URI. Fails closed with an UploadError when the
 * endpoint answers with a bot challenge, 403, 429, a redirect, an error, anything that is not JSON, or JSON without an
 * https/ipfs `metadataUri`, or metadata that does not match the draft. Never retries around a block. The draft must
 * already have passed checkCompliance; its basic limits are re-checked here.
 */
export async function uploadMetadata(draft: CoinDraft, opts: UploadOptions = {}): Promise<string> {
  const basics = [...nameProblems(draft.name), ...symbolProblems(draft.symbol), ...descriptionProblems(draft.description), ...imageProblems(draft.image)];
  if (!httpUrl(draft.postUrl)) basics.push('X link is not an http(s) link');
  if (!httpUrl(draft.website)) basics.push('website is not an http(s) link');
  if (basics.length) throw new UploadError(`draft not uploadable: ${basics.join('; ')}`);

  const endpoint = opts.url ?? ipfsUploadUrl();
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    throw new UploadError(`metadata upload URL "${clip(endpoint, 80)}" is not a URL`);
  }
  if (target.protocol !== 'https:') throw new UploadError(`metadata upload URL must be https, got ${target.protocol}`);
  const where = `${target.host}${target.pathname}`;

  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target, {
      method: 'POST',
      body: buildUploadForm(draft),
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new UploadError(`metadata upload to ${where} failed: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (res.headers.get('cf-mitigated') || ((res.status === 403 || res.status === 503) && /html/i.test(type))) {
    throw new UploadError(
      `${where} answered with a bot challenge (HTTP ${res.status}); not retrying or working around it. ` +
        'The metadata cannot be uploaded from here: the launch is blocked.',
      res.status,
    );
  }
  if (res.status >= 300 && res.status < 400) throw new UploadError(`${where} redirected (HTTP ${res.status}); refusing to follow`, res.status);
  if (!res.ok) throw new UploadError(`${where} refused the upload (HTTP ${res.status})`, res.status);
  if (!/json/i.test(type)) throw new UploadError(`${where} answered with ${type || 'no content type'}, not JSON`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UploadError(`${where} answered with malformed JSON`, res.status);
  }
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const uri = typeof o.metadataUri === 'string' ? o.metadataUri.trim() : '';
  if (!/^(?:https:\/\/[^\s/]+\.[^\s/]+\/\S+|ipfs:\/\/\S+)$/i.test(uri)) {
    throw new UploadError(`${where} answered without a usable metadataUri`, res.status);
  }
  const meta = o.metadata && typeof o.metadata === 'object' ? (o.metadata as Record<string, unknown>) : null;
  if (meta && ((typeof meta.name === 'string' && meta.name !== draft.name) || (typeof meta.symbol === 'string' && meta.symbol !== draft.symbol))) {
    throw new UploadError(`${where} stored different metadata than the draft (name or ticker changed)`, res.status);
  }
  return uri;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
