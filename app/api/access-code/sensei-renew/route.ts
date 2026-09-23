/**
 * Sensei "remember this device": sliding renewal of OpenMAIC's access cookie.
 * A still-valid cookie is exchanged for a fresh one, so a device that opens Sensei
 * at least once a week is never asked for the code again. An expired or missing
 * cookie gets nothing — the code is still required once. Lives under
 * /api/access-code/ because the middleware lets that prefix through; the check
 * here is the same HMAC verification the middleware uses.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { createAccessToken, verifyAccessToken } from '@/lib/server/access-token';
import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/server/access-token-shared';

export const dynamic = 'force-dynamic';

export async function POST() {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return NextResponse.json({ renewed: false, gate: false });
  const store = await cookies();
  const current = store.get('openmaic_access')?.value;
  if (!current || !verifyAccessToken(current, accessCode)) {
    return NextResponse.json({ renewed: false }, { status: 401 });
  }
  store.set('openmaic_access', createAccessToken(accessCode), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });
  return NextResponse.json({ renewed: true });
}
