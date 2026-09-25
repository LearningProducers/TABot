'use strict';
// Unit tests for js/store.js. No browser: localStorage is a Map-backed fake,
// and IndexedDB is either absent (the in-memory fallback) or the small fake below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const store = require('../../js/store.js');

const STORE_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'store.js'), 'utf8');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 1, 14, 0, 0); // any fixed moment

// A clock the test moves by hand.
function manualClock(t) {
  const clock = { t, now: () => clock.t };
  return clock;
}

// A Storage-shaped fake that also logs every write and counts every read, so
// tests can see exactly what any store API put into (or took from) localStorage.
class FakeStorage {
  constructor(entries) {
    this.map = new Map(entries || []);
    this.writes = [];
    this.reads = 0;
  }
  get length() { this.reads++; return this.map.size; }
  key(i) { this.reads++; return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { this.reads++; return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes.push([k, String(v)]); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

// Every call throws, the way a blocked or full localStorage does.
class BrokenStorage {
  get length() { throw new Error('SecurityError'); }
  key() { throw new Error('SecurityError'); }
  getItem() { throw new Error('SecurityError'); }
  setItem() { throw new Error('QuotaExceededError'); }
  removeItem() { throw new Error('SecurityError'); }
}

// Reads and removals work, every write throws: a full localStorage.
class FullStorage extends FakeStorage {
  setItem() { throw new DOMException('the quota has been exceeded', 'QuotaExceededError'); }
}

const domError = (name) => new DOMException(name, name);

// A minimal asynchronous IndexedDB: open with upgrade, transactions that
// complete once their requests settle, and put/get/getAll/delete/clear.
// Fault controls, for the connection-loss tests:
//   kill()             the browser closes every connection: close event, then
//                      transaction() throws InvalidStateError
//   closeQuietly()     connections stop working with no close event
//   upgradeElsewhere() another tab upgrades: versionchange on every connection
//   openFaults = n     the next n open() calls fail with UnknownError
//   txFaults.push(name) the next transaction fails with that error, running nothing
// It does not serialize overlapping readwrite transactions the way a browser
// does, so concurrent writes are only tested against the memory backend.
function fakeIndexedDB() {
  const dbs = new Map();
  const connections = [];
  const later = (fn) => setTimeout(fn, 0);

  function makeTransaction(rec, names, mode, fault) {
    let pending = 0;
    let finished = false;
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
    function settle() {
      later(() => {
        if (pending === 0 && !finished) {
          finished = true;
          if (tx.oncomplete) tx.oncomplete({});
        }
      });
    }
    function request(fn) {
      const req = { result: undefined, onsuccess: null, onerror: null };
      if (fault) return req; // a failing transaction runs nothing, so nothing is written
      pending++;
      later(() => {
        req.result = fn();
        pending--;
        if (req.onsuccess) req.onsuccess({});
        settle();
      });
      return req;
    }
    function writable() {
      if (mode !== 'readwrite') throw new Error('ReadOnlyError');
    }
    tx.abort = () => {
      finished = true;
      if (tx.onabort) tx.onabort({});
    };
    tx.objectStore = (name) => {
      if (!names.includes(name)) throw new Error('NotFoundError: ' + name);
      const s = rec.stores.get(name);
      return {
        put(value) {
          writable();
          const copy = structuredClone(value);
          return request(() => { s.data.set(copy[s.keyPath], copy); return copy[s.keyPath]; });
        },
        get(key) {
          return request(() => (s.data.has(key) ? structuredClone(s.data.get(key)) : undefined));
        },
        getAll() {
          return request(() => Array.from(s.data.values()).map((v) => structuredClone(v)));
        },
        delete(key) {
          writable();
          return request(() => { s.data.delete(key); });
        },
        clear() {
          writable();
          return request(() => { s.data.clear(); });
        }
      };
    };
    if (fault) {
      later(() => {
        finished = true;
        tx.error = domError(fault);
        if (tx.onerror) tx.onerror({ target: tx });
        if (tx.onabort) tx.onabort({ target: tx });
      });
    } else {
      settle();
    }
    return tx;
  }

  function makeDb(rec) {
    const conn = {
      closed: false,
      onclose: null,
      onversionchange: null,
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      createObjectStore(n, o) { rec.stores.set(n, { keyPath: o && o.keyPath, data: new Map() }); },
      transaction(names, mode) {
        if (conn.closed) { idb.closedUses++; throw domError('InvalidStateError'); }
        return makeTransaction(rec, [].concat(names), mode || 'readonly', idb.txFaults.shift());
      },
      close() { conn.closed = true; }
    };
    connections.push(conn);
    return conn;
  }

  const idb = {
    dbs,
    opens: 0,
    closedUses: 0, // transactions tried on a closed connection
    openFaults: 0,
    txFaults: [],
    kill() {
      for (const c of connections) {
        if (c.closed) continue;
        c.closed = true;
        if (c.onclose) c.onclose({});
      }
    },
    closeQuietly() {
      for (const c of connections) c.closed = true;
    },
    upgradeElsewhere() {
      for (const c of connections) if (!c.closed && c.onversionchange) c.onversionchange({});
    },
    open(name, version) {
      idb.opens++;
      const fail = idb.openFaults > 0;
      if (fail) idb.openFaults--;
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (fail) {
          req.error = domError('UnknownError');
          if (req.onerror) req.onerror({});
          return;
        }
        if (!dbs.has(name)) dbs.set(name, { version: 0, stores: new Map() });
        const rec = dbs.get(name);
        req.result = makeDb(rec);
        if (version > rec.version) {
          rec.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded({});
        }
        if (req.onsuccess) req.onsuccess({});
      });
      return req;
    }
  };
  return idb;
}

// Synthetic graded rows. The names and answers are sentinels the leak test hunts for.
function sampleRows(photoIndex, names) {
  return names.map((name, slipIndex) => ({
    photoIndex,
    slipIndex,
    studentName: name,
    nameFlag: false,
    answers: [
      { q: 1, read: 'ZQX-ANSWER-' + name + '-1', reviewRead: 'ZQX-REVIEW-' + name + '-1', confidence: 0.9, correct: true, points: 1, maxPoints: 1, flagged: false, reason: '' },
      { q: 2, read: 'ZQX-ANSWER-' + name + '-2', reviewRead: 'ZQX-REVIEW-' + name + '-2', confidence: 0.4, correct: false, points: 0, maxPoints: 1, flagged: true, reason: 'low confidence' }
    ],
    score: 1,
    maxScore: 2,
    flagged: true,
    notes: 'ZQX-NOTE-' + name,
    readBy: 'model-a',
    reviewedBy: 'model-a',
    reviewMode: 'single-model'
  }));
}

function sampleKey() {
  return { assignment: 'Unit 3 quiz', passPercent: 70, questions: [{ answer: '1/2', points: 1 }, { answer: '-3', points: 2 }] };
}

// What ready() reports for a store on working localStorage and IndexedDB.
const PERSISTENT = { memoryOnly: false, memoryReason: null, fileMode: false, settingsMemoryOnly: false };

const studentNames = async (s) => (await s.allRows()).map((r) => r.studentName);

// The three places results can live, each behind the same store API:
//   memory     no IndexedDB from the start
//   indexeddb  IndexedDB working
//   lost       IndexedDB lost mid-session: results moved to memory, and
//              IndexedDB (empty) opens again for the rows saved before the loss
const BACKENDS = ['memory', 'indexeddb', 'lost'];

async function storeOn(kind, clock, ls) {
  const idb = kind === 'memory' ? null : fakeIndexedDB();
  const s = store.create({ localStorage: ls || new FakeStorage(), indexedDB: idb, now: clock.now });
  await s.ready();
  if (kind === 'lost') {
    idb.kill();
    idb.openFaults = 1; // the reopen fails, so results move to memory
    await s.getPhotoCount();
    assert.equal(s.memoryReason, 'lost');
  }
  return { s, idb };
}

// The lastPhotoAt record as it sits in the fake IndexedDB, or undefined.
function storedLastPhoto(idb) {
  const meta = idb.dbs.get('tabot').stores.get('meta').data;
  return Array.from(meta.values()).find((rec) => 'lastPhotoAt' in rec);
}

// Turns the fake IndexedDB into what the page stored before lastPhotoAt was
// kept: rows and a photo count, no lastPhotoAt.
function forgetLastPhotoAt(idb) {
  const meta = idb.dbs.get('tabot').stores.get('meta').data;
  for (const [id, rec] of Array.from(meta)) if ('lastPhotoAt' in rec) meta.delete(id);
}

test('settings round trip under the tabot. prefix', () => {
  const ls = new FakeStorage();
  const s = store.create({ localStorage: ls, indexedDB: null });

  assert.equal(s.getKey('groq'), null);
  assert.equal(s.setKey('groq', '  test-key-not-real  '), true);
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  assert.equal(ls.getItem('tabot.key.groq'), JSON.stringify('test-key-not-real'));

  s.setModel('groq', 'vision-model-x');
  assert.equal(s.getModel('groq'), 'vision-model-x');

  s.setAnswerKey(sampleKey());
  assert.deepEqual(s.getAnswerKey(), sampleKey());

  s.setSetting('review', { mode: 'reserved' });
  assert.deepEqual(s.getSetting('review'), { mode: 'reserved' });

  s.setKey('groq', '');
  assert.equal(s.getKey('groq'), null);
  assert.equal(ls.getItem('tabot.key.groq'), null);
  assert.equal(s.storageWarning, false);
  assert.equal(s.settingsMemoryOnly, false);
});

test('answer key keeps only its own fields and fills defaults', () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  s.setAnswerKey({ assignment: 'Q', questions: [{ answer: 5, extra: 'x' }, {}], rows: ['should not persist'] });
  assert.deepEqual(s.getAnswerKey(), {
    assignment: 'Q',
    passPercent: 70,
    questions: [{ answer: '5', points: 1 }, { answer: '', points: 1 }]
  });
});

