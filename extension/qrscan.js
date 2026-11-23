// 이미지 파일/클립보드 이미지에서 QR 문자열을 읽는다. 브라우저가 지원하면 내장 BarcodeDetector를 먼저 쓰고,
// 아니면 core/qr.js의 자체 디코더를 쓴다. 모두 이 PC 안에서 처리되며 이미지는 어디에도 전송·저장되지 않는다.
import { decodeQR } from './core/qr.js';

export async function scanQr(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch { throw new Error('이미지 파일을 열 수 없습니다. PNG 또는 JPG 파일인지 확인해 주세요.'); }
  if ('BarcodeDetector' in globalThis) {
    try {
      const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
      if (r.length && r[0].rawValue) return r[0].rawValue;
    } catch { /* 자체 디코더로 계속 */ }
  }
  for (const maxSide of [2400, 1200, 800]) {
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
    const text = decodeQR(ctx.getImageData(0, 0, w, h));
    if (text) return text;
  }
  throw new Error('QR 코드를 읽지 못했습니다. QR 부분만 크게 잘라서 다시 시도하거나 비밀키를 직접 입력해 주세요.');
}
