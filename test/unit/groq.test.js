'use strict';

// Every Groq call here goes to a fake fetch. The key below is a made-up
// string, not a credential; the tests prove it only ever rides in the
// Authorization header and never survives into an error message.
const test = require('node:test');
const assert = require('node:assert/strict');
const groq = require('../../js/providers/groq.js');

const KEY = 'gsk_FAKE_unit_test_key_0000000000';
const PROBE = 'data:image/jpeg;base64,/9j/FAKEPROBE';
const SLIP = 'data:image/jpeg;base64,/9j/FAKESLIP';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } });
}

function groqError(status, message, extra) {
  return jsonResponse(status, { error: Object.assign({ message, type: 'invalid_request_error' }, extra) });
}

// A fetch that records every call and answers with responder(url, init, n).
// It is a strict-mode function that refuses a foreign `this`, the way
// window.fetch throws "Illegal invocation" when called as a method.
function fakeFetch(responder) {
  const calls = [];
  const fetch = async function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return responder(url, init, calls.length);
  };
  return { fetch, calls };
}

function chatOk(content, model) {
  return jsonResponse(200, {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: model || 'vision-model-a',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2100, completion_tokens: 40, total_tokens: 2140 }
  });
}

function assertKeyOnlyInAuthorization(call) {
  assert.ok(!call.url.includes(KEY), 'key must not be in the URL');
  assert.ok(!call.url.includes('?'), 'no query string at all');
  assert.ok(!call.url.includes('#'), 'no hash at all');
  if (call.init.body !== undefined) assert.ok(!call.init.body.includes(KEY), 'key must not be in the body');
  for (const [name, value] of Object.entries(call.init.headers)) {
    if (name === 'Authorization') assert.equal(value, 'Bearer ' + KEY);
    else assert.ok(!String(value).includes(KEY), `key must not be in header ${name}`);
  }
}

function assertPrivacyFlags(init) {
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.referrerPolicy, 'no-referrer');
}

function assertKeyAbsent(err) {
  for (const text of [err.message, String(err), err.stack || '', JSON.stringify(err)]) {
    assert.ok(!text.includes(KEY), 'key leaked into: ' + text.slice(0, 80));
  }
}

test('adapter identity', () => {
  assert.equal(groq.id, 'groq');
  assert.equal(groq.label, 'Groq');
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(groq.supportsModelCapabilities, false);
  assert.equal(typeof groq.ProviderError, 'function');
});

test('listModels: GET /models with the key in the Authorization header only', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, { object: 'list', data: [] }));
  await groq.listModels({ key: KEY, fetch });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.headers['Content-Type'], undefined);
  assert.deepEqual(Object.keys(call.init.headers), ['Authorization']);
  assertKeyOnlyInAuthorization(call);
  assertPrivacyFlags(call.init);
});

test('listModels: keeps active models only, maps context_window, skips junk and repeats', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(200, {
    object: 'list',
    data: [
      { id: 'model-b', object: 'model', created: 1, owned_by: 'x', active: true, context_window: 131072, public_apps: null },
      { id: 'model-off', object: 'model', active: false, context_window: 8192 },
      { id: 'model-a', object: 'model', active: true },
      { id: 'model-b', object: 'model', active: true, context_window: 1 },
      { object: 'model', active: true },
      null,
      { id: '', active: true }
    ]
  }));
  const models = await groq.listModels({ key: KEY, fetch });
  assert.deepEqual(models, [
    { id: 'model-b', active: true, contextWindow: 131072 },
    { id: 'model-a', active: true, contextWindow: null }
  ]);
});

test('listModels: a body without a data array is an error', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(200, { object: 'list' }));
  await assert.rejects(groq.listModels({ key: KEY, fetch }), (err) => err instanceof groq.ProviderError && err.status === 200);
});

test('listModels: the key is trimmed before it is sent', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [] }));
  await groq.listModels({ key: '  ' + KEY + '\n', fetch });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY);
});

test('a missing key fails before any request leaves', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [] }));
  for (const key of [undefined, null, '', '   ']) {
    await assert.rejects(groq.listModels({ key, fetch }), (err) => err instanceof groq.ProviderError && err.status === 401 && !err.retryable);
  }
  assert.equal(calls.length, 0);
});