test('vision cache persists each verdict and ignores junk', () => {
  const ls = new FakeStorage();
  const s = store.create({ localStorage: ls, indexedDB: null });
  const cache = s.visionCache('groq');

  assert.equal(cache.get('m1'), null);
  cache.set('m1', { vision: true, checkedAt: '2026-09-24T12:00:00.000Z' });
  cache.set('m2', { vision: false, checkedAt: '2026-09-24T12:00:01.000Z' });

  const fresh = store.create({ localStorage: ls, indexedDB: null }).visionCache('groq');
  assert.deepEqual(fresh.get('m1'), { vision: true, checkedAt: '2026-09-24T12:00:00.000Z' });
  assert.deepEqual(fresh.get('m2'), { vision: false, checkedAt: '2026-09-24T12:00:01.000Z' });
  assert.equal(fresh.get('constructor'), null);
  assert.deepEqual(Object.keys(fresh.all()).sort(), ['m1', 'm2']);
  assert.throws(() => cache.set('m3', { vision: 'yes' }), TypeError);

  ls.setItem('tabot.vision.groq', '{not json');
  assert.equal(s.visionCache('groq').get('m1'), null);
});

test('unknown setting names and bad provider ids are refused', () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  assert.throws(() => s.setSetting('rows', []), TypeError);
  assert.throws(() => s.setSetting('results', {}), TypeError);
  assert.throws(() => s.getSetting('key'), TypeError);
  assert.throws(() => s.setKey('../x', 'k'), TypeError);
});

// Settings work for the session when localStorage is missing or throws.

