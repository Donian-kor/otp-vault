// 자가 진단: 지금 쓰고 있는 브라우저에서 핵심 기능이 실제로 동작하는지 확인한다. 비밀번호·계정 데이터는 건드리지 않는다.
import { argon2id } from './argon2.js';
import { hotp, totp } from './totp.js';
import { decodeQR } from './qr.js';
import { scanQr } from '../qrscan.js';
import { LOGO } from '../logo.js';

const enc = new TextEncoder();
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const QR_TEXT = 'otpauth://totp/Diag:test?secret=JBSWY3DPEHPK3PXP&issuer=Diag';
const QR_SIZE = 33;
const QR_BITS = '/uujP8EADlBumztrt1l1tdupYjrsFeSBB/qqqv4BZOwAi5DVfOKqwIPZgln3Rghe0hJz5DpXjGwxkMucJJxRe+pzQopS7mT7xqny6EPHWDbr8SAnJyOEzgwTGHwVtaxSW47g0hNv/gBY4MU/uNuqEEFc0QurYc/N0l8r8ujWmqkEhvqQ/tzftoA='; // 내장 시험용 QR(버전 4) 모듈 행렬, 1비트씩 base64

function matrix() {
  const bin = atob(QR_BITS), m = [];
  for (let y = 0; y < QR_SIZE; y++) { m.push([]); for (let x = 0; x < QR_SIZE; x++) { const i = y * QR_SIZE + x; m[y].push((bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1); } }
  return m;
}
function rgba(scale = 4, border = 4) {
  const m = matrix(), n = (QR_SIZE + 2 * border) * scale, d = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < QR_SIZE; y++) for (let x = 0; x < QR_SIZE; x++) if (m[y][x])
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const p = (((y + border) * scale + dy) * n + (x + border) * scale + dx) * 4; d[p] = d[p + 1] = d[p + 2] = 0; }
  return { data: d, width: n, height: n };
}

