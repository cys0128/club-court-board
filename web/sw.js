// 코트판 서비스 워커: 웹 푸시 표시와 알림 누르기만 처리한다(캐시·오프라인 기능 없음).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  var opt = {
    body: d.body || '', tag: d.tag || 'ccb', renotify: true,
    icon: '/icon-192.png', badge: '/badge-72.png',
    data: { url: d.url || '/', book: d.book || '' }
  };
  if (d.book) opt.actions = [{ action: 'book', title: '용인 예약 사이트' }, { action: 'open', title: '코트판 보기' }];
  e.waitUntil(self.registration.showNotification(d.title || '코트판 알림', opt));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var data = e.notification.data || {};
  var url = e.action === 'book' && data.book ? data.book : (data.url || '/');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    if (url.indexOf(self.location.origin) === 0) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(self.location.origin) === 0 && 'navigate' in c) return c.navigate(url).then(function (w) { return (w || c).focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
