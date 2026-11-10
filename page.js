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
  // The camera is shown by this page itself (scan.html in a frame of ours), which a phone lets use it even when the app
  // sits inside Google's frame or was installed to the home screen.
  function cameraHere() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
  }
  var scanFrame = null;
  var scanId = null;
  function closeScan() {
    if (scanFrame) scanFrame.remove();
    scanFrame = null;
    scanId = null;
  }
  function openScan(mode, id) {
    closeScan();
    if (!cameraHere() || !/^(document|photo)$/.test(mode) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
      return send({ type: 'scan-result', id: id, noCamera: true });
    }
    scanId = id;
    scanFrame = document.createElement('iframe');
    scanFrame.id = 'uo-scan';
    scanFrame.setAttribute('allow', 'camera');
    scanFrame.title = 'تصوير';
    scanFrame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:30;background:#0c0a09';
    scanFrame.src = 'scan.html#' + mode + ':' + id;
    document.body.appendChild(scanFrame);
  }
  // The camera frame answers its own page (same address, same frame): the photo is handed on to the app.
  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || !scanFrame || event.source !== scanFrame.contentWindow) return;
    var data = event.data;
    if (!data || data.uo !== 1 || data.type !== 'scan-result' || data.id !== scanId) return;
    var id = scanId;
    closeScan();
    send({ type: 'scan-result', id: id, file: data.file && typeof data.file.size === 'number' && typeof data.file.type === 'string' ? data.file : null, noCamera: data.noCamera === true });
  });

  function info() {
    return currentSubscription().then(function (sub) {
      return { push: pushSupported(), standalone: standalone, ios: isIOS, permission: permission(), subscribed: Boolean(sub) && permission() === 'granted', scan: cameraHere(), brave: Boolean(navigator.brave) };
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
        // "Registration failed - push service error" (AbortError): the browser cannot reach its push service. Brave turns
        // Google's push service off by default, which is the usual reason there.
        var name = err && err.name;
        send({ type: 'push-result', ok: false, reason: permission() === 'denied' || name === 'NotAllowedError' ? 'denied' : name === 'AbortError' ? 'push-service' : 'failed' });
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

  // The opening screen above the frame goes away when the app says hello (or after a while, whatever happens).
  function hideBoot() {
    var boot = document.getElementById('boot');
    if (!boot) return;
    boot.style.opacity = '0';
    setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 400);
  }
  setTimeout(hideBoot, 25000);

  window.addEventListener('message', function (event) {
    if (!APP_ORIGIN.test(event.origin) || !insideOurFrame(event.source)) return;
    var data = event.data;
    if (!data || data.uo !== 1 || typeof data.type !== 'string') return;
    appWindow = event.source;
    appOrigin = event.origin;
    switch (data.type) {
      case 'hello':
        hideBoot();
        info().then(function (i) {
          send({ type: 'hello', info: i, open: pendingOpen });
          pendingOpen = null;
        });
        break;
      case 'status':
        info().then(function (i) { send({ type: 'status', info: i }); });
        break;
      case 'scan-open':
        openScan(data.mode, data.id);
        break;
      case 'scan-cancel':
        if (scanId === data.id) closeScan();
        break;
      // A backup copy of the sign-in: the browser may wipe the app's own storage, but keeps this page's.
      case 'session-save':
        if (typeof data.token === 'string' && /^[a-f0-9]{64}$/.test(data.token)) {
          try { localStorage.setItem('uo_session_copy', data.token); } catch (e) { /* no storage here */ }
        }
        break;
      case 'session-clear':
        try { localStorage.removeItem('uo_session_copy'); } catch (e) { /* no storage here */ }
        break;
      case 'session-load':
        var kept = null;
        try { kept = localStorage.getItem('uo_session_copy'); } catch (e) { kept = null; }
        // Only our own frame is answered (checked above), and only with a token of the right shape.
        send({ type: 'session', token: kept && /^[a-f0-9]{64}$/.test(kept) ? kept : null });
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

  // ---- The first thing a person sees: ask for notifications with one big tap, and offer to install ----
  var SVG_SHARE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  var SVG_ADD = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';
  var SVG_BELL = '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  var installEvent = null;
  var card = null;

  function laterThisSession() {
    try { return sessionStorage.getItem('uo_card_later') === '1'; } catch (e) { return false; }
  }
  function rememberLater() {
    try { sessionStorage.setItem('uo_card_later', '1'); } catch (e) { /* shown again next time */ }
  }

  function cardState() {
    if (isIOS && !standalone) return 'ios-install';
    if (!pushSupported()) return null;
    var p = permission();
    if (p === 'granted') return null;
    return p === 'denied' ? 'denied' : 'ask';
  }

  function el(tag, css, text) {
    var node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text) node.textContent = text;
    return node;
  }

  function stepRow(number, text, iconSvg) {
    var row = el('li', 'display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:17px;text-align:start');
    row.appendChild(el('span', 'flex:none;width:28px;height:28px;border-radius:50%;background:#78350f;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center', String(number)));
    row.appendChild(el('span', 'flex:1', text));
    if (iconSvg) {
      var icon = el('span', 'flex:none;display:flex');
      icon.innerHTML = iconSvg; // fixed pictures written above, never text from outside
      row.appendChild(icon);
    }
    return row;
  }

  function removeCard() {
    if (card) card.remove();
    card = null;
  }

  function renderCard() {
    var state = cardState();
    if (!state || laterThisSession()) return removeCard();
    removeCard();
    card = el('div', 'position:fixed;inset:0;z-index:20;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 22px calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;text-align:center;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif');
    card.id = 'uo-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('data-state', state);
    var icon = el('div', 'margin-bottom:18px');
    icon.innerHTML = SVG_BELL;
    card.appendChild(icon);

    var title = state === 'ios-install' ? 'ثبّت التطبيق على الآيفون' : state === 'denied' ? 'الإشعارات ممنوعة' : 'فعّل الإشعارات';
    card.appendChild(el('h1', 'margin:0 0 10px;font-size:26px;font-weight:700', title));

    if (state === 'ask') {
      card.appendChild(el('p', 'margin:0 0 26px;font-size:17px;color:#d6d3d1;max-width:320px', 'عشان توصلك الرسايل بصوت حتى والبرنامج مقفول.'));
      var enable = el('button', 'width:100%;max-width:340px;min-height:60px;border:0;border-radius:18px;background:#fff;color:#000;font-size:20px;font-weight:700;font-family:inherit', 'فعّل الإشعارات');
      enable.id = 'uo-card-enable';
      enable.addEventListener('click', onEnableTap);
      card.appendChild(enable);
      if (installEvent) card.appendChild(installButton());
    } else if (state === 'ios-install') {
      card.appendChild(el('p', 'margin:0 0 20px;font-size:16px;color:#d6d3d1;max-width:320px', 'الإشعارات على الآيفون بتشتغل بعد التثبيت:'));
      var steps = el('ol', 'list-style:none;padding:18px 16px 6px;margin:0 0 8px;width:100%;max-width:340px;box-sizing:border-box;background:#fff;color:#1c1917;border-radius:18px');
      steps.id = 'uo-card-steps';
      steps.appendChild(stepRow(1, 'افتح اللينك من Safari'));
      steps.appendChild(stepRow(2, 'دوس زرار المشاركة', SVG_SHARE));
      steps.appendChild(stepRow(3, 'اختار «إضافة إلى الشاشة الرئيسية»', SVG_ADD));
      steps.appendChild(stepRow(4, 'افتح من الأيقونة وفعّل الإشعارات'));
      card.appendChild(steps);
    } else {
      var how = el('ol', 'list-style:none;padding:18px 16px 6px;margin:0 0 8px;width:100%;max-width:340px;box-sizing:border-box;background:#fff;color:#1c1917;border-radius:18px');
      how.id = 'uo-card-unblock';
      if (isIOS) {
        how.appendChild(stepRow(1, 'افتح إعدادات الآيفون'));
        how.appendChild(stepRow(2, 'اختار «الإشعارات» ثم Unflagged'));
        how.appendChild(stepRow(3, 'شغّل «السماح بالإشعارات»'));
      } else if (standalone) {
        how.appendChild(stepRow(1, 'افتح إعدادات الموبايل ← التطبيقات'));
        how.appendChild(stepRow(2, 'اختار Unflagged ← الإشعارات'));
        how.appendChild(stepRow(3, 'شغّل الإشعارات'));
      } else {
        how.appendChild(stepRow(1, 'دوس على القفل 🔒 جنب اللينك'));
        how.appendChild(stepRow(2, 'اختار «الإشعارات» ← «سماح»'));
        how.appendChild(stepRow(3, 'ارجع هنا'));
      }
      card.appendChild(how);
    }

    var later = el('button', 'margin-top:14px;min-height:46px;padding:0 22px;border:0;border-radius:14px;background:transparent;color:#a8a29e;font-size:16px;font-family:inherit', state === 'denied' ? 'تمام' : 'بعدين');
    later.id = 'uo-card-later';
    later.addEventListener('click', function () {
      rememberLater();
      removeCard();
    });
    card.appendChild(later);
    document.body.appendChild(card);
  }

  function onEnableTap() {
    if (!pushSupported()) return renderCard();
    // This tap is on the top page itself, so the phone really shows its "Allow" question.
    Promise.resolve(Notification.requestPermission()).then(function () {
      var state = cardState();
      if (!state) tellAppPermissionChanged();
      renderCard();
    });
  }

  function tellAppPermissionChanged() {
    send({ type: 'status-changed' });
  }

  function installButton() {
    var button = el('button', 'width:100%;max-width:340px;min-height:52px;margin-top:12px;border:2px solid #fff;border-radius:16px;background:transparent;color:#fff;font-size:18px;font-weight:700;font-family:inherit', 'ثبّت التطبيق');
    button.id = 'uo-card-install';
    button.addEventListener('click', runInstall);
    return button;
  }

  function runInstall() {
    var ev = installEvent;
    if (!ev) return;
    installEvent = null;
    try {
      ev.prompt();
      Promise.resolve(ev.userChoice).then(function () { renderCard(); removeBar(); });
    } catch (e) {
      renderCard();
    }
  }

  // After the card (or when notifications were already allowed): a small "install" strip that goes away by itself.
  var bar = null;
  function removeBar() {
    if (bar) bar.remove();
    bar = null;
  }
  function installDismissed() {
    try { return Date.now() - Number(localStorage.getItem('uo_install_later') || 0) < 3 * 86400000; } catch (e) { return false; }
  }
  function showInstallBar() {
    if (!installEvent || standalone || bar || installDismissed() || cardState() === 'ask') return;
    bar = el('div', 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:15;background:#fff;color:#1c1917;border-radius:16px;padding:10px 12px;display:flex;align-items:center;gap:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif');
    bar.id = 'uo-install-bar';
    bar.appendChild(el('span', 'flex:1;font-size:16px;font-weight:700', 'ثبّت التطبيق على موبايلك'));
    var yes = el('button', 'min-height:40px;padding:0 18px;border:0;border-radius:12px;background:#78350f;color:#fff;font-size:16px;font-weight:700;font-family:inherit', 'ثبّت');
    yes.id = 'uo-install-yes';
    yes.addEventListener('click', runInstall);
    var no = el('button', 'min-height:40px;width:40px;border:0;background:transparent;color:#78716c;font-size:22px;font-family:inherit', '×');
    no.setAttribute('aria-label', 'إغلاق');
    no.addEventListener('click', function () {
      try { localStorage.setItem('uo_install_later', String(Date.now())); } catch (e) { /* shown again */ }
      removeBar();
    });
    bar.appendChild(yes);
    bar.appendChild(no);
    document.body.appendChild(bar);
    setTimeout(removeBar, 15000);
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installEvent = event;
    if (card && card.getAttribute('data-state') === 'ask') renderCard();
    else showInstallBar();
  });
  window.addEventListener('appinstalled', function () {
    installEvent = null;
    removeBar();
    renderCard();
  });

  // Coming back from the phone's settings: if it was allowed there, the card goes away by itself.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    var before = card && card.getAttribute('data-state');
    var now = cardState();
    if (before && !now) tellAppPermissionChanged();
    if (before !== now) renderCard();
  });

  if (document.body) renderCard();
  else document.addEventListener('DOMContentLoaded', renderCard);

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
