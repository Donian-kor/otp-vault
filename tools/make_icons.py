"""아이콘 생성기: assets/icon-source.png -> extension/icons/icon{16,32,48,128}.png (Pillow 필요).
원본은 바깥 배경이 검정(투명 아님)이라, 가장자리에서 이어진 검정 영역만 투명하게 바꾼다."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
src = Image.open(ROOT / "assets" / "icon-source.png").convert("RGB")
w, h = src.size
NAVY = (0, 32, 99)  # 원 테두리 색

# 1) 파랑 성분이 낮은 "어두운" 픽셀을 표시하고, 모서리에서 이어진 영역(= 바깥 배경)만 남긴다
blue = src.getchannel("B")
dark = blue.point(lambda v: 255 if v < 50 else 0)
for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
    ImageDraw.floodfill(dark, corner, 128)
outside = dark.point(lambda v: 255 if v == 128 else 0)

# 2) 바깥 영역 가장자리의 부드러운 경계(검정과 남색이 섞인 픽셀)는 파랑 값에 비례한 투명도로 처리
band = outside.filter(ImageFilter.MaxFilter(9))          # 바깥 영역 주변 4픽셀
alpha = Image.new("L", (w, h), 255)
bp, ap, bandp, outp = blue.load(), alpha.load(), band.load(), outside.load()
rgb = src.copy(); rp = rgb.load()
for y in range(h):
    for x in range(w):
        if bandp[x, y]:
            a = 0 if outp[x, y] and bp[x, y] < 6 else min(255, round(bp[x, y] * 255 / NAVY[2]))
            ap[x, y] = a
            if a < 255: rp[x, y] = NAVY                  # 검은 테두리(할로)가 남지 않게 색 복원
out = rgb.convert("RGBA"); out.putalpha(alpha)
(ROOT / "assets" / "icon-source-transparent.png").write_bytes(b"")
out.save(ROOT / "assets" / "icon-source-transparent.png", optimize=True)

# 3) 크기별 아이콘
dst = ROOT / "extension" / "icons"; dst.mkdir(parents=True, exist_ok=True)
for n in (16, 32, 48, 128):
    out.resize((n, n), Image.LANCZOS).save(dst / f"icon{n}.png", optimize=True)
# 화면 제목용 내장 로고(파일 경로에 의존하지 않도록 데이터 주소로 포함)
import base64, io
buf = io.BytesIO(); out.resize((48, 48), Image.LANCZOS).save(buf, "PNG", optimize=True)
(ROOT / "extension" / "logo.js").write_text(
    "// 자동 생성 파일(tools/make_icons.py): 화면 제목 옆 로고. 파일 경로 없이도 표시되도록 PNG를 그대로 내장했다.\n"
    "export const LOGO = 'data:image/png;base64," + base64.b64encode(buf.getvalue()).decode() + "';\n", encoding="utf-8")
print("완료:", [f"icon{n}.png" for n in (16, 32, 48, 128)], "+ logo.js")
