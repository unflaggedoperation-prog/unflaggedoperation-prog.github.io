// The background helper: shows a notification with sound when a message arrives, even with the app closed,
// keeps the number on the app icon, and opens the right screen when the notification is tapped.
'use strict';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// Opening the app with no internet shows a short message instead of the browser's error page.
// Chrome also wants a real fetch handler before it offers "install app".
self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center" dir="rtl"><p style="font-size:20px">مفيش نت. افتح تاني لما يرجع.</p></body>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })
  );
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { notification: { title: 'Unflagged', body: event.data ? event.data.text() : '' } };
  }
  // The server sends the standard shape { web_push: 8030, notification: {...} }.
  var n = data.notification || data;
  var extra = n.data || {};
  var urgent = Boolean(extra.urgent || n.require_interaction);
  var options = {
    body: String(n.body || ''),
    tag: n.tag || undefined,
    renotify: Boolean(n.tag),
    requireInteraction: urgent,
    silent: false,
    lang: n.lang || 'ar',
    dir: n.dir || 'rtl',
    icon: 'icon-192.png',
    badge: 'badge-72.png',
    vibrate: urgent ? [400, 120, 400, 120, 400] : [200, 100, 200],
    data: { navigate: n.navigate || '', open: extra.open || null },
  };
  var jobs = [self.registration.showNotification(String(n.title || 'Unflagged Operation'), options)];
  var badge = Number(n.app_badge);
  if (self.navigator && self.navigator.setAppBadge && !isNaN(badge)) {
    jobs.push((badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(function () {}));
  }
  event.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var scope = self.registration.scope;
  var url = typeof data.navigate === 'string' && data.navigate.indexOf(scope) === 0 ? data.navigate : scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (client.url.indexOf(scope) === 0 && 'focus' in client) {
          client.postMessage({ uo: 'open', target: data.open });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
