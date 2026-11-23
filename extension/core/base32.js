// RFC 4648 Base32 디코더. 잘못된 문자는 조용히 지우지 않고 오류로 처리한다.
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input) {
  const s = String(input).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!s) throw new Error('비밀키가 비어 있습니다.');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error('비밀키에 사용할 수 없는 문자가 있습니다. (A-Z, 2-7만 가능)');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
      val &= (1 << bits) - 1;
    }
  }
  if (out.length < 10) throw new Error('비밀키가 너무 짧습니다. (16자 이상)');
  return Uint8Array.from(out);
}
