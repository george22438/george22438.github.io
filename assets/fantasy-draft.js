/**
 * The Garcia Report — Live fantasy draft client (current event: UFC 332)
 * Firebase Realtime Database under drafts/ufc332 (path comes from the page seed
 * / fantasy-firebase-config.js). Archived event: drafts/vegas121 (read-only now).
 *
 * UFC 332 rules: snake draft, 5 fighters per coach, 90s pick clock with
 * auto-pick, and NO same-bout rule — any undrafted fighter is a legal pick
 * (manual or auto). Draft order = SEED.draftOrder (single config array in
 * content/fantasy-ufc-332.json → "draftOrder"); it is re-applied from the
 * config while the room is still in the lobby and frozen at Start.
 * When __TGR_FIREBASE_READY__ is false, runs a local preview (localStorage)
 * so the UX can be tested; live multi-device sync starts once config is filled.
 */
(function () {
  "use strict";

  var ROOM_DEFAULT = "GARCIA332";
  var DRAFT_PATH = "drafts/ufc332";
  var TOTAL_PICKS = 20;
  var SLOTS = 5;
  var PICK_SECONDS = 90;
  var ORDER_FALLBACK = ["open1", "open3", "tgr", "open2"];

  var seedEl = document.getElementById("fd-seed");
  var appEl = document.getElementById("fd-app");
  if (!seedEl || !appEl) return;

  var SEED;
  try {
    SEED = JSON.parse(seedEl.textContent);
  } catch (e) {
    appEl.innerHTML = '<p class="fd-error">Draft seed data failed to load.</p>';
    return;
  }

  var ROOM_CODE = (SEED.roomCode || window.__TGR_DRAFT_ROOM_CODE__ || ROOM_DEFAULT).toUpperCase();
  DRAFT_PATH = SEED.draftPath || window.__TGR_DRAFT_PATH__ || DRAFT_PATH;
  var EVENT_KEY = SEED.eventKey || DRAFT_PATH.split("/").pop() || "event";
  // Per-event storage so a Vegas 121 seat/session never leaks into UFC 332.
  var LS_KEY = "tgr-draft-" + EVENT_KEY + "-v1";
  var LS_SESSION = "tgr-draft-session-" + EVENT_KEY + "-v1";
  var CONFIG_ORDER =
    Array.isArray(SEED.draftOrder) && SEED.draftOrder.length === 4
      ? SEED.draftOrder.slice()
      : ORDER_FALLBACK.slice();
  var FIREBASE_READY = !!window.__TGR_FIREBASE_READY__;
  var CONFIG = window.__TGR_FIREBASE_CONFIG__ || {};
  if (SEED.format && Number(SEED.format.pickSeconds) > 0) {
    PICK_SECONDS = Number(SEED.format.pickSeconds);
  }

  var state = {
    mode: "join", // join | lobby | drafting | complete
    draft: null,
    session: loadSession(),
    pendingFighter: null,
    busy: false,
    expireBusy: false,
    error: "",
    spectator: false,
    clientId: null,
  };
  var timerUiInterval = null;

  state.clientId = state.session.clientId || makeId("c");
  state.session.clientId = state.clientId;
  saveSession();

  /* ---------- helpers ---------- */
  function makeId(prefix) {
    return (
      (prefix || "id") +
      "-" +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36).slice(-4)
    );
  }

  function now() {
    return Date.now();
  }

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

  setCrownNames(SEED.teams || []);

  function refreshCrownNames(d) {
    var list = [];
    var teams = (d && d.teams) || {};
    Object.keys(teams).forEach(function (id) {
      var t = teams[id];
      if (t) list.push({ id: t.id || id, name: t.name, owner: t.owner });
    });
    setCrownNames(list.concat(SEED.teams || []));
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(LS_SESSION) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function saveSession() {
    try {
      localStorage.setItem(LS_SESSION, JSON.stringify(state.session));
    } catch (e) {}
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

  function teamForPick(snakeOrder, pickIndex) {
    var order = snakeOrder || [];
    var n = order.length;
    if (!n) return null;
    var round = Math.floor(pickIndex / n);
    var pos = pickIndex % n;
    var idx = round % 2 === 0 ? pos : n - 1 - pos;
    return order[idx];
  }

  function buildPoolFromSeed() {
    var pool = {};
    (SEED.bouts || []).forEach(function (bout) {
      ["fighterA", "fighterB"].forEach(function (side) {
        var f = bout[side];
        if (!f || !f.id) return;
        var opp = bout[side === "fighterA" ? "fighterB" : "fighterA"];
        pool[f.id] = {
          id: f.id,
          name: f.name,
          initials: f.initials || null,
          rank: f.rank == null ? null : f.rank,
          boutId: bout.id,
          opponentId: opp ? opp.id : null,
          weight: bout.weightClass || "",
          card: bout.card || "prelims",
          available: true,
        };
      });
    });
    return pool;
  }

  // BetOnline moneylines from content/fantasy-ufc-332.json (bouts[].fighterX.odds),
  // read from the page seed by fighter id so live RTDB pool data stays untouched.
  var ODDS = {};
  (SEED.bouts || []).forEach(function (bout) {
    ["fighterA", "fighterB"].forEach(function (side) {
      var f = bout[side];
      if (f && f.id && f.odds && f.odds.moneyline) ODDS[f.id] = f.odds;
    });
  });

  function oddsPill(fighterId) {
    var o = ODDS[fighterId];
    if (!o) return "";
    var line = String(o.moneyline);
    var fav = o.role ? o.role === "favorite" : /^-/.test(line);
    return (
      '<span class="fd-ml ' +
      (fav ? "fav" : "dog") +
      '" title="BetOnline moneyline">' +
      esc(line.replace(/^-/, "\u2212")) +
      "</span>"
    );
  }

  function draftedByTeam(d, fighterId) {
    var ids = Object.keys((d && d.teams) || {});
    for (var i = 0; i < ids.length; i++) {
      var t = d.teams[ids[i]];
      if (t && (t.roster || []).indexOf(fighterId) !== -1) return ids[i];
    }
    var log = (d && d.log) || [];
    for (var j = 0; j < log.length; j++) {
      if (log[j].fighterId === fighterId) return log[j].teamId;
    }
    return null;
  }

  function emptyTeam(id, name, owner, claimed) {
    return {
      id: id,
      name: name,
      owner: owner || "",
      claimed: !!claimed,
      roster: [null, null, null, null, null],
      picks: [],
    };
  }


  function ensureTeamShape(id, t) {
    var labels = {
      tgr: ["The Garcia Report", "George Garcia"],
      open1: ["Ferm20", "Ferm20"],
      open2: ["Rajmamba24", "Rajmamba24"],
      open3: ["BigFermPussyLips7", "BigFermPussyLips7"],
    };
    var L = labels[id] || [id, ""];
    if (!t) return emptyTeam(id, L[0], L[1], false);
    t.id = t.id || id;
    if (!t.name) t.name = L[0];
    if (t.owner == null) t.owner = L[1];
    if (typeof t.claimed !== "boolean") t.claimed = false;
    if (!Array.isArray(t.roster) || t.roster.length !== 5) {
      t.roster = [null, null, null, null, null];
    }
    if (!Array.isArray(t.picks)) t.picks = [];
    return t;
  }

  function normalizeDraft(d) {
    if (!d || typeof d !== "object") return createInitialDraft();
    if (!d.meta || typeof d.meta !== "object") d.meta = {};
    if (!d.meta.leagueName) {
      d.meta.leagueName = SEED.leagueName || "Garcia Report Fantasy — UFC 332";
    }
    if (!d.meta.status) d.meta.status = "lobby";
    if (d.meta.round == null) d.meta.round = 1;
    if (d.meta.pickIndex == null) d.meta.pickIndex = 0;
    if (d.meta.version == null) d.meta.version = 0;
    if (d.meta.pickSeconds == null) d.meta.pickSeconds = PICK_SECONDS;
    if (!d.meta.draftLockAt && SEED.draftLock) d.meta.draftLockAt = SEED.draftLock;
    // While in the lobby the config array is authoritative (flip it in
    // content/fantasy-ufc-332.json → draftOrder, rebuild). Frozen at Start.
    if (
      d.meta.status === "lobby" ||
      !Array.isArray(d.meta.snakeOrder) ||
      !d.meta.snakeOrder.length
    ) {
      d.meta.snakeOrder = CONFIG_ORDER.slice();
    }
    if (!d.teams || typeof d.teams !== "object") d.teams = {};
    ["tgr", "open1", "open2", "open3"].forEach(function (id) {
      d.teams[id] = ensureTeamShape(id, d.teams[id]);
    });
    // Keep TGR display name stable until claimed.
    if (!d.teams.tgr.claimed) {
      d.teams.tgr.name = "The Garcia Report";
      if (!d.teams.tgr.owner) d.teams.tgr.owner = "George Garcia";
    }
    if (!Array.isArray(d.log)) d.log = [];
    if (!d.pool) d.pool = buildPoolFromSeed();
    return d;
  }

  function createInitialDraft() {
    var order = CONFIG_ORDER.slice();
    var teams = {};
    (SEED.teams || []).forEach(function (t) {
      teams[t.id] = emptyTeam(
        t.id,
        t.name,
        t.coach || t.manager || "",
        t.id === "tgr" ? false : false
      );
      // Pilot: TGR pretends reserved but must still be claimed at join (no password).
      if (t.id === "tgr") {
        teams[t.id].name = "The Garcia Report";
        teams[t.id].owner = "George Garcia";
        teams[t.id].claimed = false;
      }
    });
    ["tgr", "open1", "open2", "open3"].forEach(function (id) {
      if (!teams[id]) {
        var labels = {
          tgr: ["The Garcia Report", "George Garcia"],
          open1: ["Ferm20", "Ferm20"],
          open2: ["Rajmamba24", "Rajmamba24"],
          open3: ["BigFermPussyLips7", "BigFermPussyLips7"],
        };
        var L = labels[id] || [id, ""];
        teams[id] = emptyTeam(id, L[0], L[1], false);
      }
    });
    return {
      meta: {
        leagueName: SEED.leagueName || "Garcia Report Fantasy — UFC 332",
        updatedAt: now(),
        status: "lobby",
        draftLockAt: SEED.draftLock || "",
        snakeOrder: order,
        round: 1,
        pickIndex: 0,
        pickSeconds: PICK_SECONDS,
        pickDeadlineMs: null,
        version: 1,
      },
      teams: teams,
      pool: buildPoolFromSeed(),
      log: [],
      presence: {},
    };
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /* ---------- storage adapters ---------- */
  var adapter = null;

  function LocalAdapter() {
    this._listeners = [];
    this._bc = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        this._bc = new BroadcastChannel("tgr-draft-" + EVENT_KEY);
        var self = this;
        this._bc.onmessage = function (ev) {
          if (ev && ev.data === "refresh") self._emit(self._read());
        };
      }
    } catch (e) {}
  }

  LocalAdapter.prototype._read = function () {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    var d = createInitialDraft();
    this._write(d);
    return d;
  };

  LocalAdapter.prototype._write = function (data) {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    try {
      if (this._bc) this._bc.postMessage("refresh");
    } catch (e) {}
  };

  LocalAdapter.prototype._emit = function (data) {
    this._listeners.forEach(function (fn) {
      try {
        fn(data);
      } catch (e) {}
    });
  };

  LocalAdapter.prototype.onValue = function (cb) {
    this._listeners.push(cb);
    cb(this._read());
  };

  LocalAdapter.prototype.transaction = function (updater) {
    var cur = this._read();
    var next = updater(cur);
    if (next === undefined) return Promise.resolve({ committed: false, snapshot: cur });
    this._write(next);
    this._emit(next);
    return Promise.resolve({ committed: true, snapshot: next });
  };

  LocalAdapter.prototype.setPresence = function (clientId, payload) {
    var self = this;
    return this.transaction(function (d) {
      if (!d) d = createInitialDraft();
      if (!d.presence) d.presence = {};
      d.presence[clientId] = payload;
      d.meta.updatedAt = now();
      return d;
    });
  };

  LocalAdapter.prototype.clearPresence = function (clientId) {
    return this.transaction(function (d) {
      if (!d || !d.presence) return d;
      delete d.presence[clientId];
      return d;
    });
  };

  function FirebaseAdapter(db, path) {
    this.ref = db.ref(path);
    this._db = db;
  }

  FirebaseAdapter.prototype.onValue = function (cb) {
    var self = this;
    this.ref.on(
      "value",
      function (snap) {
        var val = snap.val();
        if (!val) {
          var init = createInitialDraft();
          self.ref
            .transaction(function (current) {
              if (current === null) return init;
              return;
            })
            .then(function () {})
            .catch(function () {});
          cb(init);
          return;
        }
        cb(normalizeDraft(val));
      },
      function (err) {
        state.error = (err && err.message) || "Firebase connection error";
        render();
      }
    );
  };

  FirebaseAdapter.prototype.transaction = function (updater) {
    return this.ref.transaction(function (current) {
      current = normalizeDraft(current);
      return updater(current);
    });
  };

  FirebaseAdapter.prototype.setPresence = function (clientId, payload) {
    return this.ref.child("presence").child(clientId).set(payload);
  };

  FirebaseAdapter.prototype.clearPresence = function (clientId) {
    return this.ref.child("presence").child(clientId).remove();
  };

  function initAdapter() {
    if (FIREBASE_READY && typeof firebase !== "undefined" && CONFIG.apiKey && CONFIG.databaseURL) {
      try {
        if (!firebase.apps.length) firebase.initializeApp(CONFIG);
        var db = firebase.database();
        adapter = new FirebaseAdapter(db, DRAFT_PATH);
        return "firebase";
      } catch (e) {
        console.warn("Firebase init failed, falling back to local preview", e);
      }
    }
    adapter = new LocalAdapter();
    return "local";
  }

  var adapterKind = initAdapter();

  /* ---------- draft mutations ---------- */
  function applyClaim(d, teamId, displayName) {
    if (!d || !d.teams || !d.teams[teamId]) return { ok: false, error: "Unknown team" };
    if (d.meta.status !== "lobby") return { ok: false, error: "Draft already started" };
    var team = d.teams[teamId];
    if (team.claimed) return { ok: false, error: "That seat is already taken" };
    team.claimed = true;
    team.owner = displayName;
    if (teamId !== "tgr") {
      team.name = displayName;
    }
    d.meta.updatedAt = now();
    d.meta.version = (d.meta.version || 0) + 1;
    return { ok: true };
  }

  function seatIds() {
    return ["tgr", "open1", "open2", "open3"];
  }

  function unclaimedSeats(d) {
    var teams = (d && d.teams) || {};
    return seatIds().filter(function (id) {
      return !teams[id] || !teams[id].claimed;
    });
  }

  function seatLabel(d, id) {
    var t = d && d.teams && d.teams[id];
    return (t && (t.name || t.owner)) || id;
  }

  function applyStart(d) {
    if (!d || d.meta.status !== "lobby") return { ok: false, error: "Not in lobby" };
    var missing = unclaimedSeats(d);
    if (missing.length) {
      return {
        ok: false,
        error:
          "Need all 4 seats claimed before starting (waiting on " +
          missing.map(function (id) {
            return seatLabel(d, id);
          }).join(", ") +
          "). Snake stalls on empty seats.",
      };
    }
    d.meta.status = "drafting";
    d.meta.snakeOrder = CONFIG_ORDER.slice();
    d.meta.round = 1;
    d.meta.pickIndex = 0;
    d.meta.pickSeconds = PICK_SECONDS;
    d.meta.pickStartedAt = now();
    d.meta.pickDeadlineMs = now() + PICK_SECONDS * 1000;
    d.meta.updatedAt = now();
    d.meta.version = (d.meta.version || 0) + 1;
    return { ok: true };
  }

  /**
   * UFC 332: no same-bout rule. Any undrafted fighter is legal for any coach,
   * including the opponent of someone already on that roster. Auto-pick uses
   * this same function, so manual and auto picks follow identical rules.
   */
  function legalFightersForTeam(d, teamId) {
    var team = d.teams[teamId];
    if (!team) return [];
    var list = [];
    Object.keys(d.pool || {}).forEach(function (fid) {
      var f = d.pool[fid];
      if (!f || !f.available) return;
      list.push(f);
    });
    return list;
  }

  function chooseAutoPick(d, teamId) {
    var legal = legalFightersForTeam(d, teamId);
    if (!legal.length) return null;
    // Sort + seeded index so Firebase transaction retries stay idempotent
    // for the same pickIndex/version (still varies across picks).
    legal.sort(function (a, b) {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    var seed =
      ((d.meta && d.meta.pickIndex) || 0) * 31 +
      ((d.meta && d.meta.version) || 0) * 17 +
      String(teamId || "").length * 13;
    var idx = Math.abs(seed) % legal.length;
    return legal[idx].id;
  }

  function armPickClock(d, ts) {
    ts = ts || now();
    d.meta.pickSeconds = PICK_SECONDS;
    d.meta.pickStartedAt = ts;
    d.meta.pickDeadlineMs = ts + PICK_SECONDS * 1000;
  }

  function advanceAfterPick(d, ts) {
    d.meta.pickIndex += 1;
    d.meta.round = Math.min(SLOTS, Math.floor(d.meta.pickIndex / d.meta.snakeOrder.length) + 1);
    d.meta.updatedAt = ts;
    d.meta.version = (d.meta.version || 0) + 1;
    if (d.meta.pickIndex >= TOTAL_PICKS) {
      d.meta.status = "complete";
      d.meta.pickDeadlineMs = null;
      d.meta.pickStartedAt = null;
    } else {
      armPickClock(d, ts);
    }
  }

  function applyPick(d, teamId, fighterId, expectedPickIndex, opts) {
    opts = opts || {};
    if (!d) return { ok: false, error: "No draft" };
    if (d.meta.status !== "drafting") return { ok: false, error: "Draft not in progress" };
    if (typeof expectedPickIndex === "number" && d.meta.pickIndex !== expectedPickIndex) {
      return { ok: false, error: "Pick already taken — refresh" };
    }
    var onClock = teamForPick(d.meta.snakeOrder, d.meta.pickIndex);
    if (onClock !== teamId) return { ok: false, error: "Not your turn" };
    var team = d.teams[teamId];
    if (!team || !team.claimed) return { ok: false, error: "Team not claimed" };
    var fighter = d.pool[fighterId];
    if (!fighter || !fighter.available) return { ok: false, error: "Fighter unavailable" };
    // No same-bout rule for UFC 332: drafting both fighters from one bout is allowed.

    var slot = team.roster.indexOf(null);
    if (slot < 0) return { ok: false, error: "Roster full" };

    var pickNumber = d.meta.pickIndex + 1;
    var ts = now();
    team.roster[slot] = fighterId;
    if (!team.picks) team.picks = [];
    team.picks.push({
      fighterId: fighterId,
      pickNumber: pickNumber,
      ts: ts,
      auto: !!opts.auto,
    });
    fighter.available = false;
    if (!d.log) d.log = [];
    d.log.push({
      pickNumber: pickNumber,
      teamId: teamId,
      fighterId: fighterId,
      ts: ts,
      auto: !!opts.auto,
    });

    advanceAfterPick(d, ts);
    return { ok: true };
  }

  /** Skip / pass current pick (no legal fighter). Advances snake + resets clock. */
  function applySkip(d, teamId, expectedPickIndex, opts) {
    opts = opts || {};
    if (!d) return { ok: false, error: "No draft" };
    if (d.meta.status !== "drafting") return { ok: false, error: "Draft not in progress" };
    if (typeof expectedPickIndex === "number" && d.meta.pickIndex !== expectedPickIndex) {
      return { ok: false, error: "Pick already taken — refresh" };
    }
    var onClock = teamForPick(d.meta.snakeOrder, d.meta.pickIndex);
    if (onClock !== teamId) return { ok: false, error: "Not your turn" };
    var team = d.teams[teamId];
    if (!team) return { ok: false, error: "Team missing" };

    var pickNumber = d.meta.pickIndex + 1;
    var ts = now();
    if (!d.log) d.log = [];
    d.log.push({
      pickNumber: pickNumber,
      teamId: teamId,
      fighterId: null,
      skipped: true,
      auto: !!opts.auto,
      ts: ts,
      note: "Auto-skip — no undrafted fighter left (pool empty)",
    });
    advanceAfterPick(d, ts);
    return { ok: true };
  }

  /**
   * Commit auto-pick or skip when pickDeadlineMs has passed.
   * Safe inside Firebase transactions — only one client wins.
   */
  function applyDeadlineExpiry(d) {
    if (!d || !d.meta || d.meta.status !== "drafting") {
      return { ok: false, error: "Not drafting" };
    }
    var deadline = Number(d.meta.pickDeadlineMs);
    if (!deadline || !Number.isFinite(deadline)) {
      // Legacy draft without a clock — arm one and wait.
      armPickClock(d, now());
      d.meta.updatedAt = now();
      d.meta.version = (d.meta.version || 0) + 1;
      return { ok: true, armed: true };
    }
    if (now() < deadline) return { ok: false, error: "Clock still running" };

    var teamId = teamForPick(d.meta.snakeOrder, d.meta.pickIndex);
    if (!teamId) return { ok: false, error: "No team on clock" };
    var expected = d.meta.pickIndex;
    var fighterId = chooseAutoPick(d, teamId);
    if (fighterId) {
      return applyPick(d, teamId, fighterId, expected, { auto: true });
    }
    return applySkip(d, teamId, expected, { auto: true });
  }

  /* ---------- UI actions ---------- */
  function pulsePresence() {
    if (!adapter || !state.session.displayName) return;
    var payload = {
      teamId: state.session.teamId || null,
      name: state.session.displayName,
      spectator: !!state.spectator,
      ts: now(),
    };
    adapter.setPresence(state.clientId, payload).catch(function () {});
  }

  function tryAutoExpire() {
    var d = state.draft;
    if (!adapter || !d || !d.meta || d.meta.status !== "drafting") return;
    var deadline = Number(d.meta.pickDeadlineMs);
    if (!deadline || !Number.isFinite(deadline)) {
      // Arm missing clock via transaction (legacy rooms).
      if (state.expireBusy) return;
      state.expireBusy = true;
      adapter
        .transaction(function (cur) {
          if (!cur) return;
          var res = applyDeadlineExpiry(cur);
          if (!res.ok && !res.armed) return;
          return cur;
        })
        .then(function () {
          state.expireBusy = false;
        })
        .catch(function () {
          state.expireBusy = false;
        });
      return;
    }
    if (now() < deadline) return;
    if (state.expireBusy) return;
    state.expireBusy = true;
    var expected = d.meta.pickIndex;
    adapter
      .transaction(function (cur) {
        if (!cur) return;
        // Only commit if still on the same pick and past deadline.
        if (!cur.meta || cur.meta.status !== "drafting") return;
        if (cur.meta.pickIndex !== expected) return;
        var res = applyDeadlineExpiry(cur);
        if (!res.ok) return;
        return cur;
      })
      .then(function () {
        state.expireBusy = false;
      })
      .catch(function () {
        state.expireBusy = false;
      });
  }

  function remainingPickMs(d) {
    if (!d || !d.meta || d.meta.status !== "drafting") return null;
    var deadline = Number(d.meta.pickDeadlineMs);
    if (!deadline || !Number.isFinite(deadline)) return PICK_SECONDS * 1000;
    return Math.max(0, deadline - now());
  }

  function formatClock(ms) {
    var sec = Math.ceil(ms / 1000);
    if (sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function updateTimerDom() {
    var el = document.getElementById("fd-pick-timer");
    var pin = document.getElementById("fd-pin");
    var pinEl = document.getElementById("fd-pin-timer");
    var d = state.draft;
    if (!d || !d.meta || d.meta.status !== "drafting") {
      if (pin) pin.classList.remove("show");
      return;
    }
    var left = remainingPickMs(d);
    if (left == null) return;
    var txt = formatClock(left);
    [el, pinEl].forEach(function (node) {
      if (!node) return;
      if (node.textContent !== txt) node.textContent = txt;
      node.classList.toggle("urgent", left <= 15000);
      node.classList.toggle("expired", left <= 0);
    });
    if (pin) {
      pin.classList.toggle("urgent", left <= 15000);
      pin.classList.toggle("expired", left <= 0);
    }
    updatePinVisibility();
    if (left <= 0) tryAutoExpire();
  }

  /* ---- Pinned pick clock: stays on screen while scrolling during a live draft ---- */
  function headerBottomPx() {
    var h = document.querySelector("header.site-header");
    if (!h) return 0;
    var r = h.getBoundingClientRect();
    return Math.max(0, Math.round(r.bottom));
  }

  function updatePinVisibility() {
    var pin = document.getElementById("fd-pin");
    if (!pin) return;
    var drafting =
      state.mode === "drafting" &&
      state.draft &&
      state.draft.meta &&
      state.draft.meta.status === "drafting";
    var wrap = document.querySelector(".fd-timer-wrap");
    var top = headerBottomPx();
    document.documentElement.style.setProperty("--fd-pin-top", top + "px");
    // Show only once the in-page clock has scrolled up behind the header.
    var show = !!(drafting && wrap && wrap.getBoundingClientRect().bottom < top + 4);
    if (pin.classList.contains("show") !== show) {
      pin.classList.toggle("show", show);
      pin.setAttribute("aria-hidden", show ? "false" : "true");
    }
  }

  var pinScrollQueued = false;
  function onPinScroll() {
    if (pinScrollQueued) return;
    pinScrollQueued = true;
    (window.requestAnimationFrame || setTimeout)(function () {
      pinScrollQueued = false;
      updatePinVisibility();
    });
  }
  window.addEventListener("scroll", onPinScroll, { passive: true });
  window.addEventListener("resize", onPinScroll);

  function ensureTimerLoop() {
    if (timerUiInterval) return;
    timerUiInterval = setInterval(updateTimerDom, 250);
  }

  function onDraftUpdate(draft) {
    state.draft = draft;
    if (!draft) {
      render();
      return;
    }
    var st = draft.meta && draft.meta.status;
    if (state.spectator) {
      if (st === "complete") state.mode = "complete";
      else if (st === "drafting") state.mode = "drafting";
      else state.mode = "lobby";
    } else if (state.session.teamId) {
      if (st === "complete") state.mode = "complete";
      else if (st === "drafting") state.mode = "drafting";
      else state.mode = "lobby";
    } else {
      state.mode = "join";
    }
    if (st === "drafting") {
      ensureTimerLoop();
      // If deadline already passed when we learn about this pick, race to commit.
      tryAutoExpire();
    }
    render();
  }

  function joinAs(teamId, displayName, roomCode, asSpectator) {
    state.error = "";
    var code = String(roomCode || "").trim().toUpperCase();
    if (code !== ROOM_CODE) {
      state.error = 'Wrong room code. Use "' + ROOM_CODE + '".';
      render();
      return;
    }
    displayName = String(displayName || "").trim();
    if (!asSpectator && (!displayName || displayName.length < 2)) {
      state.error = "Enter a display name (2+ characters).";
      render();
      return;
    }
    if (asSpectator) {
      state.spectator = true;
      state.session.displayName = displayName || "Spectator";
      state.session.teamId = null;
      state.session.spectator = true;
      state.session.roomCode = code;
      saveSession();
      pulsePresence();
      var st = state.draft && state.draft.meta && state.draft.meta.status;
      state.mode = st === "complete" ? "complete" : st === "drafting" ? "drafting" : "lobby";
      render();
      return;
    }
    // Pilot: claimed seats can be rejoined (no password). Back / new device
    // used to trap coaches on the join screen with only "Watch as spectator".
    var existing = state.draft && state.draft.teams && state.draft.teams[teamId];
    if (existing && existing.claimed) {
      state.spectator = false;
      state.session.displayName = displayName || existing.owner || existing.name || teamId;
      state.session.teamId = teamId;
      state.session.spectator = false;
      state.session.roomCode = code;
      saveSession();
      pulsePresence();
      var stRe = state.draft && state.draft.meta && state.draft.meta.status;
      state.mode =
        stRe === "complete" ? "complete" : stRe === "drafting" ? "drafting" : "lobby";
      render();
      return;
    }

    state.busy = true;
    render();
    adapter
      .transaction(function (d) {
        if (!d) d = createInitialDraft();
        var res = applyClaim(d, teamId, displayName);
        if (!res.ok) {
          state.error = res.error;
          return;
        }
        return d;
      })
      .then(function (result) {
        state.busy = false;
        if (!result.committed) {
          if (!state.error) state.error = "Could not claim that seat — try another.";
          render();
          return;
        }
        state.spectator = false;
        state.session.displayName = displayName;
        state.session.teamId = teamId;
        state.session.spectator = false;
        state.session.roomCode = code;
        saveSession();
        pulsePresence();
        state.mode = "lobby";
        render();
      })
      .catch(function (err) {
        state.busy = false;
        state.error = (err && err.message) || "Claim failed";
        render();
      });
  }

  function startDraft() {
    state.error = "";
    state.busy = true;
    render();
    adapter
      .transaction(function (d) {
        var res = applyStart(d);
        if (!res.ok) {
          state.error = res.error;
          return;
        }
        return d;
      })
      .then(function (result) {
        state.busy = false;
        if (!result.committed && !state.error) state.error = "Could not start draft";
        render();
      })
      .catch(function (err) {
        state.busy = false;
        state.error = (err && err.message) || "Start failed";
        render();
      });
  }

  function confirmPick(fighterId) {
    if (!state.session.teamId || state.busy) return;
    var d = state.draft;
    if (!d) return;
    var expected = d.meta.pickIndex;
    state.busy = true;
    state.pendingFighter = null;
    state.error = "";
    render();
    adapter
      .transaction(function (cur) {
        var res = applyPick(cur, state.session.teamId, fighterId, expected);
        if (!res.ok) {
          state.error = res.error;
          return;
        }
        return cur;
      })
      .then(function (result) {
        state.busy = false;
        if (!result.committed && !state.error) {
          state.error = "Pick conflict — someone else grabbed this slot.";
        }
        render();
      })
      .catch(function (err) {
        state.busy = false;
        state.error = (err && err.message) || "Pick failed";
        render();
      });
  }

  function leaveSeat() {
    state.session.teamId = null;
    state.spectator = false;
    saveSession();
    state.mode = "join";
    render();
  }

  /* ---------- render ---------- */
  function statusBanner() {
    var live = adapterKind === "firebase";
    if (live) {
      return (
        '<div class="fd-status live" role="status">' +
        '<span class="fd-dot"></span> Live draft connected · Room <code>' +
        esc(ROOM_CODE) +
        "</code></div>"
      );
    }
    return (
      '<div class="fd-status setup" role="status">' +
      "<strong>Connecting live draft…</strong> George is finishing Firebase setup. " +
      "Full draft logic is ready — fill <code>fantasy-firebase-config.js</code> to go live. " +
      "Meanwhile this page runs a <em>local preview</em> (this device only). Room code <code>" +
      esc(ROOM_CODE) +
      "</code>.</div>"
    );
  }

  function teamName(d, id) {
    var t = d && d.teams && d.teams[id];
    if (t && t.name) return t.name;
    var st = (SEED.teams || []).filter(function (x) {
      return x.id === id;
    })[0];
    return (st && st.name) || id;
  }

  /** Draft order + why (final Vegas 121 standings), shown in join/lobby/board. */
  function renderOrderPanel(d) {
    var order = (d && d.meta && d.meta.snakeOrder) || CONFIG_ORDER;
    var basis = SEED.draftOrderBasis || null;
    var prevPts = (basis && basis.previousPoints) || {};
    var items = order
      .map(function (id, i) {
        var pts =
          prevPts[id] != null
            ? ' <span class="fd-order-pts">' + esc(Number(prevPts[id]).toFixed(1)) + " pts last event</span>"
            : "";
        return (
          '<li data-team="' +
          esc(id) +
          '"><span class="fx-pick-num">' +
          (i + 1) +
          "</span> <strong>" +
          displayTeamName(id, teamName(d, id)) +
          "</strong>" +
          pts +
          "</li>"
        );
      })
      .join("");
    var n = order.length;
    var rounds = [];
    for (var r = 0; r < SLOTS && n; r++) {
      var ids = r % 2 === 0 ? order.slice() : order.slice().reverse();
      rounds.push(
        "<li><strong>R" +
          (r + 1) +
          "</strong> " +
          esc(
            ids
              .map(function (id, j) {
                return "#" + (r * n + j + 1) + " " + displayTeamNamePlain(id, teamName(d, id));
              })
              .join(" → ")
          ) +
          "</li>"
      );
    }
    return (
      '<div class="fd-order-panel" id="fd-order">' +
      "<h3>Draft <em>order</em></h3>" +
      (basis
        ? '<p class="fd-muted"><strong>Why:</strong> ' +
          crownText(basis.reason || "") +
          (basis.previousEventUrl
            ? ' <a href="' + esc(basis.previousEventUrl) + '">Final ' + esc(basis.label || "standings") + "</a>."
            : "") +
          "</p>"
        : "") +
      '<ol class="fd-order-list">' +
      items +
      "</ol>" +
      '<details class="fd-snake"><summary>Full snake (20 picks)</summary><ul>' +
      rounds.join("") +
      "</ul></details>" +
      "</div>"
    );
  }

  function renderJoin() {
    var d = state.draft || createInitialDraft();
    var teams = d.teams || {};
    var cards = seatIds()
      .map(function (id) {
        var t = teams[id];
        if (!t) return "";
        var taken = !!t.claimed;
        return (
          '<button type="button" class="fd-seat' +
          (taken ? " taken" : "") +
          (id === "tgr" ? " tgr" : "") +
          '" data-claim="' +
          esc(id) +
          '" ' +
          (state.busy ? "disabled" : "") +
          ">" +
          "<strong>" +
          displayTeamName(id, t.name, { top: true }) +
          "</strong>" +
          '<span class="fd-seat-meta">' +
          (taken
            ? "Claimed by " +
              displayTeamName(id, t.owner || "—") +
              " — tap to rejoin this seat"
            : id === "tgr"
              ? "Claim as George / TGR"
              : "Open — your name becomes the team name") +
          "</span></button>"
        );
      })
      .join("");

    return (
      '<section class="fd-panel fd-join">' +
      "<h2>Join the <em>draft</em></h2>" +
      '<p class="fd-muted">4 coaches · 5 fighters · snake · 90s pick clock · both fighters from one bout allowed. Room code <code>' +
      esc(ROOM_CODE) +
      "</code>. Already claimed a seat? Tap it again to rejoin the lobby (Start lives there).</p>" +
      (state.error ? '<p class="fd-error" role="alert">' + crownText(state.error) + "</p>" : "") +
      '<label class="fd-field"><span>Display name</span>' +
      '<input id="fd-name" type="text" maxlength="40" autocomplete="nickname" placeholder="Your name" value="' +
      esc(state.session.displayName || "") +
      '" /></label>' +
      '<label class="fd-field"><span>Room code</span>' +
      '<input id="fd-code" type="text" maxlength="24" autocomplete="off" value="' +
      esc(state.session.roomCode || ROOM_CODE) +
      '" /></label>' +
      '<div class="fd-seats" role="group" aria-label="Claim a team">' +
      cards +
      "</div>" +
      '<div class="fd-join-actions">' +
      '<button type="button" class="fd-btn ghost" id="fd-spectate">Watch as spectator</button>' +
      "</div>" +
      renderOrderPanel(d) +
      "</section>"
    );
  }

  function renderLobby() {
    var d = state.draft;
    var teams = d.teams || {};
    var missing = unclaimedSeats(d);
    var canStart = missing.length === 0;
    var rows = seatIds()
      .map(function (id) {
        var t = teams[id];
        var you = state.session.teamId === id ? ' <span class="fd-you">YOU</span>' : "";
        return (
          '<li class="' +
          (t.claimed ? "claimed" : "") +
          (isCrowned(id) ? " fd-crowned-seat" : "") +
          '"><strong>' +
          displayTeamName(id, t.name, { top: true }) +
          "</strong>" +
          you +
          '<span>' +
          (t.claimed ? displayTeamName(id, t.owner || "Claimed") : "Waiting…") +
          "</span></li>"
        );
      })
      .join("");

    var waitMsg = "";
    if (state.spectator) {
      waitMsg =
        '<p class="fd-muted" role="status">You are spectating — Start is only for coaches. Use <strong>Back</strong>, then tap your claimed seat to <strong>rejoin</strong>.</p>';
    } else if (!canStart) {
      waitMsg =
        '<p class="fd-muted" role="status">Start unlocks when all 4 seats are claimed. Still waiting on <strong>' +
        missing
          .map(function (id) {
            return displayTeamName(id, seatLabel(d, id));
          })
          .join(", ") +
        "</strong> (" +
        missing.length +
        " open). Snake draft stalls if you start with empty seats.</p>";
    } else {
      waitMsg =
        '<p class="fd-muted">All seats claimed. Snake order: ' +
        (d.meta.snakeOrder || [])
          .map(function (id) {
            return displayTeamName(id, (teams[id] && teams[id].name) || id);
          })
          .join(" → ") +
        ".</p>";
    }

    var startBtn = "";
    if (state.spectator) {
      startBtn = "";
    } else {
      startBtn =
        '<button type="button" class="fd-btn primary" id="fd-start"' +
        (state.busy || !canStart ? " disabled" : "") +
        (canStart
          ? ">Start draft</button>"
          : ">Start draft (waiting for " + missing.length + " seat" + (missing.length === 1 ? "" : "s") + ")</button>");
    }

    return (
      '<section class="fd-panel fd-lobby">' +
      "<h2>Draft <em>lobby</em></h2>" +
      (state.error ? '<p class="fd-error" role="alert">' + crownText(state.error) + "</p>" : "") +
      '<ul class="fd-lobby-teams">' +
      rows +
      "</ul>" +
      waitMsg +
      '<div class="fd-join-actions">' +
      startBtn +
      '<button type="button" class="fd-btn ghost" id="fd-leave">Back</button>' +
      "</div>" +
      renderOrderPanel(d) +
      "</section>"
    );
  }

  function renderRosters(d, highlightTeam) {
    return (
      '<div class="fd-rosters">' +
      ["tgr", "open1", "open2", "open3"]
        .map(function (id) {
          var t = d.teams[id];
          if (!t) return "";
          var mine = highlightTeam === id;
          var slots = (t.roster || [])
            .map(function (fid, i) {
              var f = fid && d.pool[fid];
              if (!f) {
                return (
                  '<li><span class="fx-round">R' +
                  (i + 1) +
                  '</span><span class="fx-empty">—</span></li>'
                );
              }
              return (
                "<li><span class=\"fx-round\">R" +
                (i + 1) +
                '</span><span class="fx-avatar sm">' +
                esc(initials(f.name, f.initials)) +
                "</span><span>" +
                esc(f.name) +
                "</span>" +
                oddsPill(fid) +
                "</li>"
              );
            })
            .join("");
          return (
            '<article class="fx-team-card fd-roster-card' +
            (mine ? " mine" : "") +
            (t.claimed ? "" : " placeholder") +
            (isCrowned(id) ? " fx-crowned-card" : "") +
            '"><header><h3>' +
            displayTeamName(id, t.name, { top: true }) +
            "</h3><p class=\"fx-mgr\">Coach · " +
            (t.owner ? displayTeamName(id, t.owner) : "Unclaimed") +
            (mine ? " · you" : "") +
            "</p></header><ul class=\"fx-roster\">" +
            slots +
            "</ul></article>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderPool(d, canPick) {
    var bouts = SEED.bouts || [];
    var main = bouts.filter(function (b) {
      return b.card === "main";
    });
    var prelims = bouts.filter(function (b) {
      return b.card === "prelims" || (b.card !== "main" && b.card !== "early");
    });
    var early = bouts.filter(function (b) {
      return b.card === "early";
    });
    var myTeam = state.session.teamId && d.teams[state.session.teamId];

    function boutBlock(bout) {
      function sideBtn(f) {
        if (!f) return "";
        var p = d.pool[f.id];
        var avail = p && p.available;
        // No same-bout block: the only reasons a button is disabled are
        // not your turn, already drafted, or a pick in flight.
        var oppOnMyRoster = false;
        if (myTeam && p && p.opponentId) {
          oppOnMyRoster = (myTeam.roster || []).indexOf(p.opponentId) !== -1;
        }
        var disabled = !canPick || !avail || state.busy;
        var byId = !avail ? draftedByTeam(d, f.id) : null;
        var byTeam = byId && d.teams[byId];
        var byName = byTeam
          ? displayTeamName(byId, byTeam.name || byTeam.owner || byId)
          : "";
        var cls =
          "fd-fighter-btn" +
          (avail ? " avail" : " taken") +
          (avail && canPick ? " pickable" : "") +
          (state.pendingFighter === f.id ? " pending" : "");
        return (
          '<button type="button" class="' +
          cls +
          '" data-pick="' +
          esc(f.id) +
          '" ' +
          (disabled ? "disabled" : "") +
          ">" +
          '<span class="fx-avatar">' +
          esc(initials(f.name, f.initials)) +
          "</span>" +
          '<span class="fd-fighter-main"><span class="fd-fighter-name"><strong>' +
          esc(f.name) +
          "</strong>" +
          oddsPill(f.id) +
          "</span>" +
          (f.rank != null ? '<span class="fx-rank">#' + esc(String(f.rank)) + "</span>" : "") +
          '<span class="fd-fighter-sub">' +
          (!avail
            ? "Drafted" + (byName ? " · " + byName : "")
            : (canPick ? "Tap to draft" : "Available") + (oppOnMyRoster ? " · opponent on your roster" : "")) +
          "</span></span></button>"
        );
      }
      return (
        '<article class="fd-bout">' +
        '<div class="fx-bout-meta"><span class="fx-wc">' +
        esc(bout.weightClass) +
        '</span><span class="fx-card-tag">' +
        (bout.card === "main" ? "Main" : bout.card === "early" ? "Early prelims" : "Prelims") +
        "</span></div>" +
        '<div class="fd-bout-row">' +
        sideBtn(bout.fighterA) +
        '<span class="fx-vs">VS</span>' +
        sideBtn(bout.fighterB) +
        "</div></article>"
      );
    }

    return (
      '<div class="fd-pool">' +
      '<h3 class="fx-group">Main Card</h3>' +
      '<div class="fd-bout-grid">' +
      main.map(boutBlock).join("") +
      "</div>" +
      '<h3 class="fx-group">Prelims</h3>' +
      '<div class="fd-bout-grid">' +
      prelims.map(boutBlock).join("") +
      "</div>" +
      (early.length
        ? '<h3 class="fx-group">Early Prelims</h3>' +
          '<div class="fd-bout-grid">' +
          early.map(boutBlock).join("") +
          "</div>"
        : "") +
      "</div>"
    );
  }

  function renderLog(d) {
    var log = (d.log || []).slice().reverse();
    if (!log.length) return '<p class="fd-muted">No picks yet.</p>';
    return (
      '<ol class="fd-log">' +
      log
        .map(function (entry) {
          var t = d.teams[entry.teamId];
          var teamName = displayTeamName(entry.teamId, (t && t.name) || entry.teamId);
          var num =
            '<span class="fd-log-num">#' +
            esc(String(entry.pickNumber)) +
            "</span> ";
          if (entry.skipped) {
            return (
              "<li>" +
              num +
              "<strong>" +
              teamName +
              "</strong> <em>auto-skip</em> — no legal fighter" +
              "</li>"
            );
          }
          var f = entry.fighterId ? d.pool[entry.fighterId] : null;
          return (
            "<li>" +
            num +
            "<strong>" +
            teamName +
            "</strong> " +
            (entry.auto ? "auto-picks" : "selects") +
            " <em>" +
            esc((f && f.name) || entry.fighterId) +
            "</em>" +
            (entry.fighterId ? " " + oddsPill(entry.fighterId) : "") +
            "</li>"
          );
        })
        .join("") +
      "</ol>"
    );
  }

  function renderDrafting() {
    var d = state.draft;
    var pickIndex = d.meta.pickIndex;
    var onClockId = teamForPick(d.meta.snakeOrder, pickIndex);
    var onClock = d.teams[onClockId];
    var myTurn = !state.spectator && state.session.teamId === onClockId;
    var round = d.meta.round || Math.floor(pickIndex / 4) + 1;

    var confirm =
      state.pendingFighter && myTurn
        ? (function () {
            var f = d.pool[state.pendingFighter];
            return (
              '<div class="fd-confirm" role="dialog" aria-label="Confirm pick">' +
              "<p>Draft <strong>" +
              esc(f ? f.name : state.pendingFighter) +
              "</strong>?</p>" +
              '<div class="fd-join-actions">' +
              '<button type="button" class="fd-btn primary" id="fd-confirm-yes">Confirm pick</button>' +
              '<button type="button" class="fd-btn ghost" id="fd-confirm-no">Cancel</button>' +
              "</div></div>"
            );
          })()
        : "";

    var leftMs = remainingPickMs(d);
    var clockHtml =
      '<div class="fd-timer-wrap" aria-live="polite">' +
      '<span class="fd-timer-label">Pick clock</span>' +
      '<span id="fd-pick-timer" class="fd-timer' +
      (leftMs != null && leftMs <= 15000 ? " urgent" : "") +
      (leftMs != null && leftMs <= 0 ? " expired" : "") +
      '">' +
      esc(formatClock(leftMs != null ? leftMs : PICK_SECONDS * 1000)) +
      "</span>" +
      '<span class="fd-timer-sub">' +
      esc(String(d.meta.pickSeconds || PICK_SECONDS)) +
      "s per pick · auto-picks if time runs out</span></div>";

    var urgentCls =
      (leftMs != null && leftMs <= 15000 ? " urgent" : "") +
      (leftMs != null && leftMs <= 0 ? " expired" : "");
    var pinHtml =
      '<div id="fd-pin" class="fd-pin' +
      (myTurn ? " mine" : "") +
      urgentCls +
      '" aria-hidden="true">' +
      '<div class="fd-pin-inner">' +
      '<span class="fd-pin-who">' +
      (myTurn
        ? "<strong>Your pick</strong>"
        : '<span class="fd-pin-label">On the clock</span> <strong>' +
          displayTeamName(onClockId, (onClock && onClock.name) || onClockId) +
          "</strong>") +
      '<span class="fd-pin-meta">Rd ' +
      esc(String(round)) +
      " · #" +
      esc(String(pickIndex + 1)) +
      "/" +
      TOTAL_PICKS +
      "</span></span>" +
      '<span id="fd-pin-timer" class="fd-pin-timer' +
      urgentCls +
      '">' +
      esc(formatClock(leftMs != null ? leftMs : PICK_SECONDS * 1000)) +
      "</span></div></div>";

    return (
      pinHtml +
      '<section class="fd-panel fd-board">' +
      '<div class="fd-turn-banner' +
      (myTurn ? " mine" : "") +
      '" role="status">' +
      (myTurn
        ? "<strong>Your pick</strong> · Round " +
          esc(String(round)) +
          " · Overall #" +
          esc(String(pickIndex + 1))
        : "On the clock: <strong>" +
          displayTeamName(onClockId, (onClock && onClock.name) || onClockId) +
          "</strong> · Round " +
          esc(String(round)) +
          " · Pick #" +
          esc(String(pickIndex + 1)) +
          " of " +
          TOTAL_PICKS +
          (state.spectator ? " · Spectating" : "")) +
      "</div>" +
      clockHtml +
      (state.error ? '<p class="fd-error" role="alert">' + crownText(state.error) + "</p>" : "") +
      confirm +
      "<h2>Available <em>fighters</em></h2>" +
      '<p class="fd-muted">Grouped by bout. No same-bout rule this week — you can draft both fighters from the same fight.</p>' +
      renderPool(d, myTurn) +
      "<h2>Rosters</h2>" +
      renderRosters(d, state.session.teamId) +
      "<h2>Pick <em>history</em></h2>" +
      renderLog(d) +
      renderOrderPanel(d) +
      "</section>"
    );
  }

  function renderComplete() {
    var d = state.draft;
    return (
      '<section class="fd-panel fd-complete">' +
      "<h2>Draft <em>complete</em></h2>" +
      '<p class="fd-muted">All 20 picks are in. Score Saturday night only — then check standings.</p>' +
      renderRosters(d, state.session.teamId) +
      "<h3>Pick history</h3>" +
      renderLog(d) +
      '<div class="fd-join-actions">' +
      '<a class="fd-btn primary" href="/fantasy/">Back to fantasy standings</a>' +
      "</div></section>"
    );
  }

  function render() {
    refreshCrownNames(state.draft);
    var html = statusBanner();
    html +=
      '<div class="fd-hero">' +
      '<span class="badge">Live draft</span>' +
      "<h1>" +
      esc(SEED.draftTitle || "Fantasy Draft · " + ((SEED.event && SEED.event.aka) || "UFC 332")) +
      "</h1>" +
      '<p class="lead">' +
      crownText(SEED.subtitle || "") +
      "</p></div>";

    if (!state.draft && adapterKind === "firebase") {
      html += '<p class="fd-loading">Connecting live draft…</p>';
      appEl.innerHTML = html;
      return;
    }

    if (state.mode === "join") html += renderJoin();
    else if (state.mode === "lobby") html += renderLobby();
    else if (state.mode === "drafting") html += renderDrafting();
    else if (state.mode === "complete") html += renderComplete();

    appEl.innerHTML = html;
    bind();
    if (state.mode === "drafting") {
      ensureTimerLoop();
      updateTimerDom();
    }
    updatePinVisibility();
  }

  function bind() {
    var nameInput = document.getElementById("fd-name");
    var codeInput = document.getElementById("fd-code");

    appEl.querySelectorAll("[data-claim]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var name = nameInput ? nameInput.value : "";
        var code = codeInput ? codeInput.value : ROOM_CODE;
        joinAs(btn.getAttribute("data-claim"), name, code, false);
      });
    });

    var spec = document.getElementById("fd-spectate");
    if (spec) {
      spec.addEventListener("click", function () {
        var name = nameInput ? nameInput.value : "Spectator";
        var code = codeInput ? codeInput.value : ROOM_CODE;
        joinAs(null, name, code, true);
      });
    }

    var start = document.getElementById("fd-start");
    if (start) start.addEventListener("click", startDraft);

    var leave = document.getElementById("fd-leave");
    if (leave) leave.addEventListener("click", leaveSeat);

    appEl.querySelectorAll("[data-pick]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.pendingFighter = btn.getAttribute("data-pick");
        state.error = "";
        render();
      });
    });

    var yes = document.getElementById("fd-confirm-yes");
    if (yes) {
      yes.addEventListener("click", function () {
        if (state.pendingFighter) confirmPick(state.pendingFighter);
      });
    }
    var no = document.getElementById("fd-confirm-no");
    if (no) {
      no.addEventListener("click", function () {
        state.pendingFighter = null;
        render();
      });
    }
  }

  // Resume session into lobby/draft if we already claimed
  if (state.session.teamId || state.session.spectator) {
    state.spectator = !!state.session.spectator && !state.session.teamId;
  }

  adapter.onValue(onDraftUpdate);
  setInterval(pulsePresence, 20000);
  window.addEventListener("beforeunload", function () {
    try {
      adapter.clearPresence(state.clientId);
    } catch (e) {}
  });

  // Expose tiny debug hook
  window.__TGR_DRAFT__ = {
    getState: function () {
      return { mode: state.mode, adapter: adapterKind, ready: FIREBASE_READY };
    },
    resetLocal: function () {
      try {
        localStorage.removeItem(LS_KEY);
      } catch (e) {}
      location.reload();
    },
  };
})();
