/**
 * A first draft of a coin from a post, so a launch card can reach the owner within seconds of the post: being first
 * on a post doubled what a launch made, and the next dev arrives a median 24 s after the first. The owner still sees
 * and approves every card; this only saves typing. Name-and-ticker wording made no measurable difference in the data
 * (docs/MODELS.md, round 5), so the draft stays plain: the post's own most distinctive words.
 */

const STOP = new Set(
  ('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'just me more my no not now of on or our out over she so some than that the their them then there these they this ' +
    'to too up us very was we were what when where which who why will with would you your yes new today breaking just ' +
    'amp via rt').split(' '),
);

export interface AutoDraft {
  name: string;
  symbol: string;
  /** Why these words were picked, for the card. */
  basis: string;
}

const clean = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#]\w+/g, (m) => (m.startsWith('#') ? m.slice(1) : ' '))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Picks a ticker and name: a $cashtag in the post if there is one, else the post's most distinctive word (capitalised
 * words and longer words first, stop words dropped), and a name of up to four words around it. Null when the post has
 * no usable words (an image-only post); the owner then types them.
 */
export function autoDraft(text: string | null): AutoDraft | null {
  if (!text) return null;
  const cash = text.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/);
  const words = clean(text)
    .split(' ')
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
  if (cash) {
    const symbol = cash[1]!.toUpperCase();
    return { symbol, name: titleCase(words.slice(0, 3).join(' ')) || symbol, basis: `the post's $${symbol}` };
  }
  if (!words.length) return null;
  const score = (w: string, i: number) => (/^\p{Lu}/u.test(w) ? 3 : 0) + Math.min(w.length, 10) / 2 - i * 0.05;
  const best = words.map((w, i) => ({ w, s: score(w, i), i })).sort((a, b) => b.s - a.s)[0]!;
  const symbol = best.w.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  if (!symbol) return null;
  const start = Math.max(0, best.i - 1);
  const name = titleCase(words.slice(start, start + 3).join(' ')).slice(0, 32).trim();
  return { symbol, name: name || symbol, basis: `the post's word "${best.w}"` };
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}
