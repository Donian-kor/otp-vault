"""빌드: extension/ 를 브라우저별 폴더(dist/)로 복사하고 zip을 만든다. 외부 패키지 필요 없음."""
import json, shutil, struct, zlib, zipfile
from pathlib import Path

ROOT = Path(__file__).parent
SRC, DIST = ROOT / "extension", ROOT / "dist"
TARGETS = {"chrome-edge": "manifest.chrome.json", "firefox": "manifest.firefox.json"}

def png(n):
    rows = []
    c, r_out = (n - 1) / 2, n * 0.2
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            dx, dy = abs(x - c), abs(y - c)
            ex, ey = max(dx - (c - r_out), 0), max(dy - (c - r_out), 0)
            inside = ex * ex + ey * ey <= r_out * r_out
            d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
            if not inside: px = (0, 0, 0, 0)
            elif n * 0.27 <= d <= n * 0.38: px = (232, 238, 249, 255)
            elif d <= n * 0.12: px = (119, 183, 255, 255)
            else: px = (29, 79, 134, 255)
            row += bytes(px)
        rows.append(bytes(row))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")

(SRC / "icons").mkdir(exist_ok=True)
for n in (16, 32, 48, 128):  # 실제 아이콘(tools/make_icons.py로 생성)이 없을 때만 임시 아이콘을 만든다
    f = SRC / "icons" / f"icon{n}.png"
    if not f.exists(): f.write_bytes(png(n))

shutil.rmtree(DIST, ignore_errors=True)
for name, manifest in TARGETS.items():
    out = DIST / name
    shutil.copytree(SRC, out)
    data = json.loads((ROOT / "manifests" / manifest).read_text(encoding="utf-8"))
    (out / "manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    with zipfile.ZipFile(DIST / f"otp-vault-{name}-{data['version']}.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file(): z.write(f, f.relative_to(out).as_posix())
    print("built", out.relative_to(ROOT))
