// QR 코드 이미지 디코더 (외부 라이브러리 없음). 모델 2, 버전 1~40, 숫자/영문/바이트/ECI 모드, 리드솔로몬 오류 정정.
// 입력: { data: RGBA 배열, width, height }  →  출력: 문자열 또는 null

// 오류정정 블록 표 (인덱스 0=L, 1=M, 2=Q, 3=H / 버전 1~40)
export const ECC_PER_BLOCK = [
  [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]];
export const NUM_BLOCKS = [
  [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]];
const FMT_BITS = [1, 0, 3, 2]; // L, M, Q, H 의 2비트 값

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0);

export const rawModules = (v) => {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
  return r;
};
export const dataCodewords = (v, l) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[l][v] * NUM_BLOCKS[l][v];
export function alignPositions(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2, size = v * 4 + 17;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const res = [6];
  for (let p = size - 7; res.length < n; p -= step) res.splice(1, 0, p);
  return res;
}
export function formatBits(eclBits, mask) {
  const data = (eclBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
const popcount = (n) => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };

function functionMap(v) {
  const size = v * 4 + 17, f = new Uint8Array(size * size);
  const box = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f[y * size + x] = 1; };
  box(0, 0, 8, 8); box(size - 8, 0, size - 1, 8); box(0, size - 8, 8, size - 1);
  box(6, 0, 6, size - 1); box(0, 6, size - 1, 6);
  const ap = alignPositions(v), last = ap.length - 1;
  ap.forEach((cy, i) => ap.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    box(cx - 2, cy - 2, cx + 2, cy + 2);
  }));
  if (v >= 7) { box(size - 11, 0, size - 9, 5); box(0, size - 11, 5, size - 9); }
  return f;
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0];