test('read: POST /chat/completions in JSON mode, temperature 0, one image', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('{"student_name":"Ada"}'));
  const out = await groq.read({ key: KEY, fetch, model: 'vision-model-a', imageDataUrl: SLIP, system: 'SYS', user: 'USER' });
  const call = calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' });
  assertKeyOnlyInAuthorization(call);
  assertPrivacyFlags(call.init);
  assert.deepEqual(call.body, {
    model: 'vision-model-a',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: SLIP } },
        { type: 'text', text: 'USER' }
      ] }
    ],
    temperature: 0,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });
  assert.deepEqual(out, {
    text: '{"student_name":"Ada"}',
    model: 'vision-model-a',
    usage: { prompt_tokens: 2100, completion_tokens: 40, total_tokens: 2140 },
    finishReason: 'stop'
  });
});

test('read: textOnly sends the user text alone, with no image, in JSON mode', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('{"answer":"42"}'));
  const out = await groq.read({ key: KEY, fetch, model: 'm', textOnly: true, system: 'SYS', user: 'USER' });
  assertKeyOnlyInAuthorization(calls[0]);
  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USER' }
  ]);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(out.text, '{"answer":"42"}');
});

test('read: maxTokens is passed through', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('{}'));
  await groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, system: 's', user: 'u', maxTokens: 300 });
  assert.equal(calls[0].body.max_tokens, 300);
});

test('read: a 200 with no message content is an error', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(200, { choices: [] }));
  await assert.rejects(
    groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, system: 's', user: 'u' }),
    (err) => err instanceof groq.ProviderError && err.status === 200 && !err.retryable
  );
});

test('read: refuses to send without a model or an image', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('{}'));
  await assert.rejects(groq.read({ key: KEY, fetch, imageDataUrl: SLIP }), TypeError);
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm' }), TypeError);
  assert.equal(calls.length, 0);
});

test('probeVision: request shape is one tiny image plus the OK prompt, max_tokens 5', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('OK'));
  assert.equal(await groq.probeVision({ key: KEY, fetch, model: 'vision-model-a', probeImage: PROBE }), true);
  const call = calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assertKeyOnlyInAuthorization(call);
  assertPrivacyFlags(call.init);
  assert.deepEqual(call.body, {
    model: 'vision-model-a',
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: PROBE } },
      { type: 'text', text: 'Reply with the single word OK.' }
    ] }],
    max_tokens: 5,
    temperature: 0
  });
});

test('probeVision: needs a data URL probe image', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('OK'));
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm' }), TypeError);
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: 'https://example.com/x.jpg' }), TypeError);
  assert.equal(calls.length, 0);
});

for (const status of [400, 404, 422]) {
  test(`probeVision: HTTP ${status} means the model does not take images`, async () => {
    const { fetch } = fakeFetch(() => groqError(status, 'messages[0].content must be a string'));
    assert.equal(await groq.probeVision({ key: KEY, fetch, model: 'text-model', probeImage: PROBE }), false);
  });
}

test('probeVision: another status whose error names images means no vision', async () => {
  const { fetch } = fakeFetch(() => groqError(415, 'image input is not supported for this model'));
  assert.equal(await groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE }), false);
  const modality = fakeFetch(() => groqError(403, 'unsupported modality for model m'));
  assert.equal(await groq.probeVision({ key: KEY, fetch: modality.fetch, model: 'm', probeImage: PROBE }), false);
});

for (const [status, message, code] of [
  [400, 'The model `vendor/vision-a` requires terms acceptance. Ask an org admin to accept the terms.', 'model_terms_required'],
  [404, 'The model `vendor/vision-a` does not exist or you do not have access to it.', 'model_not_found'],
  [422, 'Request could not be processed right now.', undefined],
  [400, 'Organization has been restricted.', 'organization_restricted']
]) {
  test(`probeVision: HTTP ${status} that does not name images is unknown (throws), never false: ${code || 'no code'}`, async () => {
    const { fetch } = fakeFetch(() => groqError(status, message, code ? { code } : undefined));
    await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'vendor/vision-a', probeImage: PROBE }), (err) => {
      return err instanceof groq.ProviderError && err.status === status && err.retryable === false;
    });
  });
}

for (const message of [
  'image input is not supported for this model',
  'This model does not support multimodal input',
  'Unsupported content type image_url for this model',
  'model does not accept the image modality',
  'messages[0].content must be a string'
]) {
  test(`probeVision: HTTP 400 naming images, content type or modality is false: "${message}"`, async () => {
    const { fetch } = fakeFetch(() => groqError(400, message));
    assert.equal(await groq.probeVision({ key: KEY, fetch, model: 'text-model', probeImage: PROBE }), false);
  });
}

