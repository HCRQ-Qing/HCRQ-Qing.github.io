/* ============================================================
   Service Worker · 处理通知点击 + 允许被唤醒 + 后台心跳保活
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
        if(c.url.indexOf(self.location.origin) === 0 && 'focus' in c){
          return c.focus();
        }
      }
      if(self.clients.openWindow){
        return self.clients.openWindow('/');
      }
    })
  );
});

/* ============================================================
   ★ 后台心跳：页面切后台时每秒发一次 ping
   - 收到 ping 后，SW 用 setTimeout 安排一个"隔 30 秒再响一次"的定时器
   - 这招在部分安卓内核（含雨见）能让 SW 多活一段时间
   - 不能保证 100% 不被冻，但比什么都不做强
   ============================================================ */
var __mjHeartbeatTimer = null;
var __mjLastPingAt = 0;

self.addEventListener('message', function(e){
  var data = e.data || {};
  if(data.type === 'ping'){
    __mjLastPingAt = Date.now();

    /* 清掉旧的定时器，重新排一个 */
    if(__mjHeartbeatTimer){
      clearTimeout(__mjHeartbeatTimer);
      __mjHeartbeatTimer = null;
    }

    /* 每收到一次 ping，就延后 60 秒再响一次。
       页面活着时会持续 ping，这个定时器就会一直往后推；
       页面被冻住后，它就固定 60 秒后响一次，
       用来给系统"刷新一下 SW 的活跃度" */
    __mjHeartbeatTimer = setTimeout(function(){
      __mjHeartbeatTimer = null;
      /* 给所有窗口发一条"我还在"的消息，让页面知道 SW 还活着 */
      self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
        list.forEach(function(c){
          try{ c.postMessage({ type:'sw-alive', at: Date.now() }); }catch(err){}
        });
      });
    }, 60000);
  }

  /* 页面告诉 SW：稍后某时刻该弹一条通知（预留接口，暂时不用） */
  if(data.type === 'schedule-notify'){
    var at = Number(data.at) || 0;
    var title = String(data.title || '角色');
    var body = String(data.body || '');
    var delay = Math.max(0, at - Date.now());
    setTimeout(function(){
      try{
        self.registration.showNotification(title, {
          body: body,
          tag: 'mj-msg-' + Date.now().toString(36),
          renotify: true,
          requireInteraction: false
        });
      }catch(err){}
    }, delay);
  }
});
