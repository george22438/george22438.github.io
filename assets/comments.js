/* The Garcia Report — no-login comments on Firebase Realtime Database.
 * Data: comments/<postSlug>/<pushId> = { name, text, ts }
 * All user content is rendered with textContent (never innerHTML).
 */
(function () {
  "use strict";
  var SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
  var NAME_MAX = 40;
  var TEXT_MAX = 1000;
  var COOLDOWN_MS = 20000;
  var LIMIT = 200;
  var NAME_KEY = "tgr-comment-name";
  var LAST_KEY = "tgr-comment-last";

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) {}
    return null;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing && existing.getAttribute("data-loaded") === "1") return resolve();
      var s = existing || document.createElement("script");
      s.addEventListener("load", function () { s.setAttribute("data-loaded", "1"); resolve(); });
      s.addEventListener("error", function () { reject(new Error("load failed: " + src)); });
      if (!existing) {
        s.src = src;
        s.async = false;
        document.head.appendChild(s);
      }
    });
  }

  function loadFirebase(configSrc) {
    var chain = Promise.resolve();
    if (typeof window.__TGR_FIREBASE_CONFIG__ === "undefined") {
      chain = chain.then(function () { return loadScript(configSrc); });
    }
    if (typeof window.firebase === "undefined" || !window.firebase.apps) {
      chain = chain.then(function () { return loadScript(SDK + "firebase-app-compat.js"); });
    }
    return chain.then(function () {
      if (typeof window.firebase.database !== "function") {
        return loadScript(SDK + "firebase-database-compat.js");
      }
    });
  }

  function safeKey(slug) {
    return String(slug || "").replace(/[.#$\[\]\/]/g, "_").slice(0, 200);
  }

  function relTime(ts) {
    if (typeof ts !== "number") return "just now";
    var diff = Math.max(0, Date.now() - ts);
    var s = Math.floor(diff / 1000);
    if (s < 45) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + (m === 1 ? " min ago" : " mins ago");
    var h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? " hr ago" : " hrs ago");
    var d = Math.floor(h / 24);
    if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
    } catch (e) {
      return new Date(ts).toDateString();
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  ready(function () {
    var root = document.querySelector("[data-comments-slug]");
    if (!root) return;
    var slug = safeKey(root.getAttribute("data-comments-slug"));
    if (!slug) return;
    var configSrc = root.getAttribute("data-firebase-config") || "/assets/fantasy-firebase-config.js";

    var form = root.querySelector(".tgr-c-form");
    var nameIn = root.querySelector(".tgr-c-name");
    var textIn = root.querySelector(".tgr-c-text");
    var honey = root.querySelector(".tgr-c-hp");
    var btn = root.querySelector(".tgr-c-post");
    var statusEl = root.querySelector(".tgr-c-status");
    var charsEl = root.querySelector(".tgr-c-chars");
    var listEl = root.querySelector(".tgr-c-list");
    var countEl = root.querySelector(".tgr-c-count");
    var emptyEl = root.querySelector(".tgr-c-empty");

    var ref = null;
    var posting = false;
    var cooldownTimer = null;
    var items = [];

    var savedName = store(NAME_KEY);
    if (savedName && nameIn) nameIn.value = savedName.slice(0, NAME_MAX);

    function setStatus(msg, kind) {
      statusEl.textContent = msg || "";
      statusEl.className = "tgr-c-status" + (kind ? " is-" + kind : "");
    }

    function updateChars() {
      var n = textIn.value.length;
      charsEl.textContent = n + " / " + TEXT_MAX;
      charsEl.classList.toggle("is-over", n > TEXT_MAX);
    }

    function cooldownLeft() {
      var last = parseInt(store(LAST_KEY) || "0", 10) || 0;
      return Math.max(0, COOLDOWN_MS - (Date.now() - last));
    }

    function refreshButton() {
      var left = cooldownLeft();
      if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
      if (!ref) { btn.disabled = true; btn.textContent = "Post"; return; }
      if (posting) { btn.disabled = true; btn.textContent = "Posting…"; return; }
      if (left > 0) {
        btn.disabled = true;
        btn.textContent = "Wait " + Math.ceil(left / 1000) + "s";
        cooldownTimer = setTimeout(refreshButton, 1000);
        return;
      }
      btn.disabled = false;
      btn.textContent = "Post";
    }

    function render() {
      listEl.textContent = "";
      var sorted = items.slice().sort(function (a, b) {
        var ta = typeof a.ts === "number" ? a.ts : Date.now();
        var tb = typeof b.ts === "number" ? b.ts : Date.now();
        return tb - ta || (a.key < b.key ? 1 : -1);
      });
      sorted.forEach(function (c) {
        var li = el("li", "tgr-c-item");
        var head = el("div", "tgr-c-head");
        head.appendChild(el("span", "tgr-c-author", c.name));
        var t = el("time", "tgr-c-time", relTime(c.ts));
        if (typeof c.ts === "number") {
          t.setAttribute("datetime", new Date(c.ts).toISOString());
          t.setAttribute("title", new Date(c.ts).toLocaleString());
          t.setAttribute("data-ts", String(c.ts));
        }
        head.appendChild(t);
        li.appendChild(head);
        li.appendChild(el("p", "tgr-c-body", c.text));
        listEl.appendChild(li);
      });
      var n = items.length;
      countEl.textContent = n >= LIMIT ? LIMIT + "+" : String(n);
      emptyEl.hidden = n !== 0;
    }

    function tick() {
      var times = listEl.querySelectorAll("time[data-ts]");
      for (var i = 0; i < times.length; i++) {
        times[i].textContent = relTime(parseInt(times[i].getAttribute("data-ts"), 10));
      }
    }

    function start() {
      var CONFIG = window.__TGR_FIREBASE_CONFIG__;
      if (!window.__TGR_FIREBASE_READY__ || !CONFIG) throw new Error("Firebase not configured");
      var fb = window.firebase;
      if (!fb.apps.length) fb.initializeApp(CONFIG);
      ref = fb.database().ref("comments/" + slug);
      ref.orderByKey().limitToLast(LIMIT).on(
        "value",
        function (snap) {
          var next = [];
          snap.forEach(function (child) {
            var v = child.val() || {};
            if (typeof v.name !== "string" || typeof v.text !== "string") return;
            next.push({
              key: child.key,
              name: v.name.slice(0, NAME_MAX),
              text: v.text.slice(0, TEXT_MAX),
              ts: typeof v.ts === "number" ? v.ts : null,
            });
          });
          items = next;
          root.classList.remove("is-loading");
          render();
        },
        function (err) {
          root.classList.remove("is-loading");
          setStatus("Couldn't load comments right now.", "error");
          if (window.console) console.warn("comments read failed", err);
        }
      );
      setInterval(tick, 60000);
      refreshButton();
    }

    textIn.addEventListener("input", updateChars);
    updateChars();
    refreshButton();

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!ref || posting) return;
      var name = nameIn.value.replace(/\s+/g, " ").trim();
      var text = textIn.value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!name) { setStatus("Add a display name.", "error"); nameIn.focus(); return; }
      if (name.length > NAME_MAX) { setStatus("Name must be " + NAME_MAX + " characters or fewer.", "error"); return; }
      if (!text) { setStatus("Write a comment first.", "error"); textIn.focus(); return; }
      if (text.length > TEXT_MAX) { setStatus("Comment must be " + TEXT_MAX + " characters or fewer.", "error"); return; }
      var left = cooldownLeft();
      if (left > 0) { setStatus("Easy, champ — wait " + Math.ceil(left / 1000) + "s before posting again.", "error"); refreshButton(); return; }
      store(NAME_KEY, name);
      // Honeypot: bots fill hidden fields. Pretend success, write nothing.
      if (honey && honey.value) {
        store(LAST_KEY, String(Date.now()));
        textIn.value = "";
        updateChars();
        setStatus("Posted.", "ok");
        refreshButton();
        return;
      }
      posting = true;
      refreshButton();
      setStatus("");
      ref
        .push({ name: name, text: text, ts: window.firebase.database.ServerValue.TIMESTAMP })
        .then(function () {
          store(LAST_KEY, String(Date.now()));
          textIn.value = "";
          updateChars();
          setStatus("Posted. Thanks for weighing in.", "ok");
        })
        .catch(function (err) {
          setStatus("Couldn't post that. Check your connection and try again.", "error");
          if (window.console) console.warn("comment write failed", err);
        })
        .then(function () {
          posting = false;
          refreshButton();
        });
    });

    function boot() {
      loadFirebase(configSrc)
        .then(start)
        .catch(function (err) {
          root.classList.remove("is-loading");
          setStatus("Comments are unavailable right now.", "error");
          if (window.console) console.warn("comments init failed", err);
        });
    }

    // Lazy-load Firebase only when the comments section gets close to the viewport.
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          if (entries.some(function (en) { return en.isIntersecting; })) {
            io.disconnect();
            boot();
          }
        },
        { rootMargin: "800px 0px" }
      );
      io.observe(root);
    } else {
      boot();
    }
  });
})();
