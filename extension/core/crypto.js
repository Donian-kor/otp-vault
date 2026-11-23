// 마스터 비밀번호 -> Argon2id(신규) 또는 PBKDF2-HMAC-SHA256(0.3 이전 보관소) -> AES-256-GCM.
// 형식·버전·KDF 매개변수 전체를 AAD로 묶어, 헤더를 바꾸면 복호화가 실패한다.
import { argon2id } from './argon2.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_PBKDF2 = 'PBKDF2-HMAC-SHA256';
export const KDF_ARGON2 = 'Argon2id';
export const KDF_NAME = KDF_PBKDF2; // 이전 이름 호환
export const CIPHER_NAME = 'AES-256-GCM';
export const FORMAT_VERSION = 2;    // 1: PBKDF2 전용(0.1~0.3), 2: Argon2id 지원 + HOTP 계정
export const ITERATIONS = 600000;   // PBKDF2 (읽기 호환용)
// 신규 보관소의 Argon2id 매개변수: OWASP 권고 최소 구성(m=19 MiB, t=2, p=1). 시험에서만 줄여 쓴다.
export const kdfDefaults = { memoryKiB: 19456, iterations: 2 };
const BAD_FILE = '지원하지 않거나 손상된 파일입니다.';

export const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};
const tick = () => new Promise((r) => setTimeout(r, 30)); // 오래 걸리는 계산 전에 "계산 중" 문구가 화면에 그려질 틈을 준다

async function deriveKey(password, kdf, salt, extractable) {
  const usages = ['encrypt', 'decrypt'];
  if (kdf.name === KDF_ARGON2) {
    await tick();
    const raw = argon2id({ password: enc.encode(password), salt, t: kdf.iterations, m: kdf.memoryKiB, p: kdf.parallelism, dkLen: 32 });
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, usages);
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iterations }, base,
    { name: 'AES-GCM', length: 256 }, extractable, usages);
}

// AAD에 들어가는 KDF 필드. 키 순서가 고정되어야 하며, PBKDF2는 이전 버전과 같은 형태를 유지한다.
const kdfAad = (k) => (k.name === KDF_ARGON2
  ? { name: k.name, version: k.version, memoryKiB: k.memoryKiB, iterations: k.iterations, parallelism: k.parallelism, salt: k.salt }
  : { name: k.name, iterations: k.iterations, salt: k.salt });
const aad = (format, formatVersion, kdf) => enc.encode(JSON.stringify({ format, formatVersion, kdf: kdfAad(kdf) }));

export async function seal(key, { format, formatVersion = FORMAT_VERSION, kdf }, payload) {
  const nonce = crypto.getRandomValues(new Uint8Array(12)); // 암호화할 때마다 새 nonce
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(format, formatVersion, kdf) },
    key, enc.encode(JSON.stringify(payload)));
  return { format, formatVersion, kdf, cipher: { name: CIPHER_NAME, nonce: b64(nonce), ciphertext: b64(new Uint8Array(ct)) } };
}

// extractable=true 는 "잠금 해제 유지"(키를 브라우저 메모리에만 보관)를 켠 경우에만 쓴다.
export async function createVault(password, payload, format = 'otp-vault', extractable = false, kdfName = KDF_ARGON2) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const kdf = kdfName === KDF_ARGON2
    ? { name: KDF_ARGON2, version: 19, memoryKiB: kdfDefaults.memoryKiB, iterations: kdfDefaults.iterations, parallelism: 1, salt: b64(saltBytes) }
    : { name: KDF_PBKDF2, iterations: ITERATIONS, salt: b64(saltBytes) };
  const key = await deriveKey(password, kdf, saltBytes, extractable);
  return { env: await seal(key, { format, formatVersion: FORMAT_VERSION, kdf }, payload), key };
}

function validKdf(k) {
  if (!k || typeof k.salt !== 'string') return false;
  if (k.name === KDF_PBKDF2) return Number.isInteger(k.iterations) && k.iterations >= 100000 && k.iterations <= 5000000;
  if (k.name === KDF_ARGON2) // 변조된 파일로 과도한 메모리·시간을 쓰지 않도록 상한을 둔다
    return k.version === 19 && k.parallelism === 1 && Number.isInteger(k.iterations) && k.iterations >= 1 && k.iterations <= 10 &&
      Number.isInteger(k.memoryKiB) && k.memoryKiB >= 8 && k.memoryKiB <= 65536;
  return false;
}
function parseEnvelope(env, format) {
  try {
    const ok = env && env.format === format && (env.formatVersion === 1 || env.formatVersion === 2) && validKdf(env.kdf) &&
      env.cipher && env.cipher.name === CIPHER_NAME && typeof env.cipher.nonce === 'string' && typeof env.cipher.ciphertext === 'string';
    if (!ok) throw new Error(BAD_FILE);
    const salt = unb64(env.kdf.salt), nonce = unb64(env.cipher.nonce), ct = unb64(env.cipher.ciphertext);
    if (salt.length !== 16 || nonce.length !== 12 || ct.length < 16) throw new Error(BAD_FILE);
    return { salt, nonce, ct };
  } catch { throw new Error(BAD_FILE); }
}

export async function openVault(env, password, format = 'otp-vault', extractable = false) {
  const { salt } = parseEnvelope(env, format);
  const key = await deriveKey(password, env.kdf, salt, extractable);
  return openWithKey(env, key, format);
}

export const exportKey = (key) => crypto.subtle.exportKey('jwk', key);
export const importKey = (jwk) => crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

// 이미 만들어진 키로 복호화 (비밀번호 없이 "잠금 해제 유지"에서 사용)
export async function openWithKey(env, key, format = 'otp-vault') {
  const { nonce, ct } = parseEnvelope(env, format);
  let payload;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(env.format, env.formatVersion, env.kdf) }, key, ct);
    payload = JSON.parse(dec.decode(pt));
  } catch { throw new Error('비밀번호가 틀렸거나 데이터가 손상되었습니다.'); }
  if (!payload || !Array.isArray(payload.accounts)) throw new Error(BAD_FILE);
  return { payload, key };
}
