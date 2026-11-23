// 가짜 DOM + 가짜 chrome.storage 로 화면 로직(app.js)을 끝까지 실행해 보는 시험. 실제 브라우저 시험을 대체하지는 않는다.
import assert from 'node:assert/strict';
import { totp } from '../extension/core/totp.js';
import { decodeBase32 } from '../extension/core/base32.js';
import { createVault, seal, kdfDefaults, KDF_PBKDF2 } from '../extension/core/crypto.js';
import { migrationUri } from './pb.mjs';
kdfDefaults.memoryKiB = 64; // 시험 속도용 (앱과 같은 모듈을 쓰므로 앱에도 적용됨)

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.className = ''; this.value = ''; this.files = []; this._text = null; }
  append(...kids) { for (const c of kids) { if (typeof c === 'string') { const t = new El('#text'); t._text = c; t.parent = this; this.children.push(t); } else { c.parent = this; this.children.push(c); } } }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this.value = v; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  dispatch(t, ev = {}) { for (const f of this.listeners[t] || []) f({ target: this, preventDefault() {}, key: '', ...ev }); }
  click() { this.dispatch('click'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  focus() {} select() {}
  get textContent() { return this.tag === '#text' ? this._text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.append(String(v)); }
}
const all = (n, p, out = []) => { if (p(n)) out.push(n); n.children.forEach((c) => all(c, p, out)); return out; };

let store = {}, sstore = {}, DOC, clip = '', blob = null;
const onChangedFns = [], injected = []; let closed = 0, opened = 0, scriptFail = false;
const setupDom = (mode) => {
  const body = new El('body'); body.dataset.mode = mode;
  const app = new El('div');
  const listeners = {};
  DOC = { body, getElementById: () => app, createElement: (t) => new El(t),
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener() {} };
  Object.defineProperty(globalThis, 'document', { value: DOC, configurable: true, writable: true });
  return app;
};
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('chrome', { storage: { local: {
  get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
  set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
  remove: async (k) => { delete store[k]; } },
  onChanged: { addListener: (f) => onChangedFns.push(f) },
  session: { get: async (k) => (k in sstore ? { [k]: structuredClone(sstore[k]) } : {}),
    set: async (o) => { for (const [k, v] of Object.entries(o)) sstore[k] = structuredClone(v); },
    remove: async (k) => { delete sstore[k]; } } }, runtime: { openOptionsPage: async () => { opened++; }, getManifest: () => ({ version: '9.9.9', permissions: ['storage', 'activeTab', 'scripting'] }) },
  tabs: { query: async () => [{ id: 7, url: 'https://example.com/' }], captureVisibleTab: async () => 'data:image/png;base64,' },
  scripting: { executeScript: async (o) => { if (scriptFail) throw new Error('Cannot access this page'); injected.push(o); } } });
def('close', () => { closed++; });
def('navigator', { clipboard: { writeText: async (t) => { clip = t; } } });
def('confirm', () => true);
URL.createObjectURL = (b) => { blob = b; return 'blob:test'; };
URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 20000) => { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('시간 초과: ' + what); await sleep(15); } };
let app;
const btn = (text) => all(app, (n) => n.tag === 'button' && n.textContent === text)[0];
const click = (text) => { const b = btn(text); assert.ok(b, `버튼 없음: ${text}`); b.click(); };
const input = (label) => { const l = all(app, (n) => n.tag === 'label' && n.textContent.startsWith(label))[0]; assert.ok(l, `입력칸 없음: ${label}`); return all(l, (n) => n.tag === 'input' || n.tag === 'select')[0]; };
const text = () => app.textContent;
const ov = () => all(DOC.body, (n) => n.className === 'overlay');   // 결과 알림 창
const modalOf = () => all(ov()[0], (n) => typeof n.className === 'string' && n.className.startsWith('modal '))[0];
const closeOv = () => all(ov()[0], (n) => n.tag === 'button' && n.textContent === '확인')[0].click();
// 알림 창이 뜰 때까지 기다렸다가 내용을 돌려주고 닫는다. (화면에 항상 있는 안내 문구에 속지 않도록 text() 대신 알림 창을 본다)
const waitOv = async (re) => { await until(() => ov().length === 1 && re.test(ov()[0].textContent), '알림 창: ' + re); const tx = ov()[0].textContent; closeOv(); return tx; };
const rows = () => all(app, (n) => n.className === 'row');
const rowNames = () => rows().map((r) => all(r, (n) => n.tag === 'b')[0].textContent);
const codeOf = (i) => all(rows()[i], (n) => n.className === 'code')[0];
const rowBtn = (i, t) => all(rows()[i], (n) => n.tag === 'button' && n.textContent === t)[0];

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); } };
const PW = 'correct horse battery', SECRET = 'JBSWY3DPEHPK3PXP';
const validCodes = async (secret, o = {}) => { const n = Math.floor(Date.now() / 1000); return new Set([await totp(decodeBase32(secret), n - 1, o), await totp(decodeBase32(secret), n, o), await totp(decodeBase32(secret), n + 1, o)].map((c) => c.slice(0, 3) + ' ' + c.slice(3))); };

