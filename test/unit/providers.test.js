'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const providers = require('../../js/providers/index.js');
const groq = require('../../js/providers/groq.js');

const KEY = 'gsk_FAKE_unit_test_key_1111111111';
const PROBE = 'data:image/jpeg;base64,/9j/FAKEPROBE';
const FIXED_NOW = () => new Date('2026-09-24T12:00:00.000Z');
const GROQ_JS = path.join(__dirname, '../../js/providers/groq.js');
const INDEX_JS = path.join(__dirname, '../../js/providers/index.js');

function statusError(status, message) {
  const err = new Error(message || 'HTTP ' + status);
  err.status = status;
  return err;
}

// A stand-in provider: listModels returns the given ids; probeVision answers
// from verdicts[id], which is true, false, or an Error to throw. It records
// every probe and the most probes ever running at once.
function fakeProvider(ids, verdicts) {
  const probes = [];
  let running = 0;
  let peak = 0;
  return {
    id: 'fake',
    probes,
    peak: () => peak,
    listed: [],
    async listModels(args) {
      this.listed.push(args);
      return ids.map((id) => ({ id, active: true, contextWindow: null }));
    },
    async probeVision(args) {
      probes.push(args);
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setImmediate(r));
      running--;
      const verdict = verdicts[args.model];
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }
  };
}

test('registry: get and list', () => {
  assert.equal(providers.get('groq'), groq);
  assert.equal(providers.groq, groq);
  assert.equal(providers.get('claude'), null);
  assert.equal(providers.get('toString'), null);
  assert.deepEqual(providers.list().map((p) => p.id), ['groq']);
  providers.list().push('junk');
  assert.equal(providers.list().length, 1, 'list() hands out a copy');
});

test('browser: groq.js registers TABot.providerGroq and index.js assembles TABot.providers', () => {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GROQ_JS, 'utf8'), sandbox, { filename: GROQ_JS });
  vm.runInContext(fs.readFileSync(INDEX_JS, 'utf8'), sandbox, { filename: INDEX_JS });
  const TABot = sandbox.TABot;
  assert.equal(TABot.providerGroq.id, 'groq');
  assert.equal(TABot.providers.groq, TABot.providerGroq);
  assert.equal(TABot.providers.get('groq'), TABot.providerGroq);
  assert.equal(typeof TABot.providers.resolveVisionModels, 'function');
});

test('browser: index.js loaded before groq.js fails loudly', () => {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  assert.throws(
    () => vm.runInContext(fs.readFileSync(INDEX_JS, 'utf8'), sandbox, { filename: INDEX_JS }),
    /js\/providers\/groq\.js must load before js\/providers\/index\.js/
  );
});

test('browser: makeProbeImage draws a 64x64 gray JPEG with a dark diagonal', () => {
  const drawn = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, {
      set: (target, prop, value) => { drawn.push([prop, value]); return true; },
      get: (target, prop) => (...args) => drawn.push([prop, ...args])
    }),
    toDataURL: (type, quality) => {
      drawn.push(['toDataURL', type, quality, canvas.width, canvas.height]);
      return 'data:image/jpeg;base64,/9j/PROBE';
    }
  };
  const sandbox = { document: { createElement: (tag) => { assert.equal(tag, 'canvas'); return canvas; } } };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GROQ_JS, 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(INDEX_JS, 'utf8'), sandbox);
  assert.equal(sandbox.TABot.providers.makeProbeImage(), 'data:image/jpeg;base64,/9j/PROBE');
  assert.deepEqual(drawn, [
    ['fillStyle', '#808080'],
    ['fillRect', 0, 0, 64, 64],
    ['strokeStyle', '#202020'],
    ['lineWidth', 4],
    ['beginPath'],
    ['moveTo', 0, 0],
    ['lineTo', 64, 64],
    ['stroke'],
    ['toDataURL', 'image/jpeg', 0.9, 64, 64]
  ]);
  assert.equal(canvas.width, 0, 'canvas released');
  assert.equal(canvas.height, 0, 'canvas released');
});

