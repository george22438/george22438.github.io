/**
 * The Garcia Report — Live fantasy draft client (UFC Vegas 121)
 * Firebase Realtime Database under drafts/vegas121.
 * When __TGR_FIREBASE_READY__ is false, runs a local preview (localStorage)
 * so the UX can be tested; live multi-device sync starts once config is filled.
 */
(function () {
  "use strict";

  var ROOM_DEFAULT = "GARCIA121";
  var DRAFT_PATH = "drafts/vegas121";
  var TOTAL_PICKS = 20;
  var SLOTS = 5;
  var LS_KEY = "tgr-draft-vegas121-v1";
  var LS_SESSION = "tgr-draft-session-v1";

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

  var ROOM_CODE = (window.__TGR_DRAFT_ROOM_CODE__ || ROOM_DEFAULT).toUpperCase();
  DRAFT_PATH = window.__TGR_DRAFT_PATH__ || DRAFT_PATH;
  var FIREBASE_READY = !!window.__TGR_FIREBASE_READY__;
  var CONFIG = window.__TGR_FIREBASE_CONFIG__ || {};

  var state = {
    mode: "join", // join | lobby | drafting | complete
    draft: null,
    session: loadSession(),
    pendingFighter: null,
    busy: false,
    error: "",
    spectator: false,
    clientId: null,
  };

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
      d.meta.leagueName = SEED.leagueName || "Garcia Report Fantasy — UFC Vegas 121";
    }
    if (!d.meta.status) d.meta.status = "lobby";
    if (d.meta.round == null) d.meta.round = 1;
    if (d.meta.pickIndex == null) d.meta.pickIndex = 0;
    if (d.meta.version == null) d.meta.version = 0;
    if (!d.meta.draftLockAt && SEED.draftLock) d.meta.draftLockAt = SEED.draftLock;
    if (!Array.isArray(d.meta.snakeOrder) || !d.meta.snakeOrder.length) {
      d.meta.snakeOrder = (SEED.draftOrder || ["tgr", "open1", "open2", "open3"]).slice();
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
    var order = (SEED.draftOrder || ["tgr", "open1", "open2", "open3"]).slice();
    var teams = {};
    (SEED.teams || []).forEach(function (t) {
      teams[t.id] = emptyTeam(
        t.id,
        t.name,
        t.manager || "",
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
        leagueName: SEED.leagueName || "Garcia Report Fantasy — UFC Vegas 121",
        updatedAt: now(),
        status: "lobby",
        draftLockAt: SEED.draftLock || "",
        snakeOrder: order,
        round: 1,
        pickIndex: 0,
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
        this._bc = new BroadcastChannel("tgr-draft-vegas121");
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
    d.meta.round = 1;
    d.meta.pickIndex = 0;
    d.meta.updatedAt = now();
    d.meta.version = (d.meta.version || 0) + 1;
    return { ok: true };
  }

  function applyPick(d, teamId, fighterId, expectedPickIndex) {
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

    // Same-bout rule: cannot draft opponent of someone already on this roster
    for (var i = 0; i < team.roster.length; i++) {
      var rid = team.roster[i];
      if (!rid) continue;
      var rf = d.pool[rid];
      if (rf && rf.boutId && rf.boutId === fighter.boutId) {
        return { ok: false, error: "You already drafted someone from this bout" };
      }
    }

    var slot = team.roster.indexOf(null);
    if (slot < 0) return { ok: false, error: "Roster full" };

    var pickNumber = d.meta.pickIndex + 1;
    var ts = now();
    team.roster[slot] = fighterId;
    if (!team.picks) team.picks = [];
    team.picks.push({ fighterId: fighterId, pickNumber: pickNumber, ts: ts });
    fighter.available = false;
    if (!d.log) d.log = [];
    d.log.push({ pickNumber: pickNumber, teamId: teamId, fighterId: fighterId, ts: ts });

    d.meta.pickIndex += 1;
    d.meta.round = Math.min(SLOTS, Math.floor(d.meta.pickIndex / d.meta.snakeOrder.length) + 1);
    d.meta.updatedAt = ts;
    d.meta.version = (d.meta.version || 0) + 1;

    if (d.meta.pickIndex >= TOTAL_PICKS) {
      d.meta.status = "complete";
    }
    return { ok: true };
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
    // used to trap managers on the join screen with only "Watch as spectator".
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
          esc(t.name) +
          "</strong>" +
          '<span class="fd-seat-meta">' +
          (taken
            ? "Claimed by " +
              esc(t.owner || "—") +
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
      '<p class="fd-muted">4 managers · 5 fighters · snake · same-bout rule. Room code default <code>' +
      esc(ROOM_CODE) +
      "</code>. Already claimed a seat? Tap it again to rejoin the lobby (Start lives there).</p>" +
      (state.error ? '<p class="fd-error" role="alert">' + esc(state.error) + "</p>" : "") +
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
      "</div></section>"
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
          '"><strong>' +
          esc(t.name) +
          "</strong>" +
          you +
          '<span>' +
          (t.claimed ? esc(t.owner || "Claimed") : "Waiting…") +
          "</span></li>"
        );
      })
      .join("");

    var waitMsg = "";
    if (state.spectator) {
      waitMsg =
        '<p class="fd-muted" role="status">You are spectating — Start is only for managers. Use <strong>Back</strong>, then tap your claimed seat to <strong>rejoin</strong>.</p>';
    } else if (!canStart) {
      waitMsg =
        '<p class="fd-muted" role="status">Start unlocks when all 4 seats are claimed. Still waiting on <strong>' +
        esc(
          missing
            .map(function (id) {
              return seatLabel(d, id);
            })
            .join(", ")
        ) +
        "</strong> (" +
        missing.length +
        " open). Snake draft stalls if you start with empty seats.</p>";
    } else {
      waitMsg =
        '<p class="fd-muted">All seats claimed. Snake order: ' +
        esc(
          (d.meta.snakeOrder || []).map(function (id) {
            return (teams[id] && teams[id].name) || id;
          }).join(" → ")
        ) +
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
      (state.error ? '<p class="fd-error" role="alert">' + esc(state.error) + "</p>" : "") +
      '<ul class="fd-lobby-teams">' +
      rows +
      "</ul>" +
      waitMsg +
      '<div class="fd-join-actions">' +
      startBtn +
      '<button type="button" class="fd-btn ghost" id="fd-leave">Back</button>' +
      "</div></section>"
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
                "</span></li>"
              );
            })
            .join("");
          return (
            '<article class="fx-team-card fd-roster-card' +
            (mine ? " mine" : "") +
            (t.claimed ? "" : " placeholder") +
            '"><header><h3>' +
            esc(t.name) +
            "</h3><p class=\"fx-mgr\">" +
            esc(t.owner || "Unclaimed") +
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
      return b.card !== "main";
    });

    function boutBlock(bout) {
      function sideBtn(f) {
        if (!f) return "";
        var p = d.pool[f.id];
        var avail = p && p.available;
        var myTeam = state.session.teamId && d.teams[state.session.teamId];
        var boutBlocked = false;
        if (canPick && myTeam) {
          (myTeam.roster || []).forEach(function (rid) {
            if (!rid) return;
            var rf = d.pool[rid];
            if (rf && rf.boutId === bout.id) boutBlocked = true;
          });
        }
        var disabled = !canPick || !avail || boutBlocked || state.busy;
        var cls =
          "fd-fighter-btn" +
          (!avail ? " taken" : "") +
          (boutBlocked && avail ? " blocked" : "") +
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
          "<span><strong>" +
          esc(f.name) +
          "</strong>" +
          (f.rank != null ? '<span class="fx-rank">#' + esc(String(f.rank)) + "</span>" : "") +
          '<span class="fd-fighter-sub">' +
          (!avail ? "Drafted" : boutBlocked ? "Same bout" : canPick ? "Tap to draft" : "Available") +
          "</span></span></button>"
        );
      }
      return (
        '<article class="fd-bout">' +
        '<div class="fx-bout-meta"><span class="fx-wc">' +
        esc(bout.weightClass) +
        '</span><span class="fx-card-tag">' +
        (bout.card === "main" ? "Main" : "Prelims") +
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
      "</div></div>"
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
          var f = d.pool[entry.fighterId];
          return (
            "<li><span class=\"fd-log-num\">#" +
            esc(String(entry.pickNumber)) +
            "</span> <strong>" +
            esc((t && t.name) || entry.teamId) +
            "</strong> selects <em>" +
            esc((f && f.name) || entry.fighterId) +
            "</em></li>"
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

    return (
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
          esc((onClock && onClock.name) || onClockId) +
          "</strong> · Round " +
          esc(String(round)) +
          " · Pick #" +
          esc(String(pickIndex + 1)) +
          " of " +
          TOTAL_PICKS +
          (state.spectator ? " · Spectating" : "")) +
      "</div>" +
      (state.error ? '<p class="fd-error" role="alert">' + esc(state.error) + "</p>" : "") +
      confirm +
      "<h2>Available <em>fighters</em></h2>" +
      '<p class="fd-muted">Grouped by bout — you cannot draft both fighters from the same fight.</p>' +
      renderPool(d, myTurn) +
      "<h2>Rosters</h2>" +
      renderRosters(d, state.session.teamId) +
      "<h2>Pick <em>history</em></h2>" +
      renderLog(d) +
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
    var html = statusBanner();
    html +=
      '<div class="fd-hero">' +
      '<span class="badge">Live draft</span>' +
      "<h1>Fantasy Draft · UFC Vegas 121</h1>" +
      '<p class="lead">' +
      esc(SEED.subtitle || "") +
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
