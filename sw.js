// Service worker: only shows task reminders (no offline caching; Firestore's own cache does that).
// tools/send_reminders.py sends data-only FCM messages: {data: {title, body, tag, url}}.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data?.json() ?? {}; } catch { msg = { data: { body: e.data?.text() } }; }
  const data = msg.data ?? msg.notification ?? {};
  e.waitUntil(self.registration.showNotification(data.title || "Task due", {
    body: data.body || "",
    tag: data.tag || undefined, // one notification per task; a repeat replaces it
    renotify: Boolean(data.tag),
    icon: "icons/icon-192.png",
    data: { url: data.url || "./#tasks" },
  }));
});

// Tapping a reminder opens the Tasks view, reusing an open Notes window if there is one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./#tasks", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      // Switch views by message rather than navigate(), which could reload the page.
      win.postMessage({ type: "open", hash: new URL(url).hash });
      return win.focus();
    }
    return self.clients.openWindow(url);
  })());
});