test('makeProbeImage refuses outside the browser', () => {
  assert.throws(() => providers.makeProbeImage(), /pass probeImage/);
});

test('resolveVisionModels: probes each uncached model once, in order, one at a time', async () => {
  const p = fakeProvider(['m-c', 'm-a', 'm-b'], { 'm-a': true, 'm-b': false, 'm-c': true });
  const cache = {};
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, fetch: 'FETCH', cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(out, { visionModels: ['m-a', 'm-c'], probed: 3, unknown: [] });
  assert.deepEqual(p.probes.map((a) => a.model), ['m-a', 'm-b', 'm-c']);
  assert.equal(p.peak(), 1, 'probing is sequential');
  for (const args of p.probes) {
    assert.equal(args.key, KEY);
    assert.equal(args.fetch, 'FETCH');
    assert.equal(args.probeImage, PROBE);
  }
  assert.deepEqual(p.listed, [{ key: KEY, fetch: 'FETCH' }]);
  assert.deepEqual(cache, {
    'm-a': { vision: true, checkedAt: '2026-09-24T12:00:00.000Z' },
    'm-b': { vision: false, checkedAt: '2026-09-24T12:00:00.000Z' },
    'm-c': { vision: true, checkedAt: '2026-09-24T12:00:00.000Z' }
  });
});

test('resolveVisionModels: cached verdicts are trusted and not probed again', async () => {
  const p = fakeProvider(['m-a', 'm-b', 'm-new'], { 'm-new': true });
  const cache = {
    'm-a': { vision: true, checkedAt: '2026-09-01T00:00:00.000Z' },
    'm-b': { vision: false, checkedAt: '2026-09-01T00:00:00.000Z' },
    'm-gone': { vision: true, checkedAt: '2026-09-01T00:00:00.000Z' }
  };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(out, { visionModels: ['m-a', 'm-new'], probed: 1, unknown: [] });
  assert.deepEqual(p.probes.map((a) => a.model), ['m-new']);
  assert.equal(cache['m-a'].checkedAt, '2026-09-01T00:00:00.000Z', 'old verdicts untouched');
  assert.ok(!out.visionModels.includes('m-gone'), 'an unlisted model is never offered');
});

test('resolveVisionModels: a fully cached run needs no probe image and makes no probe', async () => {
  const p = fakeProvider(['m-a'], {});
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache: { 'm-a': { vision: true, checkedAt: 'x' } } });
  assert.deepEqual(out, { visionModels: ['m-a'], probed: 0, unknown: [] });
  assert.equal(p.probes.length, 0);
});

test('resolveVisionModels: retryable and unexpected errors leave the model unknown and uncached', async () => {
  const p = fakeProvider(['m-a', 'm-b', 'm-c', 'm-d'], {
    'm-a': statusError(429),
    'm-b': true,
    'm-c': statusError(0),
    'm-d': statusError(403)
  });
  const cache = {};
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(out, { visionModels: ['m-b'], probed: 4, unknown: ['m-a', 'm-c', 'm-d'] });
  assert.deepEqual(Object.keys(cache), ['m-b']);

  // The next check probes only the unknown ones again.
  const again = fakeProvider(['m-a', 'm-b', 'm-c', 'm-d'], { 'm-a': true, 'm-c': false, 'm-d': false });
  const out2 = await providers.resolveVisionModels({ provider: again, key: KEY, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(again.probes.map((a) => a.model), ['m-a', 'm-c', 'm-d']);
  assert.deepEqual(out2, { visionModels: ['m-a', 'm-b'], probed: 3, unknown: [] });
});

test('resolveVisionModels: a 401 stops the check and rejects', async () => {
  const p = fakeProvider(['m-a', 'm-b'], { 'm-a': statusError(401, 'Invalid API Key') });
  const cache = {};
  await assert.rejects(
    providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE }),
    (err) => err.status === 401
  );
  assert.deepEqual(p.probes.map((a) => a.model), ['m-a'], 'no probe after the 401');
  assert.deepEqual(cache, {});
});