console.log('팝업 화면');
app = setupDom('popup');
await import('../extension/app.js?popup');
await until(() => btn('보관소 만들기'), '생성 화면');
await t('처음 실행: 생성 화면과 경고 문구', () => { assert.match(text(), /복구할 수 없습니다/); });
await t('짧은 비밀번호 / 불일치 거부', async () => {
  input('마스터 비밀번호').value = 'short'; input('비밀번호 확인').value = 'short'; click('보관소 만들기');
  assert.match(text(), /10자 이상/);
  input('마스터 비밀번호').value = PW; input('비밀번호 확인').value = PW + 'x'; click('보관소 만들기');
  assert.match(text(), /서로 다릅니다/);
});
await t('보관소 생성 → 목록 화면', async () => {
  input('비밀번호 확인').value = PW; click('보관소 만들기');
  await until(() => btn('+ 추가'), '목록 화면');
  assert.ok(store.vault && store.vault.cipher);
});
await t('otpauth 주소로 등록 + 올바른 코드 표시', async () => {
  click('+ 추가');
  input('주소').value = `otpauth://totp/GitHub:alice@example.com?secret=${SECRET}&issuer=GitHub`; click('주소로 등록');
  await until(() => rows().length === 1, '행 1개');
  await until(() => /\d{3} \d{3}/.test(codeOf(0).textContent), '코드 표시');
  assert.ok((await validCodes(SECRET)).has(codeOf(0).textContent), codeOf(0).textContent);
});
await t('중복 등록 거부', async () => {
  click('+ 추가');
  input('주소').value = `otpauth://totp/GitHub:alice@example.com?secret=${SECRET}&issuer=GitHub`; click('주소로 등록');
  await until(() => /이미 등록/.test(text()), '중복 메시지');
  click('취소');
});
await t('직접 입력: 잘못된 비밀키 거부 / 올바르면 등록', async () => {
  click('+ 추가');
  input('서비스 이름').value = '네이버'; input('계정 이름').value = '홍길동'; input('비밀키').value = '1111!!!!';
  click('직접 입력으로 등록'); await until(() => /비밀키/.test(text()), '비밀키 오류');
  input('비밀키').value = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; click('직접 입력으로 등록');
  await until(() => rows().length === 2, '행 2개');
  assert.deepEqual([...rowNames()].sort(), ['GitHub', '네이버'].sort());
});
await t('즐겨찾기는 맨 위로', async () => {
  const second = rowNames()[1]; all(rows()[1], (n) => n.className.includes('star'))[0].click();
  await until(() => rowNames()[0] === second, '정렬'); // 즐겨찾기한 계정이 맨 위로
});
await t('검색', () => {
  const s = all(app, (n) => n.tag === 'input' && n.attrs.type === 'search')[0]; s.value = 'git'; s.dispatch('input');
  assert.deepEqual(rowNames(), ['GitHub']); s.value = ''; s.dispatch('input'); assert.equal(rows().length, 2);
});
await t('코드 복사', async () => {
  const i = rowNames().indexOf('GitHub'); rowBtn(i, '복사').click(); await sleep(30);
  assert.equal(clip, codeOf(i).dataset.raw); assert.match(clip, /^\d{6}$/);
});
await t('계정 수정 (이름 변경, 비밀키는 유지)', async () => {
  const i = rowNames().indexOf('GitHub'); rowBtn(i, '수정').click();
  input('계정 이름').value = 'bob@example.com'; click('저장');
  await until(() => rows().length === 2, '목록 복귀');
  const j = rowNames().indexOf('GitHub'); assert.match(rows()[j].textContent, /bob@example.com/);
  await until(() => /\d{3} \d{3}/.test(codeOf(j).textContent), '코드');
  assert.ok((await validCodes(SECRET)).has(codeOf(j).textContent));
});
await t('저장소에 평문 비밀키 없음', () => { const s = JSON.stringify(store); assert.ok(!s.includes(SECRET) && !s.includes('GEZDGNBV') && !s.includes('홍길동')); });
await t('계정 삭제: 한 번 누르면 확인 단계, 두 번째 누르면 삭제', async () => {
  const i = rowNames().indexOf('네이버'); rowBtn(i, '삭제').click();
  assert.equal(rows().length, 2, '첫 클릭에는 삭제되지 않음'); assert.match(text(), /한 번 더 누르면 삭제/);
  rowBtn(i, '정말 삭제?').click(); await until(() => rows().length === 1, '삭제');
});
await t('잠금 → 틀린 비밀번호 거부 → 해제하면 계정 유지', async () => {
  click('잠금'); await until(() => btn('잠금 해제'), '잠금 화면');
  input('마스터 비밀번호').value = 'wrong password!!'; click('잠금 해제'); await until(() => /틀렸/.test(text()), '오류');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => rows().length === 1, '해제');
  assert.deepEqual(rowNames(), ['GitHub']);
});
await t('팝업에는 파일 선택(QR·백업)이 없음', () => { click('+ 추가'); assert.equal(all(app, (n) => n.tag === 'input' && n.attrs.type === 'file').length, 0); click('취소'); });

