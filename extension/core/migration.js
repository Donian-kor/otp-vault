// Google Authenticator "계정 내보내기" QR (otpauth-migration://offline?data=...) 해석.
// data 는 base64로 인코딩된 protobuf 이며, 이 파일이 필요한 부분만 직접 읽는다. (외부 라이브러리 없음)
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(bytes) {
  let out = '', bits = 0, val = 0;
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } val &= (1 << bits) - 1; }
  if (bits) out += A[(val << (5 - bits)) & 31];
  return out;
}

function* fields(b) {
  let p = 0;
  const varint = () => { let r = 0n, s = 0n; for (;;) { if (p >= b.length) throw new Error('truncated'); const x = b[p++]; r |= BigInt(x & 127) << s; if (!(x & 128)) return r; s += 7n; if (s > 63n) throw new Error('varint'); } };
  while (p < b.length) {
    const tag = Number(varint()), field = tag >> 3, wt = tag & 7;
    if (wt === 0) yield [field, varint()];
    else if (wt === 2) { const n = Number(varint()); if (p + n > b.length) throw new Error('truncated'); yield [field, b.subarray(p, p + n)]; p += n; }
    else if (wt === 1) { p += 8; } else if (wt === 5) { p += 4; } else throw new Error('wire type');
  }
}

export function parseMigration(uri) {
  const m = /^otpauth-migration:\/\/offline\?(.*)$/i.exec(String(uri).trim());
  if (!m) throw new Error('Google Authenticator 내보내기 주소가 아닙니다.');
  const data = new URLSearchParams(m[1]).get('data');
  if (!data) throw new Error('내보내기 주소에 data가 없습니다.');
  let bytes;
  try { const bin = atob(data.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/')); bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
  catch { throw new Error('내보내기 데이터를 읽을 수 없습니다.'); }
  const accounts = []; let skipped = 0;
  try {
    for (const [f, v] of fields(bytes)) {
      if (f !== 1 || !(v instanceof Uint8Array)) continue;
      const o = { secret: null, name: '', issuer: '', algorithm: 1, digits: 1, type: 2, counter: 0 };
      for (const [g, x] of fields(v)) {
        if (g === 1) o.secret = x; else if (g === 2) o.name = new TextDecoder().decode(x); else if (g === 3) o.issuer = new TextDecoder().decode(x);
        else if (g === 4) o.algorithm = Number(x); else if (g === 5) o.digits = Number(x); else if (g === 6) o.type = Number(x); else if (g === 7) o.counter = Number(x);
      }
      const algo = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }[o.algorithm], digits = { 0: 6, 1: 6, 2: 8 }[o.digits];
      if (!o.secret || !o.secret.length || !algo || !digits || ![0, 1, 2].includes(o.type)) { skipped++; continue; } // MD5 등 미지원
      let label = o.name.trim(), issuer = o.issuer.trim();
      const i = label.indexOf(':');
      if (i >= 0) { const pre = label.slice(0, i).trim(); if (!issuer) issuer = pre; if (!o.issuer || pre === issuer) label = label.slice(i + 1).trim(); }
      accounts.push({ type: o.type === 1 ? 'hotp' : 'totp', issuer, label: label || issuer, secret: encodeBase32(o.secret), algorithm: algo, digits, period: 30, counter: o.counter });
    }
  } catch { throw new Error('내보내기 데이터가 손상되었거나 지원하지 않는 형식입니다.'); }
  return { accounts, skipped };
}
