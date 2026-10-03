/**
 * The Garcia Report — Live fantasy standings (current event + archives)
 * Subscribes to Firebase RTDB standings path; falls back to static seed JSON.
 * Per-page seed JSON (#fx-standings-seed) can override standingsPath,
 * categories and categoryLegend, so /fantasy/ (UFC 332) and
 * /fantasy/vegas-121/ (archive) share this script.
 */
(function () {
  "use strict";

  var STANDINGS_PATH = "standings/ufc332";
  var ORDER_DEFAULT = ["tgr", "open1", "open2", "open3"];

  // Points by scoring category (keys match agent/updater breakdown object)
  var CATEGORIES = [
    { key: "decision", label: "Decision", short: "DEC" },
    { key: "ko_tko", label: "KO/TKO", short: "KO" },
    { key: "submission", label: "Submission", short: "SUB" },
    { key: "draw", label: "Draw", short: "DRW" },
    { key: "knockdown", label: "Knockdown", short: "KD" },
    { key: "takedown", label: "Takedown", short: "TD" },
    { key: "sig_strike", label: "Sig. strikes", short: "SS" },
    { key: "fotn", label: "Fight of Night", short: "FOTN" },
    { key: "potn", label: "Perf. of Night", short: "POTN" },
  ];


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

  STANDINGS_PATH =
    (SEED && SEED.standingsPath) || window.__TGR_STANDINGS_PATH__ || STANDINGS_PATH;
  if (SEED && Array.isArray(SEED.categories) && SEED.categories.length) {
    CATEGORIES = SEED.categories;
  }
  var LEGEND =
    (SEED && SEED.categoryLegend) ||
    "DEC decision · KO finish · SUB submission · DRW draw · KD knockdown · TD takedown · SS sig. strikes · FOTN / POTN bonuses";
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

  /* ---------- Crowned team display (display only — Firebase/JSON names untouched) ----------
   * Mirrors makeCrown() in build.js. Keyed on team id: SEED.crowned (content JSON
   * "crowned": ["open1"]), falling back to open1 (last event's King of The Ring).
   * displayTeamName(id, name)            → "Ferm20" (escaped HTML, no inline crowns)
   * displayTeamName(id, name, {top:true}) → name + the single glowing crown centered above
   * crownText(str)                        → escaped prose; stray 👑 around crowned names stripped
   * Exactly one crown per name display: only the {top:true} crown above the name. */
  var CROWN = "\uD83D\uDC51";
  var CROWNED_IDS =
    SEED && Array.isArray(SEED.crowned) ? SEED.crowned.map(String) : ["open1"];
  var crownRe = null;

  function stripCrowns(name) {
    return String(name == null ? "" : name).replace(
      /^(?:\s|\uD83D\uDC51)+|(?:\s|\uD83D\uDC51)+$/g,
      ""
    );
  }

  function isCrowned(id) {
    return id != null && CROWNED_IDS.indexOf(String(id)) !== -1;
  }

  function reEsc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function setCrownNames(teamList) {
    var names = [];
    (teamList || []).forEach(function (t) {
      if (!t || !isCrowned(t.id)) return;
      [t.name, t.owner, t.coach, t.manager].forEach(function (n) {
        var c = stripCrowns(n);
        if (c && names.indexOf(c) === -1) names.push(c);
      });
    });
    names.sort(function (a, b) {
      return b.length - a.length;
    });
    crownRe = names.length
      ? new RegExp(
          "(^|[^A-Za-z0-9_])(?:" + CROWN + "\\s*)?(" +
            names.map(function (n) { return reEsc(esc(n)); }).join("|") +
            ")(?![A-Za-z0-9_])(?:\\s*" + CROWN + ")?",
          "g"
        )
      : null;
  }

  function displayTeamName(teamId, name, opts) {
    var n = stripCrowns(name);
    if (!isCrowned(teamId) || !n) return esc(name);
    if (opts && opts.top) {
      return (
        '<span class="fx-crowned fx-crowned-top">' +
        '<span class="fx-crown-top" aria-hidden="true">' + CROWN + "</span>" +
        '<span class="fx-crowned-line">' + esc(n) + "</span>" +
        "</span>"
      );
    }
    return esc(n);
  }

  function displayTeamNamePlain(teamId, name) {
    var n = stripCrowns(name);
    return isCrowned(teamId) && n ? n : String(name == null ? "" : name);
  }

  function crownText(str) {
    var out = esc(str);
    return crownRe
      ? out.replace(crownRe, function (m, pre, n) {
          return pre + n;
        })
      : out;
  }

  setCrownNames((SEED && SEED.teams) || []);

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
    // 0.25 per sig. strike → keep quarter points (e.g. 12.25, 12.5)
    return x.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
  }

  function emptyBreakdown() {
    var b = {};
    CATEGORIES.forEach(function (c) {
      b[c.key] = 0;
    });
    return b;
  }

  function normalizeBreakdown(raw) {
    var b = emptyBreakdown();
    if (!raw || typeof raw !== "object") return b;
    CATEGORIES.forEach(function (c) {
      var n = Number(raw[c.key]);
      b[c.key] = Number.isFinite(n) ? n : 0;
    });
    return b;
  }

  function renderBreakdownHtml(breakdown, compact) {
    var b = normalizeBreakdown(breakdown);
    var items = CATEGORIES.map(function (c) {
      var v = b[c.key];
      var cls =
        "fx-cat" + (v ? " has-pts" : "") + (compact ? " compact" : "");
      return (
        '<li class="' +
        cls +
        '" title="' +
        esc(c.label) +
        '"><span class="fx-cat-label">' +
        esc(compact ? c.short : c.label) +
        '</span><span class="fx-cat-pts">' +
        esc(fmtPts(v)) +
        "</span></li>"
      );
    }).join("");
    return '<ul class="fx-breakdown" aria-label="Points by category">' + items + "</ul>";
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

  function kingTeamCell(t, isKing, top) {
    if (!isKing) {
      return (
        "<td>" +
        displayTeamName(t.id, t.name, { top: !!top }) +
        (t.owner
          ? '<span class="fx-owner">Coach · ' + displayTeamName(t.id, t.owner) + "</span>"
          : "") +
        "</td>"
      );
    }
    return (
      '<td class="fx-king-cell">' +
      '<div class="fx-king-throne">' +
      '<span class="fx-king-crown-giant" aria-hidden="true">👑</span>' +
      '<span class="fx-king-claim">King of The Ring</span>' +
      '<strong class="fx-king-name">' +
      displayTeamName(t.id, t.name) +
      "</strong>" +
      (t.owner
        ? '<span class="fx-owner">Coach · ' + displayTeamName(t.id, t.owner) + "</span>"
        : "") +
      "</div></td>"
    );
  }

  function renderStandings(data) {
    var list = teamsArray(data);
    var isFinal = data && data.meta && data.meta.status === "final";
    var rows = list
      .map(function (t, i) {
        var isKing = isFinal && i === 0;
        return (
          "<tr" +
          (isKing ? ' class="fx-king-row"' : isCrowned(t.id) ? ' class="fx-crowned-row"' : "") +
          ">" +
          '<td class="fx-rank-cell">' +
          (i + 1) +
          "</td>" +
          kingTeamCell(t, isKing, true) +
          '<td class="fx-pts' +
          (isKing ? " fx-king-pts" : "") +
          '">' +
          esc(fmtPts(t.points)) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    var catHead =
      "<th>#</th><th>Team</th>" +
      CATEGORIES.map(function (c) {
        return '<th title="' + esc(c.label) + '">' + esc(c.short) + "</th>";
      }).join("") +
      "<th>Total</th>";
    var catRows = list
      .map(function (t, i) {
        var b = normalizeBreakdown(t.breakdown);
        var isKing = isFinal && i === 0;
        var cells = CATEGORIES.map(function (c) {
          var v = b[c.key];
          return (
            '<td class="fx-cat-cell' +
            (v ? " has-pts" : "") +
            '">' +
            esc(fmtPts(v)) +
            "</td>"
          );
        }).join("");
        return (
          "<tr" +
          (isKing ? ' class="fx-king-row"' : isCrowned(t.id) ? ' class="fx-crowned-row"' : "") +
          ">" +
          '<td class="fx-rank-cell">' +
          (i + 1) +
          "</td>" +
          kingTeamCell(t, isKing, false) +
          cells +
          '<td class="fx-pts' +
          (isKing ? " fx-king-pts" : "") +
          '">' +
          esc(fmtPts(t.points)) +
          "</td></tr>"
        );
      })
      .join("");

    var kingCallout = "";
    if (isFinal && list.length) {
      kingCallout =
        '<aside class="fx-king-callout fx-king-winner" role="status">' +
        '<div class="fx-king-winner-inner">' +
        '<span class="fx-king-crown-giant" aria-hidden="true">👑</span>' +
        '<p class="fx-king-claim">King of The Ring</p>' +
        '<strong class="fx-king-name-hero">' +
        displayTeamName(list[0].id, list[0].name) +
        "</strong>" +
        '<p class="fx-king-score">' +
        esc(fmtPts(list[0].points)) +
        " pts" +
        (list[0].owner ? " · Coach " + displayTeamName(list[0].id, list[0].owner) : "") +
        "</p>" +
        '<p class="fx-king-tagline">Crowned — highest-scoring coach on fight night</p>' +
        "</div></aside>";
    }

    root.innerHTML =
      kingCallout +
      '<div class="fx-table-wrap">' +
      '<table class="fx-table fx-standings-live">' +
      "<thead><tr><th>#</th><th>Team</th><th>Points</th></tr></thead>" +
      "<tbody>" +
      (rows ||
        '<tr><td colspan="3" class="fx-muted">No teams yet.</td></tr>') +
      "</tbody></table></div>" +
      '<div class="fx-cat-board">' +
      "<h3>Points by category</h3>" +
      '<p class="fx-muted fx-cat-legend">' + esc(LEGEND) + "</p>" +
      '<div class="fx-table-wrap fx-cat-scroll">' +
      '<table class="fx-table fx-cat-table">' +
      "<thead><tr>" +
      catHead +
      "</tr></thead><tbody>" +
      (catRows ||
        '<tr><td colspan="' +
        String(3 + CATEGORIES.length) +
        '" class="fx-muted">No teams yet.</td></tr>') +
      "</tbody></table></div></div>";
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
          '<article class="fx-team-card' +
          (isCrowned(t.id) ? " fx-crowned-card" : "") +
          '" data-team="' +
          esc(t.id) +
          '">' +
          "<header><h3>" +
          displayTeamName(t.id, t.name, { top: true }) +
          "</h3>" +
          (t.owner
            ? '<p class="fx-mgr">Coach · ' + displayTeamName(t.id, t.owner) + "</p>"
            : "") +
          "</header>" +
          '<ul class="fx-roster">' +
          slots +
          "</ul>" +
          '<div class="fx-team-pts"><span>Points</span><strong>' +
          esc(fmtPts(t.points)) +
          "</strong></div>" +
          renderBreakdownHtml(t.breakdown, false) +
          "</article>"
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
          crownText(e.text || "Update") +
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
    setCrownNames(teamsArray(data).concat((SEED && SEED.teams) || []));
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
        owner: t.coach || t.manager || t.name,
        points: t.points || 0,
        breakdown: emptyBreakdown(),
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
