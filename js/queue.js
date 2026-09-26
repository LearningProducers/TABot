// TABot.queue: one request queue for every provider call, with blind
// exponential backoff. Groq hides retry-after and x-ratelimit-* from the
// browser (no Access-Control-Expose-Headers), so the client cannot read how
// long to wait; full jitter spreads retries out without that information.
//
// What is retried, and how many tries each kind gets (a try is one call of
// the task; the cap counts failures of that kind, and maxAttempts caps every
// try of the task whatever failed):
//   'rate_limit'    HTTP 429          up to maxAttempts (default 8)
//   'server'        HTTP 500-599      up to maxAttempts
//   'network'       status 0          3 tries (the connection failed)
//   'timeout'       status 0, err.kind 'timeout'   2 tries (one retry)
//   'invalid_json'  err.kind 'invalid_json'        2 tries (the model's JSON
//                   failed the provider's JSON-mode check; same model again)
// Anything else rejects at once. An AbortError (err.name) is never retried.
//
// run(taskFn, {signal, onRetry}) rejects at once with an AbortError when
// the signal aborts: while the task waits for a slot, while it sleeps in
// backoff, and while its request is in flight. A task that is in flight
// keeps its slot until it settles (pass the same signal to the request so
// it settles at once); a waiting or sleeping task gives its slot up at once.
//
// onRetry({attempt, status, kind, delayMs, daily}) is called before each backoff
// sleep, from the queue options and from run's options: attempt is the
// number of tries made so far (1 after the first failure), status the
// failed try's status, kind one of the kinds above, delayMs the wait, and
// daily true only on a 429 whose text names a limit per day.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.queue = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var DEFAULT_BASE_MS = 1000;
  var DEFAULT_CAP_MS = 30000;
  var DEFAULT_CONCURRENCY = 2;
  // 8 tries sleep 7 times: ceilings 1, 2, 4, 8, 16, 30 and 30 s (91 s at
  // most, about 45 s on average), so a 429 usually outlasts a rate window.
  var DEFAULT_MAX_ATTEMPTS = 8;
  // Tries per failure kind, for the kinds that must not use every attempt.
  // A stalled connection costs a whole read timeout per try.
  var MAX_TRIES_BY_KIND = { timeout: 2, network: 3, invalid_json: 2 };

  function numberOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  // Full jitter: a uniform draw between 0 and the exponential ceiling.
  // attempt starts at 0, so the first retry waits up to baseMs.
  function backoffDelay(attempt, opts) {
    opts = opts || {};
    var baseMs = numberOr(opts.baseMs, DEFAULT_BASE_MS);
    var capMs = numberOr(opts.capMs, DEFAULT_CAP_MS);
    var random = opts.random || Math.random;
    var ceiling = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
    return random() * ceiling;
  }

  // 429 = rate limited, 5xx = provider trouble, 0 = network or timeout.
  function isRetryableStatus(status) {
    return status === 0 || status === 429 || (status >= 500 && status <= 599);
  }

  function isAbortError(err) {
    return !!err && err.name === 'AbortError';
  }

  // A fresh AbortError each time; a DOMException where the platform has one,
  // the same shape fetch rejects with when its signal aborts.
  function abortError() {
    var message = 'Stopped before it finished.';
    if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
    var err = new Error(message);
    err.name = 'AbortError';
    return err;
  }

  // -> the retry kind of a failure, or null when it must not be retried.
  // Groq names a daily cap in its 429 text: "(RPD)", "(TPD)", "per day".
  var DAILY_RE = /\(RPD\)|\(TPD\)|per day|requests per day|tokens per day/i;

  function retryKind(err) {
    if (!err || isAbortError(err) || typeof err.status !== 'number') return null;
    var status = err.status;
    if (status === 429) return 'rate_limit';
    if (status >= 500 && status <= 599) return 'server';
    if (status === 0) return err.kind === 'timeout' ? 'timeout' : 'network';
    if (err.kind === 'invalid_json') return 'invalid_json';
    return null;
  }

  function defaultSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function callQuietly(fn, info) {
    if (typeof fn !== 'function') return;
    try {
      fn(info);
    } catch (err) {
      // A progress callback that throws must not break the read.
    }
  }

  function createQueue(opts) {
    opts = opts || {};
    var concurrency = Math.max(1, Math.floor(numberOr(opts.concurrency, DEFAULT_CONCURRENCY)));
    var maxAttempts = Math.max(1, Math.floor(numberOr(opts.maxAttempts, DEFAULT_MAX_ATTEMPTS)));
    var delayOpts = { baseMs: opts.baseMs, capMs: opts.capMs, random: opts.random || Math.random };
    var sleep = opts.sleep || defaultSleep;
    var onRetry = opts.onRetry;
    var waiting = [];
    var active = 0;
    var counts = { retries429: 0, retriesOther: 0 };

    // Sleeps between tries, cut short when the job is aborted.
    function pause(job, ms) {
      return new Promise(function (resolve) {
        job.wake = resolve;
        Promise.resolve(sleep(ms)).then(resolve, resolve);
      }).then(function () { job.wake = null; });
    }

    // A task keeps its slot while it sleeps between tries: a rate-limited
    // provider gets less traffic, not the same traffic from a new slot.
    async function execute(job) {
      var tries = 0;
      var failures = {};
      for (;;) {
        if (job.settled) throw abortError();
        tries++;
        try {
          return await Promise.resolve().then(job.taskFn);
        } catch (err) {
          if (job.settled) throw err;
          var kind = retryKind(err);
          if (!kind) throw err;
          failures[kind] = (failures[kind] || 0) + 1;
          var kindCap = MAX_TRIES_BY_KIND[kind] || maxAttempts;
          if (tries >= maxAttempts || failures[kind] >= kindCap) throw err;
          if (kind === 'rate_limit') counts.retries429++;
          else counts.retriesOther++;
          var delayMs = backoffDelay(tries - 1, delayOpts);
          var info = { attempt: tries, status: err.status, kind: kind, delayMs: delayMs };
          // A limit per day never clears in a backoff; the caller moves on.
          if (kind === 'rate_limit' && DAILY_RE.test(String(err.message || ''))) info.daily = true;
          callQuietly(onRetry, info);
          callQuietly(job.onRetry, info);
          // A callback that aborted the task frees its slot now, not after
          // the backoff.
          if (job.settled) throw abortError();
          await pause(job, delayMs);
        }
      }
    }

    function start(job) {
      active++;
      execute(job).then(function (value) {
        active--;
        pump();
        job.resolve(value);
      }, function (err) {
        active--;
        pump();
        job.reject(err);
      });
    }

    function pump() {
      while (active < concurrency && waiting.length) start(waiting.shift());
    }

    function run(taskFn, runOpts) {
      if (typeof taskFn !== 'function') {
        return Promise.reject(new TypeError('queue.run needs a function that returns a promise'));
      }
      runOpts = runOpts || {};
      var signal = runOpts.signal || null;
      if (signal && signal.aborted) return Promise.reject(abortError());
      return new Promise(function (resolve, reject) {
        var job = { taskFn: taskFn, onRetry: runOpts.onRetry, settled: false, wake: null };
        function onAbort() {
          var i = waiting.indexOf(job);
          if (i >= 0) waiting.splice(i, 1);
          job.reject(abortError());
          if (job.wake) job.wake();
        }
        function finish() {
          job.settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
        }
        job.resolve = function (value) {
          if (job.settled) return;
          finish();
          resolve(value);
        };
        job.reject = function (err) {
          if (job.settled) return;
          finish();
          reject(err);
        };
        if (signal) signal.addEventListener('abort', onAbort);
        waiting.push(job);
        pump();
      });
    }

    function stats() {
      return { retries429: counts.retries429, retriesOther: counts.retriesOther };
    }

    return { run: run, stats: stats };
  }

  return {
    backoffDelay: backoffDelay,
    createQueue: createQueue,
    isRetryableStatus: isRetryableStatus,
    isAbortError: isAbortError,
    retryKind: retryKind
  };
});