test('resolveVisionModels: an error with no status is a bug and is thrown', async () => {
  const p = fakeProvider(['m-a'], { 'm-a': new TypeError('oops') });
  await assert.rejects(providers.resolveVisionModels({ provider: p, key: KEY, probeImage: PROBE }), TypeError);
});

test('resolveVisionModels: a listModels failure rejects', async () => {
  const p = fakeProvider([], {});
  p.listModels = async () => { throw statusError(401, 'Invalid API Key'); };
  await assert.rejects(providers.resolveVisionModels({ provider: p, key: KEY, probeImage: PROBE }), (err) => err.status === 401);
});

test('resolveVisionModels: needs a probe image in node when something must be probed', async () => {
  const p = fakeProvider(['m-a'], { 'm-a': true });
  await assert.rejects(providers.resolveVisionModels({ provider: p, key: KEY, cache: {} }), /pass probeImage/);
});

test('resolveVisionModels: a cache with get/set (a Map) works and each verdict lands as it is made', async () => {
  const p = fakeProvider(['m-a', 'm-b'], { 'm-a': true, 'm-b': false });
  const writes = [];
  const map = new Map([['m-z', { vision: true, checkedAt: 'x' }]]);
  const cache = { get: (id) => map.get(id), set: (id, v) => { writes.push(id); map.set(id, v); } };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(out.visionModels, ['m-a']);
  assert.deepEqual(writes, ['m-a', 'm-b']);
  assert.deepEqual(map.get('m-b'), { vision: false, checkedAt: '2026-09-24T12:00:00.000Z' });
});

test('resolveVisionModels: progress reports every model, cached or probed', async () => {
  const p = fakeProvider(['m-a', 'm-b', 'm-c'], { 'm-b': true, 'm-c': statusError(503) });
  const progress = [];
  await providers.resolveVisionModels({
    provider: p, key: KEY, probeImage: PROBE,
    cache: { 'm-a': { vision: false, checkedAt: 'x' } },
    onProgress: (done, total) => progress.push(`${done}/${total}`)
  });
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
});

test('resolveVisionModels: accepts a provider id and runs the real Groq adapter end to end', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [
        { id: 'text-model', active: true, context_window: 131072 },
        { id: 'vision-model', active: true, context_window: 131072 },
        { id: 'retired-model', active: false }
      ] }), { status: 200 });
    }
    const model = JSON.parse(init.body).model;
    if (model === 'vision-model') {
      return new Response(JSON.stringify({ model, choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'messages[0].content must be a string', type: 'invalid_request_error' } }), { status: 400 });
  };
  const cache = {};
  const out = await providers.resolveVisionModels({ provider: 'groq', key: KEY, fetch, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(out, { visionModels: ['vision-model'], probed: 2, unknown: [] });
  assert.deepEqual(Object.keys(cache).sort(), ['text-model', 'vision-model']);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(!call.url.includes(KEY));
    assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
  }
});

test('resolveVisionModels: an unknown provider id is a TypeError', async () => {
  await assert.rejects(providers.resolveVisionModels({ provider: 'nope', key: KEY }), TypeError);
});

test('rankModels: chosen first, the rest ascending', () => {
  assert.deepEqual(providers.rankModels(['m-c', 'm-a', 'm-b'], 'm-b'), ['m-b', 'm-a', 'm-c']);
  assert.deepEqual(providers.rankModels(['m-c', 'm-a'], 'm-a'), ['m-a', 'm-c']);
});

test('rankModels: a chosen model that is no longer a vision model is dropped', () => {
  assert.deepEqual(providers.rankModels(['m-c', 'm-a'], 'm-gone'), ['m-a', 'm-c']);
  assert.deepEqual(providers.rankModels(['m-c', 'm-a'], null), ['m-a', 'm-c']);
});

