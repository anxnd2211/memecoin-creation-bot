import { createServer, type Server } from 'node:http';

/**
 * The dashboard's HTTP server: one static page, a JSON snapshot, and a server-sent-events stream pushing a fresh
 * snapshot every couple of seconds. Read-only by construction: there is no route that writes anything, so leaving it
 * running during a live session cannot touch a launch. It serves no secret: public keys, balances and launch records
 * only.
 */

export interface DashboardDeps {
  snapshot: () => unknown;
  page: string;
  /** How often the event stream pushes, in ms (default 2000). */
  intervalMs?: number;
}

export function startDashboard(d: DashboardDeps, port: number, host: string): Promise<{ server: Server; port: number }> {
  const interval = d.intervalMs ?? 2000;
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(d.page);
      return;
    }
    if (url === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(d.snapshot()));
      return;
    }
    if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const send = () => {
        try {
          res.write(`data: ${JSON.stringify(d.snapshot())}\n\n`);
        } catch {
          clearInterval(timer);
        }
      };
      res.write('retry: 3000\n\n');
      send();
      const timer = setInterval(send, interval);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}