// 리드솔로몬 정정. block = 데이터+ECC 코드워드. 실패하면 null.
export function rsCorrect(block, nEcc) {
  const n = block.length, r = block.slice(), S = [];
  let bad = false;
  for (let i = 0; i < nEcc; i++) { let s = 0; for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ r[j]; S.push(s); if (s) bad = true; }
  if (!bad) return r;
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let k = 0; k < nEcc; k++) {
    let d = S[k];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, S[k - i]);
    if (d === 0) { m++; continue; }
    const coef = div(d, b), T = C.slice();
    for (let i = 0; i < B.length; i++) C[i + m] = (C[i + m] || 0) ^ mul(coef, B[i]);
    if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  if (L > nEcc / 2) return null;
  const pos = [];
  for (let k = 0; k < n; k++) {
    const xinv = EXP[(255 - ((n - 1 - k) % 255)) % 255];
    let v = 0, p = 1;
    for (let i = 0; i < C.length; i++) { v ^= mul(C[i], p); p = mul(p, xinv); }
    if (v === 0) pos.push(k);
  }
  if (pos.length !== L) return null;
  const omega = new Array(nEcc).fill(0);
  for (let i = 0; i < nEcc; i++) for (let j = 0; j < C.length && i + j < nEcc; j++) omega[i + j] ^= mul(S[i], C[j]);
  for (const k of pos) {
    const xinv = EXP[(255 - ((n - 1 - k) % 255)) % 255], x = EXP[(n - 1 - k) % 255];
    let num = 0, p = 1;
    for (let i = 0; i < nEcc; i++) { num ^= mul(omega[i], p); p = mul(p, xinv); }
    let den = 0; p = 1;
    for (let i = 1; i < C.length; i += 2) { den ^= mul(C[i], p); p = mul(p, mul(xinv, xinv)); }
    if (!den) return null;
    r[k] ^= mul(x, div(num, den));
  }
  for (let i = 0; i < nEcc; i++) { let s = 0; for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ r[j]; if (s) return null; }
  return r;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function parseData(bytes, ver) {
  const total = bytes.length * 8; let pos = 0;
  const read = (n) => { if (pos + n > total) return -1; let v = 0; for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
  const cc = (a, b, c) => (ver <= 9 ? a : ver <= 26 ? b : c);
  let text = '', buf = [];
  const flush = () => {
    if (!buf.length) return;
    const u = Uint8Array.from(buf);
    try { text += new TextDecoder('utf-8', { fatal: true }).decode(u); } catch { text += new TextDecoder('latin1').decode(u); }
    buf = [];
  };
  for (;;) {
    const mode = read(4);
    if (mode <= 0) break;
    if (mode === 4) { const n = read(cc(8, 16, 16)); if (n < 0) return null; for (let i = 0; i < n; i++) { const c = read(8); if (c < 0) return null; buf.push(c); } }
    else if (mode === 1) { flush(); let n = read(cc(10, 12, 14)); if (n < 0) return null;
      while (n > 0) { const k = Math.min(3, n), v = read(k === 3 ? 10 : k === 2 ? 7 : 4); if (v < 0) return null; text += String(v).padStart(k, '0'); n -= k; } }
    else if (mode === 2) { flush(); let n = read(cc(9, 11, 13)); if (n < 0) return null;
      while (n > 0) { if (n >= 2) { const v = read(11); if (v < 0) return null; text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; n -= 2; } else { const v = read(6); if (v < 0) return null; text += ALNUM[v]; n--; } } }
    else if (mode === 7) { const f = read(8); if (f < 0) return null; if ((f & 0xC0) === 0x80) read(8); else if ((f & 0xE0) === 0xC0) read(16); }
    else return null;
  }
  flush();
  return text;
}

// get(x, y) -> 0|1 (1 = 어두운 모듈). 성공하면 문자열.
export function decodeMatrix(get, size) {
  const ver = (size - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > 40) return null;
  const rd = (pts) => { let b = 0; pts.forEach(([x, y], i) => { b |= get(x, y) << i; }); return b; };
  const p1 = [], p2 = [];
  for (let i = 0; i < 6; i++) p1.push([8, i]);
  p1.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) p1.push([14 - i, 8]);
  for (let i = 0; i < 8; i++) p2.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) p2.push([8, size - 15 + i]);
  const reads = [rd(p1), rd(p2)];
  let best = null, bestD = 4;
  for (let d = 0; d < 32; d++) {
    const code = formatBits(d >> 3, d & 7);
    for (const rv of reads) { const dist = popcount(rv ^ code); if (dist < bestD) { bestD = dist; best = d; } }
  }
  if (best === null) return null;
  const lvl = FMT_BITS.indexOf(best >> 3), mask = MASKS[best & 7];
  const fn = functionMap(ver), bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y * size + x]) bits.push(get(x, y) ^ (mask(x, y) ? 1 : 0));
    }
  }
  const raw = Math.floor(rawModules(ver) / 8), cw = [];
  for (let i = 0; i < raw; i++) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i * 8 + k] || 0); cw.push(b); }
  const nb = NUM_BLOCKS[lvl][ver], ecc = ECC_PER_BLOCK[lvl][ver];
  const shortLen = Math.floor(raw / nb), nShort = nb - (raw % nb);
  const dlen = Array.from({ length: nb }, (_, i) => shortLen - ecc + (i < nShort ? 0 : 1));
  const blocks = dlen.map(() => []);
  let k = 0;
  for (let i = 0; i <= shortLen - ecc; i++) for (let j = 0; j < nb; j++) if (i < dlen[j]) blocks[j].push(cw[k++]);
  for (let i = 0; i < ecc; i++) for (let j = 0; j < nb; j++) blocks[j].push(cw[k++]);
  const data = [];
  for (const blk of blocks) { const fixed = rsCorrect(blk, ecc); if (!fixed) return null; data.push(...fixed.slice(0, blk.length - ecc)); }
  return parseData(data, ver);
}

