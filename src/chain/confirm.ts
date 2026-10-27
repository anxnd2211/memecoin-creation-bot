import { log } from '../log.ts';

/**
 * Holds streamed transactions until the RPC confirms they landed. Standard `logsSubscribe` occasionally delivers
 * logs of transactions that never confirm (seen on the public RPC), which would otherwise become phantom trades.
 * Confirmed transactions are released as soon as they check out, so real ones are delayed by one polling interval.
 */
export class ConfirmGate<T extends { sig: string }> {
  readonly stats = { confirmed: 0, phantom: 0, rpcErrors: 0 };
  private pending: { tx: T; since: number }[] = [];
  private inflight = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly rpcHttp: string;
  private readonly onConfirmed: (tx: T) => void;
  private readonly maxWaitMs: number;

  constructor(rpcHttp: string, onConfirmed: (tx: T) => void, maxWaitMs = 15_000) {
    this.rpcHttp = rpcHttp;
    this.onConfirmed = onConfirmed;
    this.maxWaitMs = maxWaitMs;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  start(intervalMs = 400): void {
    this.timer = setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  push(tx: T): void {
    this.pending.push({ tx, since: Date.now() });
  }

  private async check(): Promise<void> {
    if (this.inflight || this.pending.length === 0) return;
    this.inflight = true;
    const batch = this.pending.slice(0, 256);
    try {
      const res = await fetch(this.rpcHttp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [batch.map((p) => p.tx.sig)],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await res.json()) as {
        result?: { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
        error?: unknown;
      };
      if (!body.result) throw new Error(`RPC error ${JSON.stringify(body.error ?? res.status)}`);
      const now = Date.now();
      const done = new Set<T>();
      body.result.value.forEach((status, i) => {
        const p = batch[i]!;
        const landed =
          status !== null &&
          status.err === null &&
          (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
        if (landed) {
          this.stats.confirmed++;
          done.add(p.tx);
          this.onConfirmed(p.tx);
        } else if (now - p.since > this.maxWaitMs) {
          this.stats.phantom++;
          done.add(p.tx);
        }
      });
      this.pending = this.pending.filter((p) => !done.has(p.tx));
    } catch (err) {
      this.stats.rpcErrors++;
      log.warn('signature status check failed', { error: String(err).slice(0, 200) });
      // Never hold data hostage to an RPC outage: release anything that has waited too long.
      const now = Date.now();
      const stale = this.pending.filter((p) => now - p.since > this.maxWaitMs);
      if (stale.length) {
        for (const p of stale) this.onConfirmed(p.tx);
        this.pending = this.pending.filter((p) => now - p.since <= this.maxWaitMs);
      }
    } finally {
      this.inflight = false;
    }
  }
}
