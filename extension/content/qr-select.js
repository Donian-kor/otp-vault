// 현재 웹페이지 위에 "QR 영역 드래그" 화면을 올리는 내용 스크립트.
// 사용자가 팝업에서 버튼을 눌렀을 때만 그 탭에 주입된다. 페이지 내용은 읽지 않고, 드래그한 좌표만 확장프로그램으로 보낸다.
(() => {
  const G = globalThis;
  if (G.__otpVaultQrSelect) { G.__otpVaultQrSelect.start(); return; } // 이미 주입되어 있으면 다시 시작만
  const api = G.browser ?? G.chrome;
  const MIN = 24; // 이보다 작게 드래그하면 무시
  let host = null, onKey = null;

  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; };
  const mount = (e) => (document.documentElement || document.body).append(e);
  // 페이지 스타일이 섞이지 않도록 shadow DOM 안에 만든다
  const makeHost = () => { const h = el('div', 'all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;'); return { host: h, root: h.attachShadow ? h.attachShadow({ mode: 'closed' }) : h }; };
  const frames = (n) => new Promise((res) => { const step = () => (n-- > 0 ? G.requestAnimationFrame(step) : res()); step(); });
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  function stop() {
    if (host) host.remove();
    host = null;
    if (onKey) { G.removeEventListener('keydown', onKey, true); onKey = null; }
  }
  function toast(text, ok) {
    const { host: h, root } = makeHost();
    h.style.pointerEvents = 'none';
    root.append(el('div', `position:fixed;left:50%;top:18px;transform:translateX(-50%);max-width:80vw;padding:10px 16px;border-radius:10px;font:600 14px/1.5 system-ui,'Malgun Gothic',sans-serif;color:#fff;background:${ok ? '#1f7a55' : '#a8323e'};box-shadow:0 4px 18px rgba(0,0,0,.4);`, text));
    mount(h); setTimeout(() => h.remove(), 4500);
  }

  function start() {
    stop();
    const made = makeHost(); host = made.host;
    const layer = el('div', 'position:fixed;left:0;top:0;width:100vw;height:100vh;cursor:crosshair;background:rgba(0,0,0,.28);touch-action:none;user-select:none;');
    const hint = el('div', "position:fixed;left:50%;top:18px;transform:translateX(-50%);padding:10px 16px;border-radius:10px;background:#0b1020;color:#e8eef9;font:600 14px/1.5 system-ui,'Malgun Gothic',sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);pointer-events:none;", 'QR 코드를 마우스로 드래그해서 영역을 지정하세요 (Esc: 취소)');
    const box = el('div', 'position:fixed;display:none;border:2px solid #5ee0a0;box-shadow:0 0 0 100vmax rgba(0,0,0,.5);pointer-events:none;box-sizing:border-box;');
    layer.append(box); made.root.append(layer, hint); mount(host);

    let a = null;
    const rectOf = (p) => ({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(a.x - p.x), h: Math.abs(a.y - p.y) });
    const draw = (r) => { Object.assign(box.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); };
    const pt = (e) => ({ x: Math.max(0, Math.min(G.innerWidth, e.clientX)), y: Math.max(0, Math.min(G.innerHeight, e.clientY)) });

    layer.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); layer.setPointerCapture?.(e.pointerId); a = pt(e); draw({ x: a.x, y: a.y, w: 0, h: 0 }); });
    layer.addEventListener('pointermove', (e) => { if (a) draw(rectOf(pt(e))); });
    layer.addEventListener('pointerup', async (e) => {
      if (!a) return;
      const r = rectOf(pt(e)); a = null;
      if (r.w < MIN || r.h < MIN) { hint.textContent = '영역이 너무 작습니다. QR 코드 전체를 감싸도록 더 크게 드래그하세요.'; box.style.display = 'none'; return; }
      const vw = G.innerWidth, vh = G.innerHeight;
      stop();                         // 안내 화면을 먼저 지워야 스크린샷에 찍히지 않는다
      await frames(2); await wait(80);
      let res;
      try { res = await api.runtime.sendMessage({ type: 'otpvault-qr-region', rect: r, vw, vh }); }
      catch { res = { ok: false, error: '확장프로그램과 통신하지 못했습니다. 아이콘을 눌러 다시 시작해 주세요.' }; }
      if (res && res.ok) toast('QR을 읽었습니다. 새로 열린 OTP Vault 탭에서 계정 추가를 확인하세요.', true);
      else { toast(((res && res.error) || 'QR을 읽지 못했습니다.') + ' 다시 드래그하세요.', false); setTimeout(start, 700); } // 바로 다시 지정할 수 있게 한다
    });
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    layer.addEventListener('wheel', (e) => e.preventDefault(), { passive: false }); // 선택 중에는 스크롤하지 않는다(좌표 어긋남 방지)
    onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); stop(); } };
    G.addEventListener('keydown', onKey, true);
  }

  G.__otpVaultQrSelect = { start };
  start();
})();