console.log('관리 페이지 (같은 저장소)');
app = setupDom('page');
await import('../extension/app.js?page');
await until(() => btn('잠금 해제'), '페이지 잠금 화면');
await t('잠금 해제 + QR 파일 입력 표시', async () => {
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('설정·백업'), '목록');
  click('+ 추가'); assert.equal(all(app, (n) => n.tag === 'input' && n.attrs.type === 'file').length, 1); click('취소');
});
await t('설정 저장(정렬 방식·자동 잠금)', async () => {
  click('설정·백업'); input('목록 정렬').value = 'custom'; input('목록 정렬').dispatch('change');
  await until(() => store.settings?.sortMode === 'custom', '설정 저장');
  input('자동 잠금').value = '15'; input('자동 잠금').dispatch('change'); await until(() => store.settings?.autoLockMin === 15, '자동 잠금');
});
await t('비밀번호 변경: 현재 비밀번호 틀리면 거부', async () => {
  input('현재 비밀번호').value = 'wrong password!!'; input('새 비밀번호 (10자 이상)').value = 'new password 1234'; input('새 비밀번호 확인').value = 'new password 1234';
  click('비밀번호 변경'); await until(() => /틀렸/.test(text()), '오류');
});
const NEWPW = 'new password 1234';
await t('비밀번호 변경 성공 → 새 비밀번호로 잠금 해제', async () => {
  input('현재 비밀번호').value = PW; click('비밀번호 변경'); await until(() => /바꿨습니다/.test(text()), '성공');
  click('돌아가기'); click('잠금'); await until(() => btn('잠금 해제'), '잠금');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => /틀렸/.test(text()), '이전 비밀번호 거부');
  input('마스터 비밀번호').value = NEWPW; click('잠금 해제'); await until(() => rows().length === 1, '새 비밀번호로 해제');
});
let backupText;
await t('암호화 백업 내보내기', async () => {
  click('설정·백업'); click('암호화 백업 내보내기'); await until(() => /저장했습니다/.test(text()), '내보내기');
  backupText = await blob.text(); const j = JSON.parse(backupText);
  assert.equal(j.format, 'otp-vault-backup'); assert.ok(!backupText.includes(SECRET));
});
await t('백업 가져오기: 건너뛰기 / 덮어쓰기', async () => {
  const f = input('백업 파일'); f.files = [{ size: backupText.length, text: async () => backupText }];
  input('백업 비밀번호').value = 'wrong password!!'; click('백업 가져오기'); await waitOv(/가져오지 못했습니다.*틀렸/);
  input('백업 비밀번호').value = NEWPW; click('백업 가져오기'); await waitOv(/0개 추가, 0개 덮어씀, 1개 건너뜀/);
  input('같은 서비스·계정 이름이 있을 때').value = 'replace'; click('백업 가져오기'); await waitOv(/0개 추가, 1개 덮어씀/);
});
await t('손상된 백업 파일 거부', async () => {
  const bad = JSON.parse(backupText); bad.cipher.ciphertext = bad.cipher.ciphertext.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  input('백업 파일').files = [{ size: 10, text: async () => JSON.stringify(bad) }]; click('백업 가져오기'); await waitOv(/가져오지 못했습니다.*(손상|틀렸)/);
});
await t('백업 결과 알림: 실패는 빨강·성공은 초록 창, 확인하면 닫힘, 결과는 버튼 바로 아래 칸에도 표시', async () => {
  assert.equal(ov().length, 0, '앞선 시험의 알림이 남아 있지 않아야 함');
  const below = (label) => { const b = btn(label), sib = b.parent.children[b.parent.children.indexOf(b) + 1]; return sib.textContent; };
  input('백업 파일').files = [{ size: 10, text: async () => backupText }]; input('백업 비밀번호').value = 'wrong password!!'; click('백업 가져오기');
  await until(() => ov().length === 1, '실패 알림'); assert.match(ov()[0].textContent, /백업을 가져오지 못했습니다/); assert.equal(modalOf().className, 'modal err');
  assert.match(below('백업 가져오기'), /✗ 백업을 가져오지 못했습니다.*아무것도 가져오지 않았습니다/); closeOv(); assert.equal(ov().length, 0);
  input('백업 비밀번호').value = NEWPW; click('백업 가져오기'); await until(() => ov().length === 1, '성공 알림');
  assert.match(ov()[0].textContent, /백업을 가져왔습니다.*현재 계정은 모두 1개/); assert.equal(modalOf().className, 'modal ok');
  assert.match(below('백업 가져오기'), /✓ 백업을 가져왔습니다/); closeOv();
  click('암호화 백업 내보내기'); await until(() => ov().length === 1, '내보내기 알림');
  assert.match(ov()[0].textContent, /백업 파일을 저장했습니다.*otp-vault-backup-\d{8}\.json/); assert.match(below('암호화 백업 내보내기'), /✓ 백업 파일을 저장했습니다/); closeOv();
});
await t('로고: 생성/잠금/목록 화면 제목에 아이콘 이미지', async () => {
  click('돌아가기'); const img = all(app, (n) => n.tag === 'img')[0]; assert.ok(img && img.attrs.src.startsWith('data:image/png;base64,') && img.attrs.alt === 'OTP Vault');
});
await t('백업 → 다른 브라우저(빈 저장소)에 복원', async () => {
  store = {}; app = setupDom('page'); await import('../extension/app.js?page2');
  await until(() => btn('백업으로 복원'), '생성/복원 화면');
  input('백업 파일').files = [{ size: backupText.length, text: async () => backupText }]; input('백업 비밀번호').value = 'wrong password!!';
  click('백업으로 복원'); await until(() => ov().length === 1, '복원 실패 알림');
  assert.match(ov()[0].textContent, /백업을 복원하지 못했습니다/); assert.equal(modalOf().className, 'modal err'); assert.match(text(), /보관소는 만들어지지 않았습니다/); assert.ok(!store.vault, '실패하면 보관소를 만들지 않음');
  closeOv(); assert.equal(ov().length, 0, '확인을 누르면 닫힘');
  input('백업 비밀번호').value = NEWPW;
  click('백업으로 복원'); await until(() => rows().length === 1, '복원');
  assert.match(ov()[0].textContent, /복원을 완료했습니다.*계정 1개/); assert.equal(modalOf().className, 'modal ok'); closeOv();
  assert.deepEqual(rowNames(), ['GitHub']); await until(() => /\d{3} \d{3}/.test(codeOf(0).textContent), '코드');
  assert.ok((await validCodes(SECRET)).has(codeOf(0).textContent));
});
await t('비밀번호를 잊었을 때: 확인 문구 없으면 삭제 거부, 입력하면 삭제', async () => {
  click('잠금'); await until(() => btn('보관소 영구 삭제'), '잠금 화면');
  click('보관소 영구 삭제'); assert.match(text(), /"삭제"라고 입력/); assert.ok(store.vault);
  input('계속하려면').value = '삭제'; click('보관소 영구 삭제'); await until(() => btn('보관소 만들기'), '초기화');
  assert.ok(!store.vault);
});


