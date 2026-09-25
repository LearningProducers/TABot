'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backoffDelay, createQueue, isRetryableStatus } = require('../../js/queue.js');

function httpError(status) {
  const err = new Error('HTTP ' + status);
  err.status = status;
  return err;
}

// A sleep that resolves at once and remembers every delay it was asked for.
function recordingSleep() {
  const delays = [];
  const sleep = (ms) => { delays.push(ms); return Promise.resolve(); };
  return { sleep, delays };
}

// A task that fails with the given statuses in order, then resolves 'ok'.
function failingThen(statuses) {
  let calls = 0;
  const task = () => {
    const status = statuses[calls];
    calls++;
    return status === undefined ? Promise.resolve('ok') : Promise.reject(httpError(status));
  };
  return { task, calls: () => calls };
}

test('backoffDelay: full jitter is random() times min(cap, base * 2^attempt)', () => {
  assert.equal(backoffDelay(0, { random: () => 0.5 }), 500);
  assert.equal(backoffDelay(1, { random: () => 0.5 }), 1000);
  assert.equal(backoffDelay(3, { random: () => 0.25 }), 2000);
  assert.equal(backoffDelay(2, { baseMs: 10, capMs: 1000, random: () => 1 }), 40);
  // Capped: 1000 * 2^10 is far past the 30000 default cap.
  assert.equal(backoffDelay(10, { random: () => 1 }), 30000);
  assert.equal(backoffDelay(4, { baseMs: 100, capMs: 700, random: () => 0.5 }), 350);
});

test('backoffDelay: lower bound is 0 and every draw stays under the ceiling', () => {
  for (let attempt = 0; attempt <= 12; attempt++) {
    const ceiling = Math.min(30000, 1000 * Math.pow(2, attempt));
    assert.equal(backoffDelay(attempt, { random: () => 0 }), 0);
    const nearTop = backoffDelay(attempt, { random: () => 0.999999 });
    assert.ok(nearTop < ceiling, `attempt ${attempt}: ${nearTop} < ${ceiling}`);
    assert.ok(nearTop > ceiling * 0.999, `attempt ${attempt}: ${nearTop} near ${ceiling}`);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(attempt);
      assert.ok(d >= 0 && d < ceiling, `attempt ${attempt}: ${d} in [0, ${ceiling})`);
    }
  }
});

test('isRetryableStatus: 0, 429 and 5xx only', () => {
  for (const s of [0, 429, 500, 502, 503, 504, 599]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [200, 400, 401, 403, 404, 413, 422, 600, undefined, null, '429']) {
    assert.equal(isRetryableStatus(s), false, String(s));
  }
});

for (const status of [429, 500, 502, 503, 599, 0]) {
  test(`queue retries on status ${status} and sleeps the jittered delay`, async () => {
    const { sleep, delays } = recordingSleep();
    const q = createQueue({ sleep, random: () => 0.5, baseMs: 100, capMs: 10000 });
    const t = failingThen([status, status]);
    const result = await q.run(t.task);
    assert.equal(result, 'ok');
    assert.equal(t.calls(), 3);
    assert.deepEqual(delays, [50, 100]);
  });
}

