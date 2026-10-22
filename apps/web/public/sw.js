/* Infinite Abyss · service worker de notificaciones push (Web Push + VAPID). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Infinite Abyss";
  // Solo rutas internas: nunca se abre un dominio externo desde una notificación.
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/lobby";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/brand/app-icon-192.png",
      badge: "/brand/app-icon-192.png",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/lobby", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url.startsWith(self.location.origin));
      if (same) return same.navigate(url).then((w) => (w || same).focus());
      return self.clients.openWindow(url);
    }),
  );
});
