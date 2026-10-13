/* ============================================================
   Service Worker · 处理通知点击 + 允许被唤醒
   ============================================================ */

self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(self.clients.claim());
});

/* 处理通知点击：聚焦已有页面 */
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for(var i = 0; i < list.length; i++){
        var c = list[i];
        if(c.url.indexOf(location.origin) === 0 && 'focus' in c){
          return c.focus();
        }
      }
      if(self.clients.openWindow){
        return self.clients.openWindow('/');
      }
    })
  );
});