test('probeVision: a model id that holds "image" or "vision" does not count as naming images', async () => {
  const model = 'acme/image-vision-multimodal-9b';
  const { fetch } = fakeFetch(() => groqError(400, 'The model `' + model + '` requires terms acceptance.', { code: 'model_terms_required' }));
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model, probeImage: PROBE }), (err) => err.status === 400);
});

test('probeVision: an error code naming the content type counts too', async () => {
  const { fetch } = fakeFetch(() => groqError(400, 'Bad request.', { code: 'unsupported_content_type' }));
  assert.equal(await groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE }), false);
});

test('probeVision: another status with an unrelated error throws, not retryable', async () => {
  const { fetch } = fakeFetch(() => groqError(403, 'Organization is restricted', { code: 'org_restricted' }));
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE }), (err) => {
    return err instanceof groq.ProviderError && err.status === 403 && err.retryable === false && err.code === 'org_restricted';
  });
});

test('probeVision: 401 throws a bad-key error', async () => {
  const { fetch } = fakeFetch(() => groqError(401, 'Invalid API Key', { code: 'invalid_api_key' }));
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE }), (err) => {
    return err instanceof groq.ProviderError && err.status === 401 && err.retryable === false &&
      err.code === 'invalid_api_key' && /Invalid API Key/.test(err.message);
  });
});

for (const status of [429, 500, 503]) {
  test(`probeVision: HTTP ${status} throws a retryable error (verdict unknown)`, async () => {
    const { fetch } = fakeFetch(() => groqError(status, 'Rate limit reached for model m'));
    await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE }), (err) => {
      return err instanceof groq.ProviderError && err.status === status && err.retryable === true;
    });
  });
}

test('probeVision: a network failure throws status 0, kind network, retryable', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE }), (err) => {
    return err instanceof groq.ProviderError && err.status === 0 && err.retryable === true &&
      err.kind === 'network' && err.message === 'Could not reach Groq: Failed to fetch.';
  });
});

test('errors: Groq error body becomes message, code and type', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(400, {
    error: { message: 'model `x` does not exist', type: 'invalid_request_error', code: 'model_not_found' }
  }));
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'x', imageDataUrl: SLIP }), (err) => {
    assert.equal(err.name, 'ProviderError');
    assert.equal(err.provider, 'groq');
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    assert.equal(err.code, 'model_not_found');
    assert.equal(err.type, 'invalid_request_error');
    assert.equal(err.message, 'Groq returned HTTP 400: model `x` does not exist');
    return true;
  });
});

test('errors: an echoed key is scrubbed from every error field', async () => {
  const echo = 'Invalid API Key: ' + KEY + ' (key ' + KEY + ')';
  const { fetch } = fakeFetch(() => jsonResponse(401, { error: { message: echo, type: 'auth ' + KEY, code: KEY } }));
  await assert.rejects(groq.listModels({ key: KEY, fetch }), (err) => {
    assert.equal(err.message, 'Groq returned HTTP 401: Invalid API Key: [key] (key [key])');
    assert.equal(err.code, '[key]');
    assert.equal(err.type, 'auth [key]');
    assertKeyAbsent(err);
    return true;
  });
});

test('errors: the untrimmed form of a pasted key is scrubbed too', async () => {
  const pasted = ' ' + KEY + ' ';
  const fetch = async () => { throw new TypeError('bad header value "Bearer ' + pasted + '"'); };
  await assert.rejects(groq.listModels({ key: pasted, fetch }), (err) => {
    assertKeyAbsent(err);
    assert.ok(err.message.includes('[key]'));
    return true;
  });
});

test('errors: a network error message echoing the key is scrubbed', async () => {
  const fetch = async () => { throw new TypeError('Invalid header value: Bearer ' + KEY); };
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP }), (err) => {
    assert.equal(err.message, 'Could not reach Groq: Invalid header value: Bearer [key].');
    assert.equal(err.status, 0);
    assertKeyAbsent(err);
    return true;
  });
});

