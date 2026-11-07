// The cafe's own page: it holds the Google app in a frame, and does what only a top page may do:
// ask for notifications, keep the background helper (sw.js), put a number on the app icon, and catch
// the phone's back button while a photo is open. It talks to the app by message, and only to the app.
(function () {
  'use strict';

  // The Google app always runs on a page like n-abc123-0lu-script.googleusercontent.com
  var APP_ORIGIN = /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/;
  var frame = document.getElementById('app');
  var appWindow = null;
  var appOrigin = null;
  var viewerOpen = false;
  var ignorePop = false;

  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  function readOpen(text) {
    if (!text) return null;
    try {
      var target = JSON.parse(text);
      if (!target || typeof target.tab !== 'string' || target.tab.length > 40) return null;
      return { tab: target.tab, recordType: String(target.recordType || '').slice(0, 40), recordId: String(target.recordId || '').slice(0, 80) };
    } catch (e) {
      return null;
    }
  }

  // A tapped notification opens this page as ?open=...: remembered, then removed from the address.
  var params = new URLSearchParams(location.search);
  var pendingOpen = readOpen(params.get('open'));
  if (params.has('open')) history.replaceState(null, '', location.pathname);

  var swReady = 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; })
    : Promise.reject(new Error('no service worker'));
  swReady.catch(function () {});

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function permission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }
  function currentSubscription() {
    if (!pushSupported()) return Promise.resolve(null);
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1500); });
    return Promise.race([swReady.then(function (reg) { return reg.pushManager.getSubscription(); }), timeout]).catch(function () { return null; });
  }
  function info() {
    return currentSubscription().then(function (sub) {
      return { push: pushSupported(), standalone: standalone, ios: isIOS, permission: permission(), subscribed: Boolean(sub) && permission() === 'granted' };
    });
  }

  function send(message) {
    if (!appWindow || !appOrigin) return;
    message.uo = 1;
    appWindow.postMessage(message, appOrigin);
  }

  // Only a page inside our own frame counts (the Google app sits one or two frames deep).
  function insideOurFrame(source) {
    try {
      var w = source;
      for (var i = 0; i < 4 && w; i++) {
        if (w === frame.contentWindow) return true;
        if (w === w.parent) return false;
        w = w.parent;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function keyBytes(base64url) {
    var text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64url.length + 3) % 4));
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
  function sameKey(a, b) {
    if (!a || !b) return false;
    var x = new Uint8Array(a);
    if (x.length !== b.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
    return true;
  }

  function subscribe(publicKey) {
    var key = keyBytes(publicKey);
    return swReady.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub && sameKey(sub.options && sub.options.applicationServerKey, key)) return sub;
        var clear = sub ? sub.unsubscribe() : Promise.resolve();
        return clear.then(function () {
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        });
      });
    });
  }

  function answerPush(publicKey) {
    return subscribe(publicKey).then(
      function (sub) {
        send({ type: 'push-result', ok: true, subscription: sub.toJSON(), userAgent: navigator.userAgent });
      },
      function (err) {
        send({ type: 'push-result', ok: false, reason: permission() === 'denied' || (err && err.name === 'NotAllowedError') ? 'denied' : 'failed' });
      }
    );
  }

  function askPermission(publicKey, retryWithButton) {
    var asked = Notification.requestPermission();
    return Promise.resolve(asked).then(function (result) {
      if (result === 'granted') return answerPush(publicKey);
      // No question was shown (the tap did not count here): this page shows its own button.
      if (result === 'default' && retryWithButton) return showAllowSheet(publicKey);
      send({ type: 'push-result', ok: false, reason: result === 'denied' ? 'denied' : 'failed' });
    });
  }

  // The phone only shows its "Allow" question after a tap on this page itself, so this page shows one button.
  function showAllowSheet(publicKey) {
    var old = document.getElementById('uo-allow');
    if (old) old.remove();
    var sheet = document.createElement('div');
    sheet.id = 'uo-allow';
    sheet.setAttribute('role', 'dialog');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#1c1917;width:100%;max-width:440px;border-radius:22px 22px 0 0;padding:20px 18px calc(22px + env(safe-area-inset-bottom));box-sizing:border-box;text-align:center';
    var title = document.createElement('p');
    title.textContent = 'تشغيل الإشعارات';
    title.style.cssText = 'margin:0 0 6px;font-size:18px;font-weight:700';
    var note = document.createElement('p');
    note.textContent = 'دوس «سماح»، وبعدها اختار «سماح» تاني في السؤال اللي هيظهر.';
    note.style.cssText = 'margin:0 0 16px;font-size:14px;color:#57534e';
    var allow = document.createElement('button');
    allow.id = 'uo-allow-yes';
    allow.textContent = 'سماح';
    allow.style.cssText = 'width:100%;min-height:50px;border:0;border-radius:14px;background:#78350f;color:#fff;font-size:17px;font-weight:700';
    var later = document.createElement('button');
    later.id = 'uo-allow-no';
    later.textContent = 'مش دلوقتي';
    later.style.cssText = 'width:100%;min-height:44px;margin-top:8px;border:0;border-radius:14px;background:#f5f5f4;color:#44403c;font-size:15px';
    allow.addEventListener('click', function () {
      sheet.remove();
      askPermission(publicKey);
    });
    later.addEventListener('click', function () {
      sheet.remove();
      send({ type: 'push-result', ok: false, reason: 'failed' });
    });
    box.appendChild(title);
    box.appendChild(note);
    box.appendChild(allow);
    box.appendChild(later);
    sheet.appendChild(box);
    document.body.appendChild(sheet);
  }

  function enablePush(publicKey) {
    if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) return;
    if (isIOS && !standalone) return send({ type: 'push-result', ok: false, reason: 'ios-install' });
    if (!pushSupported()) return send({ type: 'push-result', ok: false, reason: 'unsupported' });
    var state = permission();
    if (state === 'denied') return send({ type: 'push-result', ok: false, reason: 'denied' });
    if (state === 'granted') return answerPush(publicKey);
    // The tap inside the app usually counts for this page too; if not, this page asks for its own tap.
    if (navigator.userActivation && navigator.userActivation.isActive) {
      askPermission(publicKey, true).catch(function () { showAllowSheet(publicKey); });
    } else {
      showAllowSheet(publicKey);
    }
  }

  function setBadge(count) {
    var n = Math.max(0, Math.min(999, Number(count) || 0));
    try {
      if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n).catch(function () {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {});
    } catch (e) {
      // Not on this phone
    }
  }

  window.addEventListener('message', function (event) {
    if (!APP_ORIGIN.test(event.origin) || !insideOurFrame(event.source)) return;
    var data = event.data;
    if (!data || data.uo !== 1 || typeof data.type !== 'string') return;
    appWindow = event.source;
    appOrigin = event.origin;
    switch (data.type) {
      case 'hello':
        info().then(function (i) {
          send({ type: 'hello', info: i, open: pendingOpen });
          pendingOpen = null;
        });
        break;
      case 'status':
        info().then(function (i) { send({ type: 'status', info: i }); });
        break;
      case 'push-enable':
        enablePush(data.publicKey);
        break;
      case 'push-disable':
        currentSubscription().then(function (sub) {
          if (!sub) return null;
          var endpoint = sub.endpoint;
          return sub.unsubscribe().then(function () { return endpoint; });
        }).then(function (endpoint) { send({ type: 'push-disabled', endpoint: endpoint || null }); });
        break;
      case 'badge':
        setBadge(data.count);
        break;
      case 'viewer-open':
        if (!viewerOpen) history.pushState({ uoViewer: 1 }, '');
        viewerOpen = true;
        break;
      case 'viewer-close':
        if (viewerOpen && history.state && history.state.uoViewer) {
          ignorePop = true;
          history.back();
        }
        viewerOpen = false;
        break;
    }
  });

  // The phone's back button while a photo is open: it closes the photo and stays in the app.
  window.addEventListener('popstate', function () {
    if (ignorePop) {
      ignorePop = false;
      return;
    }
    if (viewerOpen) {
      viewerOpen = false;
      send({ type: 'back' });
    }
  });

  // A notification tapped while the app is already open.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.uo !== 'open') return;
      var target = readOpen(JSON.stringify(data.target || null));
      if (!target) return;
      if (appWindow) send({ type: 'open', target: target });
      else pendingOpen = target;
    });
  }
})();
