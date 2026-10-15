/* ============================================================
   Service Worker · 处理通知点击 + 允许被唤醒 + 后台心跳保活
   ============================================================ */

self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(self.clients.claim());
});

/* 处理通知点击：写回执到 IndexedDB + 通知主页面跳转 + 聚焦已有页面 */
self.addEventListener('notificationclick', function(e){
  e.notification.close();

  var tag = '';
  try { tag = (e.notification && e.notification.tag) || ''; } catch(err) {}

  /* 1. 先把点击回执写进 IndexedDB，主页面下次进来/收消息时能读到，用它跳转 */
  var writeClick = (function(){
    try{
      return new Promise(function(resolve){
        var req = indexedDB.open('mj_big_files', 1);
        req.onupgradeneeded = function(ev){
          var db = ev.target.result;
          if(!db.objectStoreNames.contains('files')){
            db.createObjectStore('files');
          }
        };
        req.onsuccess = function(ev){
          var db = ev.target.result;
          try{
            var tx = db.transaction('files', 'readwrite');
            var store = tx.objectStore('files');
            store.put({ tag: tag, ts: Date.now() }, 'xy-home-v2:__notify-click');
            tx.oncomplete = function(){ try{ db.close(); }catch(err){} resolve(true); };
            tx.onerror = function(){ try{ db.close(); }catch(err){} resolve(false); };
            tx.onabort = function(){ try{ db.close(); }catch(err){} resolve(false); };
          }catch(err){
            try{ db.close(); }catch(err2){}
            resolve(false);
          }
        };
        req.onerror = function(){ resolve(false); };
      });
    }catch(err){
      return Promise.resolve(false);
    }
  })();

  /* 2. 通知主页面：我要跳了，你准备一下 */
  var tellClients = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    list.forEach(function(c){
      try{
        c.postMessage({ type: 'MOCHI_NOTIFY_CLICK', tag: tag });
      }catch(err){}
    });
    return list;
  });

  /* 3. 聚焦已有页面，没有就开一个新窗口 */
  e.waitUntil(
    Promise.all([writeClick, tellClients]).then(function(results){
      var list = results[1] || [];
      for(var i = 0; i < list.length; i++){
        var c = list[i];
        if(c.url.indexOf(self.location.origin) === 0 && 'focus' in c){
          return c.focus();
        }
      }
      if(self.clients.openWindow){
        return self.clients.openWindow('./');
      }
    }).catch(function(){
      if(self.clients.openWindow){
        return self.clients.openWindow('./');
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

  /* ============================================================
     页面直接要求 SW 立刻弹一条系统通知。
     背景：部分内核（含雨见）在页面切后台后，直接调用
     new Notification() / reg.showNotification() 会被静默拒绝，
     但从 SW 的 message 事件里调用 showNotification 成功率更高。
     ============================================================ */
  if(data.type === 'notify'){
    var title2 = String(data.title || '角色');
    var body2   = String(data.body  || '');
    var tag2    = String(data.tag   || ('mj-msg-' + Date.now().toString(36)));
    try{
      self.registration.showNotification(title2, {
        body: body2,
        tag: tag2,
        renotify: true,
        requireInteraction: true,
        silent: false,
        data: { roleId: data.roleId || '' }
      });
    }catch(err){
      /* 兜底：如果 showNotification 失败，再用 new Notification 试一次 */
      try{
        new Notification(title2, { body: body2, tag: tag2 });
      }catch(err2){}
    }
  }

  /* ============================================================
     ★ 页面切后台时，往 SW 里塞一批"定时炸弹"。
     每个炸弹到点后由 SW 自己弹通知，不依赖 page 侧 JS 是否被冻。
     页面上线时会重新算一批塞进来。

     消息格式：
       { type:'schedule-batch', items:[
           { at: 时间戳, title:'角色', body:'内容', tag:'xxx', roleId:'r1' },
           ...
       ]}
     限制：一次最多 30 条，避免把 SW 撑爆。
     ============================================================ */
  if(data.type === 'schedule-batch'){
    var items = Array.isArray(data.items) ? data.items.slice(0, 30) : [];
    items.forEach(function(it){
      var at = Number(it.at) || 0;
      var delay = Math.max(0, at - Date.now());
      /* 只接未来 6 小时内的，太远的排了也会被内核清掉，没意义 */
      if(delay > 6 * 60 * 60 * 1000) return;
      var title3 = String(it.title || '角色');
      var body3  = String(it.body  || '');
      var tag3   = String(it.tag   || ('mj-msg-' + at.toString(36)));
      setTimeout(function(){
        try{
          self.registration.showNotification(title3, {
            body: body3,
            tag: tag3,
            renotify: true,
            requireInteraction: true,
            silent: false,
            data: { roleId: it.roleId || '' }
          });
        }catch(err){
          try{ new Notification(title3, { body: body3, tag: tag3 }); }catch(err2){}
        }
      }, delay);
    });
  }
});