test('no localStorage: settings live in memory for the session, flagged', async () => {
  const s = store.create({ localStorage: null, indexedDB: null });
  assert.equal(s.settingsMemoryOnly, true);
  assert.equal(s.storageWarning, true);

  assert.equal(s.getKey('groq'), null);
  assert.equal(s.setKey('groq', 'test-key-not-real'), true);
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  assert.equal(s.setModel('groq', 'vision-model-x'), true);
  assert.equal(s.getModel('groq'), 'vision-model-x');
  assert.equal(s.setAnswerKey(sampleKey()), true);
  assert.deepEqual(s.getAnswerKey(), sampleKey());
  s.visionCache('groq').set('vision-model-x', { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' });
  assert.deepEqual(s.visionCache('groq').get('vision-model-x'), { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' });

  // A stored value is a copy: changing the caller's object changes nothing.
  const review = { mode: 'reserved' };
  s.setSetting('review', review);
  review.mode = 'changed by caller';
  assert.deepEqual(s.getSetting('review'), { mode: 'reserved' });

  await s.wipeAfterDownload();
  assert.equal(s.getSetting('review'), null);
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  assert.deepEqual(s.getAnswerKey(), sampleKey());

  // Another page load starts empty: nothing was persisted.
  assert.equal(store.create({ localStorage: null, indexedDB: null }).getKey('groq'), null);
});

test('a localStorage that throws: settings move to memory on the first failure', async () => {
  const s = store.create({ localStorage: new BrokenStorage(), indexedDB: null });
  assert.equal(s.storageWarning, false);
  assert.equal(s.settingsMemoryOnly, false);

  assert.equal(s.getKey('groq'), null);
  assert.equal(s.storageWarning, true);
  assert.equal(s.settingsMemoryOnly, true);

  assert.equal(s.setModel('groq', 'm'), true);
  assert.equal(s.getModel('groq'), 'm');
  s.setKey('groq', 'test-key-not-real');
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  s.setAnswerKey(sampleKey());
  assert.deepEqual(s.getAnswerKey(), sampleKey());
  await s.wipeAfterDownload();
  assert.equal(s.getKey('groq'), 'test-key-not-real');
});

test('a localStorage that refuses writes keeps what it already holds', async () => {
  const ls = new FullStorage([
    ['tabot.key.groq', JSON.stringify('test-key-not-real')],
    ['tabot.answerKey', JSON.stringify(sampleKey())],
    ['tabot.review', '"old"']
  ]);
  const s = store.create({ localStorage: ls, indexedDB: null });
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  assert.equal(s.settingsMemoryOnly, false);

  assert.equal(s.setModel('groq', 'vision-model-x'), true);
  assert.equal(s.settingsMemoryOnly, true);
  assert.equal(s.storageWarning, true);
  assert.equal(s.getModel('groq'), 'vision-model-x');
  assert.equal(s.getKey('groq'), 'test-key-not-real', 'the saved key survives the move to memory');
  assert.deepEqual(s.getAnswerKey(), sampleKey());

  s.setKey('groq', '');
  assert.equal(s.getKey('groq'), null);

  // The wipe still prunes what it can reach in the real localStorage.
  await s.wipeAfterDownload();
  assert.equal(s.getSetting('review'), null);
  assert.ok(!ls.map.has('tabot.review'));
  assert.deepEqual(s.getAnswerKey(), sampleKey());
});

// A page opened from file: persists nothing.

test('file: page persists nothing: settings and results stay in memory, fileMode set', async () => {
  const ls = new FakeStorage([['tabot.key.groq', JSON.stringify('saved-by-an-earlier-page')]]);
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: ls, indexedDB: idb, location: { protocol: 'file:' } });

  assert.equal(s.fileMode, true);
  assert.equal(s.settingsMemoryOnly, true);
  assert.equal(s.getKey('groq'), null, 'a file: page does not read localStorage');
  assert.equal(s.setKey('groq', 'test-key-not-real'), true);
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  s.setModel('groq', 'vision-model-x');
  s.setAnswerKey(sampleKey());
  s.setSetting('review', { mode: 'reserved' });
  s.visionCache('groq').set('vision-model-x', { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' });
  assert.equal(s.getModel('groq'), 'vision-model-x');
  assert.deepEqual(s.getAnswerKey(), sampleKey());

  assert.deepEqual(await s.ready(), { memoryOnly: true, memoryReason: 'file', fileMode: true, settingsMemoryOnly: true });
  assert.equal(s.memoryOnly, true);
  assert.equal(s.memoryReason, 'file');
  assert.equal(await s.nextPhotoIndex(), 0);
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  await s.setInFlight({ photoIndex: 0, total: 2, done: 2 });
  assert.deepEqual(await studentNames(s), ['Ana', 'Ben']);

  // The refresh: a new file: store on the same storage finds nothing.
  const reloaded = store.create({ localStorage: ls, indexedDB: idb, location: { protocol: 'file:' } });
  assert.equal(reloaded.getModel('groq'), null);
  assert.deepEqual(await reloaded.allRows(), []);
  assert.equal(await reloaded.getInFlight(), null);

  await s.wipeAfterDownload();
  assert.equal(s.getSetting('review'), null);
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  assert.deepEqual(await s.allRows(), []);
  assert.equal(await s.getInFlight(), null);

  assert.equal(idb.opens, 0, 'IndexedDB never opened');
  assert.equal(ls.reads, 0, 'localStorage never read');
  assert.deepEqual(ls.writes, [], 'localStorage never written');
  assert.deepEqual(Array.from(ls.map.keys()), ['tabot.key.groq']);
  assert.equal(s.storageWarning, false, 'nothing failed; fileMode is the banner');
});

test('fileMode comes only from a file: protocol', async () => {
  const cases = [
    [{ protocol: 'file:' }, true],
    [{ protocol: 'FILE:' }, true],
    [{ protocol: 'https:' }, false],
    [{ protocol: 'http:' }, false],
    [{}, false],
    [null, false],
    [{ get protocol() { throw new Error('SecurityError'); } }, false]
  ];
  cases.forEach(([location, expected], i) => {
    assert.equal(store.create({ localStorage: new FakeStorage(), indexedDB: null, location }).fileMode, expected, 'case ' + i);
  });

  const ls = new FakeStorage();
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: ls, indexedDB: idb, location: { protocol: 'https:' } });
  s.setKey('groq', 'test-key-not-real');
  assert.equal(ls.getItem('tabot.key.groq'), JSON.stringify('test-key-not-real'));
  assert.deepEqual(await s.ready(), PERSISTENT);
  assert.equal(idb.opens, 1);
});

test('in-memory fallback: flagged, round trips, reading order, copies', async () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  assert.deepEqual(await s.ready(), { memoryOnly: true, memoryReason: 'unavailable', fileMode: false, settingsMemoryOnly: false });
  assert.equal(s.memoryOnly, true);
  assert.equal(s.memoryReason, 'unavailable');

  await s.addRows(sampleRows(1, ['Dee', 'Eli']));
  await s.addRows(sampleRows(0, ['Ana', 'Ben', 'Cy']));
  const rows = await s.allRows();
  assert.deepEqual(rows.map((r) => r.studentName), ['Ana', 'Ben', 'Cy', 'Dee', 'Eli']);
  assert.deepEqual(rows.map((r) => r.id), ['p0-s0', 'p0-s1', 'p0-s2', 'p1-s0', 'p1-s1']);
  assert.equal(rows[0].answers[1].flagged, true);

  rows[0].studentName = 'changed by caller';
  assert.equal((await s.allRows())[0].studentName, 'Ana');

  // same id replaces, it does not duplicate
  await s.addRows([Object.assign(sampleRows(0, ['Ana'])[0], { score: 2 })]);
  const again = await s.allRows();
  assert.equal(again.length, 5);
  assert.equal(again[0].score, 2);
});

test('photo count: addRows raises it, nextPhotoIndex takes one, clearResults resets', async () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  assert.equal(await s.getPhotoCount(), 0);
  assert.equal(await s.nextPhotoIndex(), 0);
  assert.equal(await s.nextPhotoIndex(), 1);
  await s.addRows(sampleRows(4, ['Ana']));
  assert.equal(await s.getPhotoCount(), 5);
  assert.equal(await s.nextPhotoIndex(), 5);
  await s.clearResults();
  assert.equal(await s.getPhotoCount(), 0);
  assert.deepEqual(await s.allRows(), []);
});

test('removePhoto removes that photo only', async () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  await s.addRows(sampleRows(1, ['Cy']));
  assert.equal(await s.removePhoto(0), 2);
  assert.deepEqual(await studentNames(s), ['Cy']);
  assert.equal(await s.removePhoto(7), 0);
  await assert.rejects(s.removePhoto(-1), TypeError);
});

test('addRows rejects bad input without storing anything', async () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  await assert.rejects(s.addRows('nope'), TypeError);
  await assert.rejects(s.addRows([{ studentName: 'no id, no indices' }]), TypeError);
  await s.addRows([{ id: 'custom-1', studentName: 'Ana' }]);
  assert.deepEqual((await s.allRows()).map((r) => r.id), ['custom-1']);
});

// The in-flight marker, and addRows once per slip.

test('in-flight marker: per-slip progress survives a reload; cleared by clearInFlight, removePhoto, clearResults and the wipe', async () => {
  for (const idb of [null, fakeIndexedDB()]) {
    const label = idb ? 'IndexedDB' : 'memory';
    const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
    assert.equal(await s.getInFlight(), null, label);

    const photoIndex = await s.nextPhotoIndex();
    await s.setInFlight({ photoIndex, total: 8, done: 0, studentName: 'Ana' });
    assert.deepEqual(await s.getInFlight(), { photoIndex: 0, total: 8, done: 0 }, label + ': only the three counts are kept');

    // One addRows per slip, the marker bumped after each.
    const slips = sampleRows(photoIndex, ['Ana', 'Ben', 'Cy']);
    for (let i = 0; i < slips.length; i++) {
      await s.addRows([slips[i]]);
      await s.setInFlight({ photoIndex, total: 8, done: i + 1 });
    }

    // The reload: a fresh store on the same database says which photo stopped where.
    const view = idb ? store.create({ localStorage: new FakeStorage(), indexedDB: idb }) : s;
    assert.deepEqual(await view.getInFlight(), { photoIndex: 0, total: 8, done: 3 }, label);
    assert.deepEqual((await view.allRows()).map((r) => r.id), ['p0-s0', 'p0-s1', 'p0-s2'], label);
    assert.equal(await view.getPhotoCount(), 1, label);

    // The marker and the photo count share the meta store without touching each other.
    assert.equal(await s.nextPhotoIndex(), 1, label);
    assert.deepEqual(await s.getInFlight(), { photoIndex: 0, total: 8, done: 3 }, label);

    await s.clearInFlight();
    assert.equal(await s.getInFlight(), null, label);

    await s.setInFlight({ photoIndex: 1, total: 2, done: 1 });
    await s.removePhoto(0);
    assert.deepEqual(await s.getInFlight(), { photoIndex: 1, total: 2, done: 1 }, label + ': another photo leaves it');
    await s.removePhoto(1);
    assert.equal(await s.getInFlight(), null, label + ': discarding the interrupted photo clears it');

    await s.setInFlight({ photoIndex: 2, total: 4, done: 4 });
    await s.wipeAfterDownload();
    assert.equal(await s.getInFlight(), null, label + ': the wipe clears it');

    await s.setInFlight({ photoIndex: 0, total: 1, done: 0 });
    await s.clearResults();
    assert.equal(await s.getInFlight(), null, label + ': clearResults clears it');
  }
});

