import { normalizeAccount } from './account.js';

// otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=...&digits=...&period=...
export function parseOtpauth(uri) {
  const m = /^otpauth:\/\/([a-z]+)\/([^?]*)\?(.*)$/i.exec(String(uri).trim());
  if (!m) throw new Error('otpauth:// 로 시작하는 올바른 주소가 아닙니다.');
  const type = m[1].toLowerCase();
  if (type !== 'totp' && type !== 'hotp') throw new Error('지원하지 않는 OTP 종류입니다.');
  let label;
  try { label = decodeURIComponent(m[2]); } catch { throw new Error('계정 이름의 인코딩이 잘못되었습니다.'); }
  const q = new URLSearchParams(m[3]);
  if (!q.get('secret')) throw new Error('주소에 secret(비밀키)이 없습니다.');
  if (type === 'hotp' && q.get('counter') === null) throw new Error('HOTP 주소에 counter(카운터)가 없습니다.');
  let issuer = (q.get('issuer') || '').trim();
  let name = label;
  const i = label.indexOf(':');
  if (i >= 0) {
    name = label.slice(i + 1).trim();
    if (!issuer) issuer = label.slice(0, i).trim();
  }
  return normalizeAccount({
    type, counter: q.get('counter') ?? 0, issuer, label: name, secret: q.get('secret'),
    algorithm: q.get('algorithm') || 'SHA1',
    digits: q.get('digits') || 6,
    period: q.get('period') || 30,
  });
}
