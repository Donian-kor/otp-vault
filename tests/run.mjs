import assert from 'node:assert/strict';
import { decodeBase32 } from '../extension/core/base32.js';
import { hotp, totp, formatCode } from '../extension/core/totp.js';
import { normalizeAccount } from '../extension/core/account.js';
import { parseOtpauth } from '../extension/core/uri.js';
import { parseMigration, encodeBase32 } from '../extension/core/migration.js';
import { migrationUri } from './pb.mjs';
import { createVault, openVault, openWithKey, exportKey, importKey, seal, b64, unb64, kdfDefaults, KDF_PBKDF2, KDF_ARGON2 } from '../extension/core/crypto.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message); }
};
const rejects = (p, re) => assert.rejects(p, re);
const bytes = (s) => new TextEncoder().encode(s);

console.log('RFC 6238 테스트 벡터 (8자리)');
const seeds = { SHA1: '12345678901234567890', SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234' };
const vec = { // 시간: [SHA1, SHA256, SHA512]
  59: ['94287082', '46119246', '90693936'],
  1111111109: ['07081804', '68084774', '25091201'],
  1111111111: ['14050471', '67062674', '99943326'],
  1234567890: ['89005924', '91819424', '93441116'],
  2000000000: ['69279037', '90698825', '38618901'],
  20000000000: ['65353130', '77737706', '47863826'],
};
for (const [time, exp] of Object.entries(vec)) {
  ['SHA1', 'SHA256', 'SHA512'].forEach((alg, i) =>
    t(`${alg} T=${time}`, async () =>
      assert.equal(await totp(bytes(seeds[alg]), Number(time), { algorithm: alg, digits: 8 }), exp[i])));
}
await t('6자리는 8자리의 마지막 6자리', async () =>
  assert.equal(await totp(bytes(seeds.SHA1), 59, { digits: 6 }), '287082'));
await t('앞자리 0 유지', async () => {
  const c = await totp(bytes(seeds.SHA1), 1111111109, { digits: 6 });
  assert.equal(c, '081804'); assert.equal(formatCode(c), '081 804');
});
await t('30초 경계 전후로 코드가 바뀜', async () => {
  const k = bytes(seeds.SHA1);
  assert.equal(await totp(k, 59), await totp(k, 30));
  assert.notEqual(await totp(k, 59), await totp(k, 60));
});

console.log('Base32 / URI');
await t('Base32 디코딩(대소문자·공백·패딩)', () => {
  const a = decodeBase32('JBSWY3DPEHPK3PXP');
  assert.equal(new TextDecoder().decode(a.slice(0, 6)), 'Hello!');
  assert.deepEqual(decodeBase32('jbsw y3dp ehpk 3pxp===='), a);
});
await t('Base32 잘못된 문자·빈 값 거부', () => {
  assert.throws(() => decodeBase32('JBSWY3DPEHPK3PX1'));
  assert.throws(() => decodeBase32('   '));
});
await t('URI 파싱', () => {
  const a = parseOtpauth('otpauth://totp/GitHub:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60');
  assert.deepEqual(a, { type: 'totp', issuer: 'GitHub', label: 'alice@example.com', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60 });
});
await t('URI 한글 라벨', () => {
  const a = parseOtpauth('otpauth://totp/%EB%84%A4%EC%9D%B4%EB%B2%84:%ED%99%8D%EA%B8%B8%EB%8F%99?secret=JBSWY3DPEHPK3PXP');
  assert.equal(a.issuer, '네이버'); assert.equal(a.label, '홍길동');
});
await t('URI 거부: hotp / 알고리즘 / 자릿수 / secret 없음 / 형식', () => {
  const base = 'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP';
  assert.throws(() => parseOtpauth('otpauth://hotp/A:b?secret=JBSWY3DPEHPK3PXP'), /counter/);
  assert.throws(() => parseOtpauth('otpauth://steam/A:b?secret=JBSWY3DPEHPK3PXP'));
  assert.throws(() => parseOtpauth(base + '&algorithm=MD5'));
  assert.throws(() => parseOtpauth(base + '&digits=11'));
  assert.throws(() => parseOtpauth(base + '&period=0'));
  assert.throws(() => parseOtpauth('otpauth://totp/A:b?issuer=x'));
  assert.throws(() => parseOtpauth('https://example.com'));
});

console.log('암호화 보관소');
// 시험 속도를 위해 Argon2id 메모리를 줄인다. 실제 기본값은 아래 '기본 매개변수' 시험에서 따로 확인한다.
const REAL = { ...kdfDefaults };
kdfDefaults.memoryKiB = 64;
const payload = { accounts: [{ issuer: 'GitHub', label: 'a@b.c', secret: 'JBSWY3DPEHPK3PXP' }] };
const { env, key } = await createVault('correct horse battery', payload);
await t('올바른 비밀번호로 복호화', async () =>
  assert.deepEqual((await openVault(env, 'correct horse battery')).payload, payload));
await t('틀린 비밀번호 거부', () => rejects(openVault(env, 'wrong password!!'), /비밀번호/));
await t('저장 데이터에 평문 비밀키 없음', () => assert.ok(!JSON.stringify(env).includes('JBSWY3DPEHPK3PXP')));
await t('암호문 변조 시 거부', async () => {
  const bad = structuredClone(env); const u = unb64(bad.cipher.ciphertext); u[0] ^= 1; bad.cipher.ciphertext = b64(u);
  await rejects(openVault(bad, 'correct horse battery'), /손상/);
});
await t('nonce 변조 시 거부', async () => {
  const bad = structuredClone(env); const u = unb64(bad.cipher.nonce); u[0] ^= 1; bad.cipher.nonce = b64(u);
  await rejects(openVault(bad, 'correct horse battery'), /손상/);
});
await t('KDF 헤더(반복 횟수/salt) 변조 시 거부', async () => {
  const a = structuredClone(env); a.kdf.iterations += 1;
  await rejects(openVault(a, 'correct horse battery'), /손상/);
  const b = structuredClone(env); const s = unb64(b.kdf.salt); s[0] ^= 1; b.kdf.salt = b64(s);
  await rejects(openVault(b, 'correct horse battery'), /손상/);
});
await t('과도한 KDF 반복 횟수 즉시 거부', async () => {
  const a = structuredClone(env); a.kdf.iterations = 1e9;
  const t0 = Date.now(); await rejects(openVault(a, 'x'), /파일/); assert.ok(Date.now() - t0 < 500);
});
await t('형식 이름이 다르면 거부(보관소 ↔ 백업 바꿔치기)', () =>
  rejects(openVault(env, 'correct horse battery', 'otp-vault-backup'), /파일/));
await t('nonce 100회 모두 다름', async () => {
  const set = new Set();
  for (let i = 0; i < 100; i++) set.add((await seal(key, { format: 'otp-vault', kdf: env.kdf }, payload)).cipher.nonce);
  assert.equal(set.size, 100);
});
await t('백업 내보내기 → 복원', async () => {
  const bk = await seal(key, { format: 'otp-vault-backup', kdf: env.kdf }, payload);
  assert.deepEqual((await openVault(bk, 'correct horse battery', 'otp-vault-backup')).payload, payload);
});


console.log('잠금 해제 유지용 키 처리');
await t('기본값: 키를 내보낼 수 없음(non-extractable)', () => rejects(exportKey(key), /./));
await t('extractable 옵션: 내보냈다가 가져온 키로 비밀번호 없이 복호화', async () => {
  const v = await createVault('correct horse battery', payload, 'otp-vault', true);
  const jwk = await exportKey(v.key);
  assert.equal((await openWithKey(v.env, await importKey(jwk))).payload.accounts[0].issuer, 'GitHub');
});
await t('다른 보관소의 키로는 복호화 거부', async () => {
  const other = await createVault('another password!!', payload, 'otp-vault', true);
  await rejects(openWithKey(env, await importKey(await exportKey(other.key))), /손상|틀렸/);
});
await t('openVault(extractable=true)도 같은 결과', async () => {
  const r = await openVault(env, 'correct horse battery', 'otp-vault', true);
  assert.equal(typeof (await exportKey(r.key)).k, 'string');
});


console.log('HOTP (RFC 4226 부록 D 시험 벡터)');
const hv = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
for (let c = 0; c < 10; c++) await t(`HOTP 카운터 ${c} = ${hv[c]}`, async () => assert.equal(await hotp(bytes('12345678901234567890'), c), hv[c]));
await t('HOTP 주소 파싱(카운터 포함) / 직접 입력 정규화', () => {
  const a = parseOtpauth('otpauth://hotp/Bank:me?secret=JBSWY3DPEHPK3PXP&counter=5&issuer=Bank');
  assert.equal(a.type, 'hotp'); assert.equal(a.counter, 5); assert.equal(a.issuer, 'Bank');
  assert.equal(normalizeAccount({ type: 'hotp', label: 'x', secret: 'JBSWY3DPEHPK3PXP' }).counter, 0);
  assert.throws(() => normalizeAccount({ type: 'hotp', label: 'x', secret: 'JBSWY3DPEHPK3PXP', counter: -1 }));
  assert.equal(normalizeAccount({ label: 'x', secret: 'JBSWY3DPEHPK3PXP' }).type, 'totp'); // 이전 데이터는 TOTP
});

console.log('Base32 인코딩 / Google Authenticator 내보내기');
await t('Base32 인코딩 ↔ 디코딩 왕복', () => {
  for (let n = 10; n < 40; n++) { const u = crypto.getRandomValues(new Uint8Array(n)); assert.deepEqual(decodeBase32(encodeBase32(u)), u); }
  assert.equal(encodeBase32(bytes('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});
const sec1 = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
await t('내보내기 주소: 여러 계정, 이름/서비스 분리, HOTP, 알고리즘·자릿수', () => {
  const r = parseMigration(migrationUri([
    { secret: sec1, name: 'Example:alice@google.com', issuer: 'Example', algorithm: 1, digits: 1, type: 2 },
    { secret: bytes('12345678901234567890'), name: '홍길동', issuer: '네이버', algorithm: 2, digits: 2, type: 2 },
    { secret: sec1, name: 'Bank:me', issuer: '', algorithm: 3, digits: 1, type: 1, counter: 7 },
    { secret: sec1, name: 'Old', issuer: 'MD5', algorithm: 4, digits: 1, type: 2 }]));
  assert.equal(r.skipped, 1); assert.equal(r.accounts.length, 3);
  assert.deepEqual(r.accounts[0], { type: 'totp', issuer: 'Example', label: 'alice@google.com', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 });
  assert.equal(r.accounts[1].issuer, '네이버'); assert.equal(r.accounts[1].algorithm, 'SHA256'); assert.equal(r.accounts[1].digits, 8);
  assert.equal(r.accounts[2].type, 'hotp'); assert.equal(r.accounts[2].counter, 7); assert.equal(r.accounts[2].issuer, 'Bank'); assert.equal(r.accounts[2].label, 'me');
  r.accounts.forEach((a) => normalizeAccount(a)); // 앱의 검증도 통과해야 한다
});
await t('내보내기 주소: 잘못된 데이터 거부', () => {
  assert.throws(() => parseMigration('otpauth-migration://offline?data=%%%'));
  assert.throws(() => parseMigration('otpauth-migration://offline?data=' + encodeURIComponent(Buffer.from([0x0a, 0x7f, 1, 2]).toString('base64'))), /손상/);
  assert.throws(() => parseMigration('https://example.com'));
  assert.throws(() => parseMigration('otpauth-migration://offline?data='), /data/);
});

console.log('Argon2id 보관소 형식');
await t('기본 매개변수: Argon2id, m=19 MiB, t=2, p=1, 형식 버전 2', async () => {
  assert.deepEqual(REAL, { memoryKiB: 19456, iterations: 2 });
  kdfDefaults.memoryKiB = REAL.memoryKiB;
  const v = await createVault('correct horse battery', payload);
  kdfDefaults.memoryKiB = 64;
  assert.equal(v.env.kdf.name, KDF_ARGON2); assert.equal(v.env.kdf.memoryKiB, 19456); assert.equal(v.env.kdf.iterations, 2);
  assert.equal(v.env.kdf.parallelism, 1); assert.equal(v.env.formatVersion, 2);
  assert.deepEqual((await openVault(v.env, 'correct horse battery')).payload, payload);
});
await t('이전 버전(PBKDF2, 형식 1) 보관소도 열림', async () => {
  const old = await createVault('correct horse battery', payload, 'otp-vault', false, KDF_PBKDF2);
  const v1 = await seal(old.key, { format: 'otp-vault', formatVersion: 1, kdf: old.env.kdf }, payload);
  assert.equal(v1.kdf.name, KDF_PBKDF2); assert.equal(v1.formatVersion, 1);
  assert.deepEqual((await openVault(v1, 'correct horse battery')).payload, payload);
});
await t('Argon2id 매개변수 변조/과도한 값 거부', async () => {
  const a = structuredClone(env); a.kdf.memoryKiB += 8; await rejects(openVault(a, 'correct horse battery'), /손상/);
  const b = structuredClone(env); b.kdf.memoryKiB = 10 ** 7; await rejects(openVault(b, 'x'), /파일/);
  const c = structuredClone(env); c.kdf.parallelism = 2; await rejects(openVault(c, 'x'), /파일/);
  const d = structuredClone(env); d.kdf.iterations = 11; await rejects(openVault(d, 'x'), /파일/);
  const e = structuredClone(env); e.formatVersion = 3; await rejects(openVault(e, 'x'), /파일/);
});

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
