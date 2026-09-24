(function () {
  // Service worker registration
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {});
    });
  }

  var DISMISS_KEY = "tgr-install-dismissed";
  var VISITS_KEY = "tgr-visits";
  var SESSION_KEY = "tgr-install-shown";
  var DISMISS_DAYS = 30;

  function ls(get, key, val) {
    try {
      if (get) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }
  function ss(get, key, val) {
    try {
      if (get) return sessionStorage.getItem(key);
      sessionStorage.setItem(key, val);
    } catch (e) { return null; }
  }

  var isStandalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  if (isStandalone) return;

  var dismissedAt = parseInt(ls(true, DISMISS_KEY) || "0", 10);
  if (dismissedAt && Date.now() - dismissedAt < DISMISS_DAYS * 864e5) return;

  // Count visits once per browser session.
  var visits = parseInt(ls(true, VISITS_KEY) || "0", 10);
  if (!ss(true, "tgr-visit-counted")) {
    visits += 1;
    ls(false, VISITS_KEY, String(visits));
    ss(false, "tgr-visit-counted", "1");
  }

  var ua = navigator.userAgent || "";
  var isIOS =
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isIOSSafari =
    isIOS && /safari/i.test(ua) &&
    !/crios|fxios|edgios|opios|gsa\/|fban|fbav|instagram|line\/|twitter|snapchat|pinterest/i.test(ua);

  var banner = null;
  var deferredPrompt = null;
  var hideTimer = null;

  function remove() {
    if (!banner) return;
    banner.classList.remove("is-visible");
    var b = banner;
    banner = null;
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 300);
  }

  function dismiss() {
    ls(false, DISMISS_KEY, String(Date.now()));
    remove();
  }

  function show(mode) {
    if (banner || ss(true, SESSION_KEY)) return;
    ss(false, SESSION_KEY, "1");
    banner = document.createElement("div");
    banner.className = "install-hint";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Install The Garcia Report");
    var shareIcon =
      '<svg class="install-share" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2l4 4-1.4 1.4L13 5.8V15h-2V5.8L9.4 7.4 8 6l4-4zM5 10h3v2H6v8h12v-8h-2v-2h3a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V11a1 1 0 011-1z"/></svg>';
    var text =
      mode === "ios"
        ? "Get The Garcia Report app: tap <strong>Share</strong> " + shareIcon +
          " then <strong>Add to Home Screen</strong>."
        : "Get The Garcia Report app on your home screen.";
    banner.innerHTML =
      '<img class="install-icon" src="/assets/icon-192.png" alt="" width="40" height="40" />' +
      '<p class="install-text">' + text + "</p>" +
      (mode === "prompt" ? '<button type="button" class="install-btn">Install app</button>' : "") +
      '<button type="button" class="install-close" aria-label="Dismiss">&times;</button>';
    document.body.appendChild(banner);
    banner.querySelector(".install-close").addEventListener("click", dismiss);
    var btn = banner.querySelector(".install-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        if (!deferredPrompt) return remove();
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (choice) {
          if (choice && choice.outcome === "dismissed") dismiss();
          else remove();
          deferredPrompt = null;
        });
      });
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { if (banner) banner.classList.add("is-visible"); });
    });
    // Don't sit over content forever: auto-hide after 25s (shows again next session).
    hideTimer = setTimeout(remove, 25000);
  }

  var delay = visits >= 2 ? 1500 : 5000;

  if (isIOSSafari) {
    setTimeout(function () { show("ios"); }, delay);
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(function () { show("prompt"); }, delay);
  });

  window.addEventListener("appinstalled", function () {
    ls(false, DISMISS_KEY, String(Date.now() + 3650 * 864e5));
    if (hideTimer) clearTimeout(hideTimer);
    remove();
  });
})();
