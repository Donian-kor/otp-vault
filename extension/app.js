import { storage, sessionStore, openManagePage, manifest, tabsApi, onSessionChange } from './platform/api.js';
import { PENDING_KEY } from './core/screenqr.js';
import { runDiagnostics, formatReport, summarize } from './core/diagnostics.js';
import { LOGO } from './logo.js';
import { createVault, openVault, openWithKey, seal, exportKey, importKey, KDF_ARGON2 } from './core/crypto.js';
import { decodeBase32 } from './core/base32.js';
import { totp, hotp, formatCode } from './core/totp.js';
import { parseOtpauth } from './core/uri.js';
import { parseMigration } from './core/migration.js';
import { normalizeAccount, accountKey } from './core/account.js';
import { scanQr } from './qrscan.js';

const mode = document.body.dataset.mode; // 'popup' | 'page'
const root = document.getElementById('app');
const MAX_FILE = 5 * 1024 * 1024;
const DEFAULTS = { autoLockMin: 5, sortMode: 'name', keepUnlocked: 'off', backupRemind: '7d', lastBackupAt: null, dirtySince: null };
const REMIND_DAYS = { '3d': 3, '7d': 7, '30d': 30 };
const KEEP_MS = { '1h': 3600e3, '8h': 8 * 3600e3 };
let session = null;            // { key, kdf, accounts } — 잠금 해제 중에만 메모리에 존재
let settings = { ...DEFAULTS }; // 비밀 아님: 평문으로 저장
let tick = null, idle = null, onPaste = null, snoozed = false;

// ---------- 도우미 (사용자 데이터는 항상 textContent로만 표시) ----------
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
const msg = (text, kind = 'err') => h('div', { class: 'msg ' + kind }, text);
const field = (label, input) => h('label', {}, label, input);
const show = (out, text, kind) => out.replaceChildren(msg(text, kind));
const title = () => h('h1', { class: 'brand' }, h('img', { src: LOGO, alt: 'OTP Vault', width: '24', height: '24' }), 'OTP Vault');
// 화면 가운데에 결과를 알리는 창 (브라우저 대화상자가 아님). "확인"을 눌러야 닫힌다.
let overlayEl = null;
function notify(titleText, detail, ok = true) {
  if (overlayEl) overlayEl.remove();
  const okBtn = h('button', { class: 'primary', onclick: () => overlayEl && overlayEl.remove() }, '확인');
  overlayEl = h('div', { class: 'overlay', role: 'alertdialog', 'aria-modal': 'true' },
    h('div', { class: 'modal ' + (ok ? 'ok' : 'err') }, h('h2', {}, (ok ? '✓ ' : '✗ ') + titleText), detail ? h('p', {}, detail) : null, okBtn));
  overlayEl.addEventListener('keydown', (e) => e.key === 'Escape' && overlayEl && overlayEl.remove());
  document.body.append(overlayEl); okBtn.focus();
}
// 작업 버튼 바로 아래 결과 칸에 표시하고, 알림 창도 함께 띄운다.
function report(box, ok, titleText, detail = '') {
  box.replaceChildren(msg(`${ok ? '✓' : '✗'} ${titleText}${detail ? ' — ' + detail : ''}`, ok ? 'ok' : 'err'));
  box.scrollIntoView?.({ block: 'nearest' });
  notify(titleText, detail, ok);
}
// 예/아니오를 묻는 창 (브라우저 대화상자가 아님). Esc는 취소.
function confirmBox(titleText, detail, yesLabel, onYes) {
  if (overlayEl) overlayEl.remove();
  const close = () => overlayEl && overlayEl.remove();
  const yes = h('button', { class: 'primary', onclick: async () => { close(); await onYes(); } }, yesLabel);
  overlayEl = h('div', { class: 'overlay', role: 'alertdialog', 'aria-modal': 'true' },
    h('div', { class: 'modal ok' }, h('h2', {}, titleText), detail ? h('p', {}, detail) : null,
      h('div', { class: 'btns' }, yes, h('button', { onclick: close }, '취소'))));
  overlayEl.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(overlayEl); yes.focus();
}

// ---------- 화면에서 드래그로 읽은 QR 처리 (관리 페이지에서, 잠금을 푼 뒤) ----------
let pendingBusy = false;
async function handlePendingQr() {
  if (mode !== 'page' || !session || pendingBusy) return;
  pendingBusy = true;
  try {
    const p = await sessionStore.get(PENDING_KEY);
    if (!p) return;
    await sessionStore.remove(PENDING_KEY); // 비밀키가 든 주소는 한 번만 처리하고 메모리에서 바로 지운다
    if (!p.text || Date.now() - p.at > 10 * 60 * 1000) return notify('화면 QR이 오래되어 취소했습니다', '화면에서 QR을 다시 가져와 주세요.', false);
    let list, skipped = 0;
    try {
      if (/^otpauth-migration:/i.test(p.text)) { const r = parseMigration(p.text); list = r.accounts; skipped = r.skipped; } else list = [parseOtpauth(p.text)];
      if (!list.length) throw new Error('가져올 계정이 없습니다.');
    } catch (e) { return notify('화면에서 읽은 QR을 사용할 수 없습니다', e.message, false); }
    const names = list.slice(0, 5).map((a) => `· ${a.issuer ? a.issuer + ' / ' : ''}${a.label}${a.type === 'hotp' ? ' (HOTP)' : ''}`).join('\n');
    confirmBox('화면에서 읽은 QR로 계정을 추가할까요?', `${list.length}개 계정${list.length > 5 ? ' (처음 5개만 표시)' : ''}\n${names}`, '추가', async () => {
      const r = merge(list); await save(); viewList();
      notify(r.added ? '계정을 추가했습니다' : '추가된 계정이 없습니다', `${r.added}개 추가, ${r.skipped + skipped}개 건너뜀(이미 등록되었거나 지원하지 않는 항목).`, r.added > 0);
    });
  } finally { pendingBusy = false; }
}

