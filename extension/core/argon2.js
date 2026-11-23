// Argon2id (RFC 9106, 버전 0x13) — 외부 라이브러리 없는 순수 JavaScript 구현.
// 블록 채우기의 64비트 연산은 32비트 쌍(lo, hi)으로 처리해 속도를 확보하고,
// 해시(BLAKE2b)와 참조 위치 계산처럼 호출이 적은 부분은 BigInt를 쓴다.

// ---------- BLAKE2b (BigInt) ----------
const M64 = (1n << 64n) - 1n;
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],[11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],
  [7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],[9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
  [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],[6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],
  [10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

function compress(h, block, t, last) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) { let w = 0n; for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(block[i * 8 + b]); m[i] = w; }
  const v = [...h, ...IV];
  v[12] ^= t & M64; if (last) v[14] ^= M64;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]); G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]); G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}
export function blake2b(input, outLen = 64) {
  const h = IV.slice(); h[0] ^= 0x01010000n ^ BigInt(outLen);
  const n = Math.max(1, Math.ceil(input.length / 128));
  for (let i = 0; i < n; i++) {
    const blk = new Uint8Array(128); blk.set(input.subarray(i * 128, (i + 1) * 128));
    const last = i === n - 1;
    compress(h, blk, BigInt(last ? input.length : (i + 1) * 128), last);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((h[i] >> BigInt(8 * b)) & 0xffn);
  return out.slice(0, outLen);
}

// ---------- Argon2 ----------
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const concat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

function hPrime(input, T) { // 가변 길이 해시 H'
  const pre = concat(le32(T), input);
  if (T <= 64) return blake2b(pre, T);
  const r = Math.ceil(T / 32) - 2, out = new Uint8Array(T);
  let v = blake2b(pre, 64); out.set(v.subarray(0, 32), 0);
  for (let i = 1; i < r; i++) { v = blake2b(v, 64); out.set(v.subarray(0, 32), i * 32); }
  out.set(blake2b(v, T - 32 * r), r * 32);
  return out;
}

let MH = 0; // mul32 의 상위 32비트 결과
function mul32(a, b) { // 32비트 × 32비트 → 64비트: 반환값=하위, MH=상위
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const p00 = a0 * b0, mid = a0 * b1 + a1 * b0, p11 = a1 * b1;
  const lowSum = p00 + (mid & 0xffff) * 65536;
  MH = (p11 + Math.floor(mid / 65536) + Math.floor(lowSum / 4294967296)) >>> 0;
  return lowSum >>> 0;
}
// 64비트 값 a = a + b + 2*lo(a)*lo(b)  (a, b 는 v 안의 오프셋)
function addMul(v, a, b) {
  const al = v[a], ah = v[a + 1], bl = v[b], bh = v[b + 1];
  const pl = mul32(al, bl), ph = MH;
  const l2 = (pl << 1) >>> 0, h2 = ((ph << 1) | (pl >>> 31)) >>> 0;
  const lo = al + bl + l2;
  v[a] = lo >>> 0; v[a + 1] = (ah + bh + h2 + Math.floor(lo / 4294967296)) >>> 0;
}
function add(v, c, d) { const lo = v[c] + v[d]; v[c + 1] = (v[c + 1] + v[d + 1] + Math.floor(lo / 4294967296)) >>> 0; v[c] = lo >>> 0; }
function G(v, a, b, c, d) { // a,b,c,d: 오프셋(워드 번호*2)
  addMul(v, a, b);
  let l = v[d] ^ v[a], h = v[d + 1] ^ v[a + 1]; v[d] = h; v[d + 1] = l;                      // rotr 32
  addMul(v, c, d);
  l = v[b] ^ v[c]; h = v[b + 1] ^ v[c + 1]; v[b] = ((l >>> 24) | (h << 8)) >>> 0; v[b + 1] = ((h >>> 24) | (l << 8)) >>> 0; // rotr 24
  addMul(v, a, b);
  l = v[d] ^ v[a]; h = v[d + 1] ^ v[a + 1]; v[d] = ((l >>> 16) | (h << 16)) >>> 0; v[d + 1] = ((h >>> 16) | (l << 16)) >>> 0; // rotr 16
  addMul(v, c, d);
  l = v[b] ^ v[c]; h = v[b + 1] ^ v[c + 1]; v[b] = ((l << 1) | (h >>> 31)) >>> 0; v[b + 1] = ((h << 1) | (l >>> 31)) >>> 0;     // rotr 63
}
function round16(v, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) { // 인자는 워드 번호
  G(v, i0 * 2, i4 * 2, i8 * 2, i12 * 2); G(v, i1 * 2, i5 * 2, i9 * 2, i13 * 2); G(v, i2 * 2, i6 * 2, i10 * 2, i14 * 2); G(v, i3 * 2, i7 * 2, i11 * 2, i15 * 2);
  G(v, i0 * 2, i5 * 2, i10 * 2, i15 * 2); G(v, i1 * 2, i6 * 2, i11 * 2, i12 * 2); G(v, i2 * 2, i7 * 2, i8 * 2, i13 * 2); G(v, i3 * 2, i4 * 2, i9 * 2, i14 * 2);
}
const R = new Uint32Array(256), T = new Uint32Array(256);
// out = P(X xor Y) xor (X xor Y) [xor out]
function gBlock(X, xo, Y, yo, out, oo, withXor) {
  for (let k = 0; k < 256; k++) { const r = X[xo + k] ^ Y[yo + k]; R[k] = r; T[k] = withXor ? r ^ out[oo + k] : r; }
  for (let i = 0; i < 8; i++) { const b = 16 * i; round16(R, b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8, b + 9, b + 10, b + 11, b + 12, b + 13, b + 14, b + 15); }
  for (let i = 0; i < 8; i++) { const c = 2 * i; round16(R, c, c + 1, c + 16, c + 17, c + 32, c + 33, c + 48, c + 49, c + 64, c + 65, c + 80, c + 81, c + 96, c + 97, c + 112, c + 113); }
  for (let k = 0; k < 256; k++) out[oo + k] = (R[k] ^ T[k]) >>> 0;
}

export function argon2id({ password, salt, secret = new Uint8Array(0), ad = new Uint8Array(0), t, m, p = 1, dkLen = 32 }) {
  if (!(t >= 1 && p >= 1 && m >= 8 * p && dkLen >= 4)) throw new Error('잘못된 Argon2 매개변수');
  const mPrime = 4 * p * Math.floor(m / (4 * p)), q = mPrime / p, seg = q / 4;
  const H0 = blake2b(concat(le32(p), le32(dkLen), le32(m), le32(t), le32(0x13), le32(2),
    le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad), 64);
  const mem = new Uint32Array(mPrime * 256);
  for (let lane = 0; lane < p; lane++) for (let i = 0; i < 2; i++) {
    const b = hPrime(concat(H0, le32(i), le32(lane)), 1024), off = (lane * q + i) * 256;
    for (let k = 0; k < 256; k++) mem[off + k] = (b[4 * k] | (b[4 * k + 1] << 8) | (b[4 * k + 2] << 16) | (b[4 * k + 3] << 24)) >>> 0;
  }
  const zero = new Uint32Array(256), input = new Uint32Array(256), addr = new Uint32Array(256);
  const nextAddr = () => { input[12]++; gBlock(zero, 0, input, 0, addr, 0, false); gBlock(zero, 0, addr, 0, addr, 0, false); };
  for (let pass = 0; pass < t; pass++) for (let slice = 0; slice < 4; slice++) for (let lane = 0; lane < p; lane++) {
    const indep = pass === 0 && slice < 2; // Argon2id: 처음 두 조각은 데이터 독립 주소
    let start = 0;
    if (indep) { input.fill(0); input[0] = pass; input[2] = lane; input[4] = slice; input[6] = mPrime; input[8] = t; input[10] = 2; }
    if (pass === 0 && slice === 0) { start = 2; if (indep) nextAddr(); }
    for (let i = start; i < seg; i++) {
      const col = slice * seg + i, cur = (lane * q + col) * 256, prev = (lane * q + (col === 0 ? q - 1 : col - 1)) * 256;
      let J1, J2;
      if (indep) { if (i % 128 === 0) nextAddr(); J1 = addr[2 * (i % 128)]; J2 = addr[2 * (i % 128) + 1]; }
      else { J1 = mem[prev]; J2 = mem[prev + 1]; }
      const refLane = pass === 0 && slice === 0 ? lane : J2 % p, same = refLane === lane;
      let size;
      if (pass === 0) size = slice === 0 ? i - 1 : same ? slice * seg + i - 1 : slice * seg + (i === 0 ? -1 : 0);
      else size = same ? q - seg + i - 1 : q - seg + (i === 0 ? -1 : 0);
      const x = (BigInt(J1) * BigInt(J1)) >> 32n, y = (BigInt(size) * x) >> 32n;
      const rel = size - 1 - Number(y);
      const startPos = pass === 0 ? 0 : slice === 3 ? 0 : (slice + 1) * seg;
      const refCol = (startPos + rel) % q;
      gBlock(mem, prev, mem, (refLane * q + refCol) * 256, mem, cur, pass !== 0);
    }
  }
  const fin = new Uint32Array(256);
  for (let lane = 0; lane < p; lane++) { const off = (lane * q + q - 1) * 256; for (let k = 0; k < 256; k++) fin[k] ^= mem[off + k]; }
  const bytes = new Uint8Array(1024);
  for (let k = 0; k < 256; k++) { bytes[4 * k] = fin[k] & 255; bytes[4 * k + 1] = (fin[k] >>> 8) & 255; bytes[4 * k + 2] = (fin[k] >>> 16) & 255; bytes[4 * k + 3] = fin[k] >>> 24; }
  return hPrime(bytes, dkLen);
}
