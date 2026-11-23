// 백그라운드(Chrome·Edge: 서비스 워커, Firefox: 이벤트 페이지). 암호 키나 보관소는 다루지 않는다.
// 하는 일: 내용 스크립트가 보낸 영역으로 화면을 캡처하고, 그 부분만 잘라 QR을 해독한다.
import { decodeQR } from './core/qr.js';
import { createRegionHandler, mapRect, padFor, dataUrlBytes, MSG } from './core/screenqr.js';

const api = globalThis.browser ?? globalThis.chrome;

async function crop(dataUrl, rect, vw, vh, scale) {
  const img = dataUrlBytes(dataUrl);
  const bmp = await createImageBitmap(new Blob([img.bytes], { type: img.type }));
  const s = mapRect(rect, vw, vh, bmp.width, bmp.height), pad = padFor(s.w, s.h);
  const W = Math.round((s.w + 2 * pad) * scale), H = Math.round((s.h + 2 * pad) * scale);
  const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = scale < 1; // 확대할 때는 QR 모서리를 뭉개지 않는다
  ctx.drawImage(bmp, s.x, s.y, s.w, s.h, Math.round(pad * scale), Math.round(pad * scale), Math.round(s.w * scale), Math.round(s.h * scale));
  bmp.close?.();
  return ctx.getImageData(0, 0, W, H);
}

const handle = createRegionHandler({ api, crop, decode: decodeQR });
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== MSG) return false;
  handle(msg, sender).then(sendResponse, () => sendResponse({ ok: false, error: '화면을 캡처하지 못했습니다. 확장프로그램 아이콘을 눌러 다시 시작해 주세요.' }));
  return true; // 비동기 응답
});
