/* Voertuigenbord logistiek – service worker voor pushmeldingen */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // staat het bord nu open en in beeld op dit apparaat, dan is het pingeltje in de app genoeg
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (d.tag !== 'test' && wins.some(w => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'Voertuigenbord', {
      body: d.body || '', tag: d.tag || 'rit', renotify: true,
      icon: 'icon-192.png', badge: 'badge-96.png', timestamp: d.t || Date.now(),
      data: { url: d.url || './' }, requireInteraction: !!d.laat
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { w.postMessage({ type: 'open', url }); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