for (const status of [400, 401, 403, 404, 422]) {
  test(`queue does not retry status ${status}`, async () => {
    const { sleep, delays } = recordingSleep();
    const q = createQueue({ sleep });
    const t = failingThen([status]);
    await assert.rejects(q.run(t.task), (err) => err.status === status);
    assert.equal(t.calls(), 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(q.stats(), { retries429: 0, retriesOther: 0 });
  });
}

test('queue does not retry an error with no status (a bug, not the network)', async () => {
  const { sleep, delays } = recordingSleep();
  const q = createQueue({ sleep });
  let calls = 0;
  await assert.rejects(q.run(() => { calls++; throw new TypeError('boom'); }), TypeError);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('queue gives up after maxAttempts total tries and rejects with the last error', async () => {
  const { sleep, delays } = recordingSleep();
  const q = createQueue({ sleep, maxAttempts: 4, random: () => 1, baseMs: 10, capMs: 1000 });
  let calls = 0;
  const task = () => { calls++; return Promise.reject(httpError(429)); };
  await assert.rejects(q.run(task), (err) => err.status === 429 && err.message === 'HTTP 429');
  assert.equal(calls, 4);
  assert.deepEqual(delays, [10, 20, 40]);
  assert.deepEqual(q.stats(), { retries429: 3, retriesOther: 0 });
});

for (const status of [429, 503]) {
  test(`queue default maxAttempts is 8 (status ${status}), so a 429 can outlast a rate window`, async () => {
    const { sleep, delays } = recordingSleep();
    const q = createQueue({ sleep, random: () => 1 });
    let calls = 0;
    await assert.rejects(q.run(() => { calls++; return Promise.reject(httpError(status)); }));
    assert.equal(calls, 8);
    // Full jitter at its ceiling: 1, 2, 4, 8, 16, then the 30 s cap twice.
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
}

test('queue maxAttempts 1 means no retry at all', async () => {
  const { sleep, delays } = recordingSleep();
  const q = createQueue({ sleep, maxAttempts: 1 });
  const t = failingThen([429]);
  await assert.rejects(q.run(t.task));
  assert.equal(t.calls(), 1);
  assert.deepEqual(delays, []);
});

test('queue stats count 429 retries apart from other retries', async () => {
  const { sleep } = recordingSleep();
  const q = createQueue({ sleep });
  await q.run(failingThen([429, 500, 0, 429]).task);
  await q.run(failingThen([502]).task);
  assert.deepEqual(q.stats(), { retries429: 2, retriesOther: 3 });
});

test('queue returns each task its own result and survives a synchronous throw', async () => {
  const q = createQueue({ sleep: () => Promise.resolve() });
  const results = await Promise.all([1, 2, 3].map((n) => q.run(() => Promise.resolve(n * 10))));
  assert.deepEqual(results, [10, 20, 30]);
  await assert.rejects(q.run(() => { throw httpError(404); }), (err) => err.status === 404);
  assert.equal(await q.run(() => 'plain value'), 'plain value');
});

test('queue.run rejects a non-function', async () => {
  const q = createQueue();
  await assert.rejects(q.run('nope'), TypeError);
});

test('concurrency never exceeds the limit, and the limit is used', async () => {
  const q = createQueue({ concurrency: 2, sleep: () => Promise.resolve() });
  let inFlight = 0;
  let peak = 0;
  const releases = [];
  const task = () => new Promise((resolve) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    releases.push(() => { inFlight--; resolve('done'); });
  });
  const all = Array.from({ length: 9 }, () => q.run(task));
  // Release tasks one at a time; each release lets the next one start.
  for (let released = 0; released < 9; released++) {
    await new Promise((r) => setImmediate(r));
    assert.ok(inFlight <= 2, `in flight ${inFlight}`);
    releases[released]();
  }
  assert.deepEqual(await Promise.all(all), Array(9).fill('done'));
  assert.equal(peak, 2);
});

test('concurrency holds while tasks retry and sleep', async () => {
  const sleeps = [];
  // A sleep that only ends when the test says so, so sleeping tasks pile up.
  const sleep = () => new Promise((resolve) => sleeps.push(resolve));
  const q = createQueue({ concurrency: 3, sleep, random: () => 0.5 });
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const failuresLeft = new Map();
  const makeTask = (id) => () => {
    started++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve, reject) => setImmediate(() => {
      inFlight--;
      const left = failuresLeft.get(id);
      if (left > 0) { failuresLeft.set(id, left - 1); reject(httpError(429)); } else resolve(id);
    }));
  };
  const ids = [0, 1, 2, 3, 4, 5, 6];
  ids.forEach((id) => failuresLeft.set(id, id % 3));
  const all = ids.map((id) => q.run(makeTask(id)));
  // Drain: wake every sleeper until all tasks settle.
  let settled = false;
  Promise.all(all).then(() => { settled = true; });
  while (!settled) {
    await new Promise((r) => setImmediate(r));
    while (sleeps.length) sleeps.shift()();
  }
  assert.deepEqual(await Promise.all(all), ids);
  assert.equal(peak, 3, `peak ${peak}`);
  assert.equal(started, 7 + (0 + 1 + 2 + 0 + 1 + 2 + 0));
  assert.deepEqual(q.stats(), { retries429: 6, retriesOther: 0 });
});

test('tasks start in the order they were queued', async () => {
  const q = createQueue({ concurrency: 1 });
  const order = [];
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => q.run(async () => { order.push(id); })));
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('createQueue clamps silly options to at least one slot and one try', async () => {
  const q = createQueue({ concurrency: 0, maxAttempts: 0, sleep: () => Promise.resolve() });
  let calls = 0;
  await assert.rejects(q.run(() => { calls++; return Promise.reject(httpError(429)); }));
  assert.equal(calls, 1);
  assert.equal(await q.run(() => Promise.resolve(7)), 7);
});

// --- retry kinds: a stalled connection must not eat six full timeouts ---

function kindError(status, kind) {
  const err = httpError(status);
  if (kind) err.kind = kind;
  return err;
}

// A task that always fails with the errors made by make(), counting calls.
function alwaysFailing(make) {
  let calls = 0;
  return { task: () => { calls++; return Promise.reject(make()); }, calls: () => calls };
}

test('retryKind names each retryable failure and nothing else', () => {
  const { retryKind } = require('../../js/queue.js');
  assert.equal(retryKind(kindError(429)), 'rate_limit');
  assert.equal(retryKind(kindError(503)), 'server');
  assert.equal(retryKind(kindError(0)), 'network');
  assert.equal(retryKind(kindError(0, 'network')), 'network');
  assert.equal(retryKind(kindError(0, 'timeout')), 'timeout');
  assert.equal(retryKind(kindError(400, 'invalid_json')), 'invalid_json');
  assert.equal(retryKind(kindError(400)), null);
  assert.equal(retryKind(new TypeError('bug')), null);
  const aborted = kindError(0, 'network');
  aborted.name = 'AbortError';
  assert.equal(retryKind(aborted), null);
  assert.equal(retryKind(null), null);
});

test('a timeout is retried at most once', async () => {
  const { sleep, delays } = recordingSleep();
  const q = createQueue({ sleep, random: () => 0.5, baseMs: 100 });
  const t = alwaysFailing(() => kindError(0, 'timeout'));
  await assert.rejects(q.run(t.task), (err) => err.kind === 'timeout');
  assert.equal(t.calls(), 2);
  assert.deepEqual(delays, [50]);
  assert.deepEqual(q.stats(), { retries429: 0, retriesOther: 1 });
});

test('a network error (kind network, or a bare status 0) gets 3 tries', async () => {
  for (const make of [() => kindError(0, 'network'), () => kindError(0)]) {
    const { sleep, delays } = recordingSleep();
    const q = createQueue({ sleep, random: () => 0.5, baseMs: 100 });
    const t = alwaysFailing(make);
    await assert.rejects(q.run(t.task), (err) => err.status === 0);
    assert.equal(t.calls(), 3);
    assert.deepEqual(delays, [50, 100]);
  }
});

test('each kind has its own cap: timeout, 429, timeout stops at the second timeout', async () => {
  const { sleep } = recordingSleep();
  const q = createQueue({ sleep });
  const seq = [kindError(0, 'timeout'), kindError(429), kindError(0, 'timeout'), kindError(429)];
  let calls = 0;
  await assert.rejects(q.run(() => Promise.reject(seq[calls++])), (err) => err.kind === 'timeout');
  assert.equal(calls, 3);
});

test('maxAttempts still caps every try, whatever the kinds', async () => {
  const { sleep } = recordingSleep();
  const q = createQueue({ sleep, maxAttempts: 3 });
  const seq = [kindError(429), kindError(0, 'network'), kindError(503), kindError(429)];
  let calls = 0;
  await assert.rejects(q.run(() => Promise.reject(seq[calls++])), (err) => err.status === 503);
  assert.equal(calls, 3);
});

test('a JSON-validation failure (kind invalid_json) is retried once on the same task', async () => {
  const { sleep, delays } = recordingSleep();
  const q = createQueue({ sleep, random: () => 0.5, baseMs: 100 });
  let calls = 0;
  const once = () => (calls++ === 0 ? Promise.reject(kindError(400, 'invalid_json')) : Promise.resolve('ok'));
  assert.equal(await q.run(once), 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [50]);

  const t = alwaysFailing(() => kindError(400, 'invalid_json'));
  await assert.rejects(q.run(t.task), (err) => err.kind === 'invalid_json');
  assert.equal(t.calls(), 2, 'never a third try');
});

test('onRetry reports each wait before it happens, from the queue and from run', async () => {
  const seen = [];
  const perRun = [];
  const { sleep } = recordingSleep();
  const q = createQueue({
    sleep, random: () => 0.5, baseMs: 100,
    onRetry: (info) => { seen.push(info); throw new Error('a broken progress line must not break the read'); }
  });
  const seq = [kindError(429), kindError(0, 'timeout'), kindError(502)];
  let calls = 0;
  const result = await q.run(() => (calls < seq.length ? Promise.reject(seq[calls++]) : Promise.resolve('ok')), {
    onRetry: (info) => perRun.push(info)
  });
  assert.equal(result, 'ok');
  const expected = [
    { attempt: 1, status: 429, kind: 'rate_limit', delayMs: 50 },
    { attempt: 2, status: 0, kind: 'timeout', delayMs: 100 },
    { attempt: 3, status: 502, kind: 'server', delayMs: 200 }
  ];
  assert.deepEqual(seen, expected);
  assert.deepEqual(perRun, expected);
});

test('onRetry is not called for a failure that is not retried', async () => {
  const seen = [];
  const q = createQueue({ sleep: () => Promise.resolve(), onRetry: (i) => seen.push(i) });
  await assert.rejects(q.run(() => Promise.reject(kindError(0, 'timeout'))));
  assert.equal(seen.length, 1, 'one retry, then the second timeout is final');
  await assert.rejects(q.run(() => Promise.reject(kindError(404))));
  assert.equal(seen.length, 1);
});

// --- abort: the teacher can stop a photo at any point ---

function isAbort(err) {
  return err && err.name === 'AbortError';
}

// Settles within a few turns of the event loop, or reports that it did not.
async function settlesSoon(promise) {
  let state = 'pending';
  promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return state;
}

test('abort: an already aborted signal rejects at once and the task never runs', async () => {
  const q = createQueue();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(q.run(() => { calls++; return 'x'; }, { signal: controller.signal }), isAbort);
  assert.equal(calls, 0);
});

test('abort: a queued task is dropped at once and never starts; the queue keeps going', async () => {
  const q = createQueue({ concurrency: 1 });
  let releaseFirst;
  const first = q.run(() => new Promise((resolve) => { releaseFirst = resolve; }));
  const controller = new AbortController();
  let secondCalls = 0;
  const second = q.run(() => { secondCalls++; return 'second'; }, { signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  assert.equal(await settlesSoon(second), 'rejected');
  await assert.rejects(second, isAbort);
  releaseFirst('first');
  assert.equal(await first, 'first');
  assert.equal(await q.run(() => 'third'), 'third');
  assert.equal(secondCalls, 0);
});

test('abort: a task sleeping in backoff rejects at once and gives its slot up', async () => {
  // A sleep that never ends: only the abort can end the wait.
  const q = createQueue({ concurrency: 1, sleep: () => new Promise(() => {}) });
  const controller = new AbortController();
  let calls = 0;
  const retrying = q.run(() => { calls++; return Promise.reject(kindError(429)); }, { signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  controller.abort();
  assert.equal(await settlesSoon(retrying), 'rejected');
  await assert.rejects(retrying, isAbort);
  assert.equal(await settlesSoon(q.run(() => 'next')), 'resolved', 'the slot was released');
  assert.equal(calls, 1, 'never tried again');
});

test('abort: an in-flight task rejects at once, is never retried, and holds its slot until it settles', async () => {
  const q = createQueue({ concurrency: 1, sleep: () => Promise.resolve() });
  const controller = new AbortController();
  let calls = 0;
  let failInFlight;
  const inFlight = q.run(() => {
    calls++;
    return new Promise((resolve, reject) => { failInFlight = reject; });
  }, { signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  let nextStarted = false;
  const next = q.run(() => { nextStarted = true; return 'next'; });
  controller.abort();
  assert.equal(await settlesSoon(inFlight), 'rejected', 'the caller is not kept waiting');
  await assert.rejects(inFlight, isAbort);
  assert.equal(nextStarted, false, 'concurrency counts the request still in flight');
  failInFlight(kindError(429));
  assert.equal(await next, 'next');
  assert.equal(calls, 1, 'a 429 that lands after the abort is not retried');
});

test('abort: an AbortError thrown by the task itself is never retried', async () => {
  const { sleep, delays } = recordingSleep();
  const q = createQueue({ sleep });
  let calls = 0;
  const aborted = () => {
    calls++;
    const err = kindError(0, 'network');
    err.name = 'AbortError';
    return Promise.reject(err);
  };
  await assert.rejects(q.run(aborted), isAbort);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('abort after the task finished changes nothing', async () => {
  const q = createQueue();
  const controller = new AbortController();
  assert.equal(await q.run(() => 'done', { signal: controller.signal }), 'done');
  controller.abort();
  await new Promise((r) => setImmediate(r));
});
