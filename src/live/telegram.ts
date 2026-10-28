import { randomBytes } from 'node:crypto';
import { log } from '../log.ts';
import { DesignError, parsePost, sniffImage } from './designer.ts';
import type { Approval, CoinDraft, Notifier } from './types.ts';

/**
 * The owner's Telegram link, over the Bot API with fetch: alerts, launch approvals and the command loop. Only the
 * configured owner in the configured chat counts; everything else is ignored without a reply. One long-poll loop reads
 * updates for both approvals and commands (the Bot API allows one reader per token). The bot token is never logged:
 * it sits in the URL path, so every error and log line passes through `redactToken`.
 *
 * Configuration (read from the environment unless passed in):
 *   TELEGRAM_BOT_TOKEN  the bot's token from @BotFather
 *   TELEGRAM_CHAT_ID    the chat the bot talks in; the owner's private chat with the bot
 *   TELEGRAM_OWNER_ID   the owner's user ID; required only when TELEGRAM_CHAT_ID is a group (a negative ID)
 */

export const TELEGRAM_API = 'https://api.telegram.org';
/** The Bot API serves files up to 20 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MESSAGE_MAX = 4096;
const CAPTION_MAX = 1024;

export const USAGE = [
  'Commands:',
  '/launch <post url> | <TICKER> | <Name> | <source url> | <description>',
  '  attach the coin image as a photo with the command as its caption (or reply to a photo);',
  '  source url and description are optional',
  '/status  what the bot is doing',
  '/kill    stop launching and sell any open bag now',
  '/resume  allow launches again',
  '/claim   claim creator fees',
].join('\n');

/** A command from the owner, parsed. */
export type Command =
  | {
      kind: 'launch';
      /** The post's canonical link (x.com/<account>/status/<id>). */
      postUrl: string;
      /** As typed, a leading $ dropped. */
      ticker: string;
      name: string;
      sourceUrl: string | null;
      description: string | null;
    }
  | { kind: 'status' }
  | { kind: 'kill' }
  | { kind: 'resume' }
  | { kind: 'claim' }
  | { kind: 'help' };

/** A command as the command loop hands it over. */
export interface CommandMessage {
  command: Command;
  /** The photo attached to /launch (or the photo it replies to); null when there is none. */
  image: CoinDraft['image'] | null;
  messageId: number;
  /** Unix seconds, Telegram's time for the message. */
  sentAt: number;
}

export type CommandHandler = (msg: CommandMessage) => void | Promise<void>;

/**
 * Parses a message: null when it is not a command (no leading /), `{ ok: false }` with a reason for a malformed or
 * unknown command. `/launch` takes `|`-separated fields: post url, ticker, name, then optional source url and
 * description (a description may itself contain `|`).
 */
export function parseCommand(text: string): { ok: true; command: Command } | { ok: false; error: string } | null {
  const m = text.trim().match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return text.trim().startsWith('/') ? { ok: false, error: 'not a command' } : null;
  const name = m[1]!.toLowerCase();
  const args = (m[2] ?? '').trim();
  switch (name) {
    case 'status':
    case 'kill':
    case 'resume':
    case 'claim':
      return { ok: true, command: { kind: name } };
    case 'help':
    case 'start':
      return { ok: true, command: { kind: 'help' } };
    case 'launch': {
      // Four fields split on the first four pipes; the description is the rest, kept as typed.
      const parts: string[] = [];
      let rest = args;
      while (parts.length < 4 && rest.includes('|')) {
        parts.push(rest.slice(0, rest.indexOf('|')).trim());
        rest = rest.slice(rest.indexOf('|') + 1);
      }
      parts.push(rest.trim());
      if (parts.length < 3) return { ok: false, error: '/launch needs at least: <post url> | <TICKER> | <Name>' };
      const [post, rawTicker, coinName, source = '', description = ''] = parts as [string, string, string, ...string[]];
      const ticker = rawTicker.replace(/^\$/, '').trim();
      if (!post) return { ok: false, error: '/launch: the post url is missing' };
      if (!ticker) return { ok: false, error: '/launch: the ticker is missing' };
      if (!coinName) return { ok: false, error: '/launch: the name is missing' };
      let postUrl: string;
      try {
        postUrl = parsePost(post).url;
      } catch (e) {
        return { ok: false, error: `/launch: ${e instanceof DesignError ? e.problems.join('; ') : (e as Error).message}` };
      }
      return {
        ok: true,
        command: { kind: 'launch', postUrl, ticker, name: coinName, sourceUrl: source || null, description: description || null },
      };
    }
    default:
      return { ok: false, error: `unknown command /${name}` };
  }
}