test('rankModels: one model, none, repeats, and input left untouched', () => {
  assert.deepEqual(providers.rankModels(['only'], 'only'), ['only']);
  assert.deepEqual(providers.rankModels([], 'x'), []);
  assert.deepEqual(providers.rankModels(undefined, 'x'), []);
  const input = ['m-b', 'm-a', 'm-b'];
  assert.deepEqual(providers.rankModels(input, 'm-b'), ['m-b', 'm-a']);
  assert.deepEqual(input, ['m-b', 'm-a', 'm-b']);
});

test('rankModels: ascending order is by code point, not locale', () => {
  assert.deepEqual(providers.rankModels(['b', 'B', 'a', 'A'], null), ['A', 'B', 'a', 'b']);
});

// --- a false verdict is not forever; retired models leave the cache ---

const OLD = '2026-09-01T00:00:00.000Z';

test('resolveVisionModels: a cached id missing from the fresh list is deleted (plain object cache)', async () => {
  const p = fakeProvider(['m-a'], {});
  const cache = {
    'm-a': { vision: true, checkedAt: OLD },
    'm-gone': { vision: true, checkedAt: OLD },
    'm-gone-too': { vision: false, checkedAt: OLD }
  };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache });
  assert.deepEqual(out, { visionModels: ['m-a'], probed: 0, unknown: [] });
  assert.deepEqual(Object.keys(cache), ['m-a']);
});

test('resolveVisionModels: pruning works on a Map cache', async () => {
  const p = fakeProvider(['m-a'], {});
  const cache = new Map([['m-a', { vision: true, checkedAt: OLD }], ['m-gone', { vision: true, checkedAt: OLD }]]);
  await providers.resolveVisionModels({ provider: p, key: KEY, cache });
  assert.deepEqual([...cache.keys()], ['m-a']);
});

test('resolveVisionModels: pruning works on the store.js vision cache, which has no delete', async () => {
  const store = require('../../js/store.js');
  const data = new Map();
  const localStorage = {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); }
  };
  const s = store.create({ localStorage, indexedDB: null });
  const cache = s.visionCache('groq');
  cache.set('m-a', { vision: true, checkedAt: OLD });
  cache.set('m-b', { vision: false, checkedAt: OLD });
  cache.set('m-retired', { vision: true, checkedAt: OLD });
  const p = fakeProvider(['m-a', 'm-b'], {});
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache });
  assert.deepEqual(out.visionModels, ['m-a']);
  assert.deepEqual(cache.all(), {
    'm-a': { vision: true, checkedAt: OLD },
    'm-b': { vision: false, checkedAt: OLD }
  });
});

test('resolveVisionModels: a get/set cache that cannot list its ids is left alone', async () => {
  const p = fakeProvider(['m-a'], {});
  const map = new Map([['m-gone', { vision: true, checkedAt: OLD }]]);
  const cache = { get: (id) => map.get(id), set: (id, v) => map.set(id, v) };
  await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.ok(map.has('m-gone'));
});

test('resolveVisionModels: an empty list clears every cached verdict', async () => {
  const p = fakeProvider([], {});
  const cache = { 'm-a': { vision: true, checkedAt: OLD } };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache });
  assert.deepEqual(out, { visionModels: [], probed: 0, unknown: [] });
  assert.deepEqual(cache, {});
});

test('resolveVisionModels: recheck probes every cached false verdict again, and trusts cached true', async () => {
  const p = fakeProvider(['m-a', 'm-b', 'm-c'], { 'm-b': true, 'm-c': false });
  const cache = {
    'm-a': { vision: true, checkedAt: OLD },
    'm-b': { vision: false, checkedAt: OLD },
    'm-c': { vision: false, checkedAt: OLD }
  };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE, now: FIXED_NOW, recheck: true });
  assert.deepEqual(p.probes.map((a) => a.model), ['m-b', 'm-c']);
  assert.deepEqual(out, { visionModels: ['m-a', 'm-b'], probed: 2, unknown: [] });
  assert.deepEqual(cache, {
    'm-a': { vision: true, checkedAt: OLD },
    'm-b': { vision: true, checkedAt: '2026-09-24T12:00:00.000Z' },
    'm-c': { vision: false, checkedAt: '2026-09-24T12:00:00.000Z' }
  });
});