console.log('잠금 해제 유지');
const open = async (mode, tag) => { app = setupDom(mode); await import(`../extension/app.js?${tag}`); await sleep(30); };
await t('기본값(끔): 해제 키를 어디에도 저장하지 않음', async () => {
  await until(() => btn('보관소 만들기'), '생성 화면');
  input('마스터 비밀번호').value = PW; input('비밀번호 확인').value = PW; click('보관소 만들기'); await until(() => btn('+ 추가'), '목록');
  assert.deepEqual(sstore, {});
  click('+ 추가'); input('주소').value = `otpauth://totp/GitHub:alice@example.com?secret=${SECRET}&issuer=GitHub`; click('주소로 등록'); await until(() => rows().length === 1, '등록');
  await open('popup', 'k1'); await until(() => btn('잠금 해제'), '다시 비밀번호를 묻는다');
});
await t('"브라우저를 끌 때까지": 설정 변경은 다음 해제부터 적용, 이후 팝업은 비밀번호 없이 열림', async () => {
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('+ 추가'), '목록');
  await open('page', 'k2'); await until(() => btn('잠금 해제'), '페이지도 비밀번호 요구');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('설정·백업'), '목록');
  click('설정·백업'); input('잠금 해제 유지').value = 'browser'; input('잠금 해제 유지').dispatch('change');
  await until(() => /다음에 마스터 비밀번호/.test(text()), '안내 문구'); assert.equal(store.settings.keepUnlocked, 'browser');
  assert.deepEqual(sstore, {}, '설정 변경 직후에는 아직 저장 안 됨');
  click('돌아가기'); click('잠금'); await until(() => btn('잠금 해제'), '잠금');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('설정·백업'), '다시 해제');
  assert.ok(sstore.unlock && sstore.unlock.jwk && sstore.unlock.salt === store.vault.kdf.salt);
  assert.equal(sstore.unlock.expiresAt, null);
  assert.ok(!JSON.stringify(sstore).includes(PW) && !JSON.stringify(store).includes(PW), '비밀번호 자체는 어디에도 없음');
  await open('popup', 'k3'); await until(() => rows().length === 1, '비밀번호 없이 목록 표시');
  assert.ok(!btn('잠금 해제'));
});
await t('잠금 버튼을 누르면 유지된 해제 상태도 지워짐', async () => {
  click('잠금'); await until(() => btn('잠금 해제'), '잠금 화면'); assert.deepEqual(sstore, {});
  await open('popup', 'k4'); await until(() => btn('잠금 해제'), '새 팝업도 비밀번호 요구');
});
await t('시간 제한(1시간): 만료 시간 기록, 만료되면 비밀번호 요구', async () => {
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('+ 추가'), '목록');
  await open('page', 'k5'); await until(() => btn('잠금 해제') || btn('설정·백업'), '페이지');
  if (btn('잠금 해제')) { input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('설정·백업'), '목록'); }
  click('설정·백업'); input('잠금 해제 유지').value = '1h'; input('잠금 해제 유지').dispatch('change'); await until(() => store.settings.keepUnlocked === '1h', '설정');
  click('돌아가기'); click('잠금'); await until(() => btn('잠금 해제'), '잠금');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('설정·백업'), '해제');
  const left = sstore.unlock.expiresAt - Date.now(); assert.ok(left > 3590e3 && left <= 3600e3, String(left));
  sstore.unlock.expiresAt = Date.now() - 1000;
  await open('popup', 'k6'); await until(() => btn('잠금 해제'), '만료 후 비밀번호 요구'); assert.deepEqual(sstore, {});
});
await t('보관소와 맞지 않는 salt / 엉뚱한 키는 거부하고 지움', async () => {
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('+ 추가'), '목록');
  const good = structuredClone(sstore.unlock);
  sstore.unlock = { ...good, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }; await open('popup', 'k7'); await until(() => btn('잠금 해제'), 'salt 불일치'); assert.deepEqual(sstore, {});
  const other = await (await import('../extension/core/crypto.js')).createVault('another password!!', { accounts: [] }, 'otp-vault', true);
  sstore.unlock = { ...good, jwk: await (await import('../extension/core/crypto.js')).exportKey(other.key) };
  await open('popup', 'k8'); await until(() => btn('잠금 해제'), '엉뚱한 키'); assert.deepEqual(sstore, {});
});
await t('다시 "끄기"로 바꾸면 즉시 지워지고 이후 저장 안 함', async () => {
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('+ 추가'), '목록');
  await open('page', 'k9'); await until(() => btn('잠금 해제') || btn('설정·백업'), '페이지');
  if (btn('잠금 해제')) { input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('설정·백업'), '목록'); }
  click('설정·백업'); input('잠금 해제 유지').value = 'off'; input('잠금 해제 유지').dispatch('change'); await until(() => store.settings.keepUnlocked === 'off', '설정');
  assert.deepEqual(sstore, {}); click('돌아가기'); click('잠금'); await until(() => btn('잠금 해제'), '잠금');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => btn('+ 추가') || btn('설정·백업'), '해제'); assert.deepEqual(sstore, {});
});


