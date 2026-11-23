// 시험용 protobuf 인코더: Google Authenticator "계정 내보내기" 주소를 만든다.
const enc = (s) => [...new TextEncoder().encode(s)];
const varint = (n) => { const o = []; n = BigInt(n); while (n > 127n) { o.push(Number(n & 127n) | 128); n >>= 7n; } o.push(Number(n)); return o; };
const ld = (f, bytes) => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
const vi = (f, n) => [...varint(f << 3), ...varint(n)];
export const migrationUri = (accts) => {
  const body = accts.flatMap((a) => ld(1, [...ld(1, [...a.secret]), ...ld(2, enc(a.name)), ...ld(3, enc(a.issuer)),
    ...vi(4, a.algorithm ?? 1), ...vi(5, a.digits ?? 1), ...vi(6, a.type ?? 2), ...(a.counter !== undefined ? vi(7, a.counter) : [])]));
  const all = [...body, ...vi(2, 1), ...vi(3, 1), ...vi(4, 0), ...vi(5, 123456789)];
  return 'otpauth-migration://offline?data=' + encodeURIComponent(Buffer.from(all).toString('base64'));
};
