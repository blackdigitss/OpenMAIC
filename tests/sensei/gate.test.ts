import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLockout } from '@/scripts/sensei/gate';

describe('access-code lockout', () => {
  it('locks a device after 3 wrong codes, for an hour', () => {
    const l = createLockout();
    const t = 1_000_000;
    l.fail('a', t);
    l.fail('a', t + 1);
    expect(l.check('a', t + 2)).toBe(0);
    l.fail('a', t + 2);
    expect(l.check('a', t + 3)).toBeGreaterThan(59 * 60_000);
    expect(l.check('b', t + 3)).toBe(0); // other devices unaffected
    expect(l.check('a', t + 2 + 60 * 60_000)).toBe(0);
  });

  it('a correct code resets that device’s count', () => {
    const l = createLockout();
    l.fail('a', 1);
    l.fail('a', 2);
    l.succeed('a');
    l.fail('a', 3);
    expect(l.check('a', 4)).toBe(0);
  });

  it('locks everyone after 10 wrong codes from many devices', () => {
    const l = createLockout();
    for (let i = 0; i < 10; i++) l.fail(`ip${i}`, 100 + i);
    expect(l.check('fresh-device', 200)).toBeGreaterThan(0);
  });
});

describe('gate proxy', () => {
  let target: http.Server;
  let gate: http.Server;
  let base = '';
  beforeAll(async () => {
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/api/access-code/verify') {
          res.writeHead(body.includes('911919') ? 200 : 401, { 'content-type': 'application/json' });
          res.end('{}');
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const { createGate } = await import('@/scripts/sensei/gate');
    gate = createGate(createLockout(), (target.address() as AddressInfo).port);
    await new Promise<void>((r) => gate.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    gate.close();
    target.close();
  });

  const verify = (code: string, ip = '203.0.113.9') =>
    fetch(`${base}/api/access-code/verify`, { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: JSON.stringify({ code }) });

  it('passes normal traffic and blocks the 4th guess', async () => {
    expect(await (await fetch(`${base}/sensei`)).text()).toBe('ok');
    expect((await verify('000000')).status).toBe(401);
    expect((await verify('111111')).status).toBe(401);
    expect((await verify('222222')).status).toBe(401);
    expect((await verify('911919')).status).toBe(429); // even the right code waits out the lock
    expect((await verify('911919', '198.51.100.7')).status).toBe(200); // a different device is fine
  });
});