console.log('HOTP · Google 내보내기 · 백업 알림 · 보안 방식 업그레이드');
const reset = async (tag, mode = 'page') => { store = {}; sstore = {}; await open(mode, tag); await until(() => btn('보관소 만들기'), '생성 화면');
  input('마스터 비밀번호').value = PW; input('비밀번호 확인').value = PW; click('보관소 만들기'); await until(() => btn('+ 추가'), '목록'); };
const HSECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
await reset('n1');
await t('HOTP 직접 등록 → RFC 4226 카운터 0 코드 → "다음 번호"로 카운터 증가', async () => {
  click('+ 추가'); input('방식').value = 'hotp'; input('서비스 이름').value = '은행'; input('계정 이름').value = 'me'; input('비밀키').value = HSECRET;
  click('직접 입력으로 등록'); await until(() => rows().length === 1, '등록');
  await until(() => codeOf(0).textContent === '755 224', 'HOTP 코드'); assert.match(rows()[0].textContent, /카운터 0/);
  rowBtn(0, '다음 번호').click(); await until(() => codeOf(0).textContent === '287 082', '다음 코드'); assert.match(rows()[0].textContent, /카운터 1/);
  assert.equal(all(rows()[0], (n) => n.className === 'bar').length, 0, 'HOTP에는 시간 막대가 없음');
});
await t('HOTP 카운터는 잠금 후에도 유지, 수정 화면에서 카운터 맞춤', async () => {
  click('잠금'); await until(() => btn('잠금 해제'), '잠금'); input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => rows().length === 1, '해제');
  await until(() => codeOf(0).textContent === '287 082', '유지된 카운터');
  rowBtn(0, '수정').click(); input('카운터').value = '3'; click('저장'); await until(() => rows().length === 1 && /카운터 3/.test(rows()[0].textContent), '수정 반영');
  await until(() => codeOf(0).textContent === '969 429', '카운터 3 = 969429');
});
await t('Google Authenticator 내보내기 주소 가져오기 (여러 계정, 중복은 건너뜀)', async () => {
  click('+ 추가');
  const uri = migrationUri([{ secret: Uint8Array.from(Buffer.from('JBSWY3DPEHPK3PXP'.length ? [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef] : [])), name: 'Example:alice@google.com', issuer: 'Example' },
    { secret: new TextEncoder().encode('12345678901234567890'), name: '홍길동', issuer: '네이버', digits: 2 }]);
  input('주소').value = uri; click('주소로 등록'); await until(() => /2개를 추가했고 0개는 건너뛰었습니다/.test(text()), '가져오기 결과');
  input('주소').value = uri; click('주소로 등록'); await until(() => /0개를 추가했고 2개는 건너뛰었습니다/.test(text()), '중복 건너뜀');
  click('취소'); await until(() => rows().length === 3, '목록 3개');
  const n = rowNames().indexOf('네이버'); await until(() => /\d{4} \d{4}/.test(codeOf(n).textContent), '8자리 코드');
});
await t('백업 알림: 백업이 없으면 배너 → 백업하면 사라짐 → 오래 지나면 다시 표시 → 끄면 안 보임', async () => {
  assert.match(text(), /아직 백업 파일을 만든 적이 없습니다/);
  click('나중에'); assert.ok(!/아직 백업 파일을 만든 적이 없습니다/.test(text()), '"나중에"는 이번 화면에서만 숨김');
  click('설정·백업'); assert.match(text(), /마지막 백업: 없음/); click('암호화 백업 내보내기'); await until(() => /저장했습니다/.test(text()), '내보내기');
  assert.ok(store.settings.lastBackupAt > 0 && store.settings.dirtySince === null); click('돌아가기');
  assert.ok(!/백업 파일을 만든 적이|백업되지 않았습니다/.test(text()), '백업 직후에는 배너 없음');
  all(rows()[0], (n) => n.className.includes('star'))[0].click(); await until(() => store.settings.dirtySince > 0, '변경 기록');
  store.settings.dirtySince = Date.now() - 8 * 86400e3; store.settings.lastBackupAt = Date.now() - 9 * 86400e3;
  await open('page', 'n2'); await until(() => btn('잠금 해제'), '잠금 화면'); input('마스터 비밀번호').value = PW; click('잠금 해제');
  await until(() => /8일 동안 바뀐 내용이 백업되지 않았습니다/.test(text()), '7일 경과 배너');
  click('설정·백업'); input('백업 알림').value = 'off'; input('백업 알림').dispatch('change'); await until(() => store.settings.backupRemind === 'off', '알림 끄기');
  click('돌아가기'); assert.ok(!/백업되지 않았습니다/.test(text()));
});
await t('이전 버전(PBKDF2·형식 1) 보관소: 비밀번호로 열면 Argon2id로 자동 업그레이드, 계정 유지', async () => {
  const accounts = [{ id: 'a1', type: 'totp', issuer: 'Old', label: 'user', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 }];
  const old = await createVault(PW, { accounts }, 'otp-vault', false, KDF_PBKDF2);
  store = { vault: await seal(old.key, { format: 'otp-vault', formatVersion: 1, kdf: old.env.kdf }, { accounts }) }; sstore = {};
  assert.equal(store.vault.kdf.name, 'PBKDF2-HMAC-SHA256'); assert.equal(store.vault.formatVersion, 1);
  await open('page', 'n3'); await until(() => btn('잠금 해제'), '잠금 화면'); input('마스터 비밀번호').value = PW; click('잠금 해제');
  await until(() => rows().length === 1, '해제'); assert.deepEqual(rowNames(), ['Old']);
  assert.equal(store.vault.kdf.name, 'Argon2id'); assert.equal(store.vault.formatVersion, 2);
  click('잠금'); await until(() => btn('잠금 해제'), '잠금'); input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => rows().length === 1, '새 방식으로 다시 해제');
});


