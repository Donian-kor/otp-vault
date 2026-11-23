"""테스트용 QR 이미지 생성기 (독립 구현). 결과: tests/qr/*.bin (가로·세로 uint32 LE + RGBA) 와 cases.json"""
import json, math, os, random
from PIL import Image, ImageFilter

ECC = [[-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
       [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
       [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
       [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]]
BLK = [[-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
       [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
       [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
       [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]]
FMT = [1, 0, 3, 2]
ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

def raw_modules(v):
    r = (16*v+128)*v+64
    if v >= 2:
        n = v//7+2; r -= (25*n-10)*n-55
        if v >= 7: r -= 36
    return r
def gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D); z ^= ((y >> i) & 1) * x
    return z
def rs_div(deg):
    res = [0]*(deg-1)+[1]; root = 1
    for _ in range(deg):
        for j in range(deg):
            res[j] = gf_mul(res[j], root)
            if j+1 < deg: res[j] ^= res[j+1]
        root = gf_mul(root, 2)
    return res
def rs_rem(data, div):
    res = [0]*len(div)
    for b in data:
        f = b ^ res.pop(0); res.append(0)
        for i, c in enumerate(div): res[i] ^= gf_mul(c, f)
    return res
def align_pos(v):
    if v == 1: return []
    n = v//7+2; size = v*4+17
    step = 26 if v == 32 else math.ceil((v*4+4)/(n*2-2))*2
    res = [6]; p = size-7
    while len(res) < n: res.insert(1, p); p -= step
    return res
def fmt_bits(e, m):
    d = (e << 3) | m; r = d
    for _ in range(10): r = (r << 1) ^ ((r >> 9) * 0x537)
    return ((d << 10) | r) ^ 0x5412

def segment(kind, data, v):
    bits = []
    def put(val, n): bits.extend((val >> i) & 1 for i in range(n-1, -1, -1))
    if kind == 'byte':
        put(4, 4); put(len(data), 8 if v <= 9 else 16)
        for b in data: put(b, 8)
    elif kind == 'numeric':
        put(1, 4); put(len(data), 10 if v <= 9 else 12 if v <= 26 else 14)
        for i in range(0, len(data), 3):
            g = data[i:i+3]; put(int(g), {3: 10, 2: 7, 1: 4}[len(g)])
    else:
        put(2, 4); put(len(data), 9 if v <= 9 else 11 if v <= 26 else 13)
        for i in range(0, len(data), 2):
            g = data[i:i+2]
            if len(g) == 2: put(ALNUM.index(g[0])*45+ALNUM.index(g[1]), 11)
            else: put(ALNUM.index(g), 6)
    return bits

def make(kind, data, level, mask, min_ver=1):
    for v in range(min_ver, 41):
        cap = raw_modules(v)//8 - ECC[level][v]*BLK[level][v]
        bits = segment(kind, data, v)
        if len(bits) <= cap*8: break
    bits += [0]*min(4, cap*8-len(bits))
    bits += [0]*(-len(bits) % 8)
    pad = 0xEC
    while len(bits) < cap*8:
        bits += [(pad >> i) & 1 for i in range(7, -1, -1)]; pad ^= 0xEC ^ 0x11
    dc = [int(''.join(map(str, bits[i:i+8])), 2) for i in range(0, len(bits), 8)]
    nb, eb, raw = BLK[level][v], ECC[level][v], raw_modules(v)//8
    ns = nb - raw % nb; sl = raw//nb
    div = rs_div(eb); blocks = []; k = 0
    for i in range(nb):
        dl = sl-eb+(0 if i < ns else 1); d = dc[k:k+dl]; k += dl
        blocks.append((d, rs_rem(d, div)))
    out = []
    for i in range(max(len(b[0]) for b in blocks)):
        for d, _ in blocks:
            if i < len(d): out.append(d[i])
    for i in range(eb):
        for _, e in blocks: out.append(e[i])
    size = v*4+17
    m = [[False]*size for _ in range(size)]; fn = [[False]*size for _ in range(size)]
    def setf(x, y, val):
        if 0 <= x < size and 0 <= y < size: m[y][x] = val; fn[y][x] = True
    for i in range(size): setf(6, i, i % 2 == 0); setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size-4, 3), (3, size-4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5): setf(cx+dx, cy+dy, max(abs(dx), abs(dy)) not in (2, 4))
    ap = align_pos(v)
    for i, cy in enumerate(ap):
        for j, cx in enumerate(ap):
            if (i == 0 and j == 0) or (i == 0 and j == len(ap)-1) or (i == len(ap)-1 and j == 0): continue
            for dy in range(-2, 3):
                for dx in range(-2, 3): setf(cx+dx, cy+dy, max(abs(dx), abs(dy)) != 1)
    def draw_fmt(msk):
        b = fmt_bits(FMT[level], msk); bit = lambda i: (b >> i) & 1 == 1
        for i in range(6): setf(8, i, bit(i))
        setf(8, 7, bit(6)); setf(8, 8, bit(7)); setf(7, 8, bit(8))
        for i in range(9, 15): setf(14-i, 8, bit(i))
        for i in range(8): setf(size-1-i, 8, bit(i))
        for i in range(8, 15): setf(8, size-15+i, bit(i))
        setf(8, size-8, True)
    draw_fmt(msk := mask)
    if v >= 7:
        r = v
        for _ in range(12): r = (r << 1) ^ ((r >> 11) * 0x1F25)
        vb = (v << 12) | r
        for i in range(18):
            bt = (vb >> i) & 1 == 1; a = size-11+i % 3; b2 = i//3; setf(a, b2, bt); setf(b2, a, bt)
    bitsout = [(c >> (7-i)) & 1 for c in out for i in range(8)]
    idx = 0; right = size-1
    while right >= 1:
        if right == 6: right = 5
        for vert in range(size):
            for j in range(2):
                x = right-j; up = ((right+1) & 2) == 0; y = size-1-vert if up else vert
                if not fn[y][x] and idx < len(bitsout): m[y][x] = bitsout[idx] == 1; idx += 1
        right -= 2
    conds = [lambda x, y: (x+y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0, lambda x, y: (x+y) % 3 == 0,
             lambda x, y: (x//3+y//2) % 2 == 0, lambda x, y: x*y % 2+x*y % 3 == 0, lambda x, y: (x*y % 2+x*y % 3) % 2 == 0,
             lambda x, y: ((x+y) % 2+x*y % 3) % 2 == 0]
    for y in range(size):
        for x in range(size):
            if not fn[y][x] and conds[mask](x, y): m[y][x] = not m[y][x]
    return m, fn, v

def render(m, scale, border=4):
    n = len(m)+2*border; img = Image.new('L', (n*scale, n*scale), 255); px = img.load()
    for y, row in enumerate(m):
        for x, val in enumerate(row):
            if val:
                for dy in range(scale):
                    for dx in range(scale): px[(x+border)*scale+dx, (y+border)*scale+dy] = 0
    return img

def save(img, name, outdir):
    img = img.convert('RGBA'); w, h = img.size
    open(os.path.join(outdir, name), 'wb').write(w.to_bytes(4, 'little')+h.to_bytes(4, 'little')+img.tobytes())

def main():
    random.seed(7)
    out = os.path.join(os.path.dirname(__file__), 'qr'); os.makedirs(out, exist_ok=True)
    cases = []
    def add(img, text, desc, expect=True):
        name = f'{len(cases):03d}.bin'; save(img, name, out); cases.append({'file': name, 'text': text, 'desc': desc, 'expect': expect})
    short = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
    long_ = 'otpauth://totp/' + '네이버' + ':' + '홍길동@example.com' + '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=' + '네이버' + '&algorithm=SHA256&digits=8&period=60'
    for lvl, ln in enumerate('LMQH'):
        for mask in range(8):
            m, _, v = make('byte', short.encode(), lvl, mask); add(render(m, 4), short, f'v{v} ECC-{ln} mask{mask}')
    for lvl in range(4):
        m, _, v = make('byte', long_.encode(), lvl, 3); add(render(m, 3), long_, f'긴 문자열 v{v} ECC-{"LMQH"[lvl]}')
    m, _, v = make('byte', (long_*3).encode(), 1, 5); add(render(m, 3), long_*3, f'큰 버전 v{v}')
    m, _, v = make('numeric', '0123456789012345678', 1, 2); add(render(m, 5), '0123456789012345678', 'numeric')
    m, _, v = make('alnum', 'HELLO WORLD 123', 2, 6); add(render(m, 5), 'HELLO WORLD 123', 'alnum')
    base, _, v = make('byte', short.encode(), 1, 4); img = render(base, 6)
    for scale in (1, 2, 3, 8, 11): add(render(base, scale), short, f'배율 {scale}')
    add(Image.eval(img, lambda p: 255-p), short, '색 반전')
    for ang in (4, 12, 25, 45, 90, 180): add(img.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=255), short, f'회전 {ang}도')
    add(img.filter(ImageFilter.GaussianBlur(1.6)), short, '흐림')
    noisy = Image.eval(img, lambda p: p); px = noisy.load()
    for _ in range(img.size[0]*img.size[1]//25): px[random.randrange(img.size[0]), random.randrange(img.size[1])] = random.choice((0, 255))
    add(noisy, short, '점 잡음')
    canvas = Image.new('L', (1280, 800), 235); canvas.paste(img, (700, 260)); add(canvas, short, '큰 화면 속 작은 QR')
    # 오류 정정: 데이터 모듈 일부를 뒤집는다
    for lvl, nflip in ((0, 8), (1, 14), (2, 22), (3, 30)):
        m, fn, v = make('byte', short.encode(), lvl, 1)
        spots = [(x, y) for y in range(len(m)) for x in range(len(m)) if not fn[y][x]]
        for x, y in random.sample(spots, nflip): m[y][x] = not m[y][x]
        add(render(m, 5), short, f'모듈 {nflip}개 손상 ECC-{"LMQH"[lvl]}')
    add(Image.new('L', (300, 300), 255), None, '빈 이미지', False)
    noise = Image.effect_noise((300, 300), 90); add(noise, None, '무작위 노이즈', False)
    json.dump(cases, open(os.path.join(out, 'cases.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(len(cases), 'cases')
if __name__ == '__main__':
    main()
