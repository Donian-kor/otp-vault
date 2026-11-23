// RFC 4226(HOTP) / RFC 6238(TOTP). Web Crypto의 HMAC만 사용한다.
const HASH = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export async function hotp(keyBytes, counter, { algorithm = 'SHA1', digits = 6 } = {}) {
  const hash = HASH[algorithm];
  if (!hash) throw new Error('지원하지 않는 알고리즘입니다.');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0'); // 앞자리 0 유지
}

// unixSeconds: UTC 기준 Unix 초. 매번 현재 시간으로 다시 계산한다.
export function totp(keyBytes, unixSeconds, { algorithm = 'SHA1', digits = 6, period = 30 } = {}) {
  return hotp(keyBytes, Math.floor(unixSeconds / period), { algorithm, digits });
}

export function formatCode(code) {
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  return code;
}