test('setInFlight refuses anything but three whole counts with done <= total', async () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  const bad = [
    null, 'photo 1', {}, { photoIndex: 0, total: 1 },
    { photoIndex: -1, total: 1, done: 0 }, { photoIndex: 0, total: 2, done: 3 },
    { photoIndex: 0.5, total: 1, done: 0 }, { photoIndex: '0', total: 1, done: 0 }
  ];
  for (const marker of bad) await assert.rejects(s.setInFlight(marker), TypeError, JSON.stringify(marker));
  assert.equal(await s.getInFlight(), null);
});

test('addRows once per slip, concurrently: every row lands and the photo count holds', async () => {
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  await s.addRows(sampleRows(0, ['Ana']));
  const slips = sampleRows(3, ['Ben', 'Cy', 'Dee', 'Eli']);
  await Promise.all(slips.map((row) => s.addRows([row])));
  await Promise.all(slips.map((row) => s.addRows([row]))); // a slip saved twice replaces itself
  assert.deepEqual((await s.allRows()).map((r) => r.id), ['p0-s0', 'p3-s0', 'p3-s1', 'p3-s2', 'p3-s3']);
  assert.equal(await s.getPhotoCount(), 4);
});

test('wipeAfterDownload keeps exactly key.*, model.*, vision.*, answerKey', async () => {
  const ls = new FakeStorage([
    ['tabot.review', '"reserved"'],
    ['tabot.lastPhoto', '3'],
    ['tabot.draft', '"x"'],
    ['other.app', 'left alone']
  ]);
  const s = store.create({ localStorage: ls, indexedDB: null });
  s.setKey('groq', 'test-key-not-real');
  s.setKey('claude', 'another-test-key');
  s.setModel('groq', 'vision-model-x');
  s.visionCache('groq').set('vision-model-x', { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' });
  s.setAnswerKey(sampleKey());
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  await s.nextPhotoIndex();

  await s.wipeAfterDownload();

  assert.deepEqual(Array.from(ls.map.keys()).sort(), [
    'other.app',
    'tabot.answerKey',
    'tabot.key.claude',
    'tabot.key.groq',
    'tabot.model.groq',
    'tabot.vision.groq'
  ]);
  assert.equal(s.getKey('groq'), 'test-key-not-real');
  assert.deepEqual(s.getAnswerKey(), sampleKey());
  assert.deepEqual(await s.allRows(), []);
  assert.equal(await s.getPhotoCount(), 0);
  assert.equal(s.storageWarning, false);
});

test('no store API ever writes student names or answers to localStorage', async () => {
  for (const idb of [null, fakeIndexedDB()]) {
    const ls = new FakeStorage();
    const s = store.create({ localStorage: ls, indexedDB: idb });
    s.setKey('groq', 'test-key-not-real');
    s.setModel('groq', 'vision-model-x');
    s.setAnswerKey(sampleKey());
    s.visionCache('groq').set('vision-model-x', { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' });
    await s.ready();
    await s.nextPhotoIndex();
    await s.addRows(sampleRows(0, ['Ana', 'Ben']));
    await s.setInFlight({ photoIndex: 0, total: 2, done: 2 });
    await s.addRows(sampleRows(1, ['Cy']));
    await s.allRows();
    await s.getPhotoCount();
    await s.getInFlight();
    await s.removePhoto(1);
    await s.addRows(sampleRows(2, ['Dee']));
    await s.expireIfStale({ maxAgeMs: DAY });
    await s.getLastPhotoAt();
    await s.wipeAfterDownload();
    await s.addRows(sampleRows(0, ['Eli']));
    await s.expireIfStale({ maxAgeMs: 0 }); // expires on the spot
    await s.addRows(sampleRows(0, ['Eli']), { regrade: true });
    await s.expireIfStale({ maxAgeMs: DAY }); // starts the clock of rows with none
    await s.clearInFlight();
    await s.clearResults();

    const written = ls.writes.map(([k, v]) => k + '=' + v).join('\n');
    const kept = Array.from(ls.map.entries()).map(([k, v]) => k + '=' + v).join('\n');
    for (const text of [written, kept]) {
      assert.doesNotMatch(text, /ZQX-/);
      for (const name of ['Ana', 'Ben', 'Cy', 'Dee', 'Eli']) assert.ok(!text.includes(name), name + ' leaked');
    }
    assert.ok(ls.writes.every(([k]) => /^tabot\.(key\.|model\.|vision\.|answerKey$)/.test(k)));
  }
});

test('IndexedDB path: rows, photo count, removePhoto, clear', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await s.ready(), PERSISTENT);

  assert.equal(await s.nextPhotoIndex(), 0);
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  await s.addRows(sampleRows(2, ['Cy']));
  assert.equal(await s.getPhotoCount(), 3);

  const rec = idb.dbs.get('tabot');
  assert.equal(rec.version, 1);
  assert.deepEqual(Array.from(rec.stores.keys()).sort(), ['meta', 'rows']);
  assert.equal(rec.stores.get('rows').keyPath, 'id');
  assert.equal(rec.stores.get('rows').data.size, 3);

  // A second store instance on the same database sees the rows: the refresh case.
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await studentNames(reloaded), ['Ana', 'Ben', 'Cy']);
  assert.equal(reloaded.memoryOnly, false);

  assert.equal(await s.removePhoto(0), 2);
  assert.deepEqual((await s.allRows()).map((r) => r.id), ['p2-s0']);
  await s.clearResults();
  assert.deepEqual(await s.allRows(), []);
  assert.equal(await s.getPhotoCount(), 0);
  assert.equal(rec.stores.get('rows').data.size, 0);
});

test('IndexedDB that will not open falls back to memory, flagged', async () => {
  const throwing = { open() { throw new Error('InvalidStateError'); } };
  const s1 = store.create({ localStorage: new FakeStorage(), indexedDB: throwing });
  await s1.addRows(sampleRows(0, ['Ana']));
  assert.equal(s1.memoryOnly, true);
  assert.equal(s1.memoryReason, 'unavailable');
  assert.equal((await s1.allRows()).length, 1);

  const failing = {
    open() {
      const req = { error: new Error('UnknownError'), onerror: null };
      setTimeout(() => req.onerror && req.onerror({}), 0);
      return req;
    }
  };
  const s2 = store.create({ localStorage: new FakeStorage(), indexedDB: failing });
  assert.deepEqual(await s2.ready(), { memoryOnly: true, memoryReason: 'unavailable', fileMode: false, settingsMemoryOnly: false });
});

// A connection lost mid-session is reopened once, then memory takes over.

test('a lost IndexedDB connection is dropped and reopened once, and the call lands', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana']));
  assert.equal(idb.opens, 1);

  idb.kill(); // close event: storage cleared, or Safari's IndexedDB server gone
  await s.addRows(sampleRows(1, ['Ben']));
  assert.equal(idb.opens, 2);
  assert.equal(idb.closedUses, 0, 'the close event dropped the connection before anything tried it');

  idb.closeQuietly(); // no close event: transaction() throws InvalidStateError
  assert.equal(await s.nextPhotoIndex(), 2);
  assert.equal(idb.opens, 3);
  assert.equal(idb.closedUses, 1);

  idb.txFaults.push('UnknownError'); // "Connection to Indexed Database server lost"
  await s.addRows(sampleRows(2, ['Cy']));
  assert.equal(idb.opens, 4);

  idb.txFaults.push('AbortError'); // a transaction in flight when the browser closed the connection
  await s.setInFlight({ photoIndex: 2, total: 1, done: 1 });
  assert.equal(idb.opens, 5);

  idb.upgradeElsewhere(); // another tab upgrades: this one closes its connection
  assert.equal(await s.getPhotoCount(), 3);
  assert.equal(idb.opens, 6);
  assert.equal(idb.closedUses, 1, 'versionchange dropped the connection it closed');

  assert.equal(s.memoryOnly, false);
  assert.equal(s.memoryReason, null);
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await studentNames(reloaded), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(await reloaded.getInFlight(), { photoIndex: 2, total: 1, done: 1 });
});

