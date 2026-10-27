import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XWatcher, parseStreamLine, watchRules, type XPostCandidate } from '../src/live/xwatch.ts';

test('watch rules cover every handle within the length limit and skip invalid ones', () => {
  const handles = Array.from({ length: 80 }, (_, i) => `account_${i}`).concat(['@Elon', 'bad handle!']);
  const rules = watchRules(handles);
  assert.ok(rules.every((r) => r.length <= 512));
  const joined = rules.join(' ');
  assert.ok(joined.includes('from:account_79') && joined.includes('from:elon'));
  assert.ok(!joined.includes('bad'));
  assert.ok(rules.every((r) => r.endsWith('-is:retweet -is:reply')));
});

test('stream lines become candidates with the post time from the ID', () => {
  const line = JSON.stringify({
    data: { id: '1983000000000000000', text: 'hello', author_id: '42' },
    includes: { users: [{ id: '42', username: 'SomeOne' }] },
  });
  const c = parseStreamLine(line, 1)!;
  assert.equal(c.url, 'https://x.com/SomeOne/status/1983000000000000000');
  assert.equal(c.handle, 'someone');
  assert.equal(c.postedAt, Math.floor((472784042358 + 1288834974657) / 1000));
  assert.equal(parseStreamLine('\r'), null);
  assert.equal(parseStreamLine('{"errors":[{"title":"x"}]}'), null);
});

test('the watcher replaces only its own rules and delivers posts from the stream', async () => {
  const calls: { url: string; body?: string }[] = [];
  const line = JSON.stringify({ data: { id: '1983000000000000001', text: 'news', author_id: '7' }, includes: { users: [{ id: '7', username: 'news' }] } });
  let watcher: XWatcher;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url.endsWith('/rules') && !init?.method) {
      return new Response(JSON.stringify({ data: [{ id: '1', tag: 'memecoin-bot watchlist' }, { id: '2', tag: 'someone else' }] }));
    }
    if (url.endsWith('/rules')) return new Response('{}');
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('\r\n' + line + '\n'));
        c.close();
      },
    });
    return new Response(body);
  }) as typeof fetch;
  const got: XPostCandidate[] = [];
  watcher = new XWatcher({ bearer: 't', handles: ['news'], fetchImpl, onPost: (p) => { got.push(p); watcher.stop(); } });
  await watcher.start();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.url, 'https://x.com/news/status/1983000000000000001');
  const del = calls.find((c) => c.body?.includes('delete'))!;
  assert.deepEqual(JSON.parse(del.body!).delete.ids, ['1']);
  assert.ok(calls.some((c) => c.body?.includes('from:news')));
});