/** Removes a bot token from any text: the given token and anything shaped like one. */
export function redactToken(text: string, token?: string): string {
  let out = token ? text.split(token).join('<token>') : text;
  out = out.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '<token>');
  return out;
}

/** A Bot API call that failed; the message never contains the token. */
export class TelegramError extends Error {
  readonly method: string;
  /** Telegram's error code or the HTTP status; null for network errors. */
  readonly code: number | null;
  /** Seconds Telegram asked to wait (429). */
  readonly retryAfter: number | null;
  constructor(method: string, message: string, code: number | null, retryAfter: number | null) {
    super(`telegram ${method}: ${message}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface TelegramOptions {
  /** Defaults to TELEGRAM_BOT_TOKEN. */
  token?: string;
  /** Defaults to TELEGRAM_CHAT_ID. */
  chatId?: string | number;
  /** Defaults to TELEGRAM_OWNER_ID, else the chat ID when it is a private chat. */
  ownerId?: string | number;
  fetch?: typeof fetch;
  apiBase?: string;
  /** Long-poll wait per getUpdates call. */
  pollTimeoutSec?: number;
  /** Unix seconds; messages older than this are skipped (defaults to construction time). */
  startedAt?: number;
  /** Per-request timeout for everything but getUpdates. */
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof log, 'debug' | 'info' | 'warn' | 'error'>;
}

interface TgUser {
  id: number;
  is_bot?: boolean;
}
interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}
interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  reply_to_message?: TgMessage;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

interface PendingCard {
  resolve: (a: Approval) => void;
  timer: ReturnType<typeof setTimeout>;
  text: string;
  /** The message carrying the buttons, once sent, and whether its text is a photo caption. */
  sent: { messageId: number; caption: boolean } | null;
}

type CardMessage = { messageId: number; caption: boolean };

/** The Notifier over Telegram, plus the owner's command loop (`runCommands`). */
export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly ownerId: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly pollTimeoutSec: number;
  private readonly startedAt: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: NonNullable<TelegramOptions['logger']>;
  private readonly closer = new AbortController();

  private offset = 0;
  private loop: Promise<void> | null = null;
  private handler: CommandHandler | null = null;
  private readonly pending = new Map<string, PendingCard>();
  private sendChain: Promise<void> = Promise.resolve();
  private readonly stopWaiters: (() => void)[] = [];

  /** Throws when the token or chat is missing or malformed, or when a group chat has no owner ID. */
  constructor(opts: TelegramOptions = {}) {
    const token = String(opts.token ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new Error('TELEGRAM_BOT_TOKEN is missing or malformed (expected <bot id>:<secret> from @BotFather)');
    }
    const chatId = String(opts.chatId ?? process.env.TELEGRAM_CHAT_ID ?? '').trim();
    if (!/^-?\d+$/.test(chatId)) throw new Error('TELEGRAM_CHAT_ID is missing or not a numeric chat ID');
    const ownerRaw = String(opts.ownerId ?? process.env.TELEGRAM_OWNER_ID ?? '').trim();
    if (ownerRaw && !/^\d+$/.test(ownerRaw)) throw new Error('TELEGRAM_OWNER_ID must be a numeric user ID');
    if (!ownerRaw && chatId.startsWith('-')) {
      throw new Error('TELEGRAM_CHAT_ID is a group: set TELEGRAM_OWNER_ID to your user ID so only you can approve and command');
    }
    this.token = token;
    this.chatId = chatId;
    this.ownerId = ownerRaw || chatId;
    this.fetchFn = opts.fetch ?? fetch;
    this.apiBase = (opts.apiBase ?? TELEGRAM_API).replace(/\/+$/, '');
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.startedAt = opts.startedAt ?? Math.floor(Date.now() / 1000);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.logger = opts.logger ?? log;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.closer.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          this.closer.signal.addEventListener('abort', done, { once: true });
        }));
  }

  private get closed(): boolean {
    return this.closer.signal.aborted;
  }

  /**
   * Sends a plain-text message to the owner (no markup, link previews off), in order with other sends. Retries
   * briefly on network errors, rate limits and server errors, then logs and gives up: it never rejects, so an alert
   * can never break a launch or a sell. Do not await it on a time-critical path.
   */
  send(text: string): Promise<void> {
    const next = this.sendChain.then(async () => {
      try {
        await this.callRetrying('sendMessage', {
          chat_id: this.chatId,
          text: clip(text || '(empty)', MESSAGE_MAX),
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        this.logger.error(`telegram: message not delivered: ${this.redact((e as Error).message)}`);
      }
    });
    this.sendChain = next;
    return next;
  }

  /**
   * Sends a launch card (a photo with the text as caption, or a text message) with Approve and Reject buttons and
   * waits for the owner. Only a button press by the owner in the owner's chat on this card counts; no answer within
   * `timeoutSec` of the call is a rejection, and so is a card that could not be sent. Never rejects. The card is
   * edited to show the outcome and lose its buttons.
   */
  async askApproval(card: { text: string; image?: Uint8Array; timeoutSec: number }): Promise<Approval> {
    const startedMs = Date.now();
    const rejected = (): Approval => ({ approved: false, by: 'timeout', at: Date.now() });
    if (this.closed) return rejected();
    if (!Number.isFinite(card.timeoutSec) || card.timeoutSec <= 0) {
      this.logger.error(`telegram: approval timeout ${card.timeoutSec} s is not a positive number; rejecting`);
      return rejected();
    }
    const nonce = randomBytes(8).toString('hex');
    const text = `${card.text}\n\nApprove within ${fmtSec(card.timeoutSec)}; no answer is a rejection.`;
    const decision = new Promise<Approval>((resolve) => {
      const timer = setTimeout(() => this.settle(nonce, false, 'timeout', null), card.timeoutSec * 1000);
      this.pending.set(nonce, { resolve, timer, text, sent: null });
    });
    // Polling starts before the card goes out, so a quick answer is not missed.
    this.ensurePolling();
    const keyboard = {
      inline_keyboard: [[{ text: 'Approve', callback_data: `approve:${nonce}` }, { text: 'Reject', callback_data: `reject:${nonce}` }]],
    };
    try {
      const sent = await this.postCard(text, card.image, keyboard);
      const p = this.pending.get(nonce);
      if (p) p.sent = sent;
      else {
        // Timed out while the card was in flight (a button press already edited the card it was on).
        const r = await decision;
        if (r.by === 'timeout') void this.markCard(sent, text, r);
      }
    } catch (e) {
      this.logger.error(`telegram: approval card not sent, rejecting: ${this.redact((e as Error).message)}`);
      this.settle(nonce, false, 'timeout', null);
    }
    const result = await decision;
    if (result.by === 'timeout') this.logger.warn(`telegram: no approval within ${((Date.now() - startedMs) / 1000).toFixed(1)} s; rejected`);
    return result;
  }

  /**
   * Runs the command loop until `signal` aborts or `close()` is called. Each owner command is handed to `handler` as
   * soon as it is read, without waiting for earlier commands to finish, so /kill is never stuck behind a running
   * launch. A /launch photo is downloaded first; when that fails the owner is told and the command is dropped.
   * Malformed and unknown commands get the usage text; /help is answered here. A handler error is logged and sent to
   * the owner.
   */
  async runCommands(handler: CommandHandler, signal?: AbortSignal): Promise<void> {
    if (this.handler) throw new Error('the Telegram command loop is already running');
    if (this.closed || signal?.aborted) return;
    this.handler = handler;
    this.ensurePolling();
    try {
      await new Promise<void>((resolve) => {
        this.stopWaiters.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      this.handler = null;
    }
  }

  /** Stops polling and every pending approval (as rejections), and ends `runCommands`. */
  close(): void {
    if (this.closed) return;
    this.closer.abort();
    for (const nonce of [...this.pending.keys()]) this.settle(nonce, false, 'timeout', null, false);
    for (const w of this.stopWaiters.splice(0)) w();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------------------------------------------

  private wantsUpdates(): boolean {
    return !this.closed && (this.handler !== null || this.pending.size > 0);
  }

  private ensurePolling(): void {
    if (this.loop || !this.wantsUpdates()) return;
    this.loop = this.pollLoop()
      .catch((e) => this.logger.error(`telegram: poll loop failed: ${this.redact((e as Error).message)}`))
      .finally(() => {
        this.loop = null;
        if (this.wantsUpdates()) this.ensurePolling();
      });
  }

  /** Long-polls getUpdates while anything needs updates; backs off 1 s, 2 s, 4 s ... 30 s on errors. */
  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.wantsUpdates()) {
      let updates: TgUpdate[];
      try {
        updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: this.pollTimeoutSec, allowed_updates: ['message', 'callback_query'] },
          (this.pollTimeoutSec + 15) * 1000,
        );
        failures = 0;
      } catch (e) {
        if (this.closed) return;
        failures++;
        const err = e as TelegramError;
        const wait = err.retryAfter ? err.retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** (failures - 1));
        if (failures <= 3 || failures % 20 === 0) {
          const hint =
            err.code === 409
              ? ' (another process or a webhook is taking this bot\'s updates: run one reader only)'
              : err.code === 401
                ? ' (the bot token was rejected)'
                : '';
          this.logger.warn(`telegram: getUpdates failed${hint}: ${this.redact(err.message)}; retry ${failures} in ${wait / 1000} s`);
        }
        await this.sleep(wait);
        continue;
      }
      if (!Array.isArray(updates)) continue;
      for (const u of updates) {
        if (typeof u?.update_id !== 'number' || u.update_id < this.offset) continue;
        this.offset = u.update_id + 1;
        try {
          this.dispatch(u);
        } catch (e) {
          this.logger.error(`telegram: update ${u.update_id} not handled: ${this.redact((e as Error).message)}`);
        }
      }
    }
  }

  /** True when the update comes from the owner in the owner's chat. */
  private fromOwner(chatId: number | undefined, from: TgUser | undefined): boolean {
    return String(chatId) === this.chatId && from !== undefined && !from.is_bot && String(from.id) === this.ownerId;
  }

  private dispatch(u: TgUpdate): void {
    const q = u.callback_query;
    if (q) {
      if (!this.fromOwner(q.message?.chat?.id, q.from)) {
        this.logger.debug('telegram: ignored a button press from outside the owner chat');
        return;
      }
      const m = (q.data ?? '').match(/^(approve|reject):([0-9a-f]{16})$/);
      const settled = m !== null && this.settle(m[2]!, m[1] === 'approve', 'owner', q.message ?? null);
      const note = settled ? (m![1] === 'approve' ? 'Approved' : 'Rejected') : 'This card is no longer active';
      void this.call('answerCallbackQuery', { callback_query_id: q.id, text: note }).catch((e) =>
        this.logger.debug(`telegram: answerCallbackQuery failed: ${this.redact((e as Error).message)}`),
      );
      return;
    }
    const msg = u.message;
    if (!msg || !this.fromOwner(msg.chat?.id, msg.from)) {
      if (msg) this.logger.debug('telegram: ignored a message from outside the owner chat');
      return;
    }
    if (msg.date < this.startedAt) {
      this.logger.info(`telegram: skipped a message sent before this process started (${new Date(msg.date * 1000).toISOString()})`);
      return;
    }
    const parsed = parseCommand(msg.text ?? msg.caption ?? '');
    if (parsed === null) return;
    if (!parsed.ok) {
      void this.send(`${parsed.error}\n\n${USAGE}`);
      return;
    }
    if (parsed.command.kind === 'help') {
      void this.send(USAGE);
      return;
    }
    const handler = this.handler;
    if (!handler) {
      void this.send('Commands are not being accepted right now (the command loop is not running).');
      return;
    }
    void this.deliver(handler, parsed.command, msg);
  }

  private async deliver(handler: CommandHandler, command: Command, msg: TgMessage): Promise<void> {
    let image: CoinDraft['image'] | null = null;
    if (command.kind === 'launch') {
      const ref = imageRef(msg) ?? (msg.reply_to_message ? imageRef(msg.reply_to_message) : null);
      if (ref) {
        try {
          image = await this.downloadImage(ref);
        } catch (e) {
          const why = this.redact((e as Error).message);
          this.logger.warn(`telegram: /launch photo not downloaded: ${why}`);
          void this.send(`Could not download the photo (${why}). Nothing launched; send the command again.`);
          return;
        }
      }
    }
    try {
      await handler({ command, image, messageId: msg.message_id, sentAt: msg.date });
    } catch (e) {
      const why = this.redact((e as Error).message);
      this.logger.error(`telegram: /${command.kind} failed: ${why}`);
      void this.send(`/${command.kind} failed: ${why}`);
    }
  }

  /** Downloads a photo or image file via getFile; checks its size and that its bytes are an image. */
  private async downloadImage(ref: { fileId: string; size: number | null; filename: string | null }): Promise<CoinDraft['image']> {
    if (ref.size !== null && ref.size > MAX_DOWNLOAD_BYTES) throw new Error('the file is over the 20 MB Bot API limit');
    const file = await this.callRetrying<{ file_path?: string; file_size?: number }>('getFile', { file_id: ref.fileId });
    const path = file.file_path ?? '';
    if (!/^[\w./-]+$/.test(path) || path.includes('..')) throw new Error('Telegram gave no usable file path');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/file/bot${this.token}/${path}`, {
        signal: AbortSignal.any([this.closer.signal, AbortSignal.timeout(20_000)]),
      });
    } catch (e) {
      throw new Error(`download failed: ${this.redact(errText(e))}`);
    }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error('the file is empty');
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('the file is over 20 MB');
    const mime = sniffImage(bytes);
    if (!mime) throw new Error('the file is not a PNG, JPEG, GIF or WEBP image');
    const base = (ref.filename ?? path.split('/').pop() ?? '').replace(/[^\w.-]/g, '_');
    const filename = /\.(png|jpe?g|gif|webp)$/i.test(base) ? base : `image.${mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]}`;
    return { bytes, mime, filename };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Approval cards
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Sends the card: the photo with the text as its caption and the buttons, or (text over 1,024 characters) the photo
   * and then a text message with the buttons. When Telegram refuses the photo itself (format, size), the card goes out
   * as text with a note, so the owner still decides; network errors are not retried here beyond callRetrying.
   */
  private async postCard(text: string, image: Uint8Array | undefined, keyboard: object): Promise<CardMessage> {
    let body = text;
    if (image && image.length > 0) {
      const withCaption = text.length <= CAPTION_MAX;
      const mime = sniffImage(image) ?? 'application/octet-stream';
      const form = new FormData();
      form.append('chat_id', this.chatId);
      form.append('photo', new Blob([image], { type: mime }), `card.${mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] ?? 'bin')}`);
      if (withCaption) {
        form.append('caption', text);
        form.append('reply_markup', JSON.stringify(keyboard));
      }
      try {
        const photo = await this.callRetrying<TgMessage>('sendPhoto', form);
        if (withCaption) return { messageId: photo.message_id, caption: true };
      } catch (e) {
        const err = e as TelegramError;
        if (err.code !== 400 && err.code !== 413) throw err;
        this.logger.warn(`telegram: card photo refused, sending the card as text: ${this.redact(err.message)}`);
        body = `${text}\n\n(The image could not be shown here: ${this.redact(err.message)})`;
      }
    }
    const msg = await this.callRetrying<TgMessage>('sendMessage', {
      chat_id: this.chatId,
      text: clip(body, MESSAGE_MAX),
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    return { messageId: msg.message_id, caption: false };
  }

  /** Resolves a pending approval once; false when there is none (already decided, expired, or unknown). */
  private settle(nonce: string, approved: boolean, by: Approval['by'], pressed: TgMessage | null, edit = true): boolean {
    const p = this.pending.get(nonce);
    if (!p) return false;
    this.pending.delete(nonce);
    clearTimeout(p.timer);
    const result: Approval = { approved, by, at: Date.now() };
    p.resolve(result);
    if (!edit) return true;
    // The edit is cosmetic: it runs after the decision is handed back and never delays it.
    const target: CardMessage | null = pressed
      ? { messageId: pressed.message_id, caption: pressed.photo !== undefined || pressed.caption !== undefined }
      : p.sent;
    if (target) void this.markCard(target, p.text, result);
    return true;
  }

  private async markCard(target: CardMessage, text: string, result: Approval): Promise<void> {
    const time = new Date(result.at).toISOString().slice(11, 19);
    const outcome =
      result.by === 'owner' ? `${result.approved ? 'APPROVED' : 'REJECTED'} by the owner at ${time} UTC` : `NO ANSWER: rejected at ${time} UTC`;
    const max = target.caption ? CAPTION_MAX : MESSAGE_MAX;
    const body = `${clip(text, max - outcome.length - 2)}\n\n${outcome}`;
    try {
      // Editing without reply_markup removes the buttons.
      if (target.caption) await this.call('editMessageCaption', { chat_id: this.chatId, message_id: target.messageId, caption: body });
      else await this.call('editMessageText', { chat_id: this.chatId, message_id: target.messageId, text: body, link_preview_options: { is_disabled: true } });
    } catch (e) {
      this.logger.debug(`telegram: card not updated: ${this.redact((e as Error).message)}`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Bot API
  // -------------------------------------------------------------------------------------------------------------

  private redact(text: string): string {
    return redactToken(text, this.token);
  }

  /** One Bot API call. Errors are TelegramErrors whose messages never contain the token or the URL. */
  private async call<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) throw new TelegramError(method, 'closed', null, null);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.closer.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (e) {
      throw new TelegramError(method, `network error: ${this.redact(errText(e))}`, null, null);
    }
    let data: { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new TelegramError(method, `HTTP ${res.status}, not JSON`, res.status, null);
    }
    if (!data || data.ok !== true) {
      const retryAfter = typeof data?.parameters?.retry_after === 'number' ? data.parameters.retry_after : null;
      throw new TelegramError(method, this.redact(String(data?.description ?? `HTTP ${res.status}`)), data?.error_code ?? res.status, retryAfter);
    }
    return data.result as T;
  }

  /** A call retried up to 3 times on network errors, 429 and 5xx (waiting 0.5 s, 1 s, or what Telegram asks up to 5 s). */
  private async callRetrying<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call<T>(method, body);
      } catch (e) {
        const err = e as TelegramError;
        const retryable = err.code === null || err.code === 429 || (err.code >= 500 && err.code < 600);
        if (attempt >= 3 || !retryable || this.closed) throw err;
        await this.sleep(err.retryAfter ? Math.min(err.retryAfter * 1000, 5_000) : 500 * 2 ** (attempt - 1));
      }
    }
  }
}

/** The best image attached to a message: the largest photo size, or an image sent as a file. */
function imageRef(msg: TgMessage): { fileId: string; size: number | null; filename: string | null } | null {
  if (msg.photo?.length) {
    const best = [...msg.photo].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
    return { fileId: best.file_id, size: best.file_size ?? null, filename: null };
  }
  if (msg.document && /^image\//i.test(msg.document.mime_type ?? '')) {
    return { fileId: msg.document.file_id, size: msg.document.file_size ?? null, filename: msg.document.file_name ?? null };
  }
  return null;
}

function errText(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return 'timed out';
  if (err?.name === 'AbortError') return 'aborted';
  const cause = err?.cause?.code ?? err?.cause?.message;
  return `${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

function fmtSec(sec: number): string {
  return sec >= 120 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`;
}