// ---------- 화면에서 드래그해서 QR 가져오기 (팝업) ----------
function screenQrSection() {
  if (mode !== 'popup') return h('div', {}, h('h2', {}, '방법 1. 화면에서 드래그'), h('p', { class: 'hint' }, '웹페이지에 보이는 QR을 마우스로 드래그해 가져오는 기능은 툴바의 팝업에서 쓸 수 있습니다.'));
  const out = h('div');
  const btn = h('button', { class: 'primary', onclick: async () => {
    try {
      if (!tabsApi.available) throw new Error('unsupported');
      const tab = await tabsApi.active();
      if (!tab || tab.id == null) throw new Error('no tab');
      await tabsApi.inject(tab.id, 'content/qr-select.js'); // 방금 누른 동작(activeTab)으로 현재 탭에만 올라간다
      globalThis.close?.();                                 // 팝업을 닫아야 웹페이지에서 드래그할 수 있다
    } catch { show(out, '이 화면에서는 사용할 수 없습니다. 브라우저 내부 페이지(chrome://, edge://, about:)와 확장·스토어 페이지, 일부 보호된 페이지에서는 막혀 있습니다. 일반 웹페이지를 연 뒤 다시 눌러 주세요.'); }
  } }, '화면에서 QR 영역 드래그하기');
  return h('div', {}, h('h2', {}, '방법 1. 화면에서 드래그 (추천)'),
    h('p', { class: 'hint' }, 'QR이 보이는 웹페이지를 연 상태에서 누르세요. 팝업이 닫히면 화면에서 QR 부분을 마우스로 드래그해 지정합니다. 읽은 뒤에는 새 탭에서 계정 추가를 확인합니다.'), btn, out, h('hr'));
}
function clear() {
  clearInterval(tick);
  if (onPaste) { document.removeEventListener('paste', onPaste); onPaste = null; }
  root.replaceChildren();
}
async function readJsonFile(file) {
  if (!file) throw new Error('파일을 선택해 주세요.');
  if (file.size > MAX_FILE) throw new Error('파일이 너무 큽니다.');
  try { return JSON.parse(await file.text()); } catch { throw new Error('올바른 백업 파일이 아닙니다.'); }
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function avatar(a) {
  const name = (a.issuer || a.label || '?').trim(), el = h('div', { class: 'avatar' }, name.slice(0, 1).toUpperCase());
  let hue = 0; for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  el.style.background = `hsl(${hue} 42% 36%)`;
  return el;
}

// ---------- 설정 / 저장 / 잠금 ----------
async function loadSettings() {
  const s = await storage.get('settings');
  settings = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  if (![1, 5, 15, 30].includes(settings.autoLockMin)) settings.autoLockMin = DEFAULTS.autoLockMin;
  if (!['name', 'custom'].includes(settings.sortMode)) settings.sortMode = DEFAULTS.sortMode;
  if (!['off', 'browser', '1h', '8h'].includes(settings.keepUnlocked)) settings.keepUnlocked = DEFAULTS.keepUnlocked;
  if (!['off', '3d', '7d', '30d'].includes(settings.backupRemind)) settings.backupRemind = DEFAULTS.backupRemind;
  for (const k of ['lastBackupAt', 'dirtySince']) if (!Number.isFinite(settings[k])) settings[k] = null;
}
const saveSettings = () => storage.set('settings', settings);
async function save() {
  const env = await seal(session.key, { format: 'otp-vault', kdf: session.kdf }, { accounts: session.accounts });
  await storage.set('vault', env);
  if (!settings.dirtySince) { settings.dirtySince = Date.now(); await saveSettings(); } // 마지막 백업 이후 처음 바뀐 시각
}
async function markBackedUp() { settings.lastBackupAt = Date.now(); settings.dirtySince = null; await saveSettings(); }
function backupNag() {
  if (!session.accounts.length || settings.backupRemind === 'off') return null;
  if (!settings.lastBackupAt) return '아직 백업 파일을 만든 적이 없습니다.';
  const days = Math.floor((Date.now() - (settings.dirtySince ?? Date.now())) / 86400e3);
  return settings.dirtySince && days >= REMIND_DAYS[settings.backupRemind] ? `마지막 백업 이후 ${days}일 동안 바뀐 내용이 백업되지 않았습니다.` : null;
}
function armIdle() { clearTimeout(idle); if (session) idle = setTimeout(lock, settings.autoLockMin * 60 * 1000); }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => session && armIdle()));
function lock() { session = null; clearTimeout(idle); forget().finally(start); }

