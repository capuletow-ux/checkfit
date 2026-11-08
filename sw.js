/* CheckFit service worker: recebe notificações. Não guarda cópia das páginas (assim as atualizações chegam na hora). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {body: e.data ? e.data.text() : ''}; }
  const n = d.notification || d, url = (d.data && d.data.url) || n.url || './';
  e.waitUntil(self.registration.showNotification(n.title || 'CheckFit', {body: n.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: n.tag || undefined, data: {url}}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.postMessage({cf: 'abrir', url}); } catch (x) {} return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
