// 화면 드래그 QR: 좌표 계산, 처리 흐름(가짜 브라우저 API), 웹페이지에 올라가는 드래그 화면(내용 스크립트)을 시험한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRegionHandler, mapRect, padFor, validRegion, dataUrlBytes, MSG, PENDING_KEY, SCALES } from '../extension/core/screenqr.js';
import { decodeQR } from '../extension/core/qr.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (o) => JSON.parse(JSON.stringify(o)); // 격리 실행 환경(vm)에서 만든 객체를 값만 비교하기 위해

// ---- 시험 이미지 ----
const dir = new URL('./qr/', import.meta.url);
const cases = JSON.parse(fs.readFileSync(new URL('cases.json', dir), 'utf-8'));
const load = (i) => { const b = fs.readFileSync(new URL(cases[i].file, dir)); return { width: b.readUInt32LE(0), height: b.readUInt32LE(4), data: new Uint8ClampedArray(b.subarray(8)) }; };
const find = (desc) => cases.findIndex((c) => c.desc === desc);
const otpCase = 0, numericCase = find('numeric'), blankCase = find('빈 이미지');

// 스크린샷 흉내: 회색 바탕에 QR 이미지를 (px,py)에 붙이고 k배 확대(최근접)
function screenshot(qr, W, H, px, py, k = 1) {
  const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { d[4 * i] = 235; d[4 * i + 1] = 237; d[4 * i + 2] = 240; d[4 * i + 3] = 255; }
  for (let y = 0; y < qr.height * k; y++) for (let x = 0; x < qr.width * k; x++) {
    const sx = Math.floor(x / k), sy = Math.floor(y / k), X = px * k + x, Y = py * k + y; if (X >= W || Y >= H) continue;
    for (let c = 0; c < 4; c++) d[4 * (Y * W + X) + c] = qr.data[4 * (sy * qr.width + sx) + c];
  }
  return { data: d, width: W, height: H };
}
// 배경 스크립트의 자르기를 순수 JS로 흉내 (같은 mapRect·padFor 사용)
function pureCrop(shot, rect, vw, vh, scale) {
  const s = mapRect(rect, vw, vh, shot.width, shot.height), pad = padFor(s.w, s.h);
  const W = Math.round((s.w + 2 * pad) * scale), H = Math.round((s.h + 2 * pad) * scale), d = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < Math.round(s.h * scale); y++) for (let x = 0; x < Math.round(s.w * scale); x++) {
    const sx = s.x + Math.min(s.w - 1, Math.floor(x / scale)), sy = s.y + Math.min(s.h - 1, Math.floor(y / scale));
    const o = 4 * ((Math.round(pad * scale) + y) * W + Math.round(pad * scale) + x);
    for (let c = 0; c < 4; c++) d[o + c] = shot.data[4 * (sy * shot.width + sx) + c];
  }
  return { data: d, width: W, height: H };
}

console.log('좌표 계산');
await t('mapRect: 배율 1 / 모니터 배율 2 / 브라우저 확대 1.5 / 경계 보정', () => {
  assert.deepEqual(mapRect({ x: 100, y: 50, w: 200, h: 100 }, 800, 600, 800, 600), { x: 100, y: 50, w: 200, h: 100 });
  assert.deepEqual(mapRect({ x: 100, y: 50, w: 200, h: 100 }, 800, 600, 1600, 1200), { x: 200, y: 100, w: 400, h: 200 });
  assert.deepEqual(mapRect({ x: 100, y: 60, w: 200, h: 100 }, 1280, 720, 1920, 1080), { x: 150, y: 90, w: 300, h: 150 });
  const edge = mapRect({ x: 790, y: 590, w: 100, h: 100 }, 800, 600, 800, 600); assert.ok(edge.x + edge.w <= 800 && edge.y + edge.h <= 600 && edge.w >= 1);
});
await t('validRegion: 정상 / 비정상 입력 거부', () => {
  const ok = { type: MSG, rect: { x: 10, y: 10, w: 100, h: 100 }, vw: 800, vh: 600 };
  assert.ok(validRegion(ok));
  for (const bad of [null, {}, { ...ok, type: 'x' }, { ...ok, rect: { ...ok.rect, w: NaN } }, { ...ok, rect: { ...ok.rect, x: -5 } }, { ...ok, rect: { ...ok.rect, w: 2 } },
    { ...ok, rect: { ...ok.rect, w: 99999 } }, { ...ok, vw: 0 }, { ...ok, rect: { x: '1', y: 1, w: 50, h: 50 } }, { ...ok, rect: undefined }]) assert.ok(!validRegion(bad), JSON.stringify(bad));
});
await t('dataUrlBytes: PNG 주소를 바이트로 변환(fetch 없이), 잘못된 주소 거부', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
  const r = dataUrlBytes('data:image/png;base64,' + Buffer.from(png).toString('base64'));
  assert.equal(r.type, 'image/png'); assert.deepEqual([...r.bytes], [...png]);
  assert.throws(() => dataUrlBytes('https://example.com/a.png')); assert.throws(() => dataUrlBytes('data:image/png,abc'));
  const big = new Uint8Array(3_000_000).map((_, i) => i % 251); assert.equal(dataUrlBytes('data:image/png;base64,' + Buffer.from(big).toString('base64')).bytes.length, big.length);
});
await t('padFor: 최소 8, 크기에 비례', () => { assert.equal(padFor(20, 20), 8); assert.equal(padFor(300, 400), 36); });