test('a reopen that fails moves results to memory for the session, memoryReason lost', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.equal(await s.nextPhotoIndex(), 0);
  assert.equal(await s.nextPhotoIndex(), 1);
  assert.equal(await s.nextPhotoIndex(), 2);
  await s.addRows(sampleRows(0, ['Ana']));

  idb.kill();
  idb.openFaults = 1000;
  await s.addRows(sampleRows(1, ['Ben'])); // resolves: the row lands in memory
  assert.equal(idb.opens, 2, 'one reopen, no more');
  assert.equal(s.memoryOnly, true);
  assert.equal(s.memoryReason, 'lost');
  assert.deepEqual(await s.ready(), { memoryOnly: true, memoryReason: 'lost', fileMode: false, settingsMemoryOnly: false });

  // Rows written before the loss stay in IndexedDB, which still will not open,
  // so they are left out and said to be; photo indexes are not reused.
  assert.deepEqual(await studentNames(s), ['Ben']);
  assert.equal(s.earlierRowsUnread, true);
  const opens = idb.opens;
  assert.equal(await s.nextPhotoIndex(), 3, 'indexes 0 to 2 were taken before the loss');
  await s.setInFlight({ photoIndex: 3, total: 3, done: 1 });
  assert.deepEqual(await s.getInFlight(), { photoIndex: 3, total: 3, done: 1 });
  await s.addRows(sampleRows(3, ['Cy']));
  assert.equal(idb.opens, opens, 'writes stay in memory and never try IndexedDB again');
  assert.equal(await s.removePhoto(1), 1);
  assert.deepEqual(await s.wipeAfterDownload(), { diskCleared: false });
  assert.deepEqual(await s.allRows(), []);
  assert.equal(await s.getInFlight(), null);
});

test('a second loss right after the reopen also moves to memory, and concurrent calls share it', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.ready();
  idb.txFaults.push('UnknownError', 'UnknownError');
  assert.equal(await s.nextPhotoIndex(), 0);
  assert.equal(s.memoryReason, 'lost');
  assert.equal(idb.opens, 2);

  const idb2 = fakeIndexedDB();
  const s2 = store.create({ localStorage: new FakeStorage(), indexedDB: idb2 });
  await s2.ready();
  idb2.kill();
  idb2.openFaults = 1000;
  await Promise.all([s2.addRows(sampleRows(0, ['Ana'])), s2.addRows(sampleRows(1, ['Ben'])), s2.nextPhotoIndex()]);
  assert.equal(s2.memoryReason, 'lost');
  assert.equal(idb2.opens, 2, 'the three calls shared one reopen');
  assert.deepEqual(await studentNames(s2), ['Ana', 'Ben']);
  assert.equal(await s2.getPhotoCount(), 2);
});

// After a loss, Done reaches the rows saved before it, or is told it could not.

test('after a loss, allRows and clearResults reach the rows saved before it once IndexedDB opens again', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  assert.equal(s.earlierRowsUnread, false);

  idb.kill();
  idb.openFaults = 2; // the reopen fails, and so does allRows's first fresh try
  await s.addRows(sampleRows(1, ['Cy']));
  assert.equal(s.memoryReason, 'lost');
  assert.equal(s.earlierRowsUnread, true);
  assert.deepEqual(await studentNames(s), ['Cy'], 'IndexedDB still refuses: the memory rows alone');
  assert.equal(s.earlierRowsUnread, true);

  // IndexedDB opens again: the rows saved before the loss come back beside the memory rows.
  assert.deepEqual(await studentNames(s), ['Ana', 'Ben', 'Cy']);
  assert.equal(s.earlierRowsUnread, false);
  assert.equal(s.memoryReason, 'lost', 'writes stay in memory');

  // A row rewritten after the loss (a regrade) lands in memory and replaces its stored copy.
  await s.addRows([Object.assign(sampleRows(0, ['Ana'])[0], { score: 2 })]);
  const rows = await s.allRows();
  assert.deepEqual(rows.map((r) => r.id), ['p0-s0', 'p0-s1', 'p1-s0']);
  assert.equal(rows[0].score, 2);
  assert.equal(await s.nextPhotoIndex(), 2, 'no photo index in the list is handed out again');

  assert.deepEqual(await s.clearResults(), { diskCleared: true });
  assert.deepEqual(await s.allRows(), []);
  assert.equal(await s.getPhotoCount(), 0);
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await reloaded.allRows(), [], 'nothing comes back on the next page load');
  assert.equal(await reloaded.getPhotoCount(), 0);
});

test('after a loss, when IndexedDB still will not open, the wipe keeps the rows saved before it and says so', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  idb.kill();
  idb.openFaults = 1000;
  await s.addRows(sampleRows(1, ['Cy']));
  assert.deepEqual(await studentNames(s), ['Cy']);
  assert.equal(s.earlierRowsUnread, true);

  assert.deepEqual(await s.wipeAfterDownload(), { diskCleared: false });
  assert.deepEqual(await s.allRows(), []);
  assert.equal(await s.nextPhotoIndex(), 2, 'new photos stay above the rows still stored');

  idb.openFaults = 0; // the next page load, with IndexedDB back
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await studentNames(reloaded), ['Ana', 'Ben']);
  assert.equal(reloaded.memoryReason, null);
});

test('clearResults never clears rows saved before a loss that the last allRows could not read', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  idb.kill();
  idb.openFaults = 2; // the reopen fails, and so does allRows's fresh try
  await s.addRows(sampleRows(1, ['Cy']));
  assert.deepEqual(await studentNames(s), ['Cy'], 'what Done puts in the spreadsheet');

  // IndexedDB would open now, but Ana and Ben reached no spreadsheet.
  assert.deepEqual(await s.clearResults(), { diskCleared: false });
  assert.equal(s.earlierRowsUnread, true);
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await studentNames(reloaded), ['Ana', 'Ben']);
});

