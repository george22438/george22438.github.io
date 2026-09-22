(function () {
  var NS = "thegarciareport";
  var BASE = "https://abacus.jasoncameron.dev";

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var root = document.querySelector("[data-like-slug]");
    if (!root) return;
    var slug = root.getAttribute("data-like-slug");
    if (!slug) return;

    var btn = root.querySelector(".glove-like");
    var countEl = root.querySelector(".glove-like-count");
    if (!btn || !countEl) return;

    var storageKey = "tgr-liked:" + slug;
    var liked = false;
    try {
      liked = localStorage.getItem(storageKey) === "1";
    } catch (e) {}

    function setLikedUI(on) {
      btn.classList.toggle("is-liked", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }

    function setCount(n) {
      countEl.textContent = String(n);
    }

    setLikedUI(liked);

    fetch(BASE + "/get/" + encodeURIComponent(NS) + "/" + encodeURIComponent("like-" + slug))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && typeof data.value === "number") setCount(data.value);
      })
      .catch(function () {});

    btn.addEventListener("click", function () {
      if (liked) return;
      liked = true;
      setLikedUI(true);
      try {
        localStorage.setItem(storageKey, "1");
      } catch (e) {}
      var current = parseInt(countEl.textContent, 10);
      if (!isNaN(current)) setCount(current + 1);
      fetch(BASE + "/hit/" + encodeURIComponent(NS) + "/" + encodeURIComponent("like-" + slug))
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (data && typeof data.value === "number") setCount(data.value);
        })
        .catch(function () {});
    });
  });
})();
