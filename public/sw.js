self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      try {
        payload = { title: 'اعلان میانجی', body: event.data.text() };
      } catch {
        payload = {};
      }
    }
  }

  const fcmNotification = payload.notification || {};
  const data = payload.data || {};
  const title = payload.title || fcmNotification.title || 'اعلان جدید میانجی';
  const body = payload.body || fcmNotification.body || data.body || 'یک به‌روزرسانی جدید ثبت شد.';
  const url = payload.url || data.url || '/';
  const tag = payload.tag || data.tag || `mianji-${Date.now()}`;

  const options = {
    body,
    tag,
    renotify: false,
    dir: 'rtl',
    lang: 'fa',
    data: {
      url,
      kind: payload.kind || data.kind || 'system',
      contract_id: payload.contract_id || data.contract_id || null,
      scope: payload.scope || data.scope || null,
      chat_id: payload.chat_id || data.chat_id || null,
      channel_id: payload.channel_id || data.channel_id || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const targetUrl = new URL(data.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({
            type: 'mianji:notification-click',
            payload: data,
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