// The in-flight marker set before a loss mid-photo is still in IndexedDB,
// naming a photo whose slips all went to memory.

test('after a loss mid-photo, clearInFlight also clears the marker set before it once IndexedDB opens', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana']));
  const photoIndex = await s.nextPhotoIndex();
  await s.setInFlight({ photoIndex, total: 3, done: 0 });

  idb.kill();
  idb.openFaults = 1000; // every slip of the photo lands in memory
  for (const [i, row] of sampleRows(photoIndex, ['Cy', 'Dee', 'Eli']).entries()) {
    await s.addRows([row]);
    await s.setInFlight({ photoIndex, total: 3, done: i + 1 });
  }
  assert.equal(s.memoryReason, 'lost');

  idb.openFaults = 0; // IndexedDB opens again as the photo ends
  await s.clearInFlight();
  assert.equal(await s.getInFlight(), null);
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.equal(await reloaded.getInFlight(), null, 'the next page load does not call the photo interrupted');
  assert.deepEqual(await studentNames(reloaded), ['Ana']);
});

test('after a loss mid-photo, the wipe clears the marker set before it even when it keeps the rows it could not read', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana']));
  const photoIndex = await s.nextPhotoIndex();
  await s.setInFlight({ photoIndex, total: 3, done: 0 });

  idb.kill();
  idb.openFaults = 1000;
  await s.addRows(sampleRows(photoIndex, ['Cy', 'Dee', 'Eli']));
  await s.clearInFlight(); // resolves, though IndexedDB still refuses
  assert.deepEqual(await studentNames(s), ['Cy', 'Dee', 'Eli'], 'what Done puts in the spreadsheet');
  assert.equal(s.earlierRowsUnread, true);

  idb.openFaults = 0; // IndexedDB opens again between the download and the wipe
  assert.deepEqual(await s.wipeAfterDownload(), { diskCleared: false });
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await studentNames(reloaded), ['Ana'], 'rows that reached no spreadsheet are kept');
  assert.equal(await reloaded.getInFlight(), null, 'the photo the spreadsheet holds is not called interrupted');

  // Straight clearResults does the same.
  const idb2 = fakeIndexedDB();
  const s2 = store.create({ localStorage: new FakeStorage(), indexedDB: idb2 });
  await s2.setInFlight({ photoIndex: await s2.nextPhotoIndex(), total: 2, done: 0 });
  idb2.kill();
  idb2.openFaults = 1000;
  await s2.addRows(sampleRows(0, ['Fay', 'Gus']));
  await s2.allRows();
  idb2.openFaults = 0;
  assert.deepEqual(await s2.clearResults(), { diskCleared: false });
  assert.equal(await store.create({ localStorage: new FakeStorage(), indexedDB: idb2 }).getInFlight(), null);
});

test('after a loss, when IndexedDB never opens again, clearInFlight and the wipe still resolve', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.setInFlight({ photoIndex: await s.nextPhotoIndex(), total: 2, done: 0 });
  idb.kill();
  idb.openFaults = 1000;
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  await s.clearInFlight();
  assert.equal(await s.getInFlight(), null);
  assert.deepEqual(await s.wipeAfterDownload(), { diskCleared: false });
  idb.openFaults = 0;
  // The marker could not be reached, so it is still stored: the page's own
  // check on load weighs it against the photo's stored rows.
  assert.deepEqual(await store.create({ localStorage: new FakeStorage(), indexedDB: idb }).getInFlight(),
    { photoIndex: 0, total: 2, done: 0 });
});

test('after a loss, removePhoto also removes that photo\'s rows saved before it', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.addRows(sampleRows(0, ['Ana', 'Ben']));
  await s.addRows(sampleRows(1, ['Cy']));
  idb.kill();
  idb.openFaults = 1;
  await s.addRows(sampleRows(2, ['Dee']));
  assert.deepEqual(await studentNames(s), ['Ana', 'Ben', 'Cy', 'Dee']);

  assert.equal(await s.removePhoto(0), 2);
  assert.deepEqual(await studentNames(s), ['Cy', 'Dee']);
  const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  assert.deepEqual(await studentNames(reloaded), ['Cy']);
});

test('a loss right after a reload never hands out the photo index of a listed row', async () => {
  const idb = fakeIndexedDB();
  const first = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await first.addRows(sampleRows(0, ['Ana']));
  await first.addRows(sampleRows(1, ['Ben']));

  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb }); // the reload
  assert.deepEqual(await studentNames(s), ['Ana', 'Ben']);
  idb.kill();
  idb.openFaults = 1;
  assert.equal(await s.nextPhotoIndex(), 2, 'photos 1 and 2 are listed, so the new one is photo 3');
  await s.addRows(sampleRows(2, ['Cy']));
  assert.deepEqual(await studentNames(s), ['Ana', 'Ben', 'Cy']);
});

test('an IndexedDB error that is not a lost connection is not retried', async () => {
  const idb = fakeIndexedDB();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
  await s.ready();
  idb.txFaults.push('QuotaExceededError');
  await assert.rejects(s.addRows(sampleRows(0, ['Ana'])), { name: 'QuotaExceededError' });
  assert.equal(idb.opens, 1);
  assert.equal(s.memoryOnly, false);
  assert.deepEqual(await s.allRows(), []);
});

// Unconfirmed results expire: lastPhotoAt and expireIfStale.

test('lastPhotoAt: every stored slip records it; a regrade, an empty addRows and the marker leave it', async () => {
  for (const kind of BACKENDS) {
    const clock = manualClock(T0);
    const { s, idb } = await storeOn(kind, clock);
    assert.equal(await s.getLastPhotoAt(), null, kind);

    const slips = sampleRows(0, ['Ana', 'Ben']);
    await s.addRows([slips[0]]);
    assert.equal(await s.getLastPhotoAt(), T0, kind);
    clock.t = T0 + 5000;
    await s.addRows([slips[1]]);
    assert.equal(await s.getLastPhotoAt(), T0 + 5000, kind + ': the last saved slip');

    clock.t = T0 + HOUR;
    await s.addRows([]);
    await s.addRows([Object.assign({}, slips[0], { score: 2 })], { regrade: true });
    await s.setInFlight({ photoIndex: 0, total: 2, done: 2 });
    await s.nextPhotoIndex();
    await s.clearInFlight();
    await s.removePhoto(7);
    assert.equal(await s.getLastPhotoAt(), T0 + 5000, kind + ': no slip from a photo was stored');
    assert.equal((await s.allRows())[0].score, 2, kind + ': the regrade itself landed');

    if (kind === 'indexeddb') {
      assert.deepEqual(storedLastPhoto(idb), { id: 'lastPhoto', lastPhotoAt: T0 + 5000 }, 'one number, nothing else');
      const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
      assert.equal(await reloaded.getLastPhotoAt(), T0 + 5000, 'a reload keeps it');
    }
    if (kind === 'lost') {
      assert.equal(storedLastPhoto(idb), undefined, 'after the loss it is kept in memory, beside the rows');
    }
  }
});