// ---------- "잠금 해제 유지": 키를 디스크가 아닌 브라우저 메모리(storage.session)에만 둔다 ----------
const wantsRemember = () => settings.keepUnlocked !== 'off' && sessionStore.available;
const forget = () => sessionStore.remove('unlock');
async function remember() {
  if (!wantsRemember() || !session) return;
  try {
    const ms = KEEP_MS[settings.keepUnlocked];
    await sessionStore.set('unlock', { jwk: await exportKey(session.key), salt: session.kdf.salt, expiresAt: ms ? Date.now() + ms : null });
  } catch { /* 키를 내보낼 수 없으면(설정을 막 바꾼 경우) 다음 잠금 해제부터 적용 */ }
}
async function tryRemembered(env) {
  const c = await sessionStore.get('unlock');
  if (!c) return null;
  const stale = !wantsRemember() || (c.expiresAt && Date.now() > c.expiresAt) || c.salt !== env.kdf.salt;
  if (!stale) {
    try { const key = await importKey(c.jwk); const { payload } = await openWithKey(env, key); return { key, kdf: env.kdf, accounts: payload.accounts }; }
    catch { /* 아래에서 지우고 비밀번호를 묻는다 */ }
  }
  await forget();
  return null;
}

// 중복(같은 서비스·계정 이름) 처리: policy 'skip' = 건너뜀, 'replace' = 새 값으로 덮어씀
function merge(list, policy = 'skip') {
  const index = new Map(session.accounts.map((a) => [accountKey(a), a]));
  let added = 0, replaced = 0, skipped = 0;
  for (const raw of list) {
    let a; try { a = normalizeAccount(raw); } catch { skipped++; continue; }
    const k = accountKey(a), ex = index.get(k);
    if (ex) { if (policy === 'replace') { Object.assign(ex, a); replaced++; } else skipped++; continue; }
    const rec = { ...a, id: crypto.randomUUID(), favorite: raw.favorite === true, createdAt: Date.now() };
    session.accounts.push(rec); index.set(k, rec); added++;
  }
  return { added, replaced, skipped };
}
function sorted() {
  const base = [...session.accounts];
  if (settings.sortMode === 'name') base.sort((x, y) => (x.issuer + x.label).localeCompare(y.issuer + y.label, 'ko'));
  return [...base.filter((a) => a.favorite), ...base.filter((a) => !a.favorite)];
}

// ---------- 시작 / 생성 / 잠금 해제 ----------
async function start() {
  await loadSettings();
  const env = await storage.get('vault');
  if (!env) return viewCreate();
  const hit = await tryRemembered(env);
  if (hit) { session = hit; armIdle(); return viewList(); }
  viewUnlock(env);
}

function restoreBox() {
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const pw = h('input', { type: 'password', autocomplete: 'off' });
  const rOut = h('div');
  const btn = h('button', { onclick: async () => {
    btn.disabled = true; show(rOut, '백업 파일을 확인하는 중입니다... (1~2초)', 'ok');
    try {
      const { payload } = await openVault(await readJsonFile(file.files[0]), pw.value, 'otp-vault-backup');
      const { env, key } = await createVault(pw.value, { accounts: [] }, 'otp-vault', wantsRemember());
      session = { key, kdf: env.kdf, accounts: [] };
      const r = merge(payload.accounts);
      await save(); await markBackedUp(); await remember(); armIdle(); viewList(); // 백업 비밀번호가 이 보관소의 마스터 비밀번호가 된다
      notify('복원을 완료했습니다', `계정 ${session.accounts.length}개를 복원했습니다.${r.skipped ? ` (${r.skipped}개는 올바르지 않아 건너뜀)` : ''} 백업 비밀번호가 이 보관소의 마스터 비밀번호가 되었습니다.`);
    } catch (e) { session = null; report(rOut, false, '백업을 복원하지 못했습니다', e.message + ' (보관소는 만들어지지 않았습니다)'); btn.disabled = false; }
  } }, '백업으로 복원');
  return h('div', {}, h('hr'), h('h2', {}, '백업 파일로 복원'), field('백업 파일', file), field('백업 비밀번호', pw), btn, rOut);
}

