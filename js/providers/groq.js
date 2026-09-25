// The Groq adapter. Groq speaks the OpenAI chat shape and allows direct
// browser calls (CORS open), so the page talks to it with no backend.
//
// Registration: in node this file is require()d by providers/index.js. In the
// browser it is a classic script that must load BEFORE providers/index.js; it
// registers itself as TABot.providerGroq, and index.js assembles
// TABot.providers (so app code uses TABot.providers.groq or get('groq')).
//
// Key handling: the key rides ONLY in the Authorization header, never in a
// URL or a body, and every error message built here has the key scrubbed out.
//
// Errors: a ProviderError carries .status (the HTTP status, 0 when no answer
// came back), .retryable, and .kind when the status alone does not say what
// happened: 'timeout' (no answer within the time limit, status 0), 'network'
// (the connection failed or the body was cut off, status 0), 'invalid_json'
// (HTTP 400 json_validate_failed: the model's reply failed Groq's JSON-mode
// check; retryable once on the same model). Every call takes an optional
// AbortSignal as signal: an abort cancels the request in flight and rejects
// with an AbortError (err.name), never a ProviderError, so no queue retries it.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.providerGroq = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var BASE_URL = 'https://api.groq.com/openai/v1';
  var PROBE_PROMPT = 'Reply with the single word OK.';
  // A hung request would freeze a queue slot forever on a flaky phone
  // connection; a timeout turns it into a retryable error instead. A read
  // that has not answered in 60 s is stalled, not slow.
  var TIMEOUT_MS = { list: 20000, probe: 30000, read: 60000 };
  // Error text that means "this model does not take images": it names
  // images or image input, the content type (a text-only model answers
  // "content must be a string" to a content array holding an image),
  // multimodal input, or modality. Tested with the model id taken out, since
  // an id such as "some-vision-image-model" says nothing about the refusal.
  var NO_IMAGE_PATTERN = /\bimages?\b|image[ _-]?(?:url|input)|content[ _-]?type|content must be a string|multi[ -]?modal|modalit/i;
  var INVALID_JSON_CODE = 'json_validate_failed';
  var MAX_DETAIL_CHARS = 500;
  var DEFAULT_READ_MAX_TOKENS = 2000;

  class ProviderError extends Error {
    constructor(message, fields) {
      super(message);
      fields = fields || {};
      this.name = 'ProviderError';
      this.provider = 'groq';
      this.status = typeof fields.status === 'number' ? fields.status : 0;
      this.retryable = typeof fields.retryable === 'boolean' ? fields.retryable : isRetryableStatus(this.status);
      if (fields.kind) this.kind = fields.kind;
      if (fields.code) this.code = fields.code;
      if (fields.type) this.type = fields.type;
    }
  }

  function isRetryableStatus(status) {
    return status === 0 || status === 429 || (status >= 500 && status <= 599);
  }

  // Replace every occurrence of every form of the key with "[key]".
  function scrub(text, secrets) {
    var out = String(text == null ? '' : text);
    secrets.forEach(function (secret) {
      if (secret) out = out.split(secret).join('[key]');
    });
    return out;
  }

  function scrubbedError(message, fields, secrets) {
    fields = fields || {};
    return new ProviderError(scrub(message, secrets), {
      status: fields.status,
      kind: fields.kind,
      retryable: fields.retryable,
      code: fields.code == null ? undefined : scrub(fields.code, secrets),
      type: fields.type == null ? undefined : scrub(fields.type, secrets)
    });
  }

  // What fetch rejects with when its signal aborts, made here so the error
  // is the same whichever side noticed the abort first.
  function abortError() {
    var message = 'The request to Groq was stopped.';
    if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
    var err = new Error(message);
    err.name = 'AbortError';
    return err;
  }

  // Resolve fetch once and call it as a plain function: calling window.fetch
  // as a method of some other object throws "Illegal invocation".
  function pickFetch(injected) {
    if (typeof injected === 'function') return injected;
    if (typeof root.fetch === 'function') return root.fetch.bind(root);
    if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    throw new ProviderError('This browser cannot make network requests (no fetch).', { status: 0 });
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return undefined;
    }
  }

  function errorFromBody(status, json, secrets) {
    var error = json && json.error;
    var detail = '';
    if (error && typeof error.message === 'string') detail = error.message;
    else if (typeof error === 'string') detail = error;
    detail = detail.slice(0, MAX_DETAIL_CHARS);
    var fields = { status: status };
    if (error && typeof error === 'object') {
      if (error.code != null) fields.code = String(error.code);
      if (error.type != null) fields.type = String(error.type);
    }
    // The model wrote JSON that failed Groq's check; the same model often
    // gets it right on a second try. failed_generation (the bad reply,
    // which may hold a student's answers) is never copied into the error.
    if (status === 400 && fields.code === INVALID_JSON_CODE) {
      fields.kind = 'invalid_json';
      fields.retryable = true;
    }
    var message = json === undefined
      ? 'Groq returned HTTP ' + status + ' with a body that is not JSON.'
      : 'Groq returned HTTP ' + status + (detail ? ': ' + detail : '.');
    return scrubbedError(message, fields, secrets);
  }

  // One network round trip: fetch, read the whole body, parse JSON. The
  // timeout covers the body too, since a stalled body hangs just the same.
  // The caller's signal and the timeout share one AbortController, so either
  // one cancels the fetch in flight.
  async function request(opts) {
    var rawKey = opts.key == null ? '' : String(opts.key);
    var key = rawKey.trim();
    var secrets = [rawKey, key];
    var signal = opts.signal || null;
    if (signal && signal.aborted) throw abortError();
    if (!key) throw new ProviderError('No Groq API key. Paste your key first.', { status: 401 });

    var doFetch = pickFetch(opts.fetch);
    var headers = { Authorization: 'Bearer ' + key };
    var init = {
      method: opts.method,
      headers: headers,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) init.signal = controller.signal;
    var timeoutMs = opts.timeoutMs;
    var timer = null;

    var exchange = (async function () {
      var res;
      try {
        res = await doFetch(BASE_URL + opts.path, init);
      } catch (err) {
        var reason = err && err.message ? String(err.message).replace(/\.$/, '') : 'network error';
        throw scrubbedError('Could not reach Groq: ' + reason + '.', { status: 0, kind: 'network' }, secrets);
      }
      var text;
      try {
        text = await res.text();
      } catch (err) {
        throw scrubbedError('The Groq response was cut off (HTTP ' + res.status + ').', { status: 0, kind: 'network' }, secrets);
      }
      return { status: res.status, text: text };
    })();

    // Each of these rejects before it aborts the controller, so the race
    // settles with the reason, not with the fetch error the abort causes.
    var timeout = new Promise(function (resolve, reject) {
      if (!(timeoutMs > 0)) return;
      timer = setTimeout(function () {
        reject(new ProviderError('Groq did not answer within ' + Math.round(timeoutMs / 1000) + ' seconds.', { status: 0, kind: 'timeout' }));
        if (controller) controller.abort();
      }, timeoutMs);
    });

    var onAbort = null;
    var stopped = new Promise(function (resolve, reject) {
      if (!signal) return;
      onAbort = function () {
        reject(abortError());
        if (controller) controller.abort();
      };
      signal.addEventListener('abort', onAbort);
    });

    var result;
    try {
      result = await Promise.race([exchange, timeout, stopped]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }

    var json = parseJson(result.text);
    var ok = result.status >= 200 && result.status <= 299;
    if (!ok) throw errorFromBody(result.status, json, secrets);
    if (json === undefined || json === null || typeof json !== 'object') {
      throw scrubbedError('Groq returned a response that is not JSON (HTTP ' + result.status + ').', { status: result.status }, secrets);
    }
    return { status: result.status, body: json };
  }

  function requireString(value, what) {
    if (typeof value !== 'string' || !value) throw new TypeError('groq: ' + what + ' is required');
  }

  function imagePart(dataUrl) {
    return { type: 'image_url', image_url: { url: dataUrl } };
  }

  // -> [{id, active, contextWindow}], active models only. The list carries no
  // field saying which models take images; see probeVision.
  async function listModels(opts) {
    opts = opts || {};
    var res = await request({
      key: opts.key,
      fetch: opts.fetch,
      signal: opts.signal,
      method: 'GET',
      path: '/models',
      timeoutMs: opts.timeoutMs || TIMEOUT_MS.list
    });
    if (!Array.isArray(res.body.data)) {
      throw new ProviderError('The Groq models list had an unexpected shape.', { status: res.status });
    }
    var seen = {};
    var models = [];
    res.body.data.forEach(function (m) {
      if (!m || typeof m.id !== 'string' || !m.id || m.active === false) return;
      if (Object.prototype.hasOwnProperty.call(seen, m.id)) return;
      seen[m.id] = true;
      models.push({
        id: m.id,
        active: true,
        contextWindow: typeof m.context_window === 'number' ? m.context_window : null
      });
    });
    return models;
  }

  // -> true when the model accepted an image, false when its refusal names
  // images, image input, the content type, multimodal input or modality.
  // Every other failure throws and means "unknown", which the caller must
  // not cache: 401 (bad key), retryable statuses (429, 5xx, network,
  // timeout), and any other status, 400/404/422 included, whose error does
  // not name images (terms not accepted, model not found, org restricted).
  async function probeVision(opts) {
    opts = opts || {};
    requireString(opts.model, 'model');
    if (typeof opts.probeImage !== 'string' || opts.probeImage.indexOf('data:image/') !== 0) {
      throw new TypeError('groq: probeImage must be an image data URL');
    }
    try {
      await request({
        key: opts.key,
        fetch: opts.fetch,
        signal: opts.signal,
        method: 'POST',
        path: '/chat/completions',
        timeoutMs: opts.timeoutMs || TIMEOUT_MS.probe,
        body: {
          model: opts.model,
          messages: [{
            role: 'user',
            content: [imagePart(opts.probeImage), { type: 'text', text: PROBE_PROMPT }]
          }],
          max_tokens: 5,
          temperature: 0
        }
      });
      return true;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.status === 401 || err.retryable) throw err;
      if (namesImages(err, opts.model)) return false;
      throw err;
    }
  }

  // The model id is removed only where it stands as a whole id, so a short
  // id cannot eat letters out of the words around it.
  function namesImages(err, model) {
    var text = [err.message, err.code, err.type].join(' ');
    var id = String(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var withoutId = text.replace(new RegExp('(^|[^A-Za-z0-9._/:-])' + id + '(?![A-Za-z0-9._/:-])', 'g'), '$1');
    return NO_IMAGE_PATTERN.test(withoutId);
  }

  // One slip image in, the model's raw text out (JSON mode, temperature 0).
  // max_tokens defaults to 2000: a 30-question slip is more JSON than 800
  // tokens. No reasoning parameters: Groq's vision model, measured on
  // 2026-09-21, emits no reasoning tokens by default.
  async function read(opts) {
    opts = opts || {};
    requireString(opts.model, 'model');
    requireString(opts.imageDataUrl, 'imageDataUrl');
    var messages = [];
    if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
    messages.push({
      role: 'user',
      content: [imagePart(opts.imageDataUrl), { type: 'text', text: String(opts.user || '') }]
    });
    var res = await request({
      key: opts.key,
      fetch: opts.fetch,
      signal: opts.signal,
      method: 'POST',
      path: '/chat/completions',
      timeoutMs: opts.timeoutMs || TIMEOUT_MS.read,
      body: {
        model: opts.model,
        messages: messages,
        temperature: 0,
        max_tokens: opts.maxTokens == null ? DEFAULT_READ_MAX_TOKENS : opts.maxTokens,
        response_format: { type: 'json_object' }
      }
    });
    var choice = Array.isArray(res.body.choices) ? res.body.choices[0] : null;
    var content = choice && choice.message ? choice.message.content : null;
    if (typeof content !== 'string') {
      throw new ProviderError('Groq returned no text from model ' + opts.model + '.', { status: res.status });
    }
    return {
      text: content,
      model: typeof res.body.model === 'string' && res.body.model ? res.body.model : opts.model,
      usage: res.body.usage || null,
      finishReason: choice.finish_reason || null
    };
  }

  return {
    id: 'groq',
    label: 'Groq',
    baseUrl: BASE_URL,
    supportsModelCapabilities: false,
    timeouts: { list: TIMEOUT_MS.list, probe: TIMEOUT_MS.probe, read: TIMEOUT_MS.read },
    listModels: listModels,
    probeVision: probeVision,
    read: read,
    ProviderError: ProviderError
  };
});
