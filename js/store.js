/*
 * TABot store: settings in localStorage, graded rows in IndexedDB, and the wipe.
 *
 * localStorage (prefix "tabot.") holds settings only: key.<provider>,
 * model.<provider>, vision.<provider> (the probe cache), answerKey, review.
 * setSetting refuses any other name, so student results can never land there.
 * When localStorage is missing, or any access to it throws, settings move to an
 * in-memory map of the same entries for the rest of the page load (whatever can
 * still be read is carried over), so getKey/getModel/getAnswerKey keep working;
 * settingsMemoryOnly is then true, and storageWarning says an access failed.
 *
 * Rows live in IndexedDB database "tabot": store "rows" (keyPath "id") and
 * store "meta", which holds {id: "meta", photoCount}, the in-flight marker
 * {id: "inflight", photoIndex, total, done} and the time the last slip was
 * stored, {id: "lastPhoto", lastPhotoAt} (see UNCONFIRMED RESULTS EXPIRE
 * below). When IndexedDB is missing or will not open (some private modes),
 * rows live in memory for this page load, memoryOnly is true and
 * memoryReason is "unavailable", so the UI can warn that a
 * refresh loses them. A connection lost mid-session (its close event, or
 * InvalidStateError, UnknownError or AbortError from a transaction) is dropped and
 * reopened once; if the reopen fails too, rows live in memory for the rest of the
 * page load and memoryReason is "lost". Rows written before the loss stay in
 * IndexedDB and are not copied over; photo indexes keep counting up from the
 * highest one seen. allRows and removePhoto reach those earlier rows on a fresh
 * IndexedDB connection whenever one opens (earlierRowsUnread is true while it
 * does not), and clearResults clears them only when the last allRows read them,
 * so rows that reached no spreadsheet are never cleared. clearInFlight and
 * clearResults also clear the in-flight marker set before the loss, on a fresh
 * connection, whenever one opens.
 *
 * A page opened from file: persists nothing, because a file: page can share its
 * storage with every other local file the browser opens. Settings and rows both
 * live in memory from the start, neither localStorage nor IndexedDB is touched,
 * fileMode is true and memoryReason is "file".
 *
 * A row is a graded slip (grade.gradeSlip output) plus what the app adds:
 * {id, photoIndex, slipIndex, readBy, reviewedBy, reviewMode}. A row without
 * an id gets "p<photoIndex>-s<slipIndex>". addRows replaces a row with the same
 * id, so it is safe to call once per slip, and again for a slip already saved.
 *
 * UNCONFIRMED RESULTS EXPIRE. Every addRows that stores a row also records
 * lastPhotoAt (milliseconds since the epoch, from the store's clock) in the same
 * write, so it is the time of the last photo's last saved slip. A regrade
 * rewrites rows already stored and passes {regrade: true}, which leaves
 * lastPhotoAt as it is. clearResults and wipeAfterDownload clear it.
 * expireIfStale({now, maxAgeMs}) clears the results (as clearResults) once
 * now - lastPhotoAt >= maxAgeMs. Rows stored with no lastPhotoAt (by a version
 * of the page from before it was kept) start their clock the first time
 * expireIfStale sees them. Settings are never touched by an expiry.
 *
 * The store's clock is create's opts.now when given. Otherwise it is the e2e
 * test hook's __TABOT_TEST__.now() when the page defines one (production never
 * does), so the page and the store read one clock; otherwise Date.now().
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.store = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var PREFIX = 'tabot.';
  var DB_NAME = 'tabot';
  var DB_VERSION = 1;
  var META_ID = 'meta';
  var INFLIGHT_ID = 'inflight';
  var LAST_PHOTO_ID = 'lastPhoto';
  var LOST = 'TABotStorageLost';
  var ALLOWED = /^(?:(?:key|model|vision)\.[A-Za-z0-9_-]+|answerKey|review)$/;
  var KEPT_BY_WIPE = /^(?:(?:key|model|vision)\..+|answerKey)$/;
  var PROVIDER_ID = /^[A-Za-z0-9_-]+$/;
  // How a connection the browser closed under the page shows up: a transaction on
  // a closed connection throws InvalidStateError, Safari's lost IndexedDB server
  // fails transactions with UnknownError, and a transaction in flight when the
  // browser closes the connection ends with AbortError.
  var CONNECTION_LOST = /^(?:InvalidStateError|UnknownError|AbortError)$/;

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function isIndex(n) {
    return typeof n === 'number' && Number.isInteger(n) && n >= 0;
  }

  function isFiniteNumber(n) {
    return n !== null && n !== '' && isFinite(Number(n));
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // Touching window.localStorage can itself throw (blocked storage, sandboxed frames).
  function defaultLocalStorage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function defaultIndexedDB() {
    try { return root.indexedDB || null; } catch (e) { return null; }
  }

  function defaultLocation() {
    try { return root.location || null; } catch (e) { return null; }
  }

  function isFileProtocol(location) {
    try {
      return !!location && String(location.protocol).toLowerCase() === 'file:';
    } catch (e) {
      return false;
    }
  }

  function photoCountOf(meta) {
    return meta && isIndex(meta.photoCount) ? meta.photoCount : 0;
  }

  // The in-flight marker is three whole counts and nothing else, so no student
  // data can ride along with it. Anything else reads as no marker.
  function inFlightOf(m) {
    if (!m || typeof m !== 'object') return null;
    if (!isIndex(m.photoIndex) || !isIndex(m.total) || !isIndex(m.done) || m.done > m.total) return null;
    return { photoIndex: m.photoIndex, total: m.total, done: m.done };
  }

  // A time in milliseconds since the epoch: a finite number.
  function isTime(t) {
    return typeof t === 'number' && isFinite(t);
  }

  // The lastPhotoAt record is one number and nothing else. Anything else reads
  // as no lastPhotoAt.
  function lastPhotoAtOf(m) {
    return m && typeof m === 'object' && isTime(m.lastPhotoAt) ? m.lastPhotoAt : null;
  }

  // The later of two times, either of which may be null.
  function later(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    return a > b ? a : b;
  }

  // The e2e test hook's clock when the page defines one, otherwise Date.now().
  function defaultNow() {
    var hook = null;
    try { hook = (root && root.__TABOT_TEST__) || null; } catch (e) { hook = null; }
    if (hook && typeof hook.now === 'function') return hook.now();
    return Date.now();
  }

  function isConnectionLoss(err) {
    return !!err && CONNECTION_LOST.test(String(err.name));
  }

  function lostError(cause) {
    var err = new Error('IndexedDB connection lost' + (cause && cause.name ? ' (' + cause.name + ')' : ''));
    err.name = LOST;
    err.cause = cause;
    return err;
  }

  // ---- result backends: same promise API, memory or IndexedDB ----

  // photoFloor: the first photo index to hand out, so indexes are not reused when
  // results move here after IndexedDB is lost.
  function memoryBackend(photoFloor) {
    var rows = new Map();
    var photoCount = isIndex(photoFloor) ? photoFloor : 0;
    var inFlight = null;
    var lastPhotoAt = null;
    return {
      // stampAt: the lastPhotoAt to record with the rows, or null to leave it.
      // An empty list stores no row, so it records nothing.
      putRows: function (list, atLeast, stampAt) {
        list.forEach(function (row) { rows.set(row.id, clone(row)); });
        if (atLeast > photoCount) photoCount = atLeast;
        if (list.length && isTime(stampAt)) lastPhotoAt = stampAt;
        return Promise.resolve();
      },
      getRows: function () {
        return Promise.resolve(Array.from(rows.values()).map(clone));
      },
      // Removes that photo's rows, and the in-flight marker when it names that photo.
      removePhoto: function (photoIndex) {
        var removed = 0;
        Array.from(rows.values()).forEach(function (row) {
          if (row.photoIndex === photoIndex) { rows.delete(row.id); removed++; }
        });
        if (inFlight && inFlight.photoIndex === photoIndex) inFlight = null;
        return Promise.resolve(removed);
      },
      clear: function () {
        rows.clear();
        photoCount = 0;
        inFlight = null;
        lastPhotoAt = null;
        return Promise.resolve();
      },
      getLastPhotoAt: function () {
        return Promise.resolve(lastPhotoAt);
      },
      // Records at only when no lastPhotoAt is held.
      adoptLastPhotoAt: function (at) {
        if (lastPhotoAt === null) lastPhotoAt = at;
        return Promise.resolve();
      },
      getPhotoCount: function () {
        return Promise.resolve(photoCount);
      },
      takePhotoIndex: function () {
        return Promise.resolve(photoCount++);
      },
      getInFlight: function () {
        return Promise.resolve(inFlight ? clone(inFlight) : null);
      },
      setInFlight: function (marker) {
        inFlight = clone(marker);
        return Promise.resolve();
      },
      clearInFlight: function () {
        inFlight = null;
        return Promise.resolve();
      }
    };
  }

  function idbBackend(idb) {
    var dbPromise = null;

    // Forget a connection (unless a fresh one has already replaced it) and close it.
    function drop(conn, db) {
      if (dbPromise === conn) dbPromise = null;
      if (db) { try { db.close(); } catch (e) { /* already closed */ } }
    }

    function open() {
      if (dbPromise) return dbPromise;
      var conn = new Promise(function (resolve, reject) {
        var req;
        try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        };
        req.onsuccess = function () {
          var db = req.result;
          // A newer tab upgrading the schema must not be blocked by this one.
          db.onversionchange = function () { drop(conn, db); };
          // The browser closed the connection (storage cleared, Safari's IndexedDB
          // server gone). Either way the next call opens a fresh one.
          db.onclose = function () { drop(conn, db); };
          resolve(db);
        };
        req.onerror = function () { reject(req.error || new Error('IndexedDB would not open')); };
      });
      dbPromise = conn;
      // A failed open is not kept, so the next call makes a real attempt.
      conn.catch(function () { drop(conn); });
      return conn;
    }

    // Runs work(tx, out) in one transaction on db; resolves with out.value once it commits.
    function transact(db, storeNames, mode, work) {
      return new Promise(function (resolve, reject) {
        var out = { value: undefined };
        var tx;
        try { tx = db.transaction(storeNames, mode); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out.value); };
        // A failed request is the event's target and carries the cause before tx.error is set.
        tx.onerror = function (ev) {
          var failed = ev && ev.target;
          reject((failed && failed.error) || tx.error || new Error('IndexedDB transaction failed'));
        };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
        try {
          work(tx, out);
        } catch (e) {
          try { tx.abort(); } catch (ignored) { /* already finished */ }
          reject(e);
        }
      });
    }

    // One transaction. A lost connection is dropped and the work retried once on a
    // fresh one; a reopen that fails, or a second loss, rejects with LOST so the
    // store moves to memory. Any other error rejects as it is. A transaction that
    // fails is rolled back, so running work again never doubles a write.
    function run(storeNames, mode, work) {
      function attempt(retried) {
        var conn = open();
        return conn.then(function (db) {
          return transact(db, storeNames, mode, work).catch(function (err) {
            if (!isConnectionLoss(err)) throw err;
            drop(conn, db);
            if (retried) throw lostError(err);
            return attempt(true);
          });
        }, function (err) {
          // A reopen failing, or a fresh open after a loss that still fails.
          throw lostError(err);
        });
      }
      return attempt(false);
    }

    return {
      open: open,
      // The rows, the photo count and lastPhotoAt land in one transaction.
      putRows: function (list, atLeast, stampAt) {
        return run(['rows', 'meta'], 'readwrite', function (tx) {
          var rowStore = tx.objectStore('rows');
          list.forEach(function (row) { rowStore.put(row); });
          var metaStore = tx.objectStore('meta');
          var req = metaStore.get(META_ID);
          req.onsuccess = function () {
            if (atLeast > photoCountOf(req.result)) metaStore.put({ id: META_ID, photoCount: atLeast });
          };
          if (list.length && isTime(stampAt)) metaStore.put({ id: LAST_PHOTO_ID, lastPhotoAt: stampAt });
        });
      },
      getRows: function () {
        return run(['rows'], 'readonly', function (tx, out) {
          var req = tx.objectStore('rows').getAll();
          req.onsuccess = function () { out.value = req.result || []; };
        });
      },
      // Removes that photo's rows, and the in-flight marker when it names that
      // photo, in one transaction.
      removePhoto: function (photoIndex) {
        return run(['rows', 'meta'], 'readwrite', function (tx, out) {
          var rowStore = tx.objectStore('rows');
          var metaStore = tx.objectStore('meta');
          out.value = 0;
          var req = rowStore.getAll();
          req.onsuccess = function () {
            (req.result || []).forEach(function (row) {
              if (row.photoIndex === photoIndex) { rowStore.delete(row.id); out.value++; }
            });
          };
          var marker = metaStore.get(INFLIGHT_ID);
          marker.onsuccess = function () {
            var m = inFlightOf(marker.result);
            if (m && m.photoIndex === photoIndex) metaStore.delete(INFLIGHT_ID);
          };
        });
      },
      // Clears the whole meta store: the photo count, the in-flight marker and
      // lastPhotoAt.
      clear: function () {
        return run(['rows', 'meta'], 'readwrite', function (tx) {
          tx.objectStore('rows').clear();
          tx.objectStore('meta').clear();
        });
      },
      getLastPhotoAt: function () {
        return run(['meta'], 'readonly', function (tx, out) {
          var req = tx.objectStore('meta').get(LAST_PHOTO_ID);
          req.onsuccess = function () { out.value = lastPhotoAtOf(req.result); };
        });
      },
      // Read and write in one readwrite transaction, so a lastPhotoAt stored
      // meanwhile is never overwritten.
      adoptLastPhotoAt: function (at) {
        return run(['meta'], 'readwrite', function (tx) {
          var metaStore = tx.objectStore('meta');
          var req = metaStore.get(LAST_PHOTO_ID);
          req.onsuccess = function () {
            if (lastPhotoAtOf(req.result) === null) metaStore.put({ id: LAST_PHOTO_ID, lastPhotoAt: at });
          };
        });
      },
      getPhotoCount: function () {
        return run(['meta'], 'readonly', function (tx, out) {
          var req = tx.objectStore('meta').get(META_ID);
          req.onsuccess = function () { out.value = photoCountOf(req.result); };
        });
      },
      // Read and bump in one readwrite transaction, so two photos never share an index.
      takePhotoIndex: function () {
        return run(['meta'], 'readwrite', function (tx, out) {
          var metaStore = tx.objectStore('meta');
          var req = metaStore.get(META_ID);
          req.onsuccess = function () {
            out.value = photoCountOf(req.result);
            metaStore.put({ id: META_ID, photoCount: out.value + 1 });
          };
        });
      },
      getInFlight: function () {
        return run(['meta'], 'readonly', function (tx, out) {
          var req = tx.objectStore('meta').get(INFLIGHT_ID);
          req.onsuccess = function () { out.value = inFlightOf(req.result); };
        });
      },
      setInFlight: function (marker) {
        return run(['meta'], 'readwrite', function (tx) {
          tx.objectStore('meta').put({ id: INFLIGHT_ID, photoIndex: marker.photoIndex, total: marker.total, done: marker.done });
        });
      },
      clearInFlight: function () {
        return run(['meta'], 'readwrite', function (tx) {
          tx.objectStore('meta').delete(INFLIGHT_ID);
        });
      }
    };
  }

  // ---- the store ----

  // opts: {localStorage, indexedDB, location}; each defaults to the page's own.
  // opts.now: the clock, a function returning milliseconds since the epoch.
  function create(opts) {
    opts = opts || {};
    var clockFn = typeof opts.now === 'function' ? opts.now : defaultNow;
    var fileMode = isFileProtocol(opts.location !== undefined ? opts.location : defaultLocation());
    // A file: page never touches either storage.
    var ls = fileMode ? null : (opts.localStorage !== undefined ? opts.localStorage : defaultLocalStorage());
    var idb = fileMode ? null : (opts.indexedDB !== undefined ? opts.indexedDB : defaultIndexedDB());
    var state = {
      storageWarning: false,
      settingsMemoryOnly: false,
      memoryOnly: false,
      memoryReason: null,
      photoFloor: 0,
      // After a loss: true while the rows saved before it could not be read on
      // the last try, so they are in no list and no spreadsheet.
      earlierUnread: false
    };
    var settingsMap = null;
    var backendPromise = null;
    var memory = null;
    // After a loss: a separate IndexedDB backend for the rows saved before it.
    var earlier = null;

    function warn() { state.storageWarning = true; }

    // ---- settings storage: localStorage, or a Map of the same raw entries ----

    // From here on settings live in memory. Whatever localStorage still lets us
    // read comes along, so a refused write does not lose the saved key.
    function settingsToMemory() {
      if (settingsMap) return;
      settingsMap = new Map();
      state.settingsMemoryOnly = true;
      if (!ls) return;
      try {
        for (var i = 0; i < ls.length; i++) {
          var k = ls.key(i);
          if (typeof k === 'string' && k.indexOf(PREFIX) === 0) {
            var raw = ls.getItem(k);
            if (typeof raw === 'string') settingsMap.set(k, raw);
          }
        }
      } catch (e) {
        // Keep what was read before the failure.
      }
    }

    if (!ls) {
      settingsToMemory();
      // Missing storage is a failure worth a warning; a file: page chose memory on purpose.
      if (!fileMode) warn();
    }

    function readRaw(name) {
      var k = PREFIX + name;
      if (!settingsMap) {
        try { return ls.getItem(k); } catch (e) { warn(); settingsToMemory(); }
      }
      return settingsMap.has(k) ? settingsMap.get(k) : null;
    }

    // raw null removes the entry.
    function writeRaw(name, raw) {
      var k = PREFIX + name;
      if (!settingsMap) {
        try {
          if (raw === null) ls.removeItem(k);
          else ls.setItem(k, raw);
          return;
        } catch (e) {
          warn();
          settingsToMemory();
        }
      }
      if (raw === null) settingsMap.delete(k);
      else settingsMap.set(k, raw);
    }

    function checkName(name) {
      if (typeof name !== 'string' || !ALLOWED.test(name)) {
        throw new TypeError('not a TABot setting name: ' + String(name));
      }
    }

    function checkProvider(provider) {
      if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) {
        throw new TypeError('not a provider id: ' + String(provider));
      }
    }

    // ---- settings (synchronous) ----

    function getSetting(name) {
      checkName(name);
      var raw = readRaw(name);
      if (raw === null || raw === undefined) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }

    // null or undefined removes the setting. Returns true when the value is held,
    // in localStorage or, when settingsMemoryOnly, for this page load.
    function setSetting(name, value) {
      checkName(name);
      var raw = null;
      if (value !== null && value !== undefined) {
        try { raw = JSON.stringify(value); } catch (e) { return false; }
        if (typeof raw !== 'string') return false;
      }
      writeRaw(name, raw);
      return true;
    }

    function getKey(provider) {
      checkProvider(provider);
      var v = getSetting('key.' + provider);
      return typeof v === 'string' && v !== '' ? v : null;
    }

    function setKey(provider, key) {
      checkProvider(provider);
      var v = typeof key === 'string' ? key.trim() : '';
      return setSetting('key.' + provider, v === '' ? null : v);
    }

    function getModel(provider) {
      checkProvider(provider);
      var v = getSetting('model.' + provider);
      return typeof v === 'string' && v !== '' ? v : null;
    }

    function setModel(provider, modelId) {
      checkProvider(provider);
      return setSetting('model.' + provider, typeof modelId === 'string' && modelId !== '' ? modelId : null);
    }

    // Only the answer-key fields are kept, so nothing else can ride along into storage.
    // A question's match setting is kept only when it is 'exact': value is the
    // default, and a question with no match field reads as value.
    function cleanAnswerKey(k) {
      if (!k || typeof k !== 'object') return null;
      var questions = Array.isArray(k.questions) ? k.questions : [];
      return {
        assignment: typeof k.assignment === 'string' ? k.assignment : '',
        passPercent: isFiniteNumber(k.passPercent) ? Number(k.passPercent) : 70,
        questions: questions.map(function (q) {
          var out = {
            answer: q && q.answer !== null && q.answer !== undefined ? String(q.answer) : '',
            points: q && isFiniteNumber(q.points) ? Number(q.points) : 1
          };
          if (q && q.match === 'exact') out.match = 'exact';
          return out;
        })
      };
    }

    function getAnswerKey() {
      return cleanAnswerKey(getSetting('answerKey'));
    }

    function setAnswerKey(k) {
      return setSetting('answerKey', cleanAnswerKey(k));
    }

    // The probe cache handed to providers.resolveVisionModels: {[modelId]: {vision, checkedAt}}.
    // Each set writes through, so a probe run cut short keeps the verdicts it reached.
    function visionCache(provider) {
      checkProvider(provider);
      var name = 'vision.' + provider;
      function all() {
        var v = getSetting(name);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      }
      return {
        get: function (modelId) {
          var map = all();
          if (!hasOwn(map, modelId)) return null;
          var v = map[modelId];
          if (!v || typeof v.vision !== 'boolean') return null;
          return { vision: v.vision, checkedAt: typeof v.checkedAt === 'string' ? v.checkedAt : null };
        },
        set: function (modelId, verdict) {
          if (typeof modelId !== 'string' || modelId === '') throw new TypeError('model id required');
          if (!verdict || typeof verdict.vision !== 'boolean') throw new TypeError('verdict needs a boolean vision');
          var map = all();
          map[modelId] = {
            vision: verdict.vision,
            checkedAt: typeof verdict.checkedAt === 'string' ? verdict.checkedAt : new Date().toISOString()
          };
          return setSetting(name, map);
        },
        all: all,
        clear: function () { return setSetting(name, null); }
      };
    }

    function doomedByWipe(k) {
      return typeof k === 'string' && k.indexOf(PREFIX) === 0 && !KEPT_BY_WIPE.test(k.slice(PREFIX.length));
    }

    // Removes every "tabot." entry except key.*, model.*, vision.* and answerKey.
    // Entries without the prefix belong to other pages on this origin and are left alone.
    // With settings in memory, localStorage is still pruned as far as it allows.
    function pruneSettings() {
      if (ls) {
        try {
          var doomed = [];
          for (var i = 0; i < ls.length; i++) {
            var k = ls.key(i);
            if (doomedByWipe(k)) doomed.push(k);
          }
          doomed.forEach(function (k) { ls.removeItem(k); });
        } catch (e) {
          warn();
          settingsToMemory();
        }
      }
      if (settingsMap) {
        Array.from(settingsMap.keys()).forEach(function (k) {
          if (doomedByWipe(k)) settingsMap.delete(k);
        });
      }
    }

    // ---- results (asynchronous, IndexedDB or memory) ----

    // Moves results to memory for the rest of the page load. The first reason sticks.
    function toMemory(reason) {
      if (!memory) {
        memory = memoryBackend(state.photoFloor);
        state.memoryOnly = true;
        state.memoryReason = reason;
        // The reopen just failed, so the rows saved before the loss cannot be read.
        if (reason === 'lost') state.earlierUnread = true;
        backendPromise = Promise.resolve(memory);
      }
      return memory;
    }

    function lost() {
      return state.memoryReason === 'lost';
    }

    // After a loss, runs fn on the rows saved before it, on a fresh IndexedDB
    // connection: each call opens one again when the last attempt failed.
    function withEarlier(fn) {
      if (!earlier) earlier = idbBackend(idb);
      return Promise.resolve().then(function () { return fn(earlier); });
    }

    function backend() {
      if (backendPromise) return backendPromise;
      if (fileMode) { toMemory('file'); return backendPromise; }
      if (!idb) { toMemory('unavailable'); return backendPromise; }
      var b = idbBackend(idb);
      backendPromise = b.open().then(function () { return b; }, function () { return toMemory('unavailable'); });
      return backendPromise;
    }

    // Runs fn(backend). When IndexedDB is lost past its one reopen, results move to
    // memory and fn runs again there, so the call still lands.
    function withBackend(fn) {
      return backend().then(function (b) {
        return fn(b).catch(function (err) {
          if (!err || err.name !== LOST) throw err;
          return fn(toMemory('lost'));
        });
      });
    }

    function raisePhotoFloor(n) {
      if (isIndex(n) && n > state.photoFloor) state.photoFloor = n;
    }

    // One past the highest photo index among rows: the lowest index a new photo may take.
    function floorOf(rows) {
      var n = 0;
      rows.forEach(function (row) {
        if (isIndex(row.photoIndex) && row.photoIndex + 1 > n) n = row.photoIndex + 1;
      });
      return n;
    }

    // A new photo never takes the index of a row already listed, so a row read
    // back from IndexedDB after a loss can never share an id with a newer one.
    function keepAbove(n) {
      raisePhotoFloor(n);
      if (memory) memory.putRows([], n);
    }

    function prepareRows(rows) {
      if (!Array.isArray(rows)) throw new TypeError('addRows expects an array of rows');
      return rows.map(function (r) {
        if (!r || typeof r !== 'object') throw new TypeError('each row must be an object');
        var row = clone(r);
        if (row.id === undefined || row.id === null || row.id === '') {
          if (!isIndex(row.photoIndex) || !isIndex(row.slipIndex)) {
            throw new TypeError('a row needs an id, or a photoIndex and slipIndex');
          }
          row.id = 'p' + row.photoIndex + '-s' + row.slipIndex;
        }
        return row;
      });
    }

    function byReadingOrder(a, b) {
      var pa = isIndex(a.photoIndex) ? a.photoIndex : Infinity;
      var pb = isIndex(b.photoIndex) ? b.photoIndex : Infinity;
      if (pa !== pb) return pa < pb ? -1 : 1;
      var sa = isIndex(a.slipIndex) ? a.slipIndex : Infinity;
      var sb = isIndex(b.slipIndex) ? b.slipIndex : Infinity;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    }

    function info() {
      return {
        memoryOnly: state.memoryOnly,
        memoryReason: state.memoryReason,
        fileMode: fileMode,
        settingsMemoryOnly: state.settingsMemoryOnly
      };
    }

    function ready() {
      return backend().then(info);
    }

    // The store's clock, in milliseconds; a clock that returns no number falls
    // back to Date.now().
    function clock() {
      var t = Number(clockFn());
      return isTime(t) ? t : Date.now();
    }

    // opts.regrade: true when the rows are rows already stored, graded again;
    // lastPhotoAt is then left as it is. Otherwise every stored row records
    // lastPhotoAt = now in the same write.
    function addRows(rows, opts) {
      return Promise.resolve().then(function () {
        var list = prepareRows(rows);
        var atLeast = floorOf(list);
        var stampAt = opts && opts.regrade === true ? null : clock();
        return withBackend(function (b) { return b.putRows(list, atLeast, stampAt); }).then(function () {
          raisePhotoFloor(atLeast);
        });
      });
    }

    // After a loss: the rows still in IndexedDB from before it plus the rows in
    // memory, one per id; a memory row wins, since a regrade after the loss
    // rewrites a stored row there. When IndexedDB still will not open, the
    // memory rows alone, and earlierRowsUnread says so.
    function allRows() {
      return withBackend(function (b) { return b.getRows(); }).then(function (rows) {
        if (!lost()) return rows;
        return withEarlier(function (d) { return d.getRows(); }).then(function (stored) {
          state.earlierUnread = false;
          var byId = new Map();
          stored.concat(rows).forEach(function (row) { byId.set(row.id, row); });
          return Array.from(byId.values());
        }, function () {
          state.earlierUnread = true;
          return rows;
        });
      }).then(function (rows) {
        keepAbove(floorOf(rows));
        return rows.slice().sort(byReadingOrder);
      });
    }

    // Also clears the in-flight marker when it names this photo. After a loss,
    // the photo's rows saved before it are removed too when IndexedDB opens.
    function removePhoto(photoIndex) {
      return Promise.resolve().then(function () {
        if (!isIndex(photoIndex)) throw new TypeError('photoIndex must be a whole number');
        return withBackend(function (b) { return b.removePhoto(photoIndex); });
      }).then(function (removed) {
        if (!lost()) return removed;
        return withEarlier(function (d) { return d.removePhoto(photoIndex); }).then(function (n) {
          return removed + n;
        }, function () {
          return removed;
        });
      });
    }

    // Clears every row, the photo count and the in-flight marker. After a loss,
    // the rows saved before it are cleared too, on a fresh IndexedDB connection,
    // but only when the last allRows read them: rows it could not read reached
    // no spreadsheet, so they are kept for the next page load. The in-flight
    // marker set before the loss is cleared there whenever IndexedDB opens,
    // whether or not those rows are (clearStoredMarker).
    // -> {diskCleared}: false when rows saved before a loss are still stored.
    function clearResults() {
      return withBackend(function (b) { return b.clear(); }).then(function () {
        if (!lost()) return true;
        if (state.earlierUnread) return false;
        return withEarlier(function (d) { return d.clear(); }).then(function () {
          return true;
        }, function () {
          return false;
        });
      }).then(function (diskCleared) {
        if (diskCleared) {
          state.photoFloor = 0;
          return { diskCleared: true };
        }
        // Rows still stored keep their photo indexes, so new photos stay above them.
        memory.putRows([], state.photoFloor);
        return clearStoredMarker().then(function () {
          return { diskCleared: false };
        });
      });
    }

    // After a loss: the in-flight marker set before it is still in IndexedDB,
    // naming a photo whose slips went to memory. Left there, it would call that
    // photo interrupted on the next page load, and a retake would put its
    // students in a second spreadsheet. So it is cleared on a fresh connection
    // when one opens; when none does, it stays, and the page's own check on
    // load (the photo's stored rows against the marker's total) is the backstop.
    function clearStoredMarker() {
      return withEarlier(function (d) { return d.clearInFlight(); }).catch(function () {});
    }

    function getPhotoCount() {
      return withBackend(function (b) { return b.getPhotoCount(); }).then(function (n) {
        raisePhotoFloor(n);
        return n;
      });
    }

    // The index for a new photo: never reused while results are kept, reset by clearResults.
    function nextPhotoIndex() {
      return withBackend(function (b) { return b.takePhotoIndex(); }).then(function (i) {
        raisePhotoFloor(i + 1);
        return i;
      });
    }

    // The in-flight marker: which photo is being read, how many slips it has, and
    // how many are saved, so a reload can say which photo was interrupted and after
    // how many slips. Set it after each slip's addRows; clear it when the photo is done.
    function setInFlight(marker) {
      return Promise.resolve().then(function () {
        var m = inFlightOf(marker);
        if (!m) throw new TypeError('setInFlight expects {photoIndex, total, done}: whole numbers, done <= total');
        return withBackend(function (b) { return b.setInFlight(m); });
      });
    }

    // {photoIndex, total, done}, or null when no photo is in flight.
    function getInFlight() {
      return withBackend(function (b) { return b.getInFlight(); });
    }

    // After a loss, also clears the marker set before it, in IndexedDB, when a
    // fresh connection opens (clearStoredMarker).
    function clearInFlight() {
      return withBackend(function (b) { return b.clearInFlight(); }).then(function () {
        if (lost()) return clearStoredMarker();
      });
    }

    // Settings are pruned first: that half is synchronous and cannot be left undone
    // by a failing IndexedDB clear. clearResults takes the in-flight marker with it,
    // after a loss the one still in IndexedDB too.
    // -> clearResults's {diskCleared}.
    function wipeAfterDownload() {
      pruneSettings();
      return clearResults();
    }

    // The time the last slip was stored, in milliseconds, or null when none is
    // recorded. After a loss, the later of the time kept in memory and the one
    // still in IndexedDB from before it (read on a fresh connection when one
    // opens), since the rows of both are listed together.
    function getLastPhotoAt() {
      return withBackend(function (b) { return b.getLastPhotoAt(); }).then(function (at) {
        if (!lost()) return at;
        return withEarlier(function (d) { return d.getLastPhotoAt(); }).then(function (stored) {
          return later(at, stored);
        }, function () {
          return at;
        });
      });
    }

    // Clears results nobody confirmed saved once they are maxAgeMs old.
    // {now, maxAgeMs}: milliseconds; now defaults to the store's clock.
    // -> {expired, rows}: rows is how many rows were listed (and, when expired
    // is true, cleared).
    //   no rows                        nothing happens
    //   rows, no lastPhotoAt recorded  lastPhotoAt = now; not expired yet
    //   now - lastPhotoAt >= maxAgeMs  cleared, as clearResults (settings stay)
    // The page runs it only while no photo is being read, so no slip is stored
    // between the check and the clear.
    function expireIfStale(opts) {
      return Promise.resolve().then(function () {
        opts = opts || {};
        var now = opts.now === undefined ? clock() : opts.now;
        var maxAgeMs = opts.maxAgeMs;
        if (!isTime(now)) throw new TypeError('expireIfStale needs now in milliseconds');
        if (!isTime(maxAgeMs) || maxAgeMs < 0) throw new TypeError('expireIfStale needs maxAgeMs, milliseconds, 0 or more');
        return allRows().then(function (rows) {
          var n = rows.length;
          if (!n) return { expired: false, rows: 0 };
          return getLastPhotoAt().then(function (at) {
            if (at === null) {
              return withBackend(function (b) { return b.adoptLastPhotoAt(now); }).then(function () {
                return { expired: false, rows: n };
              });
            }
            if (now - at < maxAgeMs) return { expired: false, rows: n };
            return clearResults().then(function () {
              return { expired: true, rows: n };
            });
          });
        });
      });
    }

    var api = {
      PREFIX: PREFIX,
      DB_NAME: DB_NAME,
      getSetting: getSetting,
      setSetting: setSetting,
      getKey: getKey,
      setKey: setKey,
      getModel: getModel,
      setModel: setModel,
      getAnswerKey: getAnswerKey,
      setAnswerKey: setAnswerKey,
      visionCache: visionCache,
      ready: ready,
      addRows: addRows,
      allRows: allRows,
      removePhoto: removePhoto,
      clearResults: clearResults,
      getPhotoCount: getPhotoCount,
      nextPhotoIndex: nextPhotoIndex,
      setInFlight: setInFlight,
      getInFlight: getInFlight,
      clearInFlight: clearInFlight,
      wipeAfterDownload: wipeAfterDownload,
      getLastPhotoAt: getLastPhotoAt,
      expireIfStale: expireIfStale
    };
    // Read-only flags for the page's banners.
    //   storageWarning      a localStorage access failed
    //   settingsMemoryOnly  settings live in memory for this page load
    //   memoryOnly          rows live in memory for this page load
    //   memoryReason        null, "file", "unavailable" or "lost"
    //   fileMode            the page came from file: and persists nothing
    //   earlierRowsUnread   after a loss, the last try at the rows saved before
    //                       it failed: allRows left them out
    [
      ['storageWarning', function () { return state.storageWarning; }],
      ['settingsMemoryOnly', function () { return state.settingsMemoryOnly; }],
      ['memoryOnly', function () { return state.memoryOnly; }],
      ['memoryReason', function () { return state.memoryReason; }],
      ['fileMode', function () { return fileMode; }],
      ['earlierRowsUnread', function () { return lost() && state.earlierUnread; }]
    ].forEach(function (flag) {
      Object.defineProperty(api, flag[0], { enumerable: true, get: flag[1] });
    });
    return api;
  }

  // The page uses the default instance (window.localStorage, window.indexedDB,
  // window.location); tests call create() with injected storage, location and clock.
  var defaultStore = create();
  defaultStore.create = create;
  return defaultStore;
});