test('resolveVisionModels: without recheck a cached false verdict is not probed', async () => {
  const p = fakeProvider(['m-b'], { 'm-b': true });
  const cache = { 'm-b': { vision: false, checkedAt: OLD } };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE });
  assert.deepEqual(out, { visionModels: [], probed: 0, unknown: [] });
});

test('resolveVisionModels: a recheck whose probe errors keeps the old verdict and reports the id unknown', async () => {
  const p = fakeProvider(['m-b', 'm-c'], { 'm-b': statusError(429), 'm-c': statusError(400, 'terms') });
  const cache = { 'm-b': { vision: false, checkedAt: OLD }, 'm-c': { vision: false, checkedAt: OLD } };
  const out = await providers.resolveVisionModels({ provider: p, key: KEY, cache, probeImage: PROBE, recheck: true });
  assert.deepEqual(out, { visionModels: [], probed: 2, unknown: ['m-b', 'm-c'] });
  assert.deepEqual(cache, { 'm-b': { vision: false, checkedAt: OLD }, 'm-c': { vision: false, checkedAt: OLD } });
});

// The same case on the real adapter: the one vision model's first probe is
// refused for a reason that has nothing to do with images.
function termsThenOk() {
  let termsAccepted = false;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url.endsWith('/models') ? 'list' : JSON.parse(init.body).model);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'vendor/vision-a', active: true }] }), { status: 200 });
    }
    if (!termsAccepted) {
      return new Response(JSON.stringify({ error: {
        message: 'The model `vendor/vision-a` requires terms acceptance. Please have the org admin accept the terms.',
        type: 'invalid_request_error', code: 'model_terms_required'
      } }), { status: 400 });
    }
    return new Response(JSON.stringify({ model: 'vendor/vision-a', choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  };
  return { fetch, calls, accept: () => { termsAccepted = true; } };
}

test('a 400 that does not name images leaves the model unknown, and the next check finds it', async () => {
  const groqSite = termsThenOk();
  const cache = {};
  const check1 = await providers.resolveVisionModels({ provider: 'groq', key: KEY, fetch: groqSite.fetch, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(check1, { visionModels: [], probed: 1, unknown: ['vendor/vision-a'] });
  assert.deepEqual(cache, {}, 'no verdict cached for a refusal unrelated to images');
  groqSite.accept();
  const check2 = await providers.resolveVisionModels({ provider: 'groq', key: KEY, fetch: groqSite.fetch, cache, probeImage: PROBE, now: FIXED_NOW });
  assert.deepEqual(check2, { visionModels: ['vendor/vision-a'], probed: 1, unknown: [] });
  assert.deepEqual(groqSite.calls, ['list', 'vendor/vision-a', 'list', 'vendor/vision-a']);
});

test('a false verdict cached by an older any-400 rule is cleared by an explicit Check key', async () => {
  const groqSite = termsThenOk();
  groqSite.accept();
  const cache = { 'vendor/vision-a': { vision: false, checkedAt: OLD } };
  const out = await providers.resolveVisionModels({
    provider: 'groq', key: KEY, fetch: groqSite.fetch, cache, probeImage: PROBE, now: FIXED_NOW, recheck: true
  });
  assert.deepEqual(out, { visionModels: ['vendor/vision-a'], probed: 1, unknown: [] });
  assert.deepEqual(cache, { 'vendor/vision-a': { vision: true, checkedAt: '2026-09-24T12:00:00.000Z' } });
});

test('resolveVisionModels: a signal is handed to listModels and to every probe', async () => {
  const p = fakeProvider(['m-a'], { 'm-a': true });
  const controller = new AbortController();
  await providers.resolveVisionModels({ provider: p, key: KEY, cache: {}, probeImage: PROBE, signal: controller.signal });
  assert.equal(p.listed[0].signal, controller.signal);
  assert.equal(p.probes[0].signal, controller.signal);
});