test('clearResults and wipeAfterDownload clear lastPhotoAt', async () => {
  for (const kind of BACKENDS) {
    for (const clear of ['clearResults', 'wipeAfterDownload']) {
      const label = kind + ', ' + clear;
      const clock = manualClock(T0);
      const { s, idb } = await storeOn(kind, clock);
      await s.addRows(sampleRows(0, ['Ana']));
      assert.equal(await s.getLastPhotoAt(), T0, label);
      await s[clear]();
      assert.equal(await s.getLastPhotoAt(), null, label);
      if (idb) {
        assert.equal(storedLastPhoto(idb), undefined, label);
        const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
        assert.equal(await reloaded.getLastPhotoAt(), null, label + ': nothing comes back on the next page load');
      }
    }
  }
});

test('expireIfStale: exactly maxAgeMs after the last stored slip clears the results; one ms less does not', async () => {
  for (const kind of BACKENDS) {
    const clock = manualClock(T0);
    const { s, idb } = await storeOn(kind, clock);
    await s.addRows(sampleRows(0, ['Ana', 'Ben']));
    clock.t = T0 + 60000;
    await s.addRows(sampleRows(1, ['Cy']));
    await s.setInFlight({ photoIndex: 1, total: 2, done: 1 });
    const last = T0 + 60000;

    assert.deepEqual(await s.expireIfStale({ now: T0 + DAY, maxAgeMs: DAY }), { expired: false, rows: 3 },
      kind + ': the first photo is a day old, the last one is not');
    assert.deepEqual(await s.expireIfStale({ now: last + DAY - 1, maxAgeMs: DAY }), { expired: false, rows: 3 },
      kind + ': one ms short of a day');
    assert.deepEqual(await studentNames(s), ['Ana', 'Ben', 'Cy'], kind);
    assert.equal(await s.getLastPhotoAt(), last, kind + ': a check that does not expire changes nothing');
    assert.deepEqual(await s.getInFlight(), { photoIndex: 1, total: 2, done: 1 }, kind);

    assert.deepEqual(await s.expireIfStale({ now: last + DAY, maxAgeMs: DAY }), { expired: true, rows: 3 },
      kind + ': exactly a day');
    assert.deepEqual(await s.allRows(), [], kind);
    assert.equal(await s.getPhotoCount(), 0, kind);
    assert.equal(await s.getInFlight(), null, kind + ': the in-flight marker goes too, as with clearResults');
    assert.equal(await s.getLastPhotoAt(), null, kind);
    assert.deepEqual(await s.expireIfStale({ now: last + 2 * DAY, maxAgeMs: DAY }), { expired: false, rows: 0 },
      kind + ': nothing left to expire');

    if (idb) {
      const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
      assert.deepEqual(await reloaded.allRows(), [], kind + ': nothing comes back on the next page load');
      assert.equal(await reloaded.getInFlight(), null, kind);
    }
  }
});

test('expireIfStale with no rows does nothing', async () => {
  for (const kind of BACKENDS) {
    const clock = manualClock(T0);
    const { s, idb } = await storeOn(kind, clock);
    await s.setInFlight({ photoIndex: await s.nextPhotoIndex(), total: 3, done: 0 });
    assert.deepEqual(await s.expireIfStale({ now: T0 + 30 * DAY, maxAgeMs: DAY }), { expired: false, rows: 0 }, kind);
    assert.equal(await s.getLastPhotoAt(), null, kind + ': no clock starts for no rows');
    assert.deepEqual(await s.getInFlight(), { photoIndex: 0, total: 3, done: 0 }, kind);
    assert.equal(await s.getPhotoCount(), 1, kind);
    if (idb) assert.equal(storedLastPhoto(idb), undefined, kind);
  }
});

test('rows with no lastPhotoAt start their clock the first time expireIfStale sees them', async () => {
  for (const kind of BACKENDS) {
    const clock = manualClock(T0);
    let { s, idb } = await storeOn(kind, clock);
    if (kind === 'indexeddb') {
      // A database the page stored before lastPhotoAt was kept, opened by this version.
      await s.addRows(sampleRows(0, ['Ana', 'Ben']));
      forgetLastPhotoAt(idb);
      s = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
    } else {
      // A regrade is the one write that stores rows without recording a time.
      await s.addRows(sampleRows(0, ['Ana', 'Ben']), { regrade: true });
    }
    assert.equal(await s.getLastPhotoAt(), null, kind);

    const seen = T0 + 400 * DAY; // long after the rows were stored
    assert.deepEqual(await s.expireIfStale({ now: seen, maxAgeMs: DAY }), { expired: false, rows: 2 },
      kind + ': not expired the first time they are seen');
    assert.equal(await s.getLastPhotoAt(), seen, kind + ': that moment is their start');
    assert.deepEqual(await s.expireIfStale({ now: seen + DAY - 1, maxAgeMs: DAY }), { expired: false, rows: 2 }, kind);
    assert.equal(await s.getLastPhotoAt(), seen, kind + ': a later check does not move the start');
    if (kind === 'indexeddb') {
      const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
      assert.equal(await reloaded.getLastPhotoAt(), seen, 'the start is stored, so a reload does not restart it');
    }
    assert.deepEqual(await s.expireIfStale({ now: seen + DAY, maxAgeMs: DAY }), { expired: true, rows: 2 }, kind);
    assert.deepEqual(await s.allRows(), [], kind);
  }
});