console.log('자가 진단');
await t('설정 화면의 "진단 실행": 실패 항목 없음, 계정·저장소 데이터는 그대로', async () => {
  await reset('d1');
  click('+ 추가'); input('주소').value = `otpauth://totp/GitHub:alice@example.com?secret=${SECRET}&issuer=GitHub`; click('주소로 등록'); await until(() => rows().length === 1, '등록');
  const before = JSON.stringify(store.vault);
  click('설정·백업'); click('진단 실행');
  const pre = () => all(app, (n) => n.className === 'diag')[0].textContent;
  await until(() => /Argon2id 실제 설정/.test(pre()), '진단 완료');
  const r = pre();
  const tags = (cls) => all(app, (n) => n.className === 'tag ' + cls).length;
  assert.ok(tags('ok') >= 10, '통과 표시가 초록(tag ok) 클래스'); assert.equal(tags('fail'), 0); assert.ok(tags('info') >= 1, '참고는 별도 색');
  assert.equal(all(app, (n) => n.className === 'dsum good').length, 1, '요약줄이 초록'); assert.match(r, /✓ 전체 결과: 통과 \d+ · 실패 0 · 참고 \d+ — 모두 정상/);
  assert.ok(all(app, (n) => n.className === 'tag ok').every((n) => n.textContent === '[통과]'));
  assert.ok(!/\[실패\]/.test(r), '실패 항목이 있음'); assert.match(r, /\[통과\] Argon2id 공식 벡터/); assert.match(r, /\[통과\] TOTP 공식 벡터/);
  assert.match(r, /\[통과\] 자체 QR 디코더/); assert.match(r, /\[통과\] 메모리 전용 저장소/);
  assert.equal(JSON.stringify(store.vault), before); assert.ok(!('__diag' in store) && !('__diag' in sstore), '임시 키가 남지 않음');
  click('결과 복사'); await sleep(30); assert.match(clip, /\[통과\]/);
});


