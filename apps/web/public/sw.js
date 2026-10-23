/* Infinite Abyss · service worker de notificaciones push (Web Push + VAPID). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Solo rutas internas: nunca se abre un dominio externo desde una notificación. */
const internal = (u) => (typeof u === "string" && u.startsWith("/") && !u.startsWith("//") ? u : null);

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Infinite Abyss";
  const url = internal(data.url) || "/lobby";
  const actions = Array.isArray(data.actions)
    ? data.actions.filter((a) => a && typeof a.title === "string" && internal(a.url)).slice(0, 2)
    : [];
  const image = typeof data.image === "string" && (data.image.startsWith("https://") || internal(data.image)) ? data.image : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      // Logo a color en la notificación; silueta blanca en la barra de estado de Android.
      icon: "/brand/app-icon-192.png",
      badge: "/brand/push/badge-96.png",
      image,
      actions: actions.map((a, i) => ({ action: a.action || `a${i}`, title: a.title })),
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: true,
      timestamp: Date.now(),
      vibrate: [80, 40, 80, 40, 220],
      data: { url, actions: actions.map((a, i) => ({ action: a.action || `a${i}`, url: a.url })) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const fromAction = event.action && Array.isArray(d.actions) ? (d.actions.find((a) => a.action === event.action) || {}).url : null;
  const url = new URL(internal(fromAction) || internal(d.url) || "/lobby", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url.startsWith(self.location.origin));
      if (same) return same.navigate(url).then((w) => (w || same).focus());
      return self.clients.openWindow(url);
    }),
  );
});
