/**
 * What a coin's X link says without calling X: the account it points to, and for a link to a post, when the post was
 * made (X post IDs are snowflakes that carry their creation time). Lets the observer measure which accounts' posts
 * become coins that draw buyers, and how fast after the post the winning launches came.
 */

const TWITTER_EPOCH_MS = 1288834974657n;

const PATH = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)(?:\/status(?:es)?\/(\d+))?/i;

/** Lower-case handle of the account a link points to; null for communities, search, intents and non-X links. */
export function xHandle(link: string | null): string | null {
  const m = link?.trim().match(PATH);
  if (!m) return null;
  const handle = m[1]!.toLowerCase();
  return ['i', 'search', 'intent', 'home', 'hashtag', 'share'].includes(handle) ? null : handle;
}

/** Creation time (unix seconds) of the post a link points to, from its snowflake ID; null when it is not a post. */
export function tweetTs(link: string | null): number | null {
  const m = link?.trim().match(/\/status(?:es)?\/(\d{15,20})/);
  if (!m) return null;
  return Number(((BigInt(m[1]!) >> 22n) + TWITTER_EPOCH_MS) / 1000n);
}