console.log('화면 드래그 QR');
const OTP1 = 'otpauth://totp/Naver:hong@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Naver';
const fire = (v) => { sstore.qrPending = v; onChangedFns.forEach((f) => f({ qrPending: { newValue: v } }, 'session')); }; // 배경이 읽은 QR을 임시 저장소에 넣은 상황
const yes = (label) => all(ov()[0], (n) => n.tag === 'button' && n.textContent === label)[0].click();
await t('팝업: "화면에서 QR 영역 드래그하기" → 현재 탭에 선택 화면 주입 후 팝업 닫기', async () => {
  onChangedFns.length = 0; await reset('q1', 'popup');
  click('+ 추가'); assert.match(text(), /방법 1\. 화면에서 드래그/);
  click('화면에서 QR 영역 드래그하기'); await until(() => injected.length === 1, '주입');
  assert.deepEqual(injected[0], { target: { tabId: 7 }, files: ['content/qr-select.js'] }); await until(() => closed === 1, '팝업 닫힘');
});
await t('보호된 페이지(주입 실패)에서는 안내 문구만 보이고 팝업은 닫히지 않음', async () => {
  scriptFail = true; const c0 = closed; click('화면에서 QR 영역 드래그하기');
  await until(() => /이 화면에서는 사용할 수 없습니다/.test(text()), '안내'); assert.equal(closed, c0); scriptFail = false;
});
await t('팝업은 대기 중인 QR을 처리하지 않음(관리 페이지에서만)', async () => {
  sstore.qrPending = { text: OTP1, at: Date.now() }; click('취소'); await sleep(80);
  assert.equal(ov().length, 0); assert.ok('qrPending' in sstore);
});
await t('관리 페이지에는 드래그 버튼 대신 팝업 안내', async () => {
  onChangedFns.length = 0; await reset('q2'); click('+ 추가');
  assert.ok(!btn('화면에서 QR 영역 드래그하기')); assert.match(text(), /툴바의 팝업에서 쓸 수 있습니다/); click('취소');
});
await t('읽은 QR 도착: 비밀키 없이 이름만 보여 주고, 확인 후 추가, 임시 저장은 즉시 삭제', async () => {
  fire({ text: OTP1, at: Date.now() });
  await until(() => ov().length === 1 && /화면에서 읽은 QR로 계정을 추가할까요/.test(ov()[0].textContent), '확인 창');
  assert.match(ov()[0].textContent, /Naver \/ hong@example\.com/); assert.ok(!ov()[0].textContent.includes('GEZDGNBV'), '비밀키가 화면에 나오지 않음');
  assert.ok(!('qrPending' in sstore), '임시 저장은 처리 즉시 삭제'); assert.equal(rows().length, 0);
  yes('추가'); await until(() => rows().length === 1, '계정 추가');
  await until(() => ov().length === 1 && /계정을 추가했습니다/.test(ov()[0].textContent), '완료 알림'); assert.equal(modalOf().className, 'modal ok'); closeOv();
  await until(() => /\d{3} \d{3}/.test(codeOf(0).textContent), '코드 표시');
});
await t('취소하면 추가하지 않고 임시 저장도 남지 않음', async () => {
  fire({ text: 'otpauth://totp/Other:x?secret=JBSWY3DPEHPK3PXP&issuer=Other', at: Date.now() });
  await until(() => ov().length === 1 && /추가할까요/.test(ov()[0].textContent), '확인 창'); yes('취소'); await sleep(50);
  assert.equal(ov().length, 0); assert.equal(rows().length, 1); assert.ok(!('qrPending' in sstore));
});
await t('이미 있는 계정이면 "추가된 계정이 없습니다"(빨강)', async () => {
  fire({ text: OTP1, at: Date.now() }); await until(() => ov().length === 1 && /추가할까요/.test(ov()[0].textContent), '확인 창'); yes('추가');
  await until(() => ov().length === 1 && /추가된 계정이 없습니다/.test(ov()[0].textContent), '알림'); assert.equal(modalOf().className, 'modal err'); closeOv(); assert.equal(rows().length, 1);
});
await t('10분 지난 요청은 취소 안내, 올바르지 않은 주소는 오류 안내', async () => {
  fire({ text: OTP1, at: Date.now() - 11 * 60e3 }); await until(() => ov().length === 1 && /오래되어 취소/.test(ov()[0].textContent), '만료 안내'); closeOv();
  fire({ text: 'otpauth://hotp/A:b?secret=JBSWY3DPEHPK3PXP', at: Date.now() }); await until(() => ov().length === 1 && /사용할 수 없습니다.*counter/.test(ov()[0].textContent), '오류 안내'); closeOv();
  assert.ok(!('qrPending' in sstore)); assert.equal(rows().length, 1);
});
await t('Google 내보내기 QR도 여러 계정을 한 번에', async () => {
  const sec = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
  fire({ text: migrationUri([{ secret: sec, name: 'Example:alice@google.com', issuer: 'Example' }, { secret: new TextEncoder().encode('12345678901234567890'), name: 'bob', issuer: 'Acme' }]), at: Date.now() });
  await until(() => ov().length === 1 && /2개 계정/.test(ov()[0].textContent), '확인 창'); yes('추가'); await until(() => rows().length === 3, '3개');
  await until(() => ov().length === 1 && /2개 추가/.test(ov()[0].textContent), '완료'); closeOv();
});
await t('잠긴 상태에서 도착한 QR은 보관했다가 잠금을 푼 뒤에 확인', async () => {
  click('잠금'); await until(() => btn('잠금 해제'), '잠금');
  fire({ text: 'otpauth://totp/Late:z?secret=JBSWY3DPEHPK3PXP&issuer=Late', at: Date.now() }); await sleep(100);
  assert.equal(ov().length, 0, '잠긴 동안은 처리하지 않음'); assert.ok('qrPending' in sstore, '보관 중');
  input('마스터 비밀번호').value = PW; click('잠금 해제'); await until(() => ov().length === 1 && /Late \/ z/.test(ov()[0].textContent), '해제 후 확인 창'); yes('취소');
});

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
