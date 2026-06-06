/* 한우 올인원 — 서비스워커 (오프라인 + 백그라운드 알림)
 * 축사에서 통신이 끊겨도 앱 셸을 캐시로 띄우고,
 * 앱이 꺼져 있어도 서버가 보낸 Web Push로 알림을 표시한다. */
const CACHE = "hanwoo-allinone-v2";
const ASSETS = ["./index.html","./manifest.json","./icon-192.png","./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// 캐시 우선 (오프라인 셸)
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) =>
    hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html"))));
});

/* ===== 백그라운드 알림 (앱이 꺼져 있어도 동작) ===== */
// 서버가 일정(주차별 백신·채혈·수정확인 등)에 맞춰 Web Push를 전송하면
// 아래 핸들러가 앱 종료 상태에서도 알림을 띄운다.
self.addEventListener("push", (e) => {
  let data = { title: "한우 올인원", body: "확인할 작업이 있어요", url: "./index.html" };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: [200, 100, 200],
    tag: data.tag || "hanwoo-care",
    data: { url: data.url },
    actions: [{ action: "open", title: "열기" }, { action: "done", title: "완료처리" }],
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "./index.html";
  e.waitUntil(clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return clients.openWindow(url);
  }));
});
