import { createECDH, createPrivateKey, createPublicKey, hkdfSync, verify, createDecipheriv } from 'crypto';
import { describe, expect, it } from 'vitest';

import { encryptPayload, generateVapidKeys, isPushEndpoint, vapidAuthorization } from '@/lib/sensei/push';

const u = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291, Appendix A.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Independent decryption as the user agent would do it. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString();
}

describe('web push encryption (RFC 8291)', () => {
  it('matches the RFC test vector byte for byte', () => {
    const out = encryptPayload(Buffer.from(V.plaintext), { p256dh: V.uaPublic, auth: V.auth }, { asPrivate: u(V.asPrivate), salt: u(V.salt) });
    expect(out.toString('base64url')).toBe(V.body);
  });

  it('round-trips with fresh random keys', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const out = encryptPayload(Buffer.from('{"title":"Tonight"}'), { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
    expect(decrypt(out, ua.getPrivateKey(), auth)).toBe('{"title":"Tonight"}');
  });
});

describe('VAPID', () => {
  it('signs a verifiable ES256 JWT for the endpoint origin, expiring within 24h', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://web.push.apple.com/abc', keys, 'https://sensei.example.com', 1_700_000_000_000);
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = t.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.exp - 1_700_000_000).toBeLessThanOrEqual(24 * 3600);
    const pub = u(keys.publicKey);
    const pubKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, u(s))).toBe(true);
    void createPrivateKey;
  });

  it('only sends to real push services', () => {
    expect(isPushEndpoint('https://web.push.apple.com/QK')).toBe(true);
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('http://web.push.apple.com/QK')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isPushEndpoint('https://evil.com/?h=push.apple.com')).toBe(false);
  });
});