function viewCreate() {
  clear();
  const pw = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const out = h('div');
  const btn = h('button', { class: 'primary', onclick: async () => {
    if (pw.value.length < 10) return show(out, '비밀번호는 10자 이상으로 정해 주세요.');
    if (pw.value !== pw2.value) return show(out, '두 비밀번호가 서로 다릅니다.');
    btn.disabled = true;
    try {
      show(out, '암호 키를 계산하는 중입니다... (1~2초)', 'ok');
      const { env, key } = await createVault(pw.value, { accounts: [] }, 'otp-vault', wantsRemember());
      await storage.set('vault', env);
      session = { key, kdf: env.kdf, accounts: [] };
      await remember(); armIdle(); viewList();
    } catch (e) { show(out, e.message); btn.disabled = false; }
  } }, '보관소 만들기');
  root.append(title(),
    h('div', { class: 'warn' }, '마스터 비밀번호를 잊으면 개발자도 복구할 수 없습니다. 반드시 안전한 곳에 따로 적어 두세요. 모든 데이터는 이 브라우저 안에만 암호화되어 저장되며 서버로 전송되지 않습니다.'),
    field('마스터 비밀번호 (10자 이상)', pw), field('비밀번호 확인', pw2), btn, out,
    mode === 'page' ? restoreBox()
      : h('p', { class: 'hint' }, '백업 파일로 복원하려면 ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openManagePage(); } }, '관리 페이지'), '를 여세요.'));
}

function viewUnlock(env) {
  clear();
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const out = h('div');
  const go = async () => {
    btn.disabled = true;
    try {
      show(out, '암호 키를 계산하는 중입니다... (1~2초)', 'ok');
      let { payload, key } = await openVault(env, pw.value, 'otp-vault', wantsRemember());
      let kdf = env.kdf;
      if (kdf.name !== KDF_ARGON2) { // 이전 버전 보관소: 같은 비밀번호로 Argon2id 방식으로 자동 업그레이드
        show(out, '보안 방식을 Argon2id로 업그레이드하는 중입니다... (한 번만)', 'ok');
        const up = await createVault(pw.value, { accounts: payload.accounts }, 'otp-vault', wantsRemember());
        await storage.set('vault', up.env); key = up.key; kdf = up.env.kdf;
      }
      session = { key, kdf, accounts: payload.accounts };
      await remember(); armIdle(); viewList();
    } catch (e) { show(out, e.message); btn.disabled = false; pw.select(); }
  };
  const btn = h('button', { class: 'primary', onclick: go }, '잠금 해제');
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const sure = h('input', { type: 'text', placeholder: '삭제' });
  const del = h('button', { class: 'danger', onclick: async () => {
    if (sure.value.trim() !== '삭제') return show(out, '확인을 위해 "삭제"라고 입력해 주세요.');
    await storage.remove('vault'); await forget(); viewCreate();
  } }, '보관소 영구 삭제');
  root.append(title(), field('마스터 비밀번호', pw), btn, out,
    h('details', {}, h('summary', {}, '비밀번호를 잊었나요?'),
      h('p', { class: 'hint' }, '비밀번호를 복구할 방법은 없습니다. 이 보관소를 삭제하면 이 브라우저에 저장된 OTP가 모두 사라집니다. 백업 파일과 그 비밀번호가 있다면 삭제 후 관리 페이지에서 복원할 수 있습니다.'),
      field('계속하려면 "삭제"를 입력', sure), del));
  pw.focus();
}

// ---------- 목록 ----------
function viewList() {
  clear(); armIdle();
  const search = h('input', { type: 'search', placeholder: '검색' });
  const list = h('div'), toast = h('div', { class: 'toast' });
  let rows = [], toastTimer;
  const cache = new Map(); // 계정 id -> { counter, raw }: 다시 그릴 때 코드가 비어 보이지 않게 한다
  const flash = (t) => { toast.textContent = t; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast.textContent = ''), 1800); };
  const copyCode = async (code) => {
    if (!code.dataset.raw) return flash('코드를 계산하는 중입니다. 잠시 후 다시 눌러 주세요.');
    try { await navigator.clipboard.writeText(code.dataset.raw); flash('복사했습니다'); } catch { flash('복사하지 못했습니다'); }
  };
  const move = async (a, dir) => {
    const order = sorted(), i = order.indexOf(a), j = i + dir;
    if (j < 0 || j >= order.length || !!order[j].favorite !== !!a.favorite) return;
    [order[i], order[j]] = [order[j], order[i]];
    session.accounts = order; await save(); draw();
  };
  // 브라우저 대화상자(confirm)는 팝업에서 동작이 브라우저마다 달라서, 화면 안에서 두 번 눌러 확인한다.
  const deleteButton = (a) => {
    let armed = false, timer;
    const b = h('button', { class: 'ghost danger', title: '두 번 눌러 삭제', onclick: async () => {
      if (!armed) { armed = true; b.textContent = '정말 삭제?'; flash('한 번 더 누르면 삭제됩니다. 서비스에서 OTP를 다시 설정하기 전에는 복구할 수 없습니다.'); timer = setTimeout(() => { armed = false; b.textContent = '삭제'; }, 4000); return; }
      clearTimeout(timer); session.accounts = session.accounts.filter((x) => x.id !== a.id); await save(); draw();
    } }, '삭제');
    return b;
  };
  const update = async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      const a = r.a;
      if (a.type === 'hotp') { // 횟수 기반: 카운터가 바뀔 때만 다시 계산
        if (r.counter !== a.counter) {
          r.counter = a.counter;
          try { const raw = await hotp(decodeBase32(a.secret), a.counter, a); r.code.dataset.raw = raw; r.code.textContent = formatCode(raw); cache.set(a.id, { counter: a.counter, raw }); }
          catch { r.code.textContent = '오류'; }
        }
        r.sec.textContent = '카운터 ' + a.counter;
        continue;
      }
      const c = Math.floor(now / a.period);
      if (c !== r.counter) {
        r.counter = c;
        try { const raw = await totp(decodeBase32(a.secret), now, a); r.code.dataset.raw = raw; r.code.textContent = formatCode(raw); cache.set(a.id, { counter: c, raw }); }
        catch { r.code.textContent = '오류'; }
      }
      const left = a.period - (now % a.period);
      r.sec.textContent = left + '초';
      r.bar.style.width = (left / a.period * 100) + '%';
    }
  };
  function draw() {
    list.replaceChildren(); rows = [];
    const q = search.value.trim().toLowerCase();
    const items = sorted().filter((a) => !q || (a.issuer + ' ' + a.label).toLowerCase().includes(q));
    if (!items.length) list.append(h('p', { class: 'hint' }, session.accounts.length ? '검색 결과가 없습니다.' : '등록된 계정이 없습니다. "+ 추가"를 눌러 등록하세요.'));
    const canMove = mode === 'page' && settings.sortMode === 'custom' && !q;
    for (const a of items) {
      const code = h('div', { class: 'code', title: '클릭하면 복사', onclick: () => copyCode(code) }, '------');
      const sec = h('span'), bar = h('i');
      const star = h('button', { class: 'ghost star' + (a.favorite ? ' on' : ''), title: '즐겨찾기', 'aria-pressed': String(!!a.favorite),
        onclick: async () => { a.favorite = !a.favorite; await save(); draw(); } }, a.favorite ? '★' : '☆');
      const isH = a.type === 'hotp';
      const btns = [h('button', { class: 'ghost', onclick: () => copyCode(code) }, '복사'),
        h('button', { class: 'ghost', onclick: () => viewEdit(a) }, '수정'),
        deleteButton(a)];
      if (isH) btns.unshift(h('button', { class: 'ghost', title: '서비스에서 인증에 성공한 뒤 눌러 다음 번호로 넘깁니다', onclick: async () => { a.counter += 1; await save(); draw(); flash('다음 번호로 넘겼습니다'); } }, '다음 번호'));
      if (canMove) btns.push(h('button', { class: 'ghost', title: '위로', onclick: () => move(a, -1) }, '↑'), h('button', { class: 'ghost', title: '아래로', onclick: () => move(a, 1) }, '↓'));
      list.append(h('div', { class: 'row' },
        h('div', { class: 'head' }, avatar(a), h('div', { class: 'name' }, h('b', {}, a.issuer || '(서비스 이름 없음)'), h('span', {}, a.label)), star),
        code, h('div', { class: 'meta' }, isH ? [sec] : [h('div', { class: 'bar' }, bar), sec]), h('div', { class: 'btns' }, btns)));
      const hit = cache.get(a.id);
      if (hit) { code.dataset.raw = hit.raw; code.textContent = formatCode(hit.raw); }
      rows.push({ a, code, sec, bar, counter: hit ? hit.counter : -1 });
    }
    update();
  }
  search.addEventListener('input', draw);
  const nag = !snoozed && backupNag();
  root.append(h('div', { class: 'top' }, title(),
    h('button', { onclick: viewAdd }, '+ 추가'),
    mode === 'popup' ? h('button', { onclick: openManagePage }, '관리') : h('button', { onclick: viewSettings }, '설정·백업'),
    h('button', { onclick: lock }, '잠금')),
  ...(nag ? [h('div', { class: 'warn' }, nag + ' 백업 없이 확장프로그램을 지우거나 PC를 초기화하면 모든 OTP를 잃습니다. ',
    h('button', { class: 'ghost', onclick: mode === 'popup' ? openManagePage : viewSettings }, '백업하기'),
    h('button', { class: 'ghost', onclick: () => { snoozed = true; viewList(); } }, '나중에'))] : []),
  search, list, toast);
  draw();
  tick = setInterval(update, 1000);
  handlePendingQr(); // 화면에서 드래그로 읽은 QR이 기다리고 있으면 추가 여부를 묻는다 (관리 페이지에서만)
}

