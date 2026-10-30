// DraftDesk Service Worker（R10.39）：app shell 缓存 + 静态资源缓存 + API 永不缓存。
// 策略（这个应用的数据全靠实时 API，SW 只为「像 App」与首屏秒开，不做离线数据）：
//   - 导航请求：network-first，失败回退缓存的 shell（离线能开壳，API 自然报错态）
//   - /_next/static/*（带内容哈希）：cache-first
//   - 其余同源静态（图标等）：stale-while-revalidate
//   - /api/*：直通不缓存（拍板数据必须新鲜）
const VERSION = "dd-shell-v1";
const SHELL = ["/"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // 数据面直通，永不缓存

  if (req.mode === "navigate") {
    // 导航：网络优先（拿最新 shell），离线回退缓存壳
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    // 内容哈希资源：缓存优先
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })),
    );
    return;
  }
  // 其余同源静态：stale-while-revalidate
  e.respondWith(
    caches.match(req).then((hit) => {
      const refreshing = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || refreshing;
    }),
  );
});