test('errors: a non-JSON body is an error carrying the HTTP status', async () => {
  const bad = fakeFetch(() => textResponse(502, '<html>Bad gateway</html>'));
  await assert.rejects(groq.read({ key: KEY, fetch: bad.fetch, model: 'm', imageDataUrl: SLIP }), (err) => {
    return err instanceof groq.ProviderError && err.status === 502 && err.retryable === true &&
      err.message === 'Groq returned HTTP 502 with a body that is not JSON.';
  });
  const okButHtml = fakeFetch(() => textResponse(200, '<html>captive portal</html>'));
  await assert.rejects(groq.listModels({ key: KEY, fetch: okButHtml.fetch }), (err) => {
    return err instanceof groq.ProviderError && err.status === 200 && err.retryable === false &&
      /not JSON/.test(err.message);
  });
  const empty = fakeFetch(() => textResponse(401, ''));
  await assert.rejects(groq.listModels({ key: KEY, fetch: empty.fetch }), (err) => err.status === 401);
});

test('errors: a body cut off mid-read is a retryable network error', async () => {
  const fetch = async () => ({ status: 200, text: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(groq.listModels({ key: KEY, fetch }), (err) => {
    return err.status === 0 && err.retryable === true && err.kind === 'network';
  });
});

test('timeout: a request that never answers becomes a retryable status 0 error and is aborted', async () => {
  let signal = null;
  const fetch = (url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  };
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, timeoutMs: 20 }), (err) => {
    return err instanceof groq.ProviderError && err.status === 0 && err.retryable === true &&
      err.kind === 'timeout' && /did not answer/.test(err.message);
  });
  assert.equal(signal.aborted, true);
});

test('timeout: a fetch that ignores the abort signal still times out', async () => {
  const fetch = () => new Promise(() => {});
  await assert.rejects(groq.listModels({ key: KEY, fetch, timeoutMs: 20 }), (err) => err.status === 0 && err.retryable);
});

test('ProviderError derives retryable from status', () => {
  const E = groq.ProviderError;
  assert.equal(new E('x', { status: 429 }).retryable, true);
  assert.equal(new E('x', { status: 0 }).retryable, true);
  assert.equal(new E('x', { status: 503 }).retryable, true);
  assert.equal(new E('x', { status: 400 }).retryable, false);
  assert.equal(new E('x', { status: 401 }).retryable, false);
  assert.ok(new E('x', { status: 400 }) instanceof Error);
});

// --- read timeout, error kinds, JSON-validation retry ---

test('timeout: a read waits 60 s by default, not 120 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = () => new Promise(() => {});
  let outcome = null;
  groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP }).then(
    () => { outcome = 'resolved'; },
    (err) => { outcome = err; }
  );
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  t.mock.timers.tick(59999);
  await flush();
  assert.equal(outcome, null, 'still waiting at 59.999 s');
  t.mock.timers.tick(1);
  await flush();
  assert.ok(outcome instanceof groq.ProviderError, 'timed out at 60 s');
  assert.equal(outcome.status, 0);
  assert.equal(outcome.kind, 'timeout');
  assert.equal(outcome.message, 'Groq did not answer within 60 seconds.');
  assert.deepEqual(groq.timeouts, { list: 20000, probe: 30000, read: 60000 });
});

test('errors: HTTP 400 json_validate_failed is kind invalid_json and retryable, without the failed text', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(400, { error: {
    message: 'Failed to generate JSON. Please adjust your prompt. See \'failed_generation\' for more details.',
    type: 'invalid_request_error',
    code: 'json_validate_failed',
    failed_generation: '{"student_name": "Synthetic Student", "answers": [ SECRET_PARTIAL'
  } }));
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP }), (err) => {
    assert.ok(err instanceof groq.ProviderError);
    assert.equal(err.status, 400);
    assert.equal(err.kind, 'invalid_json');
    assert.equal(err.retryable, true);
    assert.equal(err.code, 'json_validate_failed');
    assert.ok(!JSON.stringify(err).includes('SECRET_PARTIAL') && !err.message.includes('SECRET_PARTIAL'));
    return true;
  });
});

test('errors: another 400 has no kind and stays non-retryable', async () => {
  const { fetch } = fakeFetch(() => groqError(400, 'context too long', { code: 'context_length_exceeded' }));
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP }), (err) => {
    return err.status === 400 && err.retryable === false && err.kind === undefined;
  });
});