// ---------- 이미지에서 QR 위치 찾기 ----------
function otsu(g) {
  const h = new Array(256).fill(0); for (const v of g) h[v]++;
  const total = g.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let wb = 0, sb = 0, best = -1, first = 128, last = 128;
  for (let t = 0; t < 256; t++) {
    wb += h[t]; sb += t * h[t];
    const wf = total - wb; if (!wb || !wf) continue;
    const v = wb * wf * (sb / wb - (sum - sb) / wf) ** 2;
    if (v > best) { best = v; first = last = t; } else if (v === best) last = t; // 동점 구간의 가운데를 쓴다
  }
  return (first + last) >> 1;
}
const okRatio = (l, loose) => {
  const t = l[0] + l[1] + l[2] + l[3] + l[4]; if (t < 7) return 0; const u = t / 7, e = loose ? 0.8 : 0.7;
  return Math.abs(l[0] - u) < u * e && Math.abs(l[1] - u) < u * e && Math.abs(l[2] - 3 * u) < u * 1.4 && Math.abs(l[3] - u) < u * e && Math.abs(l[4] - u) < u * e ? u : 0;
};
function crossV(bin, w, h, x, y) {
  const c = (yy) => bin[yy * w + x];
  let yy = y, a1 = 0, a2 = 0, a3 = 0, d1 = 0, d2 = 0, d3 = 0;
  while (yy >= 0 && c(yy) === 1) { a1++; yy--; } if (yy < 0) return null;
  while (yy >= 0 && c(yy) === 0) { a2++; yy--; } if (yy < 0) return null;
  while (yy >= 0 && c(yy) === 1) { a3++; yy--; }
  const top = yy + 1; yy = y + 1;
  while (yy < h && c(yy) === 1) { d1++; yy++; } if (yy >= h) return null;
  while (yy < h && c(yy) === 0) { d2++; yy++; } if (yy >= h) return null;
  while (yy < h && c(yy) === 1) { d3++; yy++; }
  const l = [a3, a2, a1 + d1, d2, d3], u = okRatio(l, true);
  return u ? { cy: top + (l[0] + l[1] + l[2] + l[3] + l[4]) / 2, size: u } : null;
}
function findFinders(bin, w, h) {
  const found = [];
  for (let y = 0; y < h; y++) {
    const runs = []; let x = 0;
    while (x < w) { const c = bin[y * w + x], s = x; while (x < w && bin[y * w + x] === c) x++; runs.push([c, s, x - s]); }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (runs[i][0] !== 1) continue;
      const l = [0, 1, 2, 3, 4].map((k) => runs[i + k][2]), u = okRatio(l, false);
      if (!u) continue;
      const cx = runs[i][1] + (l[0] + l[1] + l[2] + l[3] + l[4]) / 2, v = crossV(bin, w, h, Math.floor(cx), y);
      if (!v) continue;
      const f = found.find((o) => Math.abs(o.x - cx) < u * 2 && Math.abs(o.y - v.cy) < u * 2);
      if (f) { f.x = (f.x * f.n + cx) / (f.n + 1); f.y = (f.y * f.n + v.cy) / (f.n + 1); f.s = (f.s * f.n + u) / (f.n + 1); f.n++; }
      else found.push({ x: cx, y: v.cy, s: u, n: 1 });
    }
  }
  return found.filter((f) => f.n >= 2).sort((a, b) => b.n - a.n).slice(0, 9);
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function triples(f) {
  const out = [];
  for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) for (let k = j + 1; k < f.length; k++) {
    const P = [f[i], f[j], f[k]], d = [dist(P[1], P[2]), dist(P[0], P[2]), dist(P[0], P[1])];
    const o = [0, 1, 2].sort((a, b) => d[a] - d[b]), s1 = d[o[0]], s2 = d[o[1]], lg = d[o[2]];
    const ms = Math.max(...P.map((p) => p.s)) / Math.min(...P.map((p) => p.s));
    const dev = Math.abs(s1 - s2) / Math.max(s1, s2) + Math.abs(lg / ((s1 + s2) / 2) - Math.SQRT2) / Math.SQRT2;
    if (dev < 0.35 && ms < 1.5) out.push({ dev, tl: P[o[2]], a: P[o[0]], b: P[o[1]] });
  }
  return out.sort((x, y) => x.dev - y.dev).slice(0, 3);
}
function sample(bin, w, h, t) {
  let { tl, a, b } = t;
  if ((a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x) < 0) [a, b] = [b, a]; // a=오른쪽 위, b=왼쪽 아래
  const m = (tl.s + a.s + b.s) / 3, d = (dist(tl, a) + dist(tl, b)) / 2;
  const size = Math.round((d / m + 7 - 17) / 4) * 4 + 17;
  if (size < 21 || size > 177) return null;
  const ex = { x: (a.x - tl.x) / (size - 7), y: (a.y - tl.y) / (size - 7) }, ey = { x: (b.x - tl.x) / (size - 7), y: (b.y - tl.y) / (size - 7) };
  const px = (u, v) => { const x = Math.round(tl.x + (u - 3.5) * ex.x + (v - 3.5) * ey.x), y = Math.round(tl.y + (u - 3.5) * ex.y + (v - 3.5) * ey.y);
    return x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]; };
  const get = (x, y) => { const c = px(x + 0.5, y + 0.5), n = px(x + 0.3, y + 0.5) + px(x + 0.7, y + 0.5) + px(x + 0.5, y + 0.3) + px(x + 0.5, y + 0.7); return c + n >= 3 ? 1 : 0; };
  return decodeMatrix(get, size);
}
export function decodeQR({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) { const al = data[4 * i + 3] / 255; gray[i] = Math.round((0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]) * al + 255 * (1 - al)); }
  const thr = otsu(gray);
  for (const invert of [false, true]) {
    const bin = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) bin[i] = (gray[i] <= thr) !== invert ? 1 : 0;
    for (const t of triples(findFinders(bin, width, height))) { const r = sample(bin, width, height, t); if (r) return r; }
  }
  return null;
}
