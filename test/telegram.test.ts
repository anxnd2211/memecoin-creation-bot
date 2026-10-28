import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramNotifier, parseCommand, redactToken, type CommandMessage, type TelegramOptions } from '../src/live/telegram.ts';

const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefghijklmno';
const OWNER = 4242;
const STRANGER = 777;
const START = 1_800_000_000;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
  form: FormData | null;
}

/** A Bot API stand-in: records calls, serves queued updates to getUpdates, and hands out message IDs. */
class FakeBot {
  readonly calls: Call[] = [];
  readonly updates: Record<string, unknown>[] = [];
  readonly logs: string[] = [];
  nextUpdateId = 1;
  nextMessageId = 500;
  fileBytes: Uint8Array = JPEG;
  /** Throws a network error for the next N getUpdates calls. */
  failPolls = 0;
  /** Makes sendMessage/sendPhoto fail with this error code. */
  sendError: number | null = null;
  /** Makes only sendPhoto fail with this error code. */
  photoError: number | null = null;

  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
  }

  message(text: string, o: { chat?: number; from?: number; date?: number; photo?: boolean; caption?: boolean } = {}): void {
    const chat = o.chat ?? OWNER;
    this.push({
      message: {
        message_id: this.nextMessageId++,
        date: o.date ?? START + 5,
        chat: { id: chat, type: chat > 0 ? 'private' : 'group' },
        from: { id: o.from ?? chat, is_bot: false },
        ...(o.caption ? { caption: text } : { text }),
        ...(o.photo
          ? {
              photo: [
                { file_id: 'small', file_size: 900, width: 90, height: 90 },
                { file_id: 'large', file_size: 52_000, width: 1280, height: 1280 },
                { file_id: 'medium', file_size: 9_000, width: 320, height: 320 },
              ],
            }
          : {}),
      },
    });
  }

  press(data: string, o: { chat?: number; from?: number; messageId?: number; photo?: boolean } = {}): void {
    const chat = o.chat ?? OWNER;
    this.push({
      callback_query: {
        id: `cb${this.nextUpdateId}`,
        from: { id: o.from ?? chat, is_bot: false },
        data,
        message: {
          message_id: o.messageId ?? 1,
          date: START + 6,
          chat: { id: chat },
          ...(o.photo ? { photo: [{ file_id: 'p' }], caption: 'card' } : { text: 'card' }),
        },
      },
    });
  }

  called(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/file/bot')) {
      this.calls.push({ method: 'download', url, body: {}, form: null });
      return new Response(this.fileBytes, { status: 200 });
    }
    const method = url.split('/').pop()!;
    const form = init?.body instanceof FormData ? init.body : null;
    const body = form ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>'])) : JSON.parse(String(init?.body ?? '{}'));
    this.calls.push({ method, url, body, form });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    switch (method) {
      case 'getUpdates': {
        if (this.failPolls > 0) {
          this.failPolls--;
          throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`);
        }
        const offset = Number(body.offset ?? 0);
        const out = this.updates.filter((u) => (u.update_id as number) >= offset);
        if (!out.length) await new Promise((r) => setTimeout(r, 2));
        return ok(out);
      }
      case 'sendMessage':
      case 'sendPhoto':
        if (method === 'sendPhoto' && this.photoError !== null) {
          return new Response(JSON.stringify({ ok: false, error_code: this.photoError, description: 'Bad Request: IMAGE_PROCESS_FAILED' }), { status: this.photoError });
        }
        if (this.sendError !== null) {
          return new Response(JSON.stringify({ ok: false, error_code: this.sendError, description: 'Bad Request: chat not found' }), { status: this.sendError });
        }
        return ok({ message_id: this.nextMessageId++, date: START + 6, chat: { id: OWNER } });
      case 'getFile':
        return ok({ file_id: body.file_id, file_size: this.fileBytes.length, file_path: 'photos/file_7.jpg' });
      default:
        return ok(true);
    }
  }) as typeof fetch;

  notifier(o: Partial<TelegramOptions> = {}): TelegramNotifier {
    const logger = {
      debug: (m: string) => this.logs.push(m),
      info: (m: string) => this.logs.push(m),
      warn: (m: string) => this.logs.push(m),
      error: (m: string) => this.logs.push(m),
    };
    return new TelegramNotifier({ token: TOKEN, chatId: OWNER, fetch: this.fetch, startedAt: START, sleep: async () => {}, logger, ...o });
  }
}

async function until(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Runs the command loop, collecting what it delivers. */
function collect(tg: TelegramNotifier): { got: CommandMessage[]; stop: () => Promise<void> } {
  const got: CommandMessage[] = [];
  const ctl = new AbortController();
  const done = tg.runCommands((m) => void got.push(m), ctl.signal);
  return {
    got,
    stop: async () => {
      ctl.abort();
      await done;
      tg.close();
    },
  };
}

test('commands parse into typed objects', () => {
  assert.deepEqual(parseCommand('/launch https://x.com/Interior/status/507185938620219395?s=20 | $WBEAR | Wilderness Bear | https://www.nps.gov/yose'), {
    ok: true,
    command: {
      kind: 'launch',
      postUrl: 'https://x.com/Interior/status/507185938620219395',
      ticker: 'WBEAR',
      name: 'Wilderness Bear',
      sourceUrl: 'https://www.nps.gov/yose',
      description: null,
    },
  });
  const short = parseCommand('/launch@MyLaunchBot https://x.com/a_b/status/507185938620219395 | bear | Bear');
  assert.ok(short?.ok && short.command.kind === 'launch');
  assert.equal(short.command.sourceUrl, null);
  assert.equal(short.command.ticker, 'bear');
  const desc = parseCommand('/launch https://x.com/a/status/507185938620219395 | B | Bear |  | a bear | with a pipe');
  assert.ok(desc?.ok && desc.command.kind === 'launch');
  assert.deepEqual([desc.command.sourceUrl, desc.command.description], [null, 'a bear | with a pipe']);

  for (const k of ['status', 'kill', 'resume', 'claim'] as const) assert.deepEqual(parseCommand(`/${k}`), { ok: true, command: { kind: k } });
  assert.deepEqual(parseCommand('/KILL now please'), { ok: true, command: { kind: 'kill' } });
  assert.deepEqual(parseCommand('/start'), { ok: true, command: { kind: 'help' } });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand(''), null);
  assert.match((parseCommand('/launch https://x.com/a/status/507185938620219395 | B') as { error: string }).error, /at least/);
  assert.match((parseCommand('/launch https://x.com/Interior | B | Bear') as { error: string }).error, /not to a post/);
  assert.match((parseCommand('/launch https://x.com/a/status/507185938620219395 |  | Bear') as { error: string }).error, /ticker/);
  assert.match((parseCommand('/sell') as { error: string }).error, /unknown command \/sell/);
});

test('the constructor refuses missing or malformed settings without echoing the token', () => {
  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_OWNER_ID'] as const;
  const saved = keys.map((k) => process.env[k]);
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_OWNER_ID;
    assert.throws(() => new TelegramNotifier({ chatId: OWNER }), /TELEGRAM_BOT_TOKEN is missing/);
    assert.throws(() => new TelegramNotifier({ token: 'oops-not-a-token', chatId: OWNER }), (e: Error) => !e.message.includes('oops') && /malformed/.test(e.message));
    assert.throws(() => new TelegramNotifier({ token: TOKEN }), /TELEGRAM_CHAT_ID/);
    assert.throws(() => new TelegramNotifier({ token: TOKEN, chatId: -100123 }), /TELEGRAM_OWNER_ID/);
    assert.doesNotThrow(() => new TelegramNotifier({ token: TOKEN, chatId: -100123, ownerId: OWNER }).close());
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_CHAT_ID = String(OWNER);
    assert.doesNotThrow(() => new TelegramNotifier().close());
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test('only the owner in the owner chat is heard; old messages are not replayed', async () => {
  const bot = new FakeBot();
  bot.message('/kill', { date: START - 60 }); // sent before this process started
  bot.message('/kill', { chat: STRANGER }); // another chat
  bot.message('/kill', { chat: -100555, from: OWNER }); // the owner, but in a group
  bot.message('/resume', { from: STRANGER }); // someone else in the owner chat (impossible in a private chat, still refused)
  bot.message('just chatting');
  bot.message('/status');
  const tg = bot.notifier();
  const { got, stop } = collect(tg);
  await until(() => got.length === 1 && bot.updates.length === 6 && bot.called('getUpdates').length >= 2, 'the status command');
  await stop();
  assert.deepEqual(got.map((m) => m.command), [{ kind: 'status' }]);
  assert.equal(got[0]!.sentAt, START + 5);
  assert.equal(got[0]!.image, null);
  // Nothing was sent to anyone: strangers get no reply.
  assert.equal(bot.called('sendMessage').length, 0);
  // Offsets advance past every update, so none is read twice.
  const offsets = bot.called('getUpdates').map((c) => c.body.offset);
  assert.equal(offsets[0], 0);
  assert.ok(offsets.slice(1).every((o) => o === 7), JSON.stringify(offsets));
});

test('malformed and unknown commands get the usage text; /help is answered here', async () => {
  const bot = new FakeBot();
  bot.message('/launch https://x.com/Interior | B | Bear');
  bot.message('/help');
  const tg = bot.notifier();
  const { got, stop } = collect(tg);
  await until(() => bot.called('sendMessage').length === 2, 'two replies');
  await stop();
  assert.equal(got.length, 0);
  const texts = bot.called('sendMessage').map((c) => String(c.body.text));
  assert.match(texts[0]!, /not to a post[\s\S]*Commands:/);
  assert.match(texts[1]!, /^Commands:/);
  assert.equal(bot.called('sendMessage')[0]!.body.chat_id, String(OWNER));
});

test('/launch with a photo downloads the largest size via getFile', async () => {
  const bot = new FakeBot();
  bot.message('/launch https://x.com/Interior/status/507185938620219395 | WBEAR | Wilderness Bear | https://www.nps.gov/yose', { photo: true, caption: true });
  const tg = bot.notifier();
  const { got, stop } = collect(tg);
  await until(() => got.length === 1, 'the launch command');
  await stop();
  const m = got[0]!;
  assert.equal(m.command.kind, 'launch');
  assert.deepEqual(bot.called('getFile').map((c) => c.body.file_id), ['large']);
  const download = bot.called('download')[0]!;
  assert.equal(download.url, `https://api.telegram.org/file/bot${TOKEN}/photos/file_7.jpg`);
  assert.deepEqual(m.image, { bytes: JPEG, mime: 'image/jpeg', filename: 'file_7.jpg' });
});

test('/launch without a photo arrives with no image; an unreadable photo is refused and reported', async () => {
  const bot = new FakeBot();
  bot.message('/launch https://x.com/Interior/status/507185938620219395 | WBEAR | Bear');
  const tg = bot.notifier();
  const { got, stop } = collect(tg);
  await until(() => got.length === 1, 'the launch command');
  assert.equal(got[0]!.image, null);
  bot.fileBytes = new TextEncoder().encode('<html>not an image</html>');
  bot.message('/launch https://x.com/Interior/status/507185938620219395 | WBEAR | Bear', { photo: true, caption: true });
  await until(() => bot.called('sendMessage').length === 1, 'the download error');
  await stop();
  assert.equal(got.length, 1);
  assert.match(String(bot.called('sendMessage')[0]!.body.text), /Could not download the photo \(the file is not a PNG, JPEG, GIF or WEBP image\)/);
});

test('approval: the owner presses Approve on the card', async () => {
  const bot = new FakeBot();
  const tg = bot.notifier();
  const pending = tg.askApproval({ text: 'Launch WBEAR?', image: JPEG, timeoutSec: 5 });
  await until(() => bot.called('sendPhoto').length === 1, 'the card');
  const card = bot.called('sendPhoto')[0]!;
  assert.equal(card.body.chat_id, String(OWNER));
  assert.match(String(card.body.caption), /^Launch WBEAR\?\n\nApprove within 5 s/);
  const photo = card.form!.get('photo') as File;
  assert.equal(photo.type, 'image/jpeg');
  const keyboard = JSON.parse(String(card.body.reply_markup)) as { inline_keyboard: { text: string; callback_data: string }[][] };
  const [approve, reject] = keyboard.inline_keyboard[0]!;
  assert.deepEqual([approve!.text, reject!.text], ['Approve', 'Reject']);

  bot.press(approve!.callback_data.replace(/:.*/, ':0000000000000000'), { messageId: 500, photo: true }); // a stale card
  bot.press(approve!.callback_data, { chat: STRANGER, messageId: 500, photo: true }); // not the owner
  bot.press(approve!.callback_data, { messageId: 500, photo: true });
  const result = await pending;
  assert.equal(result.approved, true);
  assert.equal(result.by, 'owner');
  await until(() => bot.called('editMessageCaption').length === 1, 'the card edit');
  const answers = bot.called('answerCallbackQuery').map((c) => c.body.text);
  assert.deepEqual(answers, ['This card is no longer active', 'Approved']);
  const edit = bot.called('editMessageCaption')[0]!;
  assert.equal(edit.body.message_id, 500);
  assert.match(String(edit.body.caption), /APPROVED by the owner at \d\d:\d\d:\d\d UTC$/);
  assert.equal(edit.body.reply_markup, undefined);
  tg.close();
});

test('approval: a photo Telegram refuses still leaves a text card the owner can answer', async () => {
  const bot = new FakeBot();
  bot.photoError = 400;
  const tg = bot.notifier();
  const pending = tg.askApproval({ text: 'Launch WBEAR?', image: JPEG, timeoutSec: 5 });
  await until(() => bot.called('sendMessage').length === 1, 'the text card');
  const card = bot.called('sendMessage')[0]!;
  assert.match(String(card.body.text), /^Launch WBEAR\?[\s\S]*image could not be shown here: telegram sendPhoto: Bad Request: IMAGE_PROCESS_FAILED/);
  const markup = card.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  bot.press(markup.inline_keyboard[0]![0]!.callback_data, { messageId: 500 });
  assert.deepEqual((({ approved, by }) => ({ approved, by }))(await pending), { approved: true, by: 'owner' });
  tg.close();
});

test('approval: Reject is a rejection by the owner, and a second press does nothing', async () => {
  const bot = new FakeBot();
  const tg = bot.notifier();
  const pending = tg.askApproval({ text: 'Launch?', timeoutSec: 5 });
  await until(() => bot.called('sendMessage').length === 1, 'the card');
  const markup = bot.called('sendMessage')[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  const [approve, reject] = markup.inline_keyboard[0]!;
  bot.press(reject!.callback_data, { messageId: 500 });
  bot.press(approve!.callback_data, { messageId: 500 });
  assert.deepEqual(await pending, { approved: false, by: 'owner', at: (await pending).at });
  await until(() => bot.called('answerCallbackQuery').length === 2, 'both answers');
  assert.deepEqual(bot.called('answerCallbackQuery').map((c) => c.body.text), ['Rejected', 'This card is no longer active']);
  await until(() => bot.called('editMessageText').length === 1, 'the card edit');
  assert.match(String(bot.called('editMessageText')[0]!.body.text), /REJECTED by the owner/);
  tg.close();
});

test('approval: no answer within the timeout is a rejection, and the card says so', async () => {
  const bot = new FakeBot();
  const tg = bot.notifier();
  const t0 = Date.now();
  const pending = tg.askApproval({ text: 'Launch?', timeoutSec: 0.15 });
  await until(() => bot.called('sendMessage').length === 1, 'the card');
  const markup = bot.called('sendMessage')[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  bot.press(markup.inline_keyboard[0]![0]!.callback_data, { chat: STRANGER, messageId: 500 }); // a stranger's press does not count
  const result = await pending;
  assert.deepEqual([result.approved, result.by], [false, 'timeout']);
  assert.ok(Date.now() - t0 >= 140);
  await until(() => bot.called('editMessageText').length === 1, 'the card edit');
  assert.equal(bot.called('editMessageText')[0]!.body.message_id, 500);
  assert.match(String(bot.called('editMessageText')[0]!.body.text), /NO ANSWER: rejected/);
  tg.close();
});

test('approval: a card that cannot be sent, a bad timeout, or a closed notifier is a rejection', async () => {
  const bot = new FakeBot();
  bot.sendError = 400;
  const tg = bot.notifier();
  assert.deepEqual(
    (({ approved, by }) => ({ approved, by }))(await tg.askApproval({ text: 'Launch?', timeoutSec: 5 })),
    { approved: false, by: 'timeout' },
  );
  assert.ok(bot.logs.some((l) => /approval card not sent/.test(l)));
  assert.equal((await tg.askApproval({ text: 'x', timeoutSec: Number.NaN })).approved, false);
  assert.equal((await tg.askApproval({ text: 'x', timeoutSec: 0 })).approved, false);
  tg.close();
  assert.equal((await tg.askApproval({ text: 'x', timeoutSec: 5 })).approved, false);
});

test('close() rejects a pending approval at once', async () => {
  const bot = new FakeBot();
  const tg = bot.notifier();
  const pending = tg.askApproval({ text: 'Launch?', timeoutSec: 60 });
  await until(() => bot.called('sendMessage').length === 1, 'the card');
  tg.close();
  assert.deepEqual((({ approved, by }) => ({ approved, by }))(await pending), { approved: false, by: 'timeout' });
});

test('approvals and commands share one poll loop', async () => {
  const bot = new FakeBot();
  const tg = bot.notifier();
  const got: CommandMessage[] = [];
  const ctl = new AbortController();
  // A handler that waits on an approval, as a /launch does: the loop must keep reading while it waits.
  const done = tg.runCommands(async (m) => {
    got.push(m);
    if (m.command.kind === 'launch') {
      const a = await tg.askApproval({ text: 'Launch?', timeoutSec: 5 });
      await tg.send(a.approved ? 'launching' : 'not launching');
    }
  }, ctl.signal);
  bot.message('/launch https://x.com/Interior/status/507185938620219395 | WBEAR | Bear');
  await until(() => bot.called('sendMessage').length === 1, 'the card');
  bot.message('/kill'); // arrives while the launch waits for approval
  await until(() => got.length === 2, 'the kill command');
  const markup = bot.called('sendMessage')[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  bot.press(markup.inline_keyboard[0]![0]!.callback_data, { messageId: 500 });
  await until(() => bot.called('sendMessage').some((c) => c.body.text === 'launching'), 'the launch to go ahead');
  ctl.abort();
  await done;
  tg.close();
  assert.deepEqual(got.map((m) => m.command.kind), ['launch', 'kill']);
});

test('network errors back off and recover; the token never reaches a log line', async () => {
  const bot = new FakeBot();
  bot.failPolls = 4;
  const waits: number[] = [];
  const tg = bot.notifier({ sleep: async (ms) => void waits.push(ms) });
  bot.message('/status');
  const { got, stop } = collect(tg);
  await until(() => got.length === 1, 'the status command after the outage');
  await stop();
  assert.deepEqual(waits.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.ok(bot.logs.some((l) => /getUpdates failed/.test(l)));
  assert.ok(bot.logs.every((l) => !l.includes(TOKEN) && !l.includes(TOKEN.split(':')[1]!)), bot.logs.join('\n'));
  assert.ok(bot.logs.some((l) => l.includes('bot<token>/getUpdates')), 'the URL in the error is kept, with the token removed');
});

test('send delivers plain text to the owner chat, in order, and never rejects', async () => {
  const bot = new FakeBot();
  const tg = bot.notifier();
  await Promise.all([tg.send('one'), tg.send('two'), tg.send('x'.repeat(5000))]);
  const sent = bot.called('sendMessage');
  assert.deepEqual(sent.slice(0, 2).map((c) => c.body.text), ['one', 'two']);
  assert.equal(String(sent[2]!.body.text).length, 4096);
  assert.equal(sent[0]!.body.parse_mode, undefined);
  assert.ok(sent.every((c) => c.url === `https://api.telegram.org/bot${TOKEN}/sendMessage`));
  bot.sendError = 500;
  await tg.send('lost'); // resolves after three tries
  assert.equal(bot.called('sendMessage').length, 6);
  assert.ok(bot.logs.some((l) => /message not delivered/.test(l) && !l.includes(TOKEN)));
  tg.close();
});

test('redactToken removes the token and anything shaped like one', () => {
  assert.equal(redactToken(`GET https://api.telegram.org/bot${TOKEN}/getMe failed`, TOKEN), 'GET https://api.telegram.org/bot<token>/getMe failed');
  assert.equal(redactToken('bot987654321:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/x'), 'bot<token>/x');
  assert.equal(redactToken('nothing secret here'), 'nothing secret here');
});