// ---------- 추가 / 수정 ----------
const algoSelect = (v) => { const s = h('select', {}, ['SHA1', 'SHA256', 'SHA512'].map((x) => h('option', { value: x }, x))); s.value = v; return s; };
const digitSelect = (v) => { const s = h('select', {}, [6, 7, 8, 9, 10].map((x) => h('option', { value: String(x) }, String(x)))); s.value = String(v); return s; };

function viewAdd() {
  clear(); armIdle();
  const out = h('div');
  const add = async (raw) => {
    try {
      const a = normalizeAccount(raw);
      if (merge([a]).added !== 1) throw new Error('같은 서비스·계정 이름이 이미 등록되어 있습니다.');
      await save(); viewList();
    } catch (e) { show(out, e.message); }
  };
  const fromText = async (text) => {
    if (/^otpauth-migration:/i.test(text.trim())) { // Google Authenticator "계정 내보내기" QR: 여러 계정이 한 번에 들어 있다
      const r = parseMigration(text), res = merge(r.accounts); await save();
      return show(out, `Google Authenticator에서 ${res.added}개를 추가했고 ${res.skipped + r.skipped}개는 건너뛰었습니다(중복 또는 지원하지 않는 항목). 내보내기 QR이 여러 장이면 나머지 QR도 같은 방법으로 가져오세요. 끝나면 "취소"를 눌러 목록으로 돌아가세요.`, 'ok');
    }
    await add(parseOtpauth(text));
  };
  const fromImage = async (blob) => { show(out, 'QR을 읽는 중...', 'ok'); try { await fromText(await scanQr(blob)); } catch (e) { show(out, e.message); } };
  const qrFile = h('input', { type: 'file', accept: 'image/*' });
  qrFile.addEventListener('change', () => qrFile.files[0] && fromImage(qrFile.files[0]));
  onPaste = (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); fromImage(f); } };
  document.addEventListener('paste', onPaste);
  const uri = h('input', { type: 'text', placeholder: 'otpauth://totp/...', autocomplete: 'off' });
  const issuer = h('input', { type: 'text' }), label = h('input', { type: 'text' }), secret = h('input', { type: 'text', autocomplete: 'off' });
  const algo = algoSelect('SHA1'), digits = digitSelect(6), period = h('input', { type: 'number', value: '30', min: '1', max: '3600' });
  const typeSel = h('select', {}, h('option', { value: 'totp' }, 'TOTP (시간 기반 — 대부분의 서비스)'), h('option', { value: 'hotp' }, 'HOTP (횟수 기반 — 드묾)'));
  typeSel.value = 'totp';
  const counter = h('input', { type: 'number', value: '0', min: '0' });
  root.append(h('div', { class: 'top' }, h('h1', {}, '계정 추가'), h('button', { onclick: viewList }, '취소')),
    screenQrSection(),
    h('h2', {}, '방법 2. QR 이미지 파일'),
    mode === 'page'
      ? h('div', {}, field('QR 이미지 파일 (PNG/JPG)', qrFile), h('p', { class: 'hint' }, '화면 캡처(Win+Shift+S)를 한 뒤 이 페이지에서 Ctrl+V로 붙여넣어도 됩니다. 이미지는 이 PC 안에서만 처리됩니다.'))
      : h('p', { class: 'hint' }, 'QR 이미지는 ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openManagePage(); } }, '관리 페이지'), '에서 가져올 수 있습니다. (팝업은 파일 선택 시 닫힙니다)'),
    h('h2', {}, '방법 3. otpauth 주소'), field('주소 (Google Authenticator 내보내기 주소도 가능)', uri),
    h('button', { class: 'primary', onclick: () => fromText(uri.value).catch((e) => show(out, e.message)) }, '주소로 등록'),
    h('hr'), h('h2', {}, '방법 4. 비밀키 직접 입력'),
    field('서비스 이름 (예: GitHub)', issuer), field('계정 이름 (예: me@example.com)', label), field('비밀키 (Base32)', secret),
    field('방식', typeSel), field('알고리즘', algo), field('자릿수', digits), field('주기(초, TOTP만)', period), field('카운터 (HOTP만)', counter),
    h('button', { class: 'primary', onclick: () => add({ type: typeSel.value, counter: counter.value, issuer: issuer.value, label: label.value, secret: secret.value, algorithm: algo.value, digits: digits.value, period: period.value }) }, '직접 입력으로 등록'),
    out, h('p', { class: 'hint' }, '비밀키와 QR은 다른 사람에게 보내거나 공개된 곳에 올리지 마세요.'));
}

