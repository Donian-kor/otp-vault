// 브라우저 API 차이는 이 파일 한 곳에서만 다룬다. (Chrome·Edge: chrome.*, Firefox: browser.*)
const api = globalThis.browser ?? globalThis.chrome;

export const storage = {
  async get(key) { return (await api.storage.local.get(key))[key]; },
  set(key, value) { return api.storage.local.set({ [key]: value }); },
  remove(key) { return api.storage.local.remove(key); },
};
export const openManagePage = () => api.runtime.openOptionsPage();
export const manifest = () => api.runtime.getManifest();

// storage.session: 디스크에 쓰지 않고 브라우저를 끄면 사라지는 저장소. 지원하지 않는 브라우저에서는 아무 일도 하지 않는다.
const area = api.storage.session;
export const sessionStore = {
  available: !!area,
  async get(key) { return area ? (await area.get(key))[key] : undefined; },
  set(key, value) { return area ? area.set({ [key]: value }) : Promise.resolve(); },
  remove(key) { return area ? area.remove(key) : Promise.resolve(); },
};

// 화면 드래그 QR: 현재 탭에 선택 화면(내용 스크립트)을 올리는 데 쓴다. activeTab 권한은 사용자가 방금 확장프로그램을 눌렀을 때만 그 탭에 주어진다.
export const tabsApi = {
  available: !!(api.tabs && api.scripting),
  async active() { const [t] = await api.tabs.query({ active: true, currentWindow: true }); return t; },
  inject(tabId, file) { return api.scripting.executeScript({ target: { tabId }, files: [file] }); },
};
export const onSessionChange = (cb) => {
  if (api.storage.onChanged) api.storage.onChanged.addListener((changes, area) => { if (area === 'session') cb(changes); });
};
