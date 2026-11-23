// 화면 영역 QR 가져오기의 핵심 로직. 브라우저 API와 이미지 처리는 밖에서 주입받으므로 Node에서도 시험할 수 있다.
// 흐름: (내용 스크립트) 드래그로 영역 지정 → 메시지 → (이 로직) 화면 캡처 → 영역 자르기 → QR 해독 → 임시 저장 → 관리 페이지 열기
export const PENDING_KEY = 'qrPending';
export const MSG = 'otpvault-qr-region';
const MAX = 20000;
export const SCALES = [1, 2, 0.5]; // 해독이 안 되면 확대/축소해서 다시 시도

const num = (v) => typeof v === 'number' && Number.isFinite(v);
export function validRegion(m) {
  const r = m && m.rect;
  return !!(m && m.type === MSG && r && [r.x, r.y, r.w, r.h, m.vw, m.vh].every(num) &&
    r.x >= 0 && r.y >= 0 && r.w >= 8 && r.h >= 8 && r.w <= MAX && r.h <= MAX && m.vw > 0 && m.vh > 0 && m.vw <= MAX && m.vh <= MAX);
}
// data:image/png;base64,... 주소 → 바이트 (fetch 없이 직접 변환: 코드에 네트워크 호출이 없도록)
export function dataUrlBytes(url) {
  const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
  if (!m) throw new Error('올바르지 않은 이미지 주소');
  const bin = atob(m[2]), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { type: m[1] || 'image/png', bytes: out };
}
// 화면(CSS 픽셀) 영역 → 스크린샷(실제 픽셀) 영역. 모니터 배율·브라우저 확대/축소는 이미지 폭 ÷ 화면 폭으로 자동 반영된다.
export function mapRect(r, vw, vh, imgW, imgH) {
  const kx = imgW / vw, ky = imgH / vh;
  const x = Math.min(imgW - 1, Math.max(0, Math.floor(r.x * kx))), y = Math.min(imgH - 1, Math.max(0, Math.floor(r.y * ky)));
  return { x, y, w: Math.max(1, Math.min(imgW - x, Math.ceil(r.w * kx))), h: Math.max(1, Math.min(imgH - y, Math.ceil(r.h * ky))) };
}
// 지정한 영역이 QR에 딱 붙어 있어도 읽히도록 둘레에 흰 여백(콰이엇 존)을 붙인다
export const padFor = (w, h) => Math.max(8, Math.round(Math.min(w, h) * 0.12));

const FAIL_CAPTURE = '화면을 캡처하지 못했습니다. 확장프로그램 아이콘을 눌러 다시 시작해 주세요.';
export function createRegionHandler({ api, crop, decode }) {
  return async function handle(msg, sender) {
    if (!sender || sender.id !== api.runtime.id || !sender.tab) return { ok: false, error: '허용되지 않은 요청입니다.' };
    if (!validRegion(msg)) return { ok: false, error: '영역 정보가 올바르지 않습니다.' };
    if (!api.storage.session) return { ok: false, error: '이 브라우저는 임시 저장소를 지원하지 않아 화면 QR 가져오기를 쓸 수 없습니다.' };
    let dataUrl;
    try { dataUrl = await api.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }); } catch { return { ok: false, error: FAIL_CAPTURE }; }
    let text = null;
    for (const scale of SCALES) {
      const img = await crop(dataUrl, msg.rect, msg.vw, msg.vh, scale);
      text = img ? decode(img) : null;
      if (text) break;
    }
    if (!text) return { ok: false, error: 'QR 코드를 찾지 못했습니다. QR 전체가 영역 안에 들어오게 다시 드래그해 주세요.' };
    text = text.trim();
    if (!/^otpauth(-migration)?:\/\//i.test(text)) return { ok: false, error: 'OTP 등록용 QR이 아닙니다. (otpauth:// 로 시작하지 않는 QR)' };
    // 비밀키가 들어 있으므로 디스크가 아닌 브라우저 메모리(storage.session)에만 잠깐 둔다. 관리 페이지가 확인을 받은 뒤 바로 지운다.
    await api.storage.session.set({ [PENDING_KEY]: { text, at: Date.now() } });
    await api.runtime.openOptionsPage();
    return { ok: true };
  };
}
