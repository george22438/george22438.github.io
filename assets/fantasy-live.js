/**
 * The Garcia Report — Live fantasy standings (UFC Vegas 121)
 * Subscribes to Firebase RTDB standings path; falls back to static seed JSON.
 */
(function () {
  "use strict";

  var STANDINGS_PATH = "standings/vegas121";
  var ORDER_DEFAULT = ["tgr", "open1", "open2", "open3"];

  var root = document.getElementById("fx-live-standings");
  if (!root) return;

  var teamsMount = document.getElementById("fx-live-teams");
  var feedMount = document.getElementById("fx-live-feed");
  var badgeEl = document.getElementById("fx-live-badge");
  var updatedEl = document.getElementById("fx-live-updated");
  var statusEl = document.getElementById("fx-live-status-label");
  var seedEl = document.getElementById("fx-standings-seed");

  var SEED = null;
  if (seedEl) {
    try {
      SEED = JSON.parse(seedEl.textContent);
    } catch (e) {
      SEED = null;
    }
  }

  STANDINGS_PATH = window.__TGR_STANDINGS_PATH__ || STANDINGS_PATH;
  var FIREBASE_READY = !!window.__TGR_FIREBASE_READY__;
  var CONFIG = window.__TGR_FIREBASE_CONFIG__ || {};

  var draftOrder =
    (SEED && SEED.draftOrder) || ORDER_DEFAULT.slice();

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initials(name, fallback) {
    if (fallback) return String(fallback);
    var parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function fmtPts(n) {
    var x = Number(n);
    if (!Number.isFinite(x)) return "0";
    if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
    return x.toFixed(1).replace(/\.0$/, "");
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      var d = new Date(ts);
      return d.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
    } catch (e) {
      return String(ts);
    }
  }

  function statusLabel(s) {
    var map = {
      "pre-draft": "Pre-draft",
      drafting: "Drafting",
      locked: "Locked",
      live: "Live scoring",
      final: "Final",
    };
    return map[s] || s || "—";
  }

  function teamsArray(data) {
    var teams = (data && data.teams) || {};
    var list = Object.keys(teams).map(function (id) {
      return teams[id];
    });
    list.sort(function (a, b) {
      var pa = Number(a.points) || 0;
      var pb = Number(b.points) || 0;
      if (pb !== pa) return pb - pa;
      return draftOrder.indexOf(a.id) - draftOrder.indexOf(b.id);
    });
    return list;
  }

  function feedArray(data) {
    var feed = (data && data.feed) || {};
    var list = Object.keys(feed).map(function (k) {
      var e = feed[k] || {};
      return {
        key: k,
        ts: e.ts || 0,
        text: e.text || e.note || "",
        teamId: e.teamId || null,
        points: e.points,
        delta: e.delta,
      };
    });
    list.sort(function (a, b) {
      return (b.ts || 0) - (a.ts || 0);
    });
    return list.slice(0, 12);
  }

  function setBadge(kind, text) {
    if (!badgeEl) return;
    badgeEl.hidden = false;
    badgeEl.className = "fx-live-badge " + kind;
    badgeEl.textContent = text;
  }

  function renderStandings(data) {
    var list = teamsArray(data);
    var rows = list
      .map(function (t, i) {
        return (
          "<tr>" +
          '<td class="fx-rank-cell">' +
          (i + 1) +
          "</td>" +
          "<td>" +
          esc(t.name) +
          (t.owner
            ? '<span class="fx-owner">' + esc(t.owner) + "</span>"
            : "") +
          "</td>" +
          '<td class="fx-pts">' +
          esc(fmtPts(t.points)) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    root.innerHTML =
      '<div class="fx-table-wrap">' +
      '<table class="fx-table fx-standings-live">' +
      "<thead><tr><th>#</th><th>Team</th><th>Points</th></tr></thead>" +
      "<tbody>" +
      (rows ||
        '<tr><td colspan="3" class="fx-muted">No teams yet.</td></tr>') +
      "</tbody></table></div>";
  }

  function renderTeams(data) {
    if (!teamsMount) return;
    var list = teamsArray(data);
    var cards = list
      .map(function (t) {
        var roster = t.roster || [];
        var slots = "";
        var i;
        for (i = 0; i < 5; i++) {
          var r = roster[i];
          if (!r || !r.id) {
            slots +=
              '<li><span class="fx-round">R' +
              (i + 1) +
              '</span><span class="fx-empty">—</span></li>';
          } else {
            var pts =
              typeof r.points === "number" && r.points
                ? '<span class="fx-slot-pts">' + esc(fmtPts(r.points)) + "</span>"
                : "";
            slots +=
              '<li><span class="fx-round">R' +
              (i + 1) +
              '</span><span class="fx-avatar sm" aria-hidden="true">' +
              esc(initials(r.name, r.initials)) +
              "</span><span>" +
              esc(r.name || r.id) +
              "</span>" +
              pts +
              "</li>";
          }
        }
        return (
          '<article class="fx-team-card" data-team="' +
          esc(t.id) +
          '">' +
          "<header><h3>" +
          esc(t.name) +
          "</h3>" +
          (t.owner
            ? '<p class="fx-mgr">' + esc(t.owner) + "</p>"
            : "") +
          "</header>" +
          '<ul class="fx-roster">' +
          slots +
          "</ul>" +
          '<div class="fx-team-pts"><span>Points</span><strong>' +
          esc(fmtPts(t.points)) +
          "</strong></div></article>"
        );
      })
      .join("");

    var intro = teamsMount.querySelector(".fx-live-teams-intro");
    var introHtml = intro ? intro.outerHTML : "";
    teamsMount.innerHTML =
      introHtml + '<div class="fx-teams-grid">' + cards + "</div>";
  }

  function renderFeed(data) {
    if (!feedMount) return;
    var items = feedArray(data);
    if (!items.length) {
      feedMount.hidden = true;
      feedMount.innerHTML = "";
      return;
    }
    feedMount.hidden = false;
    var lis = items
      .map(function (e) {
        var delta =
          e.delta != null && Number.isFinite(Number(e.delta))
            ? '<span class="fx-feed-delta">' +
              (e.delta > 0 ? "+" : "") +
              esc(fmtPts(e.delta)) +
              "</span>"
            : "";
        return (
          "<li>" +
          '<span class="fx-feed-time">' +
          esc(fmtTime(e.ts)) +
          "</span> " +
          esc(e.text || "Update") +
          " " +
          delta +
          "</li>"
        );
      })
      .join("");
    feedMount.innerHTML =
      "<h3>Live feed</h3><ul class=\"fx-feed-list\">" + lis + "</ul>";
  }

  function renderMeta(data) {
    var meta = (data && data.meta) || {};
    if (updatedEl) {
      updatedEl.textContent = meta.updatedAt
        ? "Updated " + fmtTime(meta.updatedAt)
        : "";
    }
    if (statusEl) {
      statusEl.textContent = statusLabel(meta.status);
      statusEl.dataset.status = meta.status || "";
    }
  }

  function applyData(data, source) {
    if (!data || !data.teams) return;
    renderStandings(data);
    renderTeams(data);
    renderFeed(data);
    renderMeta(data);
    if (source === "firebase") {
      setBadge("live", "Live");
    } else if (source === "seed") {
      setBadge("static", "Static");
    }
  }

  function seedAsStandings() {
    if (!SEED || !SEED.teams) return null;
    var teams = {};
    (SEED.teams || []).forEach(function (t) {
      var roster = (t.roster || [null, null, null, null, null]).map(function (fid) {
        if (!fid) return { id: null, name: null, initials: null, points: 0 };
        return { id: fid, name: fid, initials: null, points: 0 };
      });
      teams[t.id] = {
        id: t.id,
        name: t.name,
        owner: t.manager || t.name,
        points: t.points || 0,
        roster: roster,
      };
    });
    return {
      meta: {
        leagueName: SEED.leagueName,
        status: "pre-draft",
        updatedAt: null,
      },
      teams: teams,
      feed: {},
    };
  }

  function waitForFirebase(cb) {
    var tries = 0;
    (function tick() {
      if (typeof firebase !== "undefined" && firebase.apps) {
        cb();
        return;
      }
      tries += 1;
      if (tries > 80) {
        cb(new Error("firebase timeout"));
        return;
      }
      setTimeout(tick, 50);
    })();
  }

  function connectFirebase() {
    setBadge("connecting", "Connecting…");
    waitForFirebase(function (err) {
      if (err || typeof firebase === "undefined") {
        setBadge("offline", "Offline");
        applyData(seedAsStandings(), "seed");
        return;
      }
      try {
        if (!firebase.apps.length) firebase.initializeApp(CONFIG);
        var ref = firebase.database().ref(STANDINGS_PATH);
        ref.on(
          "value",
          function (snap) {
            var val = snap.val();
            if (!val || !val.teams) {
              setBadge("connecting", "Waiting for seed…");
              applyData(seedAsStandings(), "seed");
              return;
            }
            applyData(val, "firebase");
          },
          function () {
            setBadge("offline", "Offline");
            applyData(seedAsStandings(), "seed");
          }
        );
      } catch (e) {
        setBadge("offline", "Offline");
        applyData(seedAsStandings(), "seed");
      }
    });
  }

  // Initial painted state from static seed (SEO HTML already present; this refreshes mounts)
  applyData(seedAsStandings(), "seed");

  if (
    FIREBASE_READY &&
    CONFIG.apiKey &&
    CONFIG.databaseURL &&
    String(CONFIG.databaseURL).indexOf("firebaseio.com") !== -1
  ) {
    connectFirebase();
  } else {
    setBadge("static", "Static");
  }
})();