function viewEdit(a) {
  clear(); armIdle();
  const out = h('div');
  const issuer = h('input', { type: 'text', value: a.issuer }), label = h('input', { type: 'text', value: a.label });
  const algo = algoSelect(a.algorithm), digits = digitSelect(a.digits), period = h('input', { type: 'number', value: String(a.period), min: '1', max: '3600' });
  const secret = h('input', { type: 'text', autocomplete: 'off', placeholder: '바꾸려면 새 비밀키 입력 (비워 두면 그대로)' });
  const isH = a.type === 'hotp', counter = h('input', { type: 'number', value: String(a.counter || 0), min: '0' });
  root.append(h('div', { class: 'top' }, h('h1', {}, '계정 수정'), h('button', { onclick: viewList }, '취소')),
    field('서비스 이름', issuer), field('계정 이름', label), field('알고리즘', algo), field('자릿수', digits), isH ? field('카운터 (서비스와 어긋났을 때 맞춤)', counter) : field('주기(초)', period), field('비밀키', secret),
    h('button', { class: 'primary', onclick: async () => {
      try {
        const n = normalizeAccount({ type: a.type, counter: counter.value, issuer: issuer.value, label: label.value, secret: secret.value.trim() || a.secret, algorithm: algo.value, digits: digits.value, period: period.value });
        if (session.accounts.some((x) => x.id !== a.id && accountKey(x) === accountKey(n))) throw new Error('같은 서비스·계정 이름이 이미 있습니다.');
        Object.assign(a, n); await save(); viewList();
      } catch (e) { show(out, e.message); }
    } }, '저장'), out);
}

