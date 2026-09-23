/**
 * Sensei gatekeeper: the only door from the internet (Cloudflare Tunnel → :3001 → app on :3000).
 * Passes everything through untouched, except it limits access-code guessing:
 *   - 3 wrong codes from one device (Cloudflare's CF-Connecting-IP) → that device locked 1 hour;
 *   - 10 wrong codes from anywhere within an hour → everyone locked for 1 hour.
 * On the Mac itself (localhost:3000) nothing changes. No OpenMAIC files are modified.
 */
import http from 'http';
import net from 'net';

const GATE_PORT = Number(process.env.SENSEI_GATE_PORT ?? 3001);
const PER_DEVICE = 3;
const GLOBAL = 10;
const LOCK_MS = 60 * 60_000;

export interface Lockout {
  check(ip: string, now?: number): number; // ms remaining locked (0 = open)
  fail(ip: string, now?: number): void;
  succeed(ip: string): void;
}

export function createLockout(perDevice = PER_DEVICE, global = GLOBAL, lockMs = LOCK_MS): Lockout {
  const fails = new Map<string, number[]>();
  let globalFails: number[] = [];
  const lockedUntil = new Map<string, number>();
  let globalLockedUntil = 0;
  return {
    check(ip, now = Date.now()) {
      return Math.max(0, globalLockedUntil - now, (lockedUntil.get(ip) ?? 0) - now);
    },
    fail(ip, now = Date.now()) {
      const mine = (fails.get(ip) ?? []).filter((t) => now - t < lockMs);
      mine.push(now);
      fails.set(ip, mine);
      globalFails = globalFails.filter((t) => now - t < lockMs);
      globalFails.push(now);
      if (mine.length >= perDevice) lockedUntil.set(ip, now + lockMs);
      if (globalFails.length >= global) globalLockedUntil = now + lockMs;
    },
    succeed(ip) {
      fails.delete(ip);
    },
  };
}

function clientIp(req: http.IncomingMessage): string {
  // Set by Cloudflare at its edge; a client cannot spoof it through the tunnel.
  return String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown');
}

export function createGate(lockout = createLockout(), targetPort = Number(process.env.SENSEI_PORT ?? 3000)) {
  const server = http.createServer((req, res) => {
    const ip = clientIp(req);
    const isVerify = req.method === 'POST' && req.url?.split('?')[0] === '/api/access-code/verify';
    if (isVerify) {
      const wait = lockout.check(ip);
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60_000);
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(wait / 1000)) });
        res.end(JSON.stringify({ success: false, errorCode: 'RATE_LIMITED', error: `Too many wrong codes. Try again in ${minutes} minutes.` }));
        return;
      }
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        if (isVerify) {
          if (up.statusCode === 401) lockout.fail(ip);
          else if (up.statusCode && up.statusCode < 300) lockout.succeed(ip);
        }
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Sensei is restarting. Try again in a moment.');
    });
    req.pipe(upstream);
  });
  // WebSocket / upgrade passthrough.
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(targetPort, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      up.write('\r\n');
      if (head.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return server;
}

if (process.argv[1]?.endsWith('gate.ts')) {
  createGate().listen(GATE_PORT, '127.0.0.1', () => console.log(`[gate] :${GATE_PORT} → :${process.env.SENSEI_PORT ?? 3000} (3 tries per device, 10 overall, 1h lock)`));
}
