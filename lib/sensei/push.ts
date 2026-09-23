/**
 * Web Push with Node's built-in crypto only (no dependency): VAPID (RFC 8292)
 * and aes128gcm payload encryption (RFC 8291). Works for iOS home-screen apps
 * (16.4+), which require every push to show a notification.
 */
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv } from 'crypto';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url, 32 bytes
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  void publicKey;
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

/** ES256 JWT for the push service's origin; Apple rejects exp more than 24h out. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

export interface PushSubscriptionKeys {
  p256dh: string; // user agent public key, base64url
  auth: string; // auth secret, base64url
}

/**
 * RFC 8291 aes128gcm encryption. `asPrivate` and `salt` are injectable only for the
 * RFC test vector; in real use both are fresh random values per message.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: PushSubscriptionKeys,
  opts: { asPrivate?: Buffer; salt?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const ecdh = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Only real push services — never let a stored endpoint turn this server into a proxy. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
export function isPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export type SendResult = 'ok' | 'gone' | 'error';

export async function sendPush(
  subscription: { endpoint: string; keys: PushSubscriptionKeys },
  message: PushMessage,
  vapid: VapidKeys,
  subject: string,
): Promise<SendResult> {
  if (!isPushEndpoint(subscription.endpoint)) return 'gone';
  const body = encryptPayload(Buffer.from(JSON.stringify(message)), subscription.keys);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(24 * 3600),
      urgency: 'normal',
      ...(message.tag ? { topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body: new Uint8Array(body),
  }).catch(() => null);
  if (!res) return 'error';
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'error';
}
