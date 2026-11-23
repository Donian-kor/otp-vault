import { decodeBase32 } from './base32.js';

export const ALGOS = ['SHA1', 'SHA256', 'SHA512'];
export const cleanSecret = (s) => String(s).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

// 등록·URI·백업 가져오기 모두 이 검증을 거친다.
export function normalizeAccount(a) {
  const type = String(a.type || 'totp').toLowerCase();
  const acc = {
    type,
    issuer: String(a.issuer ?? '').trim().slice(0, 100),
    label: String(a.label ?? '').trim().slice(0, 200),
    secret: cleanSecret(a.secret ?? ''),
    algorithm: String(a.algorithm ?? 'SHA1').toUpperCase(),
    digits: Number(a.digits ?? 6),
    period: Number(a.period ?? 30),
  };
  if (!['totp', 'hotp'].includes(type)) throw new Error('지원하지 않는 OTP 방식입니다. (TOTP, HOTP)');
  if (!acc.label) throw new Error('계정 이름을 입력해 주세요.');
  decodeBase32(acc.secret);
  if (!ALGOS.includes(acc.algorithm)) throw new Error('지원하지 않는 알고리즘입니다. (SHA1, SHA256, SHA512)');
  if (!Number.isInteger(acc.digits) || acc.digits < 6 || acc.digits > 10) throw new Error('자릿수는 6~10이어야 합니다.');
  if (!Number.isInteger(acc.period) || acc.period < 1 || acc.period > 3600) throw new Error('주기는 1~3600초여야 합니다.');
  if (type === 'hotp') {
    const c = Number(a.counter ?? 0);
    if (!Number.isSafeInteger(c) || c < 0) throw new Error('카운터는 0 이상의 정수여야 합니다.');
    acc.counter = c;
  }
  return acc;
}

// 같은 서비스·같은 계정 이름이면 중복으로 본다 (대소문자 무시)
export const accountKey = (a) => (a.issuer.trim() + '|' + a.label.trim()).toLowerCase();
