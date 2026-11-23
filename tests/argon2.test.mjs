import fs from 'node:fs';
import { argon2id, blake2b } from '../extension/core/argon2.js';
const v = JSON.parse(fs.readFileSync(new URL('argon2_vectors.json', import.meta.url), 'utf-8'));
const hex = (u) => Buffer.from(u).toString('hex'), bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
let pass = 0, fail = 0;
const ok = (name, c, extra = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', name, c ? extra : extra); };
for (const b of v.blake) ok(`BLAKE2b 길이 ${b.data.length / 2} → ${b.d}바이트`, hex(blake2b(bytes(b.data), b.d)) === b.out);
v.cases.forEach((c, i) => {
  const t0 = Date.now();
  const tag = hex(argon2id({ password: bytes(c.pw), salt: bytes(c.salt), secret: bytes(c.secret), ad: bytes(c.ad), t: c.t, m: c.m, p: c.p, dkLen: c.n }));
  ok(`Argon2id ${i === 0 ? '(RFC 9106 벡터) ' : ''}m=${c.m} t=${c.t} p=${c.p}`, tag === c.tag, `${Date.now() - t0}ms${tag === c.tag ? '' : '\n   기대 ' + c.tag + '\n   결과 ' + tag}`);
});
console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