export async function runDiagnostics({ storage, sessionStore, manifest }) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok, detail });
  const run = async (name, fn) => { try { const r = await fn(); add(name, r && 'ok' in r ? r.ok : true, r && r.detail ? r.detail : ''); } catch (e) { add(name, false, String((e && e.message) || e)); } };

  await run('환경', () => ({ detail: `${navigator.userAgent} / 확장 v${manifest ? manifest().version : '?'}` }));
  await run('WebCrypto AES-256-GCM 암·복호화', async () => {
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('a') }, k, enc.encode('hello'));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('a') }, k, ct);
    return { ok: new TextDecoder().decode(pt) === 'hello' };
  });
  await run('TOTP 공식 벡터 (RFC 6238: SHA1·SHA256·SHA512)', async () => {
    const seeds = { SHA1: '12345678901234567890', SHA256: '12345678901234567890123456789012', SHA512: '1234567890123456789012345678901234567890123456789012345678901234' };
    const want = { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' };
    for (const a of Object.keys(seeds)) if ((await totp(enc.encode(seeds[a]), 59, { algorithm: a, digits: 8 })) !== want[a]) return { ok: false, detail: a + ' 불일치' };
    return { ok: true };
  });
  await run('HOTP 공식 벡터 (RFC 4226)', async () => {
    const got = []; for (let c = 0; c < 3; c++) got.push(await hotp(enc.encode('12345678901234567890'), c));
    return { ok: got.join() === '755224,287082,359152', detail: got.join(',') };
  });
  await run('Argon2id 공식 벡터 (RFC 9106) — 이 브라우저의 계산 결과가 표준과 같은지', async () => {
    const tag = hex(argon2id({ password: new Uint8Array(32).fill(1), salt: new Uint8Array(16).fill(2), secret: new Uint8Array(8).fill(3), ad: new Uint8Array(12).fill(4), t: 3, m: 32, p: 4, dkLen: 32 }));
    const good = tag === '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659';
    return { ok: good, detail: good ? '' : '계산 결과가 다름: ' + tag };
  });
  await run('Argon2id 실제 설정(19 MiB·2회) 소요 시간', async () => {
    const t0 = performance.now(); argon2id({ password: enc.encode('diag'), salt: new Uint8Array(16), t: 2, m: 19456, p: 1, dkLen: 32 });
    const ms = Math.round(performance.now() - t0);
    return { ok: ms < 10000, detail: `${ms} ms (잠금 해제 때마다 이만큼 걸립니다)` };
  });
  await run('저장소(storage.local) 쓰기·읽기·삭제', async () => {
    const v = 'v' + Date.now(); await storage.set('__diag', v); const r = await storage.get('__diag'); await storage.remove('__diag');
    return { ok: r === v && (await storage.get('__diag')) === undefined };
  });
  await run('메모리 전용 저장소(storage.session) — "잠금 해제 유지"에 필요', async () => {
    if (!sessionStore.available) return { ok: null, detail: '지원하지 않음 → 잠금 해제 유지를 쓸 수 없습니다' };
    const v = 'v' + Date.now(); await sessionStore.set('__diag', v); const r = await sessionStore.get('__diag'); await sessionStore.remove('__diag');
    return { ok: r === v };
  });
  await run('클립보드 복사 API', () => ({ ok: !!(navigator.clipboard && navigator.clipboard.writeText), detail: navigator.clipboard ? '' : '없음' }));
  await run('아이콘·로고 이미지 로드 (툴바 아이콘 파일 / 화면 제목 로고)', async () => {
    if (typeof Image === 'undefined') return { ok: null, detail: '이미지 객체 없음(건너뜀)' };
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = src; });
    const file = await load('icons/icon32.png'), logo = await load(LOGO);
    return { ok: file > 0 && logo > 0, detail: `icons/icon32.png=${file ? file + 'px 로드됨' : '로드 실패'}, 내장 로고=${logo ? logo + 'px 로드됨' : '로드 실패'}` };
  });
  await run('화면 드래그 QR에 필요한 API (scripting · tabs.captureVisibleTab) 와 권한', () => {
    const api = globalThis.browser ?? globalThis.chrome;
    const hasApi = !!(api && api.scripting && api.scripting.executeScript && api.tabs && api.tabs.captureVisibleTab);
    const perms = (manifest && manifest().permissions) || [];
    const hasPerm = perms.includes('activeTab') && perms.includes('scripting');
    return { ok: hasApi && hasPerm, detail: `API ${hasApi ? '있음' : '없음'}, 권한(activeTab·scripting) ${hasPerm ? '있음' : '없음'}` };
  });
  await run('Blob 다운로드 주소(백업 내보내기용)', () => { const u = URL.createObjectURL(new Blob(['x'])); URL.revokeObjectURL(u); return { ok: u.startsWith('blob:') }; });
  await run('내장 QR 판독기 (브라우저 BarcodeDetector)', async () => {
    if (typeof BarcodeDetector === 'undefined') return { ok: null, detail: '없음 → 자체 디코더를 사용합니다 (정상)' };
    const f = await BarcodeDetector.getSupportedFormats(); return { ok: null, detail: f.includes('qr_code') ? 'QR 지원' : 'QR 미지원 → 자체 디코더 사용' };
  });
  await run('자체 QR 디코더 (내장 시험용 QR)', () => { const t = decodeQR(rgba(4)); return { ok: t === QR_TEXT, detail: t === QR_TEXT ? '' : String(t) }; });
  await run('QR 이미지 파일 경로 전체 (캔버스 → PNG → 이미지 열기 → 판독)', async () => {
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext) return { ok: null, detail: '캔버스 없음(건너뜀)' };
    const img = rgba(4), cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('PNG 변환 실패'))), 'image/png'));
    const text = await scanQr(blob);
    return { ok: text === QR_TEXT, detail: text === QR_TEXT ? '' : text };
  });
  return out;
}

export const summarize = (items) => ({ pass: items.filter((i) => i.ok === true).length, fail: items.filter((i) => i.ok === false).length, info: items.filter((i) => i.ok === null || i.ok === undefined).length });
export const formatReport = (items) => { const s = summarize(items); return `전체 결과: 통과 ${s.pass} · 실패 ${s.fail} · 참고 ${s.info}\n` + items.map((i) => `[${i.ok === true ? '통과' : i.ok === false ? '실패' : '참고'}] ${i.name}${i.detail ? ' — ' + i.detail : ''}`).join('\n'); };