// ---------- 설정 · 백업 (관리 페이지) ----------
function viewSettings() {
  clear(); armIdle();
  const out = h('div');
  const lockSel = h('select', {}, [1, 5, 15, 30].map((m) => h('option', { value: String(m) }, m + '분')));
  lockSel.value = String(settings.autoLockMin);
  const sortSel = h('select', {}, h('option', { value: 'name' }, '이름순'), h('option', { value: 'custom' }, '사용자 지정 (목록에서 ↑↓로 이동)'));
  sortSel.value = settings.sortMode;
  const keepSel = h('select', {}, h('option', { value: 'off' }, '끄기 (팝업을 열 때마다 비밀번호 입력)'), h('option', { value: 'browser' }, '브라우저를 끌 때까지'),
    h('option', { value: '1h' }, '1시간'), h('option', { value: '8h' }, '8시간'));
  keepSel.value = settings.keepUnlocked;
  const remSel = h('select', {}, h('option', { value: 'off' }, '끄기'), h('option', { value: '3d' }, '변경 후 3일'), h('option', { value: '7d' }, '변경 후 7일'), h('option', { value: '30d' }, '변경 후 30일'));
  remSel.value = settings.backupRemind;
  const onSet = async () => {
    const keepChanged = keepSel.value !== settings.keepUnlocked;
    settings.autoLockMin = Number(lockSel.value); settings.sortMode = sortSel.value; settings.keepUnlocked = keepSel.value; settings.backupRemind = remSel.value;
    await saveSettings(); armIdle();
    if (keepChanged) { await forget(); show(out, '저장했습니다. "잠금 해제 유지"는 다음에 마스터 비밀번호를 입력해 잠금을 풀 때부터 적용됩니다.', 'ok'); }
    else show(out, '설정을 저장했습니다.', 'ok');
  };
  lockSel.addEventListener('change', onSet); sortSel.addEventListener('change', onSet); keepSel.addEventListener('change', onSet); remSel.addEventListener('change', onSet);

  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const pwOut = h('div'), expOut = h('div'), impOut = h('div');
  const pwBtn = h('button', { onclick: async () => {
    pwBtn.disabled = true; show(pwOut, '변경하는 중입니다... (1~2초)', 'ok');
    try {
      if (n1.value.length < 10) throw new Error('새 비밀번호는 10자 이상이어야 합니다.');
      if (n1.value !== n2.value) throw new Error('새 비밀번호 두 칸이 서로 다릅니다.');
      await openVault(await storage.get('vault'), cur.value); // 현재 비밀번호 확인
      const { env, key } = await createVault(n1.value, { accounts: session.accounts }, 'otp-vault', wantsRemember()); // 새 salt로 다시 암호화
      await storage.set('vault', env); session.key = key; session.kdf = env.kdf;
      await forget(); await remember();
      cur.value = n1.value = n2.value = '';
      report(pwOut, true, '비밀번호를 바꿨습니다', '이전에 만든 백업 파일은 이전 비밀번호로 암호화되어 있으니 새 백업을 만들어 두세요.');
    } catch (e) { report(pwOut, false, '비밀번호를 바꾸지 못했습니다', e.message); }
    pwBtn.disabled = false;
  } }, '비밀번호 변경');

  const file = h('input', { type: 'file', accept: '.json,application/json' }), bpw = h('input', { type: 'password', autocomplete: 'off' });
  const policy = h('select', {}, h('option', { value: 'skip' }, '건너뛰기 (기존 유지)'), h('option', { value: 'replace' }, '덮어쓰기 (백업 값으로 교체)'));
  const exportBtn = h('button', { class: 'primary', onclick: async () => {
    try {
      const env = await seal(session.key, { format: 'otp-vault-backup', kdf: session.kdf }, { accounts: session.accounts });
      const d = new Date(), p = (x) => String(x).padStart(2, '0'), name = `otp-vault-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
      download(name, JSON.stringify(env, null, 2));
      await markBackedUp();
      report(expOut, true, '백업 파일을 저장했습니다', `파일 이름: ${name} (브라우저의 다운로드 폴더를 확인하세요). 계정 ${session.accounts.length}개가 들어 있고 현재 마스터 비밀번호로 암호화되어 있습니다.`);
    } catch (e) { report(expOut, false, '백업 파일을 만들지 못했습니다', e.message); }
  } }, '암호화 백업 내보내기');
  const importBtn = h('button', { class: 'primary', onclick: async () => {
    importBtn.disabled = true; show(impOut, '백업 파일을 확인하는 중입니다... (1~2초)', 'ok');
    try {
      const { payload } = await openVault(await readJsonFile(file.files[0]), bpw.value, 'otp-vault-backup');
      const r = merge(payload.accounts, policy.value); await save();
      report(impOut, true, '백업을 가져왔습니다', `${r.added}개 추가, ${r.replaced}개 덮어씀, ${r.skipped}개 건너뜀(중복 또는 올바르지 않음). 현재 계정은 모두 ${session.accounts.length}개입니다.`);
    } catch (e) { report(impOut, false, '백업을 가져오지 못했습니다', e.message + ' (아무것도 가져오지 않았습니다)'); }
    importBtn.disabled = false;
  } }, '백업 가져오기');

  const diagOut = h('div', { class: 'diag' }), diagNote = h('div');
  let diagText = '';
  const paint = (items) => {
    const s = summarize(items);
    diagOut.replaceChildren(h('div', { class: 'dsum ' + (s.fail ? 'bad' : 'good') }, `${s.fail ? '✗' : '✓'} 전체 결과: 통과 ${s.pass} · 실패 ${s.fail} · 참고 ${s.info}${s.fail ? '' : ' — 모두 정상'}`),
      ...items.map((i) => h('div', { class: 'dl' }, h('span', { class: 'tag ' + (i.ok === true ? 'ok' : i.ok === false ? 'fail' : 'info') }, i.ok === true ? '[통과]' : i.ok === false ? '[실패]' : '[참고]'), ' ' + i.name + (i.detail ? ' — ' + i.detail : ''))));
  };
  const diagCopy = h('button', { class: 'ghost', onclick: async () => {
    if (!diagText) return show(diagNote, '먼저 "진단 실행"을 눌러 주세요.');
    try { await navigator.clipboard.writeText(diagText); show(diagNote, '✓ 진단 결과를 복사했습니다.', 'ok'); } catch { show(diagNote, '복사하지 못했습니다. 위 내용을 직접 선택해 복사하세요.'); }
  } }, '결과 복사');
  const diagBtn = h('button', { onclick: async () => {
    diagBtn.disabled = true; diagNote.replaceChildren(); diagOut.replaceChildren(h('div', { class: 'dl' }, '진단 중... (몇 초 걸립니다)'));
    try { const items = await runDiagnostics({ storage, sessionStore, manifest }); diagText = formatReport(items); paint(items); }
    catch (e) { diagOut.replaceChildren(h('div', { class: 'dsum bad' }, '✗ 진단 실패: ' + e.message)); }
    diagBtn.disabled = false;
  } }, '진단 실행');
  root.append(h('div', { class: 'top' }, h('h1', {}, '설정·백업'), h('button', { onclick: viewList }, '돌아가기')), out,
    h('h2', {}, '일반'), field('자동 잠금 (관리 페이지에서 조작이 없을 때)', lockSel), field('목록 정렬', sortSel),
    field('잠금 해제 유지 (이 PC에서 비밀번호 입력 줄이기)', keepSel),
    h('p', { class: 'hint' }, '켜면 비밀번호를 한 번 입력한 뒤 정한 기간 동안 팝업을 열 때 다시 묻지 않습니다. 암호 키는 디스크에 저장되지 않고 브라우저 메모리에만 있으며, 잠금 버튼·자동 잠금·브라우저 종료·기간 만료 시 사라집니다. 잠금이 풀려 있는 동안 이 PC를 쓰는 사람은 OTP를 볼 수 있으니 자리를 비울 때는 Win+L로 PC를 잠그세요. 공용 PC에서는 끄세요.'),
    field('백업 알림 (아직 백업하지 않은 변경이 있을 때)', remSel),
    h('p', { class: 'hint' }, `마지막 백업: ${settings.lastBackupAt ? new Date(settings.lastBackupAt).toLocaleString('ko-KR') : '없음'} · 암호화 방식: ${session.kdf.name}`),
    h('hr'), h('h2', {}, '마스터 비밀번호 변경'), field('현재 비밀번호', cur), field('새 비밀번호 (10자 이상)', n1), field('새 비밀번호 확인', n2), pwBtn, pwOut,
    h('hr'), h('h2', {}, '백업 내보내기'),
    h('div', { class: 'warn' }, '확장프로그램을 삭제하거나 브라우저 프로필·PC를 초기화하면 보관소가 사라집니다. 백업 파일을 별도 장소에 보관하세요. 다른 브라우저(Chrome ↔ Edge ↔ Firefox)로 옮길 때도 이 파일을 쓰며, 같은 마스터 비밀번호로 복원합니다.'), exportBtn, expOut,
    h('hr'), h('h2', {}, '백업 가져오기 (기존 계정에 합침)'),
    h('p', { class: 'hint' }, '가져오기 전에 현재 상태를 먼저 백업해 두는 것을 권장합니다. 백업 파일이 손상되었거나 비밀번호가 틀리면 아무것도 가져오지 않습니다.'),
    field('백업 파일', file), field('백업 비밀번호', bpw), field('같은 서비스·계정 이름이 있을 때', policy), importBtn, impOut,
    h('hr'), h('h2', {}, '자가 진단'),
    h('p', { class: 'hint' }, '이 브라우저에서 핵심 기능(암호화·OTP 계산·저장소·QR 판독 등)이 실제로 동작하는지 확인합니다. 계정 데이터는 건드리지 않습니다. 문제가 있으면 결과를 복사해 개발자에게 보내 주세요.'),
    h('div', { class: 'btns' }, diagBtn, diagCopy), diagNote, diagOut,
    h('hr'), h('h2', {}, '보안 안내'),
    h('p', { class: 'hint' }, 'PC의 악성코드·키로거, 브라우저 자체 침해, 잠금이 풀려 있는 동안의 메모리 접근, 클립보드 감시는 이 프로그램만으로 막을 수 없습니다. OTP는 가짜 사이트에 번호를 입력하게 만드는 실시간 피싱도 완전히 막지 못하므로, 서비스가 지원하면 Passkey 같은 피싱 저항 인증도 함께 쓰세요. 마스터 비밀번호를 잊으면 복구할 수 없습니다.'));
}

if (mode === 'page') onSessionChange((ch) => { if (ch[PENDING_KEY] && ch[PENDING_KEY].newValue && session) handlePendingQr(); });
start();