test('queue + read: json_validate_failed is retried once on the same model, then the next reply is used', async () => {
  const { createQueue } = require('../../js/queue.js');
  const q = createQueue({ sleep: () => Promise.resolve() });
  const { fetch, calls } = fakeFetch((url, init, n) => (n === 1
    ? jsonResponse(400, { error: { message: 'Failed to generate JSON.', code: 'json_validate_failed' } })
    : chatOk('{"answers":[]}', 'vision-model-a')));
  const out = await q.run(() => groq.read({ key: KEY, fetch, model: 'vision-model-a', imageDataUrl: SLIP }));
  assert.equal(out.text, '{"answers":[]}');
  assert.deepEqual(calls.map((c) => c.body.model), ['vision-model-a', 'vision-model-a']);
});

test('queue + read: a stalled connection costs two timeouts, never six', async () => {
  const { createQueue } = require('../../js/queue.js');
  const q = createQueue({ sleep: () => Promise.resolve() });
  let calls = 0;
  const fetch = (url, init) => { calls++; return new Promise(() => {}); };
  await assert.rejects(q.run(() => groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, timeoutMs: 10 })),
    (err) => err.kind === 'timeout');
  assert.equal(calls, 2);
});

// --- an AbortSignal cancels the request in flight ---

function isAbort(err) {
  return err && err.name === 'AbortError' && !(err instanceof groq.ProviderError) && err.status === undefined;
}

// A fetch that hangs until its own signal aborts, then rejects the way a
// browser fetch does.
function hangingFetch() {
  const seen = { calls: 0, signal: null };
  const fetch = (url, init) => {
    seen.calls++;
    seen.signal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
    });
  };
  return { fetch, seen };
}

test('signal: an already aborted signal sends nothing and rejects with an AbortError', async () => {
  const { fetch, calls } = fakeFetch(() => chatOk('{}'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, signal: controller.signal }), isAbort);
  await assert.rejects(groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE, signal: controller.signal }), isAbort);
  assert.equal(calls.length, 0);
});

test('signal: an abort mid-read cancels the fetch and rejects with an AbortError at once', async () => {
  const { fetch, seen } = hangingFetch();
  const controller = new AbortController();
  const reading = groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.calls, 1);
  assert.equal(seen.signal.aborted, false);
  controller.abort();
  await assert.rejects(reading, isAbort);
  assert.equal(seen.signal.aborted, true, 'the request in flight was cancelled');
});

test('signal: an abort mid-probe rejects with an AbortError, not a verdict', async () => {
  const { fetch, seen } = hangingFetch();
  const controller = new AbortController();
  const probing = groq.probeVision({ key: KEY, fetch, model: 'm', probeImage: PROBE, signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(probing, isAbort);
  assert.equal(seen.signal.aborted, true);
});

test('signal: the timeout still fires when a signal is passed and never aborts', async () => {
  const { fetch, seen } = hangingFetch();
  const controller = new AbortController();
  await assert.rejects(groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, signal: controller.signal, timeoutMs: 20 }),
    (err) => err instanceof groq.ProviderError && err.kind === 'timeout');
  assert.equal(seen.signal.aborted, true);
  assert.equal(controller.signal.aborted, false, 'the caller signal is not touched');
});

test('signal: the abort listener is removed when the request ends, so a later abort does nothing', async () => {
  const { fetch } = fakeFetch(() => chatOk('{}'));
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, fn, o) => { added++; return add(type, fn, o); };
  signal.removeEventListener = (type, fn, o) => { removed++; return remove(type, fn, o); };
  const out = await groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, signal });
  assert.equal(out.text, '{}');
  assert.equal(added, 1);
  assert.equal(removed, 1);
  controller.abort();
  await new Promise((r) => setImmediate(r));
});

test('queue + read: one signal stops the queue and the fetch together, with no retry', async () => {
  const { createQueue } = require('../../js/queue.js');
  const q = createQueue({ sleep: () => Promise.resolve() });
  const { fetch, seen } = hangingFetch();
  const controller = new AbortController();
  const signal = controller.signal;
  const reading = q.run(() => groq.read({ key: KEY, fetch, model: 'm', imageDataUrl: SLIP, signal }), { signal });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(reading, (err) => err.name === 'AbortError');
  assert.equal(seen.signal.aborted, true);
  assert.equal(await q.run(() => 'free'), 'free', 'the slot came back');
  assert.equal(seen.calls, 1);
});