console.log('처리 흐름 (가짜 브라우저 API)');
function env({ crop, session = true, capture = async () => 'data:fake', id = 'ext' } = {}) {
  const sess = {}, calls = { opened: 0, crops: [] };
  const api = { runtime: { id, openOptionsPage: async () => { calls.opened++; } }, tabs: { captureVisibleTab: capture }, storage: session ? { session: { set: async (o) => Object.assign(sess, o) } } : {} };
  const handle = createRegionHandler({ api, crop: crop || (async (u, r, vw, vh, s) => { calls.crops.push(s); return load(otpCase); }), decode: decodeQR });
  return { handle, sess, calls };
}
const sender = { id: 'ext', tab: { id: 7, windowId: 1 } };
const msg = { type: MSG, rect: { x: 10, y: 10, w: 100, h: 100 }, vw: 800, vh: 600 };
await t('성공: 해독 → 메모리 임시 저장 → 관리 페이지 열기', async () => {
  const { handle, sess, calls } = env(); const r = await handle(msg, sender);
  assert.deepEqual(r, { ok: true }); assert.equal(sess[PENDING_KEY].text, cases[otpCase].text); assert.ok(Date.now() - sess[PENDING_KEY].at < 2000); assert.equal(calls.opened, 1);
});
await t('첫 배율에서 실패해도 확대·축소로 다시 시도', async () => {
  const { handle, calls } = env({ crop: async (u, r, vw, vh, s) => { calls_.push(s); return s === 2 ? load(otpCase) : null; } }); const calls_ = [];
  const r = await handle(msg, sender); assert.equal(r.ok, true); assert.deepEqual(calls_, [1, 2]);
});
await t('QR이 없으면 모든 배율을 시도한 뒤 안내하고 아무것도 저장·열지 않음', async () => {
  const seen = []; const { handle, sess, calls } = env({ crop: async (u, r, vw, vh, s) => { seen.push(s); return load(blankCase); } });
  const r = await handle(msg, sender); assert.equal(r.ok, false); assert.match(r.error, /QR 코드를 찾지 못했습니다/); assert.deepEqual(seen, SCALES); assert.deepEqual(sess, {}); assert.equal(calls.opened, 0);
});
await t('OTP용이 아닌 QR(숫자 등)은 거부하고 내용은 저장하지 않음', async () => {
  const { handle, sess, calls } = env({ crop: async () => load(numericCase) }); const r = await handle(msg, sender);
  assert.equal(r.ok, false); assert.match(r.error, /OTP 등록용 QR이 아닙니다/); assert.deepEqual(sess, {}); assert.equal(calls.opened, 0);
});
await t('거부: 다른 확장/탭 없음/잘못된 영역/임시 저장소 없음/캡처 실패', async () => {
  assert.match((await env().handle(msg, { id: 'other', tab: { id: 1 } })).error, /허용되지 않은/);
  assert.match((await env().handle(msg, { id: 'ext' })).error, /허용되지 않은/);
  assert.match((await env().handle({ ...msg, rect: { x: 0, y: 0, w: 1, h: 1 } }, sender)).error, /영역 정보/);
  assert.match((await env({ session: false }).handle(msg, sender)).error, /임시 저장소/);
  const cap = env({ capture: async () => { throw new Error('no activeTab'); } }); const r = await cap.handle(msg, sender);
  assert.equal(r.ok, false); assert.match(r.error, /캡처하지 못했습니다/); assert.equal(cap.calls.opened, 0);
});
await t('실제 좌표 경로: 모니터 배율 1·2, 브라우저 확대 1.25, QR에 딱 붙은 선택까지 해독', async () => {
  const qr = load(find('배율 8')), n = qr.width;                    // QR 이미지(여백 포함)
  const dark = (() => { let x0 = n, y0 = qr.height, x1 = 0, y1 = 0; for (let y = 0; y < qr.height; y++) for (let x = 0; x < n; x++) if (qr.data[4 * (y * n + x)] < 100) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; })();
  const run = async (dpr, vw, vh, sel) => {
    const shot = screenshot(qr, Math.round(vw * dpr), Math.round(vh * dpr), 0, 0, 1);   // 먼저 배율 1로 붙이고
    const big = dpr === 1 ? shot : screenshot(qr, Math.round(vw * dpr), Math.round(vh * dpr), 0, 0, dpr);  // 배율이 있으면 QR도 dpr배로 보이는 화면
    const { handle } = env({ crop: async (u, r, a, b, s) => pureCrop(big, r, vw, vh, s) });
    return handle({ type: MSG, rect: sel, vw, vh }, sender);
  };
  // 1) 배율 1, 여백 포함 영역
  assert.equal((await run(1, 800, 600, { x: 0, y: 0, w: n, h: qr.height })).ok, true);
  // 2) 모니터 배율 2 (CSS 크기는 절반)
  assert.equal((await run(2, 800, 600, { x: 0, y: 0, w: n, h: qr.height })).ok, true);
  // 3) QR 검은 모듈 영역에만 딱 붙게 선택 (여백 없음)
  assert.equal((await run(1, 800, 600, dark)).ok, true, '딱 붙은 선택');
  // 4) 브라우저 확대 1.25 (CSS 폭이 줄고 실제 픽셀은 그대로)
  const shot = screenshot(qr, 800, 600, 0, 0, 1), k = 1.25, vw = 800 / k, vh = 600 / k;
  const { handle } = env({ crop: async (u, r, a, b, s) => pureCrop(shot, r, vw, vh, s) });
  assert.equal((await handle({ type: MSG, rect: { x: 0, y: 0, w: n / k, h: qr.height / k }, vw, vh }, sender)).ok, true);
});

