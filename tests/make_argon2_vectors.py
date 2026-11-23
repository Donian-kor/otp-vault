"""Argon2id 시험 벡터 생성기: 독립 구현(cryptography)으로 정답을 만들어 argon2_vectors.json 에 저장한다."""
import json, hashlib
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
def mk(pw, salt, t, m, p, secret=None, ad=None, n=32):
    tag = Argon2id(salt=salt, length=n, iterations=t, lanes=p, memory_cost=m, ad=ad, secret=secret).derive(pw)
    return dict(pw=pw.hex(), salt=salt.hex(), t=t, m=m, p=p, secret=secret.hex() if secret else '', ad=ad.hex() if ad else '', n=n, tag=tag.hex())
cases = [mk(b'\x01'*32, b'\x02'*16, 3, 32, 4, b'\x03'*8, b'\x04'*12),  # RFC 9106 시험 벡터
         mk(b'password', b'somesalt12345678', 2, 64, 1), mk('한글 비밀번호!'.encode(), bytes(range(16)), 1, 8, 1),
         mk(b'x', bytes(range(16, 32)), 3, 256, 2), mk(b'correct horse battery', bytes(range(32, 48)), 2, 19456, 1)]
blake = [dict(data=(b'a'*n).hex(), out=hashlib.blake2b(b'a'*n, digest_size=d).hexdigest(), d=d) for n, d in ((0, 64), (1, 64), (127, 64), (128, 64), (129, 64), (300, 32), (1030, 64), (5, 4))]
json.dump(dict(cases=cases, blake=blake), open(__file__.replace('make_argon2_vectors.py', 'argon2_vectors.json'), 'w'), indent=1)
