import { describe, expect, it } from 'vitest';

import { GET } from '@/app/sensei-sw.js/route';

describe('service worker', () => {
  it('is valid JavaScript with a build-specific cache and no precache', async () => {
    const src = await GET().text();
    expect(() => new Function(src)).not.toThrow();
    expect(src).toMatch(/const CACHE = 'sensei-[^']+'/);
    expect(src).not.toMatch(/addAll\(/);
  });

  it('keeps pages and data but never audio or ranged requests', async () => {
    const src = await GET().text();
    const keepable = new Function(`${src.slice(src.indexOf('function keepable'), src.indexOf("self.addEventListener('fetch'"))}; return keepable;`)() as (
      u: URL,
      r: { method: string; headers: Headers },
    ) => boolean;
    Object.assign(globalThis, { self: { location: { origin: 'https://s.test' } } });
    const get = (h: Record<string, string> = {}) => ({ method: 'GET', headers: new Headers(h) });
    const u = (p: string) => new URL(p, 'https://s.test');
    expect(keepable(u('/sensei'), get())).toBe(true);
    expect(keepable(u('/api/sensei/today'), get())).toBe(true);
    expect(keepable(u('/_next/static/chunks/a.js'), get())).toBe(true);
    expect(keepable(u('/api/sensei/audio/x'), get())).toBe(false);
    expect(keepable(u('/api/sensei/reels/x'), get())).toBe(false);
    expect(keepable(u('/api/sensei/today'), get({ range: 'bytes=0-1' }))).toBe(false);
    expect(keepable(u('/api/sensei/review'), { method: 'POST', headers: new Headers() })).toBe(false);
    expect(keepable(u('/'), get())).toBe(false);
  });
});
