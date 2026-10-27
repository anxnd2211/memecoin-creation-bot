import { redactUrl } from '../../config.ts';
import { log } from '../../log.ts';
import type { RawTx } from '../events.ts';

export interface StreamStats {
  connectedSince: number | null;
  reconnects: number;
  received: number;
  failedTxs: number;
  duplicates: number;
  /** Seconds of stream lost to disconnects since start. */
  gapSeconds: number;
}

interface Options {
  url: string;
  programs: string[];
  commitment: 'processed' | 'confirmed';
  onTx: (tx: RawTx) => void;
  /** Reconnect when nothing arrives for this long; pump.fun traffic never pauses this long. */
  idleTimeoutMs?: number;
}

/**
 * Streams logs of every successful transaction that touches the given programs, over a standard Solana RPC
 * websocket (`logsSubscribe`). Works with any provider; reconnects with backoff and drops duplicate deliveries
 * (a transaction touching two programs arrives once per subscription).
 */
export class RpcLogStream {
  readonly stats: StreamStats = {
    connectedSince: null,
    reconnects: 0,
    received: 0,
    failedTxs: 0,
    duplicates: 0,
    gapSeconds: 0,
  };

  private ws: WebSocket | null = null;
  private stopped = false;
  private lastMessageAt = 0;
  private disconnectedAt: number | null = null;
  private backoffMs = 1000;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly seen = new Map<string, true>();
  private readonly opts: Required<Options>;

  constructor(opts: Options) {
    this.opts = { idleTimeoutMs: 20_000, ...opts };
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      const ws = this.ws;
      if (ws && this.lastMessageAt && Date.now() - this.lastMessageAt > this.opts.idleTimeoutMs) {
        log.warn('stream idle, reconnecting', { idleMs: Date.now() - this.lastMessageAt });
        // Don't wait for the close handshake; a stalled server can take a minute to answer it.
        ws.close();
        this.retry(ws);
      }
    }, 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  private connect(): void {
    log.info('connecting to RPC websocket', { url: redactUrl(this.opts.url) });
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.opts.programs.forEach((program, i) => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'logsSubscribe',
            params: [{ mentions: [program] }, { commitment: this.opts.commitment }],
          }),
        );
      });
      if (this.disconnectedAt) {
        this.stats.gapSeconds += (Date.now() - this.disconnectedAt) / 1000;
        log.warn('reconnected; events during the gap were missed', {
          gapSeconds: Math.round((Date.now() - this.disconnectedAt) / 1000),
        });
        this.disconnectedAt = null;
      }
      this.stats.connectedSince = Date.now();
      this.lastMessageAt = Date.now();
      this.backoffMs = 1000;
    });

    ws.addEventListener('message', (msg) => {
      this.lastMessageAt = Date.now();
      let payload: any;
      try {
        payload = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data as ArrayBuffer).toString());
      } catch {
        return;
      }
      if (payload.error) {
        log.error('RPC subscription error', { error: payload.error });
        return;
      }
      if (payload.method !== 'logsNotification') return;
      const value = payload.params?.result?.value;
      const slot: number = payload.params?.result?.context?.slot ?? 0;
      if (!value) return;
      if (value.err !== null) {
        this.stats.failedTxs++;
        return;
      }
      const sig: string = value.signature;
      if (this.seen.has(sig)) {
        this.stats.duplicates++;
        return;
      }
      this.seen.set(sig, true);
      if (this.seen.size > 50_000) this.seen.delete(this.seen.keys().next().value!);
      this.stats.received++;
      this.opts.onTx({ sig, slot, logs: value.logs as string[], receivedAt: this.lastMessageAt });
    });

    ws.addEventListener('close', () => this.retry(ws));

    ws.addEventListener('error', () => {
      // 'close' follows and handles the retry.
    });
  }

  /** Replaces a dead socket once; later close events from the same socket are ignored. */
  private retry(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stats.connectedSince = null;
    if (this.stopped) return;
    this.disconnectedAt ??= Date.now();
    this.stats.reconnects++;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    log.warn('websocket down, retrying', { inMs: wait });
    setTimeout(() => this.connect(), wait);
  }
}
