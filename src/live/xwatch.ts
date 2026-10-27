import { tweetTs } from '../intel/xlinks.ts';

/**
 * Watches the X accounts on the watchlist (data/watchlist.json, from `python3 ml/watchlist.py`) through the X API's
 * filtered stream, and hands each new original post (no replies, no reposts) to the launcher as a candidate the
 * moment X delivers it. The playbook launches only within 2 minutes of a post and only if first on it, so this is the
 * path from a post to a launch card; without an X API token the owner sends post links by hand instead.
 *
 * API: https://docs.x.com/x-api/posts/filtered-stream/introduction (rules: from:<handle>, joined with OR, tagged so
 * only this watcher's rules are replaced). Billing is per post delivered on pay-per-use.
 */

export interface XPostCandidate {
  url: string;
  handle: string;
  postId: string;
  /** Unix seconds, from the post ID. */
  postedAt: number;
  text: string;
  /** Local time (ms) the stream delivered it. */
  receivedAt: number;
}

const API = 'https://api.x.com/2/tweets/search/stream';
const TAG = 'memecoin-bot watchlist';
/** X's limit on one rule's length on the lower access levels. */
const MAX_RULE = 512;

/** `from:` rules covering every handle, each within the length limit. */
export function watchRules(handles: string[]): string[] {
  const rule = (terms: string) => `(${terms}) -is:retweet -is:reply`;
  const rules: string[] = [];
  let cur = '';
  for (const h of handles.map((x) => x.replace(/^@/, '').toLowerCase()).filter((x) => /^[a-z0-9_]{1,15}$/.test(x))) {
    const term = `from:${h}`;
    const next = cur ? `${cur} OR ${term}` : term;
    if (rule(next).length > MAX_RULE && cur) {
      rules.push(rule(cur));
      cur = term;
    } else cur = next;
  }
  if (cur) rules.push(rule(cur));
  return rules;
}

interface StreamPayload {
  data?: { id: string; text: string; author_id?: string };
  includes?: { users?: { id: string; username: string }[] };
}

/** One line of the stream as a candidate; null for heartbeats, errors and posts without an author. */
export function parseStreamLine(line: string, now = Date.now()): XPostCandidate | null {
  const t = line.trim();
  if (!t) return null;
  let p: StreamPayload;
  try {
    p = JSON.parse(t) as StreamPayload;
  } catch {
    return null;
  }
  const d = p.data;
  if (!d?.id) return null;
  const user = p.includes?.users?.find((u) => u.id === d.author_id);
  if (!user) return null;
  const url = `https://x.com/${user.username}/status/${d.id}`;
  return { url, handle: user.username.toLowerCase(), postId: d.id, postedAt: tweetTs(url) ?? Math.floor(now / 1000), text: d.text, receivedAt: now };
}

export class XWatcher {
  private stopped = false;
  private controller: AbortController | null = null;
  private readonly bearer: string;
  private readonly handles: string[];
  private readonly onPost: (p: XPostCandidate) => void;
  private readonly onStatus: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    bearer: string;
    handles: string[];
    onPost: (p: XPostCandidate) => void;
    onStatus?: (msg: string) => void;
    fetchImpl?: typeof fetch;
  }) {
    this.bearer = opts.bearer;
    this.handles = opts.handles;
    this.onPost = opts.onPost;
    this.onStatus = opts.onStatus ?? (() => {});
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(json = false): Record<string, string> {
    return { authorization: `Bearer ${this.bearer}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  /** Replaces this watcher's stream rules with rules for the current watchlist. */
  async syncRules(): Promise<number> {
    const res = await this.fetchImpl(`${API}/rules`, { headers: this.headers() });
    if (!res.ok) throw new Error(`X rules lookup failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const existing = ((await res.json()) as { data?: { id: string; tag?: string }[] }).data ?? [];
    const ours = existing.filter((r) => r.tag === TAG).map((r) => r.id);
    if (ours.length) {
      const del = await this.fetchImpl(`${API}/rules`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ delete: { ids: ours } }),
      });
      if (!del.ok) throw new Error(`X rules delete failed: HTTP ${del.status}`);
    }
    const rules = watchRules(this.handles);
    const add = await this.fetchImpl(`${API}/rules`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ add: rules.map((value) => ({ value, tag: TAG })) }),
    });
    if (!add.ok) throw new Error(`X rules add failed: HTTP ${add.status} ${(await add.text()).slice(0, 200)}`);
    return rules.length;
  }

  /** Syncs the rules, then streams until stopped, reconnecting with backoff (X asks clients to back off on 429). */
  async start(): Promise<void> {
    const n = await this.syncRules();
    this.onStatus(`X watcher: ${this.handles.length} accounts in ${n} rules`);
    let backoff = 1000;
    while (!this.stopped) {
      try {
        this.controller = new AbortController();
        const res = await this.fetchImpl(`${API}?tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`, {
          headers: this.headers(),
          signal: this.controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`X stream HTTP ${res.status}`);
        backoff = 1000;
        this.onStatus('X watcher: connected');
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const post = parseStreamLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
            if (post) this.onPost(post);
          }
        }
        if (!this.stopped) throw new Error('X stream ended');
      } catch (e) {
        if (this.stopped) break;
        this.onStatus(`X watcher: ${(e as Error).message}; reconnecting in ${Math.round(backoff / 1000)} s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }
}