test('settings survive an expiry: key, model, vision cache, answer key and review', async () => {
  for (const kind of BACKENDS) {
    const clock = manualClock(T0);
    const ls = new FakeStorage([['other.app', 'left alone']]);
    const { s } = await storeOn(kind, clock, ls);
    s.setKey('groq', 'test-key-not-real');
    s.setModel('groq', 'vision-model-x');
    s.visionCache('groq').set('vision-model-x', { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' });
    s.setAnswerKey(sampleKey());
    s.setSetting('review', { mode: 'reserved' });
    await s.addRows(sampleRows(0, ['Ana', 'Ben']));
    const before = Array.from(ls.map.entries());
    const writes = ls.writes.length;

    assert.deepEqual(await s.expireIfStale({ now: T0 + DAY, maxAgeMs: DAY }), { expired: true, rows: 2 }, kind);
    assert.deepEqual(await s.allRows(), [], kind);
    assert.deepEqual(Array.from(ls.map.entries()), before, kind + ': localStorage is untouched');
    assert.equal(ls.writes.length, writes, kind);
    assert.equal(s.getKey('groq'), 'test-key-not-real', kind);
    assert.equal(s.getModel('groq'), 'vision-model-x', kind);
    assert.deepEqual(s.visionCache('groq').get('vision-model-x'), { vision: true, checkedAt: '2026-09-24T00:00:00.000Z' }, kind);
    assert.deepEqual(s.getAnswerKey(), sampleKey(), kind);
    assert.deepEqual(s.getSetting('review'), { mode: 'reserved' }, kind);
    assert.equal(s.storageWarning, false, kind);
  }
});

test('after a loss, expiry lists the rows saved before it and after it, and goes by the latest slip of either', async () => {
  // Rows from before the loss in IndexedDB, a later slip in memory.
  {
    const clock = manualClock(T0);
    const idb = fakeIndexedDB();
    const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
    await s.addRows(sampleRows(0, ['Ana', 'Ben']));
    idb.kill();
    idb.openFaults = 1;
    clock.t = T0 + HOUR;
    await s.addRows(sampleRows(1, ['Cy']));
    assert.equal(s.memoryReason, 'lost');
    assert.equal(await s.getLastPhotoAt(), T0 + HOUR);
    assert.deepEqual(await s.expireIfStale({ now: T0 + HOUR + DAY - 1, maxAgeMs: DAY }), { expired: false, rows: 3 });
    assert.deepEqual(await s.expireIfStale({ now: T0 + HOUR + DAY, maxAgeMs: DAY }), { expired: true, rows: 3 });
    assert.deepEqual(await s.allRows(), []);
    const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
    assert.deepEqual(await reloaded.allRows(), [], 'the rows saved before the loss are cleared too');
    assert.equal(await reloaded.getLastPhotoAt(), null);
  }
  // A loss with no slip after it: the time stored before it counts.
  {
    const clock = manualClock(T0);
    const idb = fakeIndexedDB();
    const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
    await s.addRows(sampleRows(0, ['Ana', 'Ben']));
    idb.kill();
    idb.openFaults = 1;
    await s.getPhotoCount();
    assert.equal(s.memoryReason, 'lost');
    assert.equal(await s.getLastPhotoAt(), T0);
    assert.deepEqual(await s.expireIfStale({ now: T0 + DAY - 1, maxAgeMs: DAY }), { expired: false, rows: 2 });
    assert.deepEqual(await s.expireIfStale({ now: T0 + DAY, maxAgeMs: DAY }), { expired: true, rows: 2 });
    const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
    assert.deepEqual(await reloaded.allRows(), []);
  }
  // IndexedDB never opens again: the slips in memory expire now, and the rows
  // saved before the loss, which no list could read, are kept as clearResults
  // keeps them and expire by their own time on the next page load.
  {
    const clock = manualClock(T0);
    const idb = fakeIndexedDB();
    const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
    await s.addRows(sampleRows(0, ['Ana', 'Ben']));
    idb.kill();
    idb.openFaults = 1000;
    clock.t = T0 + HOUR;
    await s.addRows(sampleRows(1, ['Cy']));
    assert.deepEqual(await s.expireIfStale({ now: T0 + HOUR + DAY, maxAgeMs: DAY }), { expired: true, rows: 1 });
    assert.deepEqual(await s.allRows(), []);
    assert.equal(s.earlierRowsUnread, true);

    idb.openFaults = 0; // the next page load, with IndexedDB back
    const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
    assert.deepEqual(await studentNames(reloaded), ['Ana', 'Ben']);
    assert.deepEqual(await reloaded.expireIfStale({ now: T0 + DAY, maxAgeMs: DAY }), { expired: true, rows: 2 });
    assert.deepEqual(await reloaded.allRows(), []);
  }
  // Rows stored before lastPhotoAt was kept, then a loss: their clock starts in memory.
  {
    const clock = manualClock(T0);
    const idb = fakeIndexedDB();
    const s = store.create({ localStorage: new FakeStorage(), indexedDB: idb, now: clock.now });
    await s.addRows(sampleRows(0, ['Ana']));
    forgetLastPhotoAt(idb);
    idb.kill();
    idb.openFaults = 1;
    await s.getPhotoCount();
    assert.equal(s.memoryReason, 'lost');
    const seen = T0 + 400 * DAY;
    assert.deepEqual(await s.expireIfStale({ now: seen, maxAgeMs: DAY }), { expired: false, rows: 1 });
    assert.equal(await s.getLastPhotoAt(), seen);
    assert.deepEqual(await s.expireIfStale({ now: seen + DAY, maxAgeMs: DAY }), { expired: true, rows: 1 });
    const reloaded = store.create({ localStorage: new FakeStorage(), indexedDB: idb });
    assert.deepEqual(await reloaded.allRows(), []);
  }
});

test('expireIfStale refuses a bad maxAgeMs or now; now defaults to the store clock', async () => {
  const clock = manualClock(T0);
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null, now: clock.now });
  await s.addRows(sampleRows(0, ['Ana']));
  const bad = [
    undefined, {}, { maxAgeMs: -1 }, { maxAgeMs: NaN }, { maxAgeMs: '86400000' }, { maxAgeMs: Infinity },
    { now: NaN, maxAgeMs: DAY }, { now: String(T0 + DAY), maxAgeMs: DAY }, { now: null, maxAgeMs: DAY }
  ];
  for (const opts of bad) await assert.rejects(s.expireIfStale(opts), TypeError, String(JSON.stringify(opts)));
  assert.deepEqual(await studentNames(s), ['Ana'], 'a refused call clears nothing');

  clock.t = T0 + DAY - 1;
  assert.deepEqual(await s.expireIfStale({ maxAgeMs: DAY }), { expired: false, rows: 1 });
  clock.t = T0 + DAY;
  assert.deepEqual(await s.expireIfStale({ maxAgeMs: DAY }), { expired: true, rows: 1 });
});

test('the store clock: create\'s now, else the page\'s test hook, else Date.now()', async () => {
  const before = Date.now();
  const s = store.create({ localStorage: new FakeStorage(), indexedDB: null });
  await s.addRows(sampleRows(0, ['Ana']));
  const at = await s.getLastPhotoAt();
  assert.ok(at >= before && at <= Date.now(), 'Date.now() when no clock is given');

  const odd = store.create({ localStorage: new FakeStorage(), indexedDB: null, now: () => 'soon' });
  await odd.addRows(sampleRows(0, ['Ana']));
  const oddAt = await odd.getLastPhotoAt();
  assert.ok(oddAt >= before && oddAt <= Date.now(), 'a clock that gives no number falls back to Date.now()');

  // store.js loaded the way a browser loads it, on a page whose test hook
  // defines a clock before any script runs. Objects from that page are
  // compared field by field, since they come from another realm.
  const page = { __TABOT_TEST__: { now: () => T0 } };
  vm.runInNewContext(STORE_SOURCE, { self: page });
  const pageStore = page.TABot.store;
  await pageStore.addRows(sampleRows(0, ['Ana']));
  assert.equal(await pageStore.getLastPhotoAt(), T0);
  page.__TABOT_TEST__.now = () => T0 + DAY - 1;
  assert.equal((await pageStore.expireIfStale({ maxAgeMs: DAY })).expired, false);
  page.__TABOT_TEST__.now = () => T0 + DAY;
  const result = await pageStore.expireIfStale({ maxAgeMs: DAY });
  assert.equal(result.expired, true, 'the hook is read at each call');
  assert.equal(result.rows, 1);
  assert.equal((await pageStore.allRows()).length, 0);
});

test('module export is a usable default store plus create()', () => {
  assert.equal(typeof store.create, 'function');
  assert.equal(store.PREFIX, 'tabot.');
  assert.equal(store.DB_NAME, 'tabot');
  for (const fn of ['getKey', 'setKey', 'getModel', 'setModel', 'getAnswerKey', 'setAnswerKey', 'visionCache',
    'addRows', 'allRows', 'removePhoto', 'clearResults', 'wipeAfterDownload', 'ready', 'nextPhotoIndex',
    'setInFlight', 'getInFlight', 'clearInFlight', 'getLastPhotoAt', 'expireIfStale']) {
    assert.equal(typeof store[fn], 'function', fn);
  }
  for (const flag of ['storageWarning', 'memoryOnly', 'memoryReason', 'settingsMemoryOnly', 'fileMode', 'earlierRowsUnread']) {
    assert.ok(flag in store, flag);
  }
  // Under node there is no location: the default store is not in file mode.
  assert.equal(store.fileMode, false);
});