console.log('드래그 선택 화면 (웹페이지에 올라가는 내용 스크립트)');
class FE {
  constructor(tag, doc) { this.tag = tag; this.style = {}; this.children = []; this.l = {}; this.doc = doc; this._text = ''; }
  append(...k) { this.children.push(...k); } attachShadow() { this.shadow = new FE('shadow', this.doc); return this.shadow; }
  addEventListener(tp, f) { (this.l[tp] ||= []).push(f); } remove() { for (const p of [this.doc.documentElement, ...this.doc.all]) p.children = p.children.filter((c) => c !== this); this.doc.removed++; }
  set textContent(v) { this._text = v; } get textContent() { return this._text; }
}
function page({ send = async () => ({ ok: true }) } = {}) {
  const doc = { all: [], removed: 0 }; doc.documentElement = new FE('html', doc); doc.createElement = (tag) => new FE(tag, doc);
  const sent = [], keys = [], win = {};
  Object.assign(win, { document: doc, innerWidth: 1000, innerHeight: 700, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0),
    addEventListener: (tp, f) => { if (tp === 'keydown') keys.push(f); }, removeEventListener: (tp, f) => { const i = keys.indexOf(f); if (i >= 0) keys.splice(i, 1); },
    chrome: { runtime: { sendMessage: async (m) => { sent.push({ m, overlays: doc.documentElement.children.length }); return send(m); } } } });
  const ctx = vm.createContext(win); win.globalThis = win;
  const code = fs.readFileSync(new URL('../extension/content/qr-select.js', import.meta.url), 'utf-8');
  const run = () => vm.runInContext(code, ctx);
  const overlay = () => doc.documentElement.children.filter((c) => c.shadow && c.shadow.children.length === 2)[0];
  const layer = () => overlay().shadow.children[0], hint = () => overlay().shadow.children[1];
  const ev = (el, tp, x, y) => el.l[tp][0]({ button: 0, clientX: x, clientY: y, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  const drag = (a, b) => { ev(layer(), 'pointerdown', a[0], a[1]); ev(layer(), 'pointermove', b[0], b[1]); return ev(layer(), 'pointerup', b[0], b[1]); };
  const toasts = () => doc.documentElement.children.filter((c) => c.shadow && c.shadow.children.length === 1).map((c) => c.shadow.children[0].textContent);
  return { run, doc, sent, keys, overlay, layer, hint, drag, toasts, win };
}
await t('드래그하면 안내 화면을 지운 뒤(스크린샷에 안 찍히게) 영역 좌표를 보내고 성공 안내를 띄움', async () => {
  const p = page(); p.run(); assert.ok(p.overlay(), '드래그 화면이 올라옴');
  await p.drag([100, 80], [300, 260]); await sleep(200);
  assert.equal(p.sent.length, 1); assert.deepEqual(plain(p.sent[0].m), { type: 'otpvault-qr-region', rect: { x: 100, y: 80, w: 200, h: 180 }, vw: 1000, vh: 700 });
  assert.equal(p.sent[0].overlays, 0, '메시지를 보낼 때는 드래그 화면이 이미 지워져 있어야 함'); assert.ok(!p.overlay());
  assert.match(p.toasts().join(), /QR을 읽었습니다/);
});
await t('반대 방향 드래그도 같은 영역, 화면 밖으로 끌면 경계에 맞춤', async () => {
  const p = page(); p.run(); await p.drag([300, 260], [100, 80]); await sleep(200); assert.deepEqual(plain(p.sent[0].m.rect), { x: 100, y: 80, w: 200, h: 180 });
  const q = page(); q.run(); await q.drag([900, 600], [1500, 900]); await sleep(200); assert.deepEqual(plain(q.sent[0].m.rect), { x: 900, y: 600, w: 100, h: 100 });
});
await t('너무 작은 영역은 보내지 않고 안내만 바꿈 (화면 유지)', async () => {
  const p = page(); p.run(); await p.drag([100, 100], [110, 108]); await sleep(150);
  assert.equal(p.sent.length, 0); assert.ok(p.overlay()); assert.match(p.hint().textContent, /너무 작습니다/);
});
await t('Esc로 취소하면 화면이 사라지고 메시지는 없음', async () => {
  const p = page(); p.run(); assert.equal(p.keys.length, 1); p.keys[0]({ key: 'Escape', stopPropagation() {} }); await sleep(20);
  assert.ok(!p.overlay()); assert.equal(p.sent.length, 0); assert.equal(p.keys.length, 0, '키 이벤트 등록 해제');
});
await t('실패 응답이면 오류 안내를 띄우고 바로 다시 지정할 수 있게 화면을 다시 올림', async () => {
  const p = page({ send: async () => ({ ok: false, error: 'QR 코드를 찾지 못했습니다.' }) }); p.run();
  await p.drag([100, 80], [300, 260]); await sleep(200); assert.match(p.toasts().join(), /QR 코드를 찾지 못했습니다.*다시 드래그/); assert.ok(!p.overlay(), '안내 직후에는 아직 없음');
  await sleep(800); assert.ok(p.overlay(), '잠시 뒤 다시 드래그 화면이 올라옴');
  await p.drag([50, 50], [250, 250]); await sleep(200); assert.equal(p.sent.length, 2, '두 번째 시도도 전송됨');
});
await t('확장프로그램과 통신이 안 되면(예외) 오류 안내', async () => {
  const p = page({ send: async () => { throw new Error('no receiver'); } }); p.run(); await p.drag([100, 80], [300, 260]); await sleep(200);
  assert.match(p.toasts().join(), /통신하지 못했습니다/);
});
await t('이미 주입된 페이지에 다시 주입해도 드래그 화면은 하나만', async () => {
  const p = page(); p.run(); p.run(); assert.equal(p.doc.documentElement.children.filter((c) => c.shadow).length, 1);
});
await t('내용 스크립트는 페이지 내용을 읽거나 외부로 보내는 코드가 없음', () => {
  const code = fs.readFileSync(new URL('../extension/content/qr-select.js', import.meta.url), 'utf-8');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'innerHTML', 'eval(', 'localStorage', 'document.cookie', 'getSelection', 'querySelector']) assert.ok(!code.includes(bad), bad);
});

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
