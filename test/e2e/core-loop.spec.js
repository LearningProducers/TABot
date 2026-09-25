'use strict';
// End to end, in a real browser engine.
//
// Test 1, the core loop: setup (and a second Check key that asks the blind
// models again), answer key, one photo of seven synthetic slips read on a
// mocked Groq with a 429 whose wait is shown (the file input already emptied
// by then), slips stored as they finish,
// grades on screen, a reload mid-class, a key correction that regrades, then
// Done: the spreadsheet downloads, the page asks whether it saved, Yes wipes
// every stored result, and nothing in the page leads back to the file.
// Test 2, the unhappy paths: a bad key, a photo with no slips, touching slips
// (asked about, then retaken), and slips that fail on every model: busy,
// unreachable, and a model Groq no longer serves.
// Test 3, cut short: a reload mid-photo and Stop reading both keep every
// slip already read; the reload names the photo that was cut off.
// Test 4, a slip much larger than the rest (asked about, read anyway), crops
// from the full-resolution photo, a read that gets no answer, and a question
// count that moved while the photo was read.
// Tests 5 to 7, storage: blocked site data (said in the flow at the top as
// the page loads), a page opened from a file, and a storage connection lost
// mid-class (said under Stop reading, never at the top), with Done after it
// saying what the file holds and what stays in the browser, then a reload
// that finishes the rest.
// Test 8, a key answer corrected while the first photo's reads are held: the
// stored marks and the spreadsheet follow the corrected key.
// Test 9, localStorage writes that throw: the note raised as the key field
// loses focus goes under the Check key status line, so one press runs the
// check; also with the page scrolled so Check key sits 10, 40, 70 or 100 px
// from the top of the screen.
// Test 10, storage lost partway through a photo: once Done has sent that
// photo's slips and the teacher said the file saved, the next load does not
// call it interrupted; a marker whose photo has every slip stored is cleared
// without a word.
// Test 11, Done asks "Did the file save?": No downloads again with the rows
// untouched, a reload or a new photo leaves the results unconfirmed, a key
// edit closes the question, and Yes clears.
// Test 12, results never confirmed saved are cleared 24 hours after the last
// photo: on load, by the once-a-minute check and when the page is shown
// again, never while a photo is being read, but while the question about a
// photo's slips waits on the teacher, and before a new photo's slips could
// renew them. The page's clock is the test hook's, moved ahead by the test.
// Test 13, a match setting per question: saved, restored, regrading the
// stored slips; exact form marks 6/8 wrong against 3/4 where value marks it
// right, and the reader/reviewer asterisk follows each question's setting.
// Test 14, the screen wake lock: held while a photo's slips are read, asked
// for again after the page is hidden and shown mid-read, released when the
// reading ends, fails or is stopped; never held while the page waits on the
// question about the slips, nor for a photo with none; a refusal is silent
// and never retried.
//
// Nothing here is real: photos are drawn by test/fixtures/synth.js, students
// and answers are made up, keys are fake strings, and every Groq call is
// answered by page.route. Any request to a host other than 127.0.0.1 and
// api.groq.com fails a test, and so does any console error, page error or
// Content-Security-Policy violation.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const synth = require('../fixtures/synth.js');
const { encodePng } = require('../fixtures/png.js');
const segment = require('../../js/segment.js');
const XLSX = require('../../vendor/xlsx.mini.min.js');

const GROQ = 'https://api.groq.com/openai/v1';
const PAGE_ORIGIN = 'http://127.0.0.1:8791';
const REPO = path.resolve(__dirname, '..', '..');
const KEY = 'gsk_e2e_FAKE_not_a_real_key_0123456789abcdef';
const WRONG_KEY = 'gsk_e2e_FAKE_wrong_key_9876543210fedcba';
const MINUS = String.fromCharCode(0x2212);
const CHECK = ' ' + String.fromCharCode(0x2713);
const CROSS = ' ' + String.fromCharCode(0x2717);

const ALPHA = 'mock/vision-alpha';
const BETA = 'mock/vision-beta';
// Listed out of order, with two models that refuse images and one inactive
// model that must never be probed.
const MODELS = [
  { id: 'mock/whisper-audio' },
  { id: BETA },
  { id: 'mock/text-only' },
  { id: ALPHA },
  { id: 'mock/retired-vision', active: false }
];
const VISION = new Set([ALPHA, BETA]);

// ---------------------------------------------------------------- fixtures

// Key: Q1 1/2 (1 pt), Q2 2x+6 (1 pt), Q3 -3 (2 pts), Q4 0.75 (1 pt). Max 5.
const ANSWER_KEY = [['1/2', '1'], ['2x+6', '1'], ['-3', '2'], ['0.75', '1']];
// A two-question key for the tests that are not about grading.
const SHORT_KEY = [['1/2', '1'], ['4', '1']];

// Seven made-up students in the order layoutGrid places their slips. Scores
// worked out by hand against the key above; correct marks per question.
const STUDENTS = [
  { name: 'Ada Fixture', answers: ['0.5', '2(x+3)', MINUS + '3', '3/4'], correct: [1, 1, 1, 1], score: 5 },
  { name: 'Ben Fixture', answers: ['2/4', '2x+3', '-3', '.75'], correct: [1, 0, 1, 1], score: 4, reviewerQ4: '1.75' },
  { name: 'Cal Fixture', answers: ['1/3', '6+2x', '3', '75%'], correct: [0, 1, 0, 1], score: 2 },
  { name: 'Dee Fixture', answers: ['', '2x+6', '-3', '0.7'], correct: [0, 1, 1, 0], score: 3 },
  { name: 'Eli Fixture', answers: ['1 / 2', 'x+6', '-3.0', '3/4'], correct: [1, 0, 1, 1], score: 4 },
  { name: 'Fay Fixture', answers: ['0.50', '2*x+6', '-3', '0.25'], correct: [1, 1, 1, 0], score: 4 },
  { name: 'Gus Fixture', answers: ['1', '2x', '-6/2', '1'], correct: [0, 0, 1, 0], score: 2 }
];
// The same class with Q1 worth 2 points (max 6), for the regrade check.
const SCORES_Q1_TWO_POINTS = ['6/6', '5/6', '2/6', '3/6', '5/6', '5/6', '2/6'];
// Ben's reviewer reads Q4 as 1.75: the one disagreement, so the one asterisk.
const FLAGGED_STUDENT = 'Ben Fixture';
// Slip 3's first read on ALPHA gets a 400, so BETA must take that crop.
const FALLBACK_SLIP = 2;

// Test 2's three students, left to right. Hal's second read, Ivy's first
// read and Jo's first read are broken on purpose.
const TRIO_STUDENTS = [
  { name: 'Hal Fixture', answers: ['0.5', '4'] },
  { name: 'Ivy Fixture', answers: ['1/2', '5'] },
  { name: 'Jo Fixture', answers: ['2/4', '4'] }
];
// Test 3's five students.
const FIVE_STUDENTS = [
  { name: 'Kit Fixture', answers: ['1/2', '4'] },
  { name: 'Lou Fixture', answers: ['0.5', '5'] },
  { name: 'Max Fixture', answers: ['2/4', '4'] },
  { name: 'Ned Fixture', answers: ['1', '4'] },
  { name: 'Oda Fixture', answers: ['', '4'] }
];
// Test 4's three students (four questions each).
const BIG_STUDENTS = [
  { name: 'Pia Fixture', answers: ['1/2', '2x+6', '-3', '0.75'] },
  { name: 'Quin Fixture', answers: ['0.5', '2x+6', '-3', '3/4'] },
  { name: 'Rae Fixture', answers: ['1/3', '2x', '3', '0.75'] }
];

// Truth in the page's reading order; each rect keeps the index of its student.
function inReadingOrder(truth) {
  return segment.readingOrder(truth.map((t, i) => Object.assign({ student: i }, t)));
}

function photoOf(size, slips) {
  const photo = synth.makePhoto(Object.assign({ slips }, size));
  return { png: encodePng(photo.raster), ordered: inReadingOrder(photo.truth) };
}

function classPhoto() {
  const size = { width: 2000, height: 1500, seed: 11 };
  return photoOf(size, synth.layoutGrid(STUDENTS.length, size));
}

// Test 2's photos: an empty surface, five slips of which two touch, and three
// slips (Hal, Ivy and Jo) whose reads the mock breaks on purpose.
function unhappyPhotos() {
  const size = { width: 1600, height: 1200, seed: 5 };
  const blank = synth.makePhoto(Object.assign({ slips: [] }, size));
  const touching = synth.makePhoto(Object.assign({
    slips: [
      { cx: 300, cy: 300, w: 420, h: 280, angleDeg: 3 },
      { cx: 1250, cy: 300, w: 420, h: 280, angleDeg: -4 },
      { cx: 300, cy: 900, w: 420, h: 280, angleDeg: 2 },
      { cx: 900, cy: 850, w: 420, h: 280, angleDeg: 0 },
      { cx: 1200, cy: 950, w: 420, h: 280, angleDeg: 18 }
    ]
  }, size));
  return {
    blank: encodePng(blank.raster),
    touching: encodePng(touching.raster),
    trio: trioPhoto()
  };
}

function trioPhoto() {
  return photoOf({ width: 1600, height: 1200, seed: 5 }, [
    { cx: 300, cy: 600, w: 420, h: 290, angleDeg: 4 },
    { cx: 800, cy: 600, w: 420, h: 290, angleDeg: -6 },
    { cx: 1300, cy: 600, w: 420, h: 290, angleDeg: 3 }
  ]);
}

function fivePhoto() {
  const size = { width: 1600, height: 1200, seed: 7 };
  return photoOf(size, synth.layoutGrid(FIVE_STUDENTS.length, size));
}

// 3000 x 2000: bigger than the 2400 px the crops used to be cut from. Two
// slips of 900 x 600 and one of 1500 x 1000 (2.8 times their area).
function bigPhoto() {
  return photoOf({ width: 3000, height: 2000, seed: 23 }, [
    { cx: 620, cy: 560, w: 900, h: 600, angleDeg: -4 },
    { cx: 2000, cy: 1000, w: 1500, h: 1000, angleDeg: 3 },
    { cx: 620, cy: 1460, w: 900, h: 600, angleDeg: 5 }
  ]);
}

const CLASS = classPhoto();
const EXPECTED = CLASS.ordered.map((t) => STUDENTS[t.student]);

// ---------------------------------------------------------------- Groq mock

function completion(model, content) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2100, completion_tokens: 60, total_tokens: 2160 }
  };
}

// student.reviewerAnswers, when set, is what the second read returns instead.
function readingReply(model, student, pass) {
  const texts = pass === 'reviewer' && student.reviewerAnswers ? student.reviewerAnswers : student.answers;
  const answers = texts.map((answer, i) => ({ q: i + 1, answer, confidence: 0.95 }));
  if (pass === 'reviewer' && student.reviewerQ4) answers[3].answer = student.reviewerQ4;
  return { status: 200, body: completion(model, JSON.stringify({ student_name: student.name, answers, note: '' })) };
}

function errorReply(status, message, type) {
  return { status, body: { error: { message, type: type || 'invalid_request_error' } } };
}

// The connection drops: no answer at all (the page's fetch fails).
const NO_ANSWER = { abort: true };

function imageOf(body) {
  const user = (body.messages || []).find((m) => m.role === 'user');
  const part = user && Array.isArray(user.content) ? user.content.find((p) => p.type === 'image_url') : null;
  return part ? part.image_url.url : null;
}

// answerRead(crop, model, entry) -> {status, body}, NO_ANSWER, or a promise
// of either (mock.hold) for a read of a known crop. Any request whose
// Authorization is not "Bearer <KEY>" gets a 401.
function createGroqMock(answerRead) {
  const crops = new Map(); // image data URL -> {photoIndex, slipIndex, pass, dataUrl}
  const cropList = [];
  const log = []; // every non-preflight Groq request, with the status it got
  const failures = [];
  const held = []; // requests the mock is sitting on, each with its release

  function recordCrop(photoIndex, slipIndex, pass, dataUrl) {
    const crop = { photoIndex, slipIndex, pass, dataUrl };
    crops.set(dataUrl, crop);
    cropList.push(crop);
    return true;
  }

  // Holds a request unanswered until release(); reply() makes the answer.
  // A request the page gives up on meanwhile (Stop reading, a reload) finds
  // no one to take the answer, and its entry is marked dropped.
  function hold(entry, reply) {
    entry.held = true;
    return new Promise((resolve) => {
      held.push({ entry, release: () => resolve(reply()) });
    });
  }

  function release() {
    held.splice(0).forEach((h) => h.release());
  }

  function answer(entry, body) {
    if (entry.headers.authorization !== 'Bearer ' + KEY) {
      entry.kind = entry.kind || 'rejected';
      return errorReply(401, 'Invalid API Key', 'invalid_request_error');
    }
    if (entry.method === 'GET' && entry.path === '/openai/v1/models') {
      entry.kind = 'list';
      return {
        status: 200,
        body: {
          object: 'list',
          data: MODELS.map((m) => ({
            id: m.id, object: 'model', created: 1700000000, owned_by: 'Mock',
            active: m.active !== false, context_window: 131072, public_apps: null
          }))
        }
      };
    }
    if (entry.method === 'POST' && entry.path === '/openai/v1/chat/completions') {
      entry.model = body.model;
      if (!body.response_format) {
        entry.kind = 'probe';
        if (VISION.has(body.model)) return { status: 200, body: completion(body.model, 'OK') };
        return errorReply(400, 'model `' + body.model + '` does not support image input');
      }
      entry.kind = 'read';
      entry.responseFormat = body.response_format;
      const crop = crops.get(imageOf(body));
      if (!crop) {
        failures.push('a read arrived for an image the onCrop hook never saw');
        return errorReply(400, 'unknown image');
      }
      entry.crop = crop;
      return answerRead(crop, body.model, entry);
    }
    failures.push('unexpected Groq request: ' + entry.method + ' ' + entry.path);
    return errorReply(404, 'not mocked');
  }

  async function handle(route) {
    const req = route.request();
    const headers = await req.allHeaders();
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: Object.assign({
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': headers['access-control-request-headers'] || 'authorization, content-type',
          'access-control-max-age': '600'
        }, cors)
      });
    }
    const entry = {
      method: req.method(),
      path: new URL(req.url()).pathname,
      url: req.url(),
      headers,
      body: req.postData() || ''
    };
    log.push(entry);
    const out = await answer(entry, entry.method === 'POST' ? JSON.parse(entry.body) : null);
    entry.status = out.abort ? 0 : out.status;
    try {
      if (out.abort) return await route.abort('failed');
      return await route.fulfill({
        status: out.status,
        headers: Object.assign({ 'content-type': 'application/json' }, cors),
        body: JSON.stringify(out.body)
      });
    } catch (err) {
      entry.dropped = true;
    }
  }

  return { crops, cropList, log, failures, held, recordCrop, hold, release, handle };
}

function readsIn(mock) {
  return mock.log.filter((e) => e.kind === 'read');
}

// ---------------------------------------------------------------- guards

function allowedUrl(url, extra) {
  const u = String(url);
  return u.startsWith(PAGE_ORIGIN + '/') || u.startsWith('https://api.groq.com/') ||
    (extra || []).some((prefix) => u.startsWith(prefix));
}

// Routes Groq to the mock, blocks and records every other host, and collects
// requests, console errors, page errors and CSP violations. Object URLs the
// page makes and revokes are tracked, so a test can see which are still open.
async function guard(page, context, mock, extraAllowed) {
  const seen = { offHost: [], requests: [], consoleErrors: [], pageErrors: [], csp: [], extraAllowed: extraAllowed || [] };
  await context.route((url) => !allowedUrl(url, seen.extraAllowed), (route) => {
    seen.offHost.push(route.request().url());
    return route.abort();
  });
  await page.route(GROQ + '/**', mock.handle);
  page.on('request', (req) => {
    seen.requests.push({ url: req.url(), post: req.postData() || '', headers: req.allHeaders().catch(() => ({})) });
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') seen.consoleErrors.push({ text: msg.text(), url: msg.location().url || '' });
  });
  page.on('pageerror', (err) => seen.pageErrors.push(String(err)));
  await page.exposeFunction('__tabotRecordCrop', mock.recordCrop);
  await page.exposeFunction('__tabotCspViolation', (v) => { seen.csp.push(v); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__tabotCspViolation(e.violatedDirective + ' blocked ' + e.blockedURI);
    });
    window.__TABOT_TEST__ = {
      queue: { baseMs: 10, capMs: 40 },
      onCrop: (photoIndex, slipIndex, pass, dataUrl) => window.__tabotRecordCrop(photoIndex, slipIndex, pass, dataUrl),
      // The page's clock: real time plus whatever shiftClock set.
      now: () => Date.now() + (window.__tabotClockShift || 0)
    };
    const live = new Set();
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (obj) {
      const url = create.call(URL, obj);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      live.delete(url);
      return revoke.call(URL, url);
    };
    window.__tabotLiveUrls = () => Array.from(live);
  });
  return seen;
}

// Keys travel only to Groq, only as "Authorization: Bearer <key>".
async function expectKeysOnlyInAuthorization(mock, seen, keys) {
  expect(mock.log.length).toBeGreaterThan(0);
  for (const call of mock.log) {
    expect(keys.map((k) => 'Bearer ' + k)).toContain(call.headers.authorization);
    for (const key of keys) {
      expect(call.url).not.toContain(key);
      expect(call.body).not.toContain(key);
      for (const [name, value] of Object.entries(call.headers)) {
        if (name !== 'authorization') expect(value, 'header ' + name).not.toContain(key);
      }
    }
  }
  for (const req of seen.requests) {
    const headers = req.url.startsWith('https://api.groq.com/') ? {} : await req.headers;
    for (const key of keys) {
      expect(req.url).not.toContain(key);
      expect(req.post).not.toContain(key);
      for (const value of Object.values(headers)) expect(value).not.toContain(key);
    }
  }
}

// Nothing left the allowed hosts, and the console stayed clean. Browsers log
// the error statuses the mock sends on purpose ("Failed to load resource"),
// and a request the mock drops or the page stops; those lines, and only
// those, are set aside.
function expectCleanRun(mock, seen) {
  expect(seen.offHost).toEqual([]);
  expect(seen.requests.filter((r) => !allowedUrl(r.url, seen.extraAllowed))).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
  expect(seen.csp).toEqual([]);
  const sent = mock.log.filter((e) => e.status >= 400);
  const statuses = new Set(sent.map((e) => String(e.status)));
  const cut = mock.log.filter((e) => e.status === 0 || e.dropped);
  const deliberate = seen.consoleErrors.filter((e) => {
    const m = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(e.text);
    if (m) return statuses.has(m[1]) && e.url.startsWith('https://api.groq.com/');
    return cut.length > 0 && isCutRequestLine(e);
  });
  expect(seen.consoleErrors.filter((e) => deliberate.indexOf(e) < 0)).toEqual([]);
  expect(deliberate.length).toBeLessThanOrEqual(sent.length + cut.length);
  expect(mock.failures).toEqual([]);
}

// WebKit's page error for a Groq read cancelled by leaving the page.
const CANCELLED_BY_RELOAD = /^Fetch API cannot load https:\s*\/+api\.groq\.com\/openai\/v1\/chat\/completions due to access control checks\.$/;

// What each engine logs for a Groq request with no answer: Chromium names the
// failed load; WebKit names the load or blames access control.
function isCutRequestLine(e) {
  const groq = e.url.startsWith('https://api.groq.com/') || e.text.indexOf('https://api.groq.com/') >= 0;
  return groq && /^(Failed to load resource|Fetch API cannot load)/.test(e.text);
}

// ---------------------------------------------------------------- page helpers

// Width and height from a JPEG data URL's start-of-frame marker.
function jpegSize(dataUrl) {
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no start-of-frame marker in the JPEG');
}

function localDate(timeZone, when) {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
}

async function expectNoSideScroll(page) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 780 });
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }));
  expect(size.scroll, 'no horizontal scroll at 360 px').toBeLessThanOrEqual(size.client);
  await page.setViewportSize(original);
}

async function checkKey(page, key) {
  await page.fill('#api-key', key);
  await page.click('#check-key');
}

async function fillAnswerKey(page, rows) {
  await page.fill('#question-count', String(rows.length));
  await expect(page.locator('#question-rows .q-row')).toHaveCount(rows.length);
  for (let i = 0; i < rows.length; i++) {
    await page.fill('#q' + (i + 1) + '-answer', rows[i][0]);
    await page.fill('#q' + (i + 1) + '-points', rows[i][1]);
  }
}

async function setUp(page, answerKey) {
  await checkKey(page, KEY);
  await expect(page.locator('#setup-status')).toHaveText('2 of 4 models read images.');
  await fillAnswerKey(page, answerKey);
  await expect(page.locator('#take-photo')).toBeEnabled();
}

async function sendPhoto(page, name, png) {
  await page.locator('#upload-photo').setInputFiles({ name, mimeType: 'image/png', buffer: png });
}

async function expectResults(page, scores) {
  await expect(page.locator('#results tbody tr')).toHaveCount(EXPECTED.length);
  await expect(page.locator('#results td.student')).toHaveText(EXPECTED.map((s) => s.name));
  await expect(page.locator('#results td.score')).toHaveText(scores || EXPECTED.map((s) => s.score + '/5'));
  await expect(page.locator('#results td.flag')).toHaveText(EXPECTED.map((s) => (s.name === FLAGGED_STUDENT ? '* Q4' : '')));
}

function countStoredResults() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tabot');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['rows', 'meta'], 'readonly');
      const rows = tx.objectStore('rows').count();
      const meta = tx.objectStore('meta').count();
      tx.oncomplete = () => {
        db.close();
        resolve({ rows: rows.result, meta: meta.result });
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// Every stored row as [student, score, whether each answer was marked right],
// in reading order.
function storedMarks() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tabot');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['rows'], 'readonly');
      const req = tx.objectStore('rows').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve(req.result
          .sort((a, b) => a.photoIndex - b.photoIndex || a.slipIndex - b.slipIndex)
          .map((r) => [r.studentName, r.score, r.answers.map((a) => a.correct)]));
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// The ids in the store's meta table: 'meta' (the photo count), 'lastPhoto'
// (when the last slip was stored) once a slip is, and, while a photo is being
// read, 'inflight'.
function storedMetaIds() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tabot');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['meta'], 'readonly');
      const keys = tx.objectStore('meta').getAllKeys();
      tx.oncomplete = () => {
        db.close();
        resolve(keys.result.map(String).sort());
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// The time the store recorded for the last slip it stored, or null.
function storedLastPhotoAt() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tabot');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['meta'], 'readonly');
      const req = tx.objectStore('meta').get('lastPhoto');
      tx.oncomplete = () => {
        db.close();
        resolve(req.result ? req.result.lastPhotoAt : null);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// Moves the page's clock (the test hook's now(), which the store reads too)
// shiftMs ahead of real time, now and on every later load of the page.
async function shiftClock(page, shiftMs) {
  await page.addInitScript((ms) => { window.__tabotClockShift = ms; }, shiftMs);
  await page.evaluate((ms) => { window.__tabotClockShift = ms; }, shiftMs);
}

const HOUR = 60 * 60 * 1000;

// Writes an in-flight marker straight into the page's IndexedDB: what a page
// load that could not clear its marker leaves behind.
function storeInFlight(marker) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tabot');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['meta'], 'readwrite');
      tx.objectStore('meta').put({ id: 'inflight', photoIndex: marker.photoIndex, total: marker.total, done: marker.done });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// Lets the test close the page's IndexedDB connections and refuse every new
// one, the way Safari does when its IndexedDB server goes away. With
// window.__tabotHealOnDownload set, storage comes back the moment the page
// hands a spreadsheet to the browser: after Done's read, before its wipe.
// -> breakStorage().
async function breakableStorage(page) {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    window.__tabotConnections = [];
    IDBFactory.prototype.open = function () {
      if (window.__tabotBreakStorage) {
        throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
      }
      const req = open.apply(this, arguments);
      req.addEventListener('success', () => window.__tabotConnections.push(req.result));
      return req;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && window.__tabotHealOnDownload) window.__tabotBreakStorage = false;
      return click.apply(this, arguments);
    };
  });
  return () => page.evaluate(() => {
    window.__tabotBreakStorage = true;
    window.__tabotConnections.forEach((db) => db.close());
  });
}

// localStorage reads work and every write throws, the way a full storage does.
async function refuseSettingsWrites(page) {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
}

// The note a settings write that failed in step 1 raises: in the flow,
// directly under the Check key status line, below Check key, which has not
// moved (before: its box as the press began). The banner at the top stays as
// the page loaded it.
async function expectSetupNote(page, before) {
  const note = page.locator('#setup-storage');
  await expect(note).toContainText('This browser is not letting TABot save settings.');
  await expect(page.locator('#storage-warning')).toBeHidden();
  expect(await note.evaluate((n) => n.previousElementSibling.id)).toBe('setup-status');
  expect(await note.evaluate(outOfFlow)).toEqual([]);
  expect((await note.boundingBox()).y).toBeGreaterThanOrEqual(before.y + before.height);
  expect(await page.locator('#check-key').boundingBox()).toEqual(before);
}

// The node and its ancestors that sit outside the page's flow (fixed,
// absolute or sticky), as "tag#id position".
function outOfFlow(node) {
  const out = [];
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    const position = getComputedStyle(n).position;
    if (position !== 'static' && position !== 'relative') out.push(n.tagName.toLowerCase() + '#' + n.id + ' ' + position);
  }
  return out;
}

// True when leaving the page would ask first: a beforeunload listener
// cancels the event.
function leavingAsks() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// Every blob: address anywhere in the page's markup. (The CSP's own
// "blob:" source keyword is followed by a space, so it is not one.)
function blobReferences() {
  return document.documentElement.outerHTML.match(/blob:[^"'\s<>);]+/g) || [];
}

// Waits until both queue slots hold a read the mock is sitting on, then until
// every slip of that photo whose two reads were answered shows as a row.
// -> how many slips of the photo were answered (and so stored).
async function waitUntilStuck(page, mock, photoIndex, rowsBefore) {
  await expect.poll(() => mock.held.length).toBe(2);
  const answered = {};
  readsIn(mock).forEach((e) => {
    if (e.crop.photoIndex !== photoIndex || e.status !== 200) return;
    answered[e.crop.slipIndex] = (answered[e.crop.slipIndex] || 0) + 1;
  });
  const finished = Object.keys(answered).filter((k) => answered[k] === 2).length;
  await expect(page.locator('#results tbody tr')).toHaveCount(rowsBefore + finished);
  return finished;
}

function sheetRows(ws, width) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const out = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = 0; c < width; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? cell.v : '');
    }
    out.push(row);
  }
  return out;
}

// Presses a button that downloads the spreadsheet (by default Download, on
// Done's confirm), reads the file the browser receives, and checks the page
// then asks whether it saved. -> {name, wb}. Each file is saved under its own
// path, so none is overwritten.
let downloadsSaved = 0;
async function downloadSheet(page, testInfo, button) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(button || '#done-yes')]);
  const name = download.suggestedFilename();
  const file = testInfo.outputPath(++downloadsSaved + '-' + name);
  await download.saveAs(file);
  await expect(page.locator('#done-saved')).toBeVisible();
  await expect(page.locator('#done-saved-text')).toHaveText('Did the file save?');
  await expect(page.locator('#done-status')).toHaveText('Sent ' + name + ' to your downloads.');
  return { name, wb: XLSX.read(fs.readFileSync(file), { type: 'buffer' }) };
}

// Answers Yes to "Did the file save?".
async function confirmSaved(page) {
  await page.click('#saved-yes');
  await expect(page.locator('#done-saved')).toBeHidden();
}

function rosterNames(sheet) {
  return sheetRows(sheet.wb.Sheets.Roster, 1).slice(1).map((row) => row[0]);
}

function expectedRosterRow(student, slipIndex) {
  const flagged = student.name === FLAGGED_STUDENT;
  const cells = student.answers.map((a, i) => {
    let text = (a === '' ? '(blank)' : a) + (student.correct[i] ? CHECK : CROSS);
    if (flagged && i === 3) text += ' *';
    return text;
  });
  return [student.name, student.score, 5, student.score * 20].concat(cells, [
    flagged ? '*' : '',
    flagged ? 'Q4: reader .75, reviewer 1.75' : '',
    slipIndex === FALLBACK_SLIP ? BETA : ALPHA,
    ALPHA,
    'single-model review'
  ]);
}

// ---------------------------------------------------------------- test 1

test('photo to spreadsheet on a mocked Groq', async ({ page, context }, testInfo) => {
  let limited = null; // the crop whose first read got the 429
  let retryHeld = false;
  const mock = createGroqMock((crop, model, entry) => {
    const reply = () => readingReply(model, STUDENTS[CLASS.ordered[crop.slipIndex].student], crop.pass);
    // The first read (not the fallback slip) is rate limited once, and its
    // retry is held so the page can be looked at mid-read.
    if (!limited && crop.slipIndex !== FALLBACK_SLIP) {
      limited = crop;
      return errorReply(429, 'Rate limit reached (mock).', 'tokens');
    }
    if (crop === limited && !retryHeld) {
      retryHeld = true;
      return mock.hold(entry, reply);
    }
    if (crop.slipIndex === FALLBACK_SLIP && crop.pass === 'reader' && model === ALPHA) {
      return errorReply(400, 'mock: this model refused the request');
    }
    return reply();
  });
  const seen = await guard(page, context, mock);
  // The page's clock is faked (it runs at real speed until paused), so the
  // download link's lifetime can be measured at the end.
  await page.clock.install();
  await page.goto('/index.html');

  // The capture input opens the phone camera directly; upload has no capture.
  const take = page.locator('#take-photo');
  const upload = page.locator('#upload-photo');
  await expect(take).toHaveAttribute('capture', 'environment');
  await expect(take).toHaveAttribute('accept', 'image/*');
  await expect(upload).toHaveAttribute('accept', 'image/*');
  expect(await upload.getAttribute('capture')).toBeNull();
  await expect(take).toBeDisabled();
  await expect(page.locator('#done')).toBeDisabled();
  await expectNoSideScroll(page);

  // ---- 1 Setup: list, probe, pick.
  await checkKey(page, KEY);
  await expect(page.locator('#setup-status')).toHaveText('2 of 4 models read images.');
  await expect(page.locator('#model option')).toHaveText([ALPHA, BETA]);
  await expect(page.locator('#model')).toHaveValue(ALPHA);
  const probes = () => mock.log.filter((e) => e.kind === 'probe').map((e) => e.model);
  expect(probes().sort()).toEqual(['mock/text-only', ALPHA, BETA, 'mock/whisper-audio']);

  // Check key again: the two models cached as blind are asked again (a
  // refusal can end), the two that read images are trusted.
  await page.click('#check-key');
  await expect.poll(() => probes().length).toBe(6);
  await expect(page.locator('#check-key')).toBeEnabled();
  await expect(page.locator('#setup-status')).toHaveText('2 of 4 models read images.');
  expect(probes().slice(4).sort()).toEqual(['mock/text-only', 'mock/whisper-audio']);
  await expect(page.locator('#model option')).toHaveText([ALPHA, BETA]);

  // ---- 2 Answer key.
  await page.fill('#assignment', 'Unit 3 Quiz');
  await fillAnswerKey(page, ANSWER_KEY);
  await expect(page.locator('#pass-percent')).toHaveValue('70');
  await expect(take).toBeEnabled();

  // ---- 3 Photo, looked at mid-read while the retry after the 429 is held.
  await sendPhoto(page, 'slips.png', CLASS.png);
  await expect.poll(() => mock.held.length).toBe(1);
  // The chosen file was let go as soon as it was decoded: the input no
  // longer holds it while the slips are read.
  expect(await upload.evaluate((input) => input.files.length)).toBe(0);
  await expect(page.locator('#photo-found')).toHaveText('Found ' + CLASS.ordered.length + ' slips.');
  await expect(page.locator('#photo-wait')).toHaveText(
    'Groq is busy; waiting 1 s before retrying slip ' + (limited.slipIndex + 1) + '.');
  // Every other slip is stored the moment its two reads finish.
  await expect(page.locator('#results tbody tr')).toHaveCount(CLASS.ordered.length - 1);
  await expect(page.locator('#stop-reading')).toBeVisible();
  await expect(page.locator('#done')).toBeDisabled();
  await expect(page.locator('#done-hint')).toHaveText('Stop reading to finish.');
  await expect(page.locator('#question-count')).toBeDisabled();
  await expect(page.locator('#results .discard')).toBeDisabled();
  expect(await page.evaluate(leavingAsks)).toBe(true);

  mock.release();
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.', { timeout: 60000 });
  await expect(page.locator('#photo-found')).toHaveText('Found ' + CLASS.ordered.length + ' slips.');
  await expect(page.locator('#photo-error')).toBeHidden();
  await expect(page.locator('#photo-wait')).toBeEmpty();
  await expect(page.locator('#stop-reading')).toBeHidden();
  await expect(page.locator('#done-hint')).toBeHidden();
  await expect(page.locator('#results .discard')).toBeEnabled();
  expect(await page.evaluate(leavingAsks)).toBe(false);
  expect(await upload.evaluate((input) => input.files.length)).toBe(0);
  await expectResults(page);
  await expectNoSideScroll(page);

  // Every slip went out twice (reader crop, enhanced reviewer copy), each
  // shown to the hook before it was sent, each the size of its slip.
  expect(mock.cropList).toHaveLength(CLASS.ordered.length * 2);
  CLASS.ordered.forEach((truth, slipIndex) => {
    const reader = mock.cropList.find((c) => c.slipIndex === slipIndex && c.pass === 'reader');
    const reviewer = mock.cropList.find((c) => c.slipIndex === slipIndex && c.pass === 'reviewer');
    expect(reader && reviewer, 'slip ' + slipIndex + ' read twice').toBeTruthy();
    expect(reader.photoIndex).toBe(0);
    expect(reader.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(reviewer.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(reviewer.dataUrl).not.toBe(reader.dataUrl);
    const size = jpegSize(reader.dataUrl);
    expect(size.width).toBeGreaterThanOrEqual(Math.floor(truth.w) - 2);
    expect(size.width).toBeLessThanOrEqual(Math.ceil(truth.w) + 40);
    expect(size.height).toBeGreaterThanOrEqual(Math.floor(truth.h) - 2);
    expect(size.height).toBeLessThanOrEqual(Math.ceil(truth.h) + 40);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1280);
    expect(jpegSize(reviewer.dataUrl)).toEqual(size);
  });
  expect(mock.failures).toEqual([]);

  // One 429, retried on the same model; one 400, taken over by the next model.
  const reads = readsIn(mock);
  expect(reads).toHaveLength(CLASS.ordered.length * 2 + 2);
  expect(reads.every((e) => VISION.has(e.model) && e.responseFormat.type === 'json_object')).toBe(true);
  const limitedReads = reads.filter((e) => e.status === 429);
  expect(limitedReads).toHaveLength(1);
  const sameCrop = reads.filter((e) => e.crop === limitedReads[0].crop);
  expect(sameCrop.map((e) => [e.model, e.status])).toEqual([[ALPHA, 429], [ALPHA, 200]]);
  const fallback = reads.filter((e) => e.crop.slipIndex === FALLBACK_SLIP && e.crop.pass === 'reader');
  expect(fallback.map((e) => [e.model, e.status])).toEqual([[ALPHA, 400], [BETA, 200]]);
  // The photo finished, so no in-flight marker is left behind.
  expect(await page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);

  // ---- Reload mid-class: everything comes back from the store, no new calls.
  const groqCallsBeforeReload = mock.log.length;
  await page.reload();
  await expectResults(page);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await expect(page.locator('#model')).toHaveValue(ALPHA);
  await expect(page.locator('#q3-points')).toHaveValue('2');
  await expect(page.locator('#question-count')).toBeDisabled();
  await expect(page.locator('#photo-error')).toBeHidden();
  expect(mock.log.length).toBe(groqCallsBeforeReload);

  // ---- A key correction regrades the stored slips, and back again.
  await page.fill('#q1-points', '2');
  await expect(page.locator('#results td.score')).toHaveText(SCORES_Q1_TWO_POINTS);
  await page.fill('#q1-points', '1');
  await expectResults(page);

  // ---- Done: confirm in the page, download, then "Did the file save?";
  // nothing is deleted until Yes. The reserved "review" setting stands in for
  // any non-key entry, which the wipe must remove.
  await page.evaluate(() => localStorage.setItem('tabot.review', '"reserved"'));
  const timeZone = testInfo.project.use.timezoneId;
  const dayBefore = localDate(timeZone, new Date());
  await page.click('#done');
  await expect(page.locator('#done-confirm')).toBeVisible();
  await expect(page.locator('#done-confirm-text')).toHaveText('The spreadsheet for 7 students downloads, and then TABot ' +
    'asks whether it saved. Nothing is deleted from this browser until you say the file saved. Your key and answer key stay.');
  await expect(page.locator('#done-yes')).toHaveText('Download');
  // Time stands still from here, so the object URL's life can be measured.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#done-yes')]);
  const dayAfter = localDate(timeZone, new Date());
  const names = [dayBefore, dayAfter].map((d) => 'TABot_Unit-3-Quiz_' + d + '.xlsx');
  expect(names).toContain(download.suggestedFilename());

  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  expect(wb.SheetNames).toEqual(['Roster', 'Summary']);

  const roster = sheetRows(wb.Sheets.Roster, 13);
  expect(roster[0]).toEqual(['Student', 'Score', 'Max', 'Percent', 'Q1', 'Q2', 'Q3', 'Q4',
    'Flags', 'Notes', 'Read by', 'Reviewed by', 'Review']);
  expect(roster.slice(1)).toEqual(EXPECTED.map(expectedRosterRow));

  // Percents 100, 80, 40, 60, 80, 80, 40: mean 480/7, median 80, 4 of 7 at
  // or above 70. Hit rates Q1 4/7, Q2 4/7, Q3 6/7, Q4 4/7. Every question is
  // matched by value.
  expect(sheetRows(wb.Sheets.Summary, 3)).toEqual([
    ['Students', 7, ''],
    ['Mean %', 68.6, ''],
    ['Median %', 80, ''],
    ['Pass rate % (pass at 70%)', 57.1, ''],
    ['Rows with flags', 1, ''],
    ['Single-model review rows', 7, ''],
    ['', '', ''],
    ['Question', 'Hit rate %', 'Match'],
    ['Q1', 57.1, 'value'],
    ['Q2', 57.1, 'value'],
    ['Q3', 85.7, 'value'],
    ['Q4', 57.1, 'value'],
    ['', '', ''],
    ['Score band', 'Students', ''],
    ['0-9%', 0, ''], ['10-19%', 0, ''], ['20-29%', 0, ''], ['30-39%', 0, ''], ['40-49%', 2, ''],
    ['50-59%', 0, ''], ['60-69%', 1, ''], ['70-79%', 0, ''], ['80-89%', 3, ''], ['90-100%', 1, '']
  ]);

  // The page asks, and every result is still stored until the teacher answers.
  await expect(page.locator('#done-saved')).toBeVisible();
  await expect(page.locator('#done-saved-text')).toHaveText('Did the file save?');
  await expect(page.locator('#saved-yes')).toHaveText('Yes, clear the results');
  await expect(page.locator('#saved-no')).toHaveText('No, download again');
  await expect(page.locator('#done')).toBeHidden();
  await expect(page.locator('#done-status')).toHaveText('Sent ' + download.suggestedFilename() + ' to your downloads.');
  await expectResults(page);
  expect((await page.evaluate(countStoredResults)).rows).toBe(7);

  // Yes: no stored rows, and only the four settings are left.
  await confirmSaved(page);
  await expect(page.locator('#done-status')).toHaveText('Every result is cleared from this browser.');
  await expect(page.locator('#results tbody tr')).toHaveCount(0);
  await expect(page.locator('#results-empty')).toBeVisible();
  await expect(page.locator('#done')).toBeVisible();
  await expect(page.locator('#done')).toBeDisabled();
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });
  const stored = await page.evaluate(() => Object.keys(localStorage).sort());
  expect(stored).toEqual(['tabot.answerKey', 'tabot.key.groq', 'tabot.model.groq', 'tabot.vision.groq']);

  // Nothing in the page leads back to the spreadsheet: no download-again
  // link and no blob: address anywhere. The one object URL lives 30 s after
  // the click, so Safari can start the download, and is then revoked.
  expect(await page.locator('#download-again').count()).toBe(0);
  expect(await page.evaluate(blobReferences)).toEqual([]);
  expect(await page.evaluate(() => window.__tabotLiveUrls().length)).toBe(1);
  await page.clock.runFor(29000);
  expect(await page.evaluate(() => window.__tabotLiveUrls().length)).toBe(1);
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => window.__tabotLiveUrls())).toEqual([]);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 2

test('plain-language errors, failed reads, and discard', async ({ page, context }) => {
  const photos = unhappyPhotos();
  const studentOf = (crop) => photos.trio.ordered[crop.slipIndex].student;
  // Hal's second read gets 503 on every try. Ivy's first read gets 429 on
  // every try (busy). Jo's first read gets 404 from ALPHA (a model Groq no
  // longer serves) and no answer at all from BETA (unreachable).
  const mock = createGroqMock((crop, model) => {
    const student = studentOf(crop);
    if (student === 0 && crop.pass === 'reviewer') return errorReply(503, 'mock: service unavailable', 'server_error');
    if (student === 1 && crop.pass === 'reader') return errorReply(429, 'Rate limit reached (mock).', 'tokens');
    if (student === 2 && crop.pass === 'reader') {
      if (model === ALPHA) {
        return errorReply(404, 'The model `' + ALPHA + '` does not exist or you do not have access to it.', 'invalid_request_error');
      }
      return NO_ANSWER;
    }
    return readingReply(model, TRIO_STUDENTS[student], crop.pass);
  });
  const seen = await guard(page, context, mock);
  await page.goto('/index.html');

  // ---- A bad key is named as a bad key, and the camera stays off.
  await checkKey(page, WRONG_KEY);
  await expect(page.locator('#setup-error')).toContainText('Groq did not accept this key.');
  await expect(page.locator('#model-field')).toBeHidden();
  await expect(page.locator('#take-photo')).toBeDisabled();
  await expect(page.locator('#photo-hint')).toContainText('Press Check key in step 1');

  await checkKey(page, KEY);
  await expect(page.locator('#setup-status')).toHaveText('2 of 4 models read images.');
  await expect(page.locator('#setup-error')).toBeHidden();

  // ---- An answer key with a blank answer keeps the camera off.
  await fillAnswerKey(page, [['1/2', '1'], ['', '1']]);
  await expect(page.locator('#photo-hint')).toContainText('Fill in the answer to Q2 in step 2.');
  await expect(page.locator('#take-photo')).toBeDisabled();
  await page.fill('#q2-answer', '4');
  await expect(page.locator('#take-photo')).toBeEnabled();

  // ---- No slips: say so, with the capture tips.
  await sendPhoto(page, 'empty-table.png', photos.blank);
  await expect(page.locator('#photo-error')).toContainText('No slips found in this photo.');
  await expect(page.locator('#photo-error li')).toHaveCount(4);
  await expect(page.locator('#photo-error')).toContainText('dark or colored surface');
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');

  // ---- Touching slips: nothing is read until the teacher answers; Retake
  // sets the photo aside.
  await sendPhoto(page, 'touching.png', photos.touching);
  await expect(page.locator('#photo-found')).toHaveText('Found 4 slips. One looks like two slips touching.');
  await expect(page.locator('#photo-check')).toBeVisible();
  await expect(page.locator('#read-anyway')).toBeVisible();
  await expect(page.locator('#retake')).toBeVisible();
  await expect(page.locator('#question-count')).toBeDisabled();
  await expect(page.locator('#done-hint')).toHaveText('Choose Read anyway or Retake first.');
  await expect(page.locator('#stop-reading')).toBeHidden();
  expect(readsIn(mock)).toHaveLength(0);
  await page.click('#retake');
  await expect(page.locator('#photo-check')).toBeHidden();
  await expect(page.locator('#photo-found')).toHaveText(
    'Photo set aside; nothing was read. Take it again once the slips are spread out.');
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(page.locator('#results tbody tr')).toHaveCount(0);
  await expect(page.locator('#question-count')).toBeEnabled();
  expect(readsIn(mock)).toHaveLength(0);

  // ---- Slips that fail on every model after retries are named, busy and
  // unreachable told apart; the slip whose second read failed is kept and
  // flagged. The retaken photo used no photo number.
  await sendPhoto(page, 'trio.png', photos.trio.png);
  await expect(page.locator('#photo-error')).toContainText(
    '2 of 3 slips could not be read, even after retries and trying every model.', { timeout: 60000 });
  await expect(page.locator('#photo-error')).toContainText('Slip 2: Groq stayed busy, even after waiting and retrying.');
  await expect(page.locator('#photo-error')).toContainText('Slip 3: No answer from Groq; check the connection.');
  await expect(page.locator('#photo-error')).toContainText('Press Check key in step 1 to refresh the model list.');
  await expect(page.locator('#photo-found')).toHaveText('Found 3 slips.');
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(page.locator('#results .photo-head h3')).toHaveText(['Photo 1 (1 slip)']);
  await expect(page.locator('#results td.student')).toHaveText(['Hal Fixture']);
  await expect(page.locator('#results td.score')).toHaveText(['2/2']);
  await expect(page.locator('#results td.flag')).toHaveText(['* no second read']);

  // Eight tries on each vision model for a busy or failing Groq, three for no
  // answer, one for a model that is gone.
  const readsOf = (student, pass) => readsIn(mock).filter((e) => studentOf(e.crop) === student && e.crop.pass === pass);
  const eightEach = (status) => Array(8).fill([ALPHA, status]).concat(Array(8).fill([BETA, status]));
  expect(readsOf(0, 'reviewer').map((e) => [e.model, e.status])).toEqual(eightEach(503));
  expect(readsOf(1, 'reader').map((e) => [e.model, e.status])).toEqual(eightEach(429));
  expect(readsOf(2, 'reader').map((e) => [e.model, e.status])).toEqual([[ALPHA, 404], [BETA, 0], [BETA, 0], [BETA, 0]]);

  // ---- Discard the photo: asked once in the page, then gone from the store.
  await page.click('#results .discard');
  await expect(page.locator('#results .confirm')).toBeVisible();
  await page.click('#results .confirm .btn-primary');
  await expect(page.locator('#results tbody tr')).toHaveCount(0);
  await expect(page.locator('#results-empty')).toBeVisible();
  await expect(page.locator('#done')).toBeDisabled();
  expect((await page.evaluate(countStoredResults)).rows).toBe(0);
  await expectNoSideScroll(page);

  await expectKeysOnlyInAuthorization(mock, seen, [WRONG_KEY, KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 3

test('a reload mid-photo and Stop reading keep every slip already read', async ({ page, context }) => {
  const five = fivePhoto();
  // Slips 1 and 2 of every photo are answered; the reads of slips 3 to 5
  // hang until the test lets them go.
  const mock = createGroqMock((crop, model, entry) => {
    const reply = () => readingReply(model, FIVE_STUDENTS[five.ordered[crop.slipIndex].student], crop.pass);
    return crop.slipIndex >= 2 ? mock.hold(entry, reply) : reply();
  });
  const seen = await guard(page, context, mock);
  await page.goto('/index.html');
  await setUp(page, SHORT_KEY);

  // ---- Photo 1 is cut off by a reload. The slips already read were stored
  // as they finished; the page asks before leaving, and after the reload it
  // names the photo, once.
  await sendPhoto(page, 'five.png', five.png);
  const saved1 = await waitUntilStuck(page, mock, 0, 0);
  expect(saved1).toBeGreaterThan(0);
  expect(await page.evaluate(storedMetaIds)).toEqual(['inflight', 'lastPhoto', 'meta']);
  expect(await page.evaluate(leavingAsks)).toBe(true);
  const dialogs = [];
  const onDialog = (dialog) => {
    dialogs.push(dialog.type());
    return dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss();
  };
  page.on('dialog', onDialog);
  const errorsBeforeReload = seen.pageErrors.length;
  await page.reload();
  page.off('dialog', onDialog);
  expect(dialogs.filter((t) => t !== 'beforeunload')).toEqual([]);
  // WebKit reports each Groq request the reload cancels mid-flight as a page
  // error on the page being left; those lines, and only those, are set aside.
  const fromReload = seen.pageErrors.splice(errorsBeforeReload);
  expect(fromReload.filter((text) => !CANCELLED_BY_RELOAD.test(text))).toEqual([]);
  expect(fromReload.length).toBeLessThanOrEqual(mock.held.length);
  mock.release(); // the reload cancelled those requests; the replies go nowhere

  await expect(page.locator('#results tbody tr')).toHaveCount(saved1);
  await expect(page.locator('#photo-error')).toContainText(
    'Photo 1 was interrupted after ' + saved1 + ' of 5 slips; take it again to read the rest.');
  await expect.poll(() => page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);
  expect(await page.evaluate(leavingAsks)).toBe(false);
  await page.reload();
  await expect(page.locator('#results tbody tr')).toHaveCount(saved1);
  await expect(page.locator('#photo-error')).toBeHidden();

  // ---- Photo 2 is stopped by the teacher: the hanging reads are cancelled,
  // nothing queued goes out, and the page says what was saved.
  await sendPhoto(page, 'five.png', five.png);
  const saved2 = await waitUntilStuck(page, mock, 1, saved1);
  expect(saved2).toBeGreaterThan(0);
  await expect(page.locator('#done')).toBeDisabled();
  await expect(page.locator('#done-hint')).toHaveText('Stop reading to finish.');
  const readsBeforeStop = readsIn(mock).length;
  await page.click('#stop-reading');
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  const left = 5 - saved2;
  await expect(page.locator('#photo-error')).toContainText(
    'Stopped reading photo 2. ' + saved2 + ' of 5 slips ' + (saved2 === 1 ? 'was' : 'were') + ' saved; the other ' +
    left + (left === 1 ? ' needs' : ' need') + ' a retake.');
  await expect(page.locator('#photo-error')).toContainText('counted left to right, top row first');
  await expect(page.locator('#stop-reading')).toBeHidden();
  await expect(page.locator('#done-hint')).toBeHidden();
  await expect(page.locator('#done')).toBeEnabled();
  await expect(page.locator('#results tbody tr')).toHaveCount(saved1 + saved2);
  await expect(page.locator('#results .photo-head h3')).toHaveText([
    'Photo 1 (' + saved1 + ' slip' + (saved1 === 1 ? '' : 's') + ')',
    'Photo 2 (' + saved2 + ' slip' + (saved2 === 1 ? '' : 's') + ')'
  ]);
  expect(await page.evaluate(leavingAsks)).toBe(false);
  expect(await page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);

  // The page finished while the mock still held both reads in flight, so
  // they were cancelled, not waited for; answering them now changes nothing,
  // and no queued read went out after Stop.
  expect(mock.held).toHaveLength(2);
  mock.release();
  await page.waitForTimeout(300);
  await expect(page.locator('#results tbody tr')).toHaveCount(saved1 + saved2);
  expect(readsIn(mock).length).toBe(readsBeforeStop);

  // ---- Done still works on what was saved, and pagehide revokes the
  // spreadsheet's object URL at once.
  await page.click('#done');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#done-yes')]);
  expect(download.suggestedFilename()).toMatch(/^TABot_assignment_\d{4}-\d{2}-\d{2}\.xlsx$/);
  await confirmSaved(page);
  await expect(page.locator('#done-status')).toHaveText('Every result is cleared from this browser.');
  expect(await page.evaluate(() => window.__tabotLiveUrls().length)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.__tabotLiveUrls())).toEqual([]);
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 4

test('a much larger slip is asked about, and crops come from the full photo', async ({ page, context }) => {
  const big = bigPhoto();
  let cut = null; // the read that gets no answer the first time
  let retryHeld = false;
  const mock = createGroqMock((crop, model, entry) => {
    const reply = () => readingReply(model, BIG_STUDENTS[big.ordered[crop.slipIndex].student], crop.pass);
    if (!cut && crop.slipIndex === 0 && crop.pass === 'reader') {
      cut = crop;
      return NO_ANSWER;
    }
    if (crop === cut && !retryHeld) {
      retryHeld = true;
      return mock.hold(entry, reply);
    }
    return reply();
  });
  const seen = await guard(page, context, mock);
  await page.goto('/index.html');
  await setUp(page, ANSWER_KEY);

  // ---- The big slip may be two slips side by side: nothing is read until
  // the teacher answers, and the question count is locked meanwhile.
  await sendPhoto(page, 'big.png', big.png);
  await expect(page.locator('#photo-found')).toHaveText(
    'Found 3 slips. One is much larger than the rest; if it is two slips side by side, retake the photo.');
  await expect(page.locator('#photo-check')).toBeVisible();
  await expect(page.locator('#question-count')).toBeDisabled();
  await expect(page.locator('#count-locked')).toHaveText('The number of questions is locked while a photo is read.');
  expect(readsIn(mock)).toHaveLength(0);

  // The backstop behind that lock: a count that moves anyway while the photo
  // is in hand is named when the photo finishes.
  await page.evaluate(() => {
    const count = document.getElementById('question-count');
    count.value = '3';
    count.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#read-anyway');
  await expect(page.locator('#photo-check')).toBeHidden();
  await expect(page.locator('#photo-found')).toHaveText('Found 3 slips.');

  // ---- One read gets no answer at all; the wait line says so while its
  // retry is held.
  await expect.poll(() => mock.held.length).toBe(1);
  await expect(page.locator('#photo-wait')).toHaveText(
    'No answer from Groq; check the connection. Trying slip 1 again in 1 s.');
  mock.release();
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(page.locator('#photo-wait')).toBeEmpty();
  await expect(page.locator('#results td.student')).toHaveText(big.ordered.map((t) => BIG_STUDENTS[t.student].name));
  await expect(page.locator('#photo-error')).toContainText(
    'The number of questions changed from 4 to 3 while photo 1 was read, so its slips were graded on 4 questions.');
  await expect(page.locator('#photo-error')).toContainText('Discard photo 1, then take it again to grade it on 3.');
  expect(readsIn(mock).filter((e) => e.crop === cut).map((e) => e.status)).toEqual([0, 200]);

  // ---- Crops are cut from the full 3000 px photo, not a 2400 px copy: a
  // 900 px slip reaches the model at about 900 px, and the big one at the
  // 1280 px limit.
  big.ordered.forEach((truth, slipIndex) => {
    const reader = mock.cropList.find((c) => c.slipIndex === slipIndex && c.pass === 'reader');
    const size = jpegSize(reader.dataUrl);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1280);
    if (Math.max(truth.w, truth.h) > 1280) {
      expect(Math.max(size.width, size.height)).toBe(1280);
    } else {
      expect(size.width).toBeGreaterThanOrEqual(Math.floor(truth.w) - 6);
      expect(size.width).toBeLessThanOrEqual(Math.ceil(truth.w) + 50);
      expect(size.height).toBeGreaterThanOrEqual(Math.floor(truth.h) - 6);
      expect(size.height).toBeLessThanOrEqual(Math.ceil(truth.h) + 50);
    }
  });

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- tests 5 to 7

test('with site data blocked, the session still works and says nothing is kept', async ({ page, context }) => {
  const trio = trioPhoto();
  const mock = createGroqMock((crop, model) => readingReply(model, TRIO_STUDENTS[trio.ordered[crop.slipIndex].student], crop.pass));
  const seen = await guard(page, context, mock);
  // The browser refuses localStorage (it throws) and has no IndexedDB.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); }
    });
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { return undefined; } });
  });
  await page.goto('/index.html');
  const banner = page.locator('#storage-warning');
  await expect(banner).toContainText(
    'This session works, but nothing is kept after the tab closes, so finish with Done before leaving the page.');
  // Known as the page loads: said in the flow, at the top, above everything
  // the teacher can press, before the first touch.
  expect(await banner.evaluate(outOfFlow)).toEqual([]);
  const bannerBox = await banner.boundingBox();
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual((await page.locator('h1').boundingBox()).y);
  const said = await banner.textContent();

  await setUp(page, SHORT_KEY);
  await expect(page.locator('#photo-hint')).toBeHidden();
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(page.locator('#results td.student')).toHaveText(trio.ordered.map((t) => TRIO_STUDENTS[t.student].name));
  await expect(page.locator('#photo-error')).toBeHidden();
  // Said once: nothing new at the top, and no note repeats it lower down.
  await expect(banner).toHaveText(said);
  await expect(page.locator('.note:not([hidden])')).toHaveCount(0);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

test('opened from a file, the page keeps nothing and points to the https copy', async ({ page, context }) => {
  const mock = createGroqMock(() => errorReply(400, 'no reads in this test'));
  const fileBase = 'file://' + REPO + '/';
  const seen = await guard(page, context, mock, [fileBase]);
  await page.goto(fileBase + 'index.html');
  const banner = page.locator('#storage-warning');
  await expect(banner).toContainText('TABot is running from a file on this device, so nothing is saved');
  await expect(banner).toContainText('Open the https copy of TABot instead.');

  await setUp(page, SHORT_KEY);
  await page.fill('#assignment', 'From a file');
  const kept = await page.evaluate(() => {
    try {
      return Object.keys(localStorage).filter((k) => k.indexOf('tabot.') === 0);
    } catch (err) {
      return [];
    }
  });
  expect(kept).toEqual([]);

  // Nothing survives a reload: not the key, not the answer key.
  await page.reload();
  await expect(banner).toContainText('running from a file on this device');
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('#assignment')).toHaveValue('');

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

test('a storage connection lost mid-class is named in plain words, and Done says what it left behind', async ({ page, context }, testInfo) => {
  const trio = trioPhoto();
  // Each student's name carries the photo number, so a spreadsheet shows
  // which photos it holds.
  const studentOf = (crop) => {
    const s = TRIO_STUDENTS[trio.ordered[crop.slipIndex].student];
    return { name: s.name + ' ' + (crop.photoIndex + 1), answers: s.answers };
  };
  const namesOf = (photo) => trio.ordered.map((t) => TRIO_STUDENTS[t.student].name + ' ' + photo);
  const mock = createGroqMock((crop, model) => readingReply(model, studentOf(crop), crop.pass));
  const seen = await guard(page, context, mock);
  const breakStorage = await breakableStorage(page);
  await page.goto('/index.html');
  await setUp(page, SHORT_KEY);
  // The loss is found while a photo is read, so it is said under Stop
  // reading, never in the banner at the top; the results it leaves out are
  // named under the list.
  const banner = page.locator('#storage-warning');
  const photoNote = page.locator('#photo-storage');
  const unread = page.locator('#results-unread');
  const groups = page.locator('#results .photo-head h3');
  const confirmText = page.locator('#done-confirm-text');
  const status = page.locator('#done-status');

  await sendPhoto(page, 'trio.png', trio.png);
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(banner).toBeHidden();
  await expect(photoNote).toBeHidden();

  await breakStorage();
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(groups).toHaveText(['Photo 2 (3 slips)']);
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(photoNote).toContainText('This browser stopped letting TABot save results.');
  await expect(photoNote).toContainText('finish with Done before closing or reloading it');
  expect(await photoNote.evaluate((n) => [n.previousElementSibling.id, n.nextElementSibling.id])).toEqual(['stop-reading', 'photo-error']);
  expect(await photoNote.evaluate(outOfFlow)).toEqual([]);
  await expect(unread).toContainText('Results saved earlier cannot be read right now');
  await expect(banner).toBeHidden();
  await expect(page.locator('#photo-error')).toBeHidden();
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/DOMException|IDBDatabase|InvalidStateError|UnknownError|transaction/);

  // ---- Done while storage still refuses: photo 1 cannot be read, so the file
  // holds photo 2 only, and the page says photo 1 is still stored.
  await page.click('#done');
  await expect(confirmText).toContainText('The spreadsheet for 3 students downloads');
  await expect(confirmText).toContainText(
    'Results saved before the storage problem cannot be read right now, so they are left out and stay in this browser.');
  let sheet = await downloadSheet(page, testInfo);
  expect(rosterNames(sheet)).toEqual(namesOf(2));
  await confirmSaved(page);
  await expect(status).toHaveText('The results in the file are cleared from this browser. The results saved before the ' +
    'storage problem were not in the file and are still in this browser. They come back after a reload, to be finished with Done.');
  await expect(page.locator('#results tbody tr')).toHaveCount(0);

  // ---- A reload with storage back: photo 1 returns, and Done finishes it.
  await page.reload();
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await expect(page.locator('#results td.student')).toHaveText(namesOf(1));
  await expect(banner).toBeHidden();
  await expect(photoNote).toBeHidden();
  await expect(unread).toBeHidden();
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 3, meta: 2 });
  await page.click('#done');
  await expect(confirmText).toHaveText('The spreadsheet for 3 students downloads, and then TABot asks whether it saved. ' +
    'Nothing is deleted from this browser until you say the file saved. Your key and answer key stay.');
  sheet = await downloadSheet(page, testInfo);
  expect(rosterNames(sheet)).toEqual(namesOf(1));
  await confirmSaved(page);
  await expect(status).toHaveText('Every result is cleared from this browser.');
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });

  // ---- Lost again, and back before Done: the file holds both photos, and
  // both are cleared.
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await breakStorage();
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(groups).toHaveText(['Photo 2 (3 slips)']);
  await expect(unread).toBeVisible();
  await page.evaluate(() => { window.__tabotBreakStorage = false; });
  await page.click('#done');
  await expect(confirmText).toContainText('The spreadsheet for 6 students downloads, and then TABot asks whether it saved. Nothing is deleted');
  await expect(groups).toHaveText(['Photo 1 (3 slips)', 'Photo 2 (3 slips)']);
  await expect(photoNote).toContainText('This browser stopped letting TABot save results.');
  await expect(unread).toBeHidden();
  await expect(banner).toBeHidden();
  sheet = await downloadSheet(page, testInfo);
  expect(rosterNames(sheet)).toEqual(namesOf(1).concat(namesOf(2)));
  await confirmSaved(page);
  await expect(status).toHaveText('Every result is cleared from this browser.');
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });
  await page.reload();
  await expect(page.locator('#results-empty')).toBeVisible();
  await expect(page.locator('#results tbody tr')).toHaveCount(0);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 8

test('a key corrected while the first photo is read grades its slips on the corrected key', async ({ page, context }, testInfo) => {
  const trio = trioPhoto();
  // Every read is held until the test has corrected the key.
  let holding = true;
  const mock = createGroqMock((crop, model, entry) => {
    const reply = () => readingReply(model, TRIO_STUDENTS[trio.ordered[crop.slipIndex].student], crop.pass);
    return holding ? mock.hold(entry, reply) : reply();
  });
  const seen = await guard(page, context, mock);
  await page.goto('/index.html');
  // Q2 is keyed as 5, then corrected to 4 while the photo is read.
  await setUp(page, [['1/2', '1'], ['5', '1']]);

  await sendPhoto(page, 'trio.png', trio.png);
  await expect.poll(() => mock.held.length).toBe(2);
  await expect(page.locator('#results tbody tr')).toHaveCount(0);
  expect(await page.evaluate(storedMarks)).toEqual([]);
  await page.fill('#q2-answer', '4');
  holding = false;
  mock.release();
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');

  // Hal wrote 0.5 and 4, Ivy 1/2 and 5, Jo 2/4 and 4: marked against Q2 = 4.
  const marks = { 'Hal Fixture': [2, [true, true]], 'Ivy Fixture': [1, [true, false]], 'Jo Fixture': [2, [true, true]] };
  const names = trio.ordered.map((t) => TRIO_STUDENTS[t.student].name);
  await expect(page.locator('#results td.student')).toHaveText(names);
  await expect(page.locator('#results td.score')).toHaveText(names.map((n) => marks[n][0] + '/2'));
  await expect(page.locator('#results td.flag')).toHaveText(names.map(() => ''));
  await expect.poll(() => page.evaluate(storedMarks)).toEqual(names.map((n) => [n, marks[n][0], marks[n][1]]));

  await page.click('#done');
  const sheet = await downloadSheet(page, testInfo);
  expect(sheetRows(sheet.wb.Sheets.Roster, 6).slice(1)).toEqual(names.map((n) => {
    const answers = TRIO_STUDENTS.find((s) => s.name === n).answers;
    const [score, right] = marks[n];
    return [n, score, 2, score * 50].concat(answers.map((a, i) => a + (right[i] ? CHECK : CROSS)));
  }));
  expect(sheetRows(sheet.wb.Sheets.Summary, 2)).toContainEqual(['Q2', 66.7]);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 9

test('a storage note raised as the key field loses focus leaves Check key under the press', async ({ page, context }, testInfo) => {
  const mock = createGroqMock(() => errorReply(400, 'no reads in this test'));
  const seen = await guard(page, context, mock);
  await refuseSettingsWrites(page);
  await page.goto('/index.html');
  const button = page.locator('#check-key');
  const lists = () => mock.log.filter((e) => e.kind === 'list').length;

  // One press right after typing: the key field loses focus, its write fails,
  // the note appears under the Check key status line, and that same press
  // still runs the check.
  async function typeAndPress(press) {
    await expect(page.locator('#setup-storage')).toBeHidden();
    await expect(page.locator('#storage-warning')).toBeHidden();
    await page.fill('#api-key', KEY);
    const before = await button.boundingBox();
    const listed = lists();
    await press();
    await expect(page.locator('#setup-status')).toHaveText('2 of 4 models read images.');
    expect(lists()).toBe(listed + 1);
    await expectSetupNote(page, before);
  }

  await typeAndPress(() => button.click());
  if (testInfo.project.use.hasTouch) {
    // The same with a finger, on a fresh page load: nothing was saved.
    await page.reload();
    await expect(page.locator('#api-key')).toHaveValue('');
    await typeAndPress(() => button.tap());
  }

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// The same press with the page scrolled so Check key sits near the top of the
// screen, where a banner pinned over the page would cover it. Each case is a
// fresh page load, so the note is raised by that one press.
for (const top of [10, 40, 70, 100]) {
  test('with Check key scrolled to ' + top + ' px from the top, one press still runs the check', async ({ page, context }, testInfo) => {
    const mock = createGroqMock(() => errorReply(400, 'no reads in this test'));
    const seen = await guard(page, context, mock);
    await refuseSettingsWrites(page);
    await page.goto('/index.html');
    const button = page.locator('#check-key');
    await expect(page.locator('#setup-storage')).toBeHidden();
    await page.fill('#api-key', KEY);
    await page.evaluate((y) => {
      window.scrollBy(0, document.getElementById('check-key').getBoundingClientRect().top - y);
    }, top);
    const before = await button.boundingBox();
    expect(Math.abs(before.y - top), 'Check key top at ' + top + ' px').toBeLessThan(1);

    // A press at the button's centre: a finger on the phone, a mouse on the desktop.
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;
    if (testInfo.project.use.hasTouch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await expect(page.locator('#setup-status')).toHaveText('2 of 4 models read images.');
    expect(mock.log.filter((e) => e.kind === 'list').length, 'one press, one check').toBe(1);
    await expectSetupNote(page, before);

    await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
    expectCleanRun(mock, seen);
  });
}

// ---------------------------------------------------------------- test 10

test('a photo read across a storage loss is not called interrupted once Done has sent it', async ({ page, context }, testInfo) => {
  const trio = trioPhoto();
  const studentOf = (crop) => {
    const s = TRIO_STUDENTS[trio.ordered[crop.slipIndex].student];
    return { name: s.name + ' ' + (crop.photoIndex + 1), answers: s.answers };
  };
  const namesOf = (photo) => trio.ordered.map((t) => TRIO_STUDENTS[t.student].name + ' ' + photo);
  // Photo 2's reads are held until the test has taken storage away.
  let holding = true;
  const mock = createGroqMock((crop, model, entry) => {
    const reply = () => readingReply(model, studentOf(crop), crop.pass);
    return holding && crop.photoIndex === 1 ? mock.hold(entry, reply) : reply();
  });
  const seen = await guard(page, context, mock);
  const breakStorage = await breakableStorage(page);
  await page.goto('/index.html');
  await setUp(page, SHORT_KEY);
  const groups = page.locator('#results .photo-head h3');
  const photoError = page.locator('#photo-error');

  await sendPhoto(page, 'trio.png', trio.png);
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');

  // ---- Photo 2's in-flight marker reaches IndexedDB, then storage goes:
  // every slip of photo 2 is kept in memory, and the marker cannot be
  // cleared when the photo ends.
  await sendPhoto(page, 'trio.png', trio.png);
  await expect.poll(() => mock.held.length).toBe(2);
  expect(await page.evaluate(storedMetaIds)).toEqual(['inflight', 'lastPhoto', 'meta']);
  await breakStorage();
  holding = false;
  mock.release();
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(groups).toHaveText(['Photo 2 (3 slips)']);
  await expect(page.locator('#photo-storage')).toContainText('This browser stopped letting TABot save results.');
  await expect(photoError).toBeHidden();

  // ---- Done while storage still refuses, which comes back as the file is
  // handed over: the file holds photo 2, and photo 1 stays stored. By the
  // time the teacher says the file saved, photo 1 can be read again, and it
  // is not in the file: Yes clears photo 2 alone, and photo 1 is listed.
  await page.click('#done');
  await expect(page.locator('#done-confirm-text')).toContainText('so they are left out and stay in this browser');
  await page.evaluate(() => { window.__tabotHealOnDownload = true; });
  const sheet = await downloadSheet(page, testInfo);
  expect(rosterNames(sheet)).toEqual(namesOf(2));
  // The page shown again before the answer: its expiry check reads the rows,
  // photo 1 among them now, so the store would clear photo 1 with the rest
  // if Yes cleared everything.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await confirmSaved(page);
  await expect(page.locator('#done-status')).toHaveText('The results in the file are cleared from this browser. The ' +
    'results saved before the storage problem were not in the file and are still in this browser, to be finished with Done.');
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await expect(page.locator('#results td.student')).toHaveText(namesOf(1));
  // Photo 1 is still in IndexedDB, and photo 2's in-flight marker is gone.
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 3, meta: 2 });
  expect(await page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);

  // ---- The next load lists photo 1 and does not ask for photo 2 again: a
  // retake would put its students in a second spreadsheet.
  await page.reload();
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await expect(page.locator('#results td.student')).toHaveText(namesOf(1));
  await expect.poll(() => page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);
  await expect(photoError).toBeHidden();

  // ---- The backstop, for a marker no store call could reach: one whose
  // photo has every slip stored is cleared without a word...
  await page.evaluate(storeInFlight, { photoIndex: 0, total: 3, done: 1 });
  await page.reload();
  await expect(groups).toHaveText(['Photo 1 (3 slips)']);
  await expect.poll(() => page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);
  await expect(photoError).toBeHidden();
  // ...and one whose photo is missing slips is still named.
  await page.evaluate(storeInFlight, { photoIndex: 0, total: 4, done: 3 });
  await page.reload();
  await expect(photoError).toContainText('Photo 1 was interrupted after 3 of 4 slips; take it again to read the rest.');
  await expect.poll(() => page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 11

test('Done asks whether the file saved, and clears nothing until Yes', async ({ page, context }, testInfo) => {
  const trio = trioPhoto();
  const names = trio.ordered.map((t) => TRIO_STUDENTS[t.student].name);
  const mock = createGroqMock((crop, model) => readingReply(model, TRIO_STUDENTS[trio.ordered[crop.slipIndex].student], crop.pass));
  const seen = await guard(page, context, mock);
  await page.goto('/index.html');
  await setUp(page, SHORT_KEY);
  const question = page.locator('#done-saved');
  const status = page.locator('#done-status');
  const done = page.locator('#done');
  const rows = page.locator('#results tbody tr');

  await sendPhoto(page, 'trio.png', trio.png);
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(rows).toHaveCount(3);
  const marks = await page.evaluate(storedMarks);
  expect(marks.map((m) => m[0])).toEqual(names);

  // ---- Download: the file arrives and the page asks; nothing is deleted.
  await page.click('#done');
  await expect(page.locator('#done-confirm-text')).toContainText('Nothing is deleted from this browser until you say the file saved.');
  const first = await downloadSheet(page, testInfo);
  expect(rosterNames(first)).toEqual(names);
  await expect(done).toBeHidden();
  await expect(rows).toHaveCount(3);
  expect(await page.evaluate(storedMarks)).toEqual(marks);
  expect(await page.evaluate(() => window.__tabotLiveUrls().length)).toBe(1);

  // ---- No: a second download, made again from the same stored rows, which
  // stay as they were; then the same question again.
  const second = await downloadSheet(page, testInfo, '#saved-no');
  expect(sheetRows(second.wb.Sheets.Roster, 6)).toEqual(sheetRows(first.wb.Sheets.Roster, 6));
  await expect(done).toBeHidden();
  await expect(rows).toHaveCount(3);
  expect(await page.evaluate(storedMarks)).toEqual(marks);
  expect((await page.evaluate(countStoredResults)).rows).toBe(3);
  // Each download made its own object URL, both still inside their 30 s,
  // and nothing in the page points at either.
  const urls = await page.evaluate(() => window.__tabotLiveUrls());
  expect(urls).toHaveLength(2);
  expect(new Set(urls).size).toBe(2);
  expect(await page.evaluate(blobReferences)).toEqual([]);

  // ---- A reload with the question open: the results are still stored and
  // unconfirmed, and the page is as it was before Done.
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(question).toBeHidden();
  await expect(page.locator('#done-confirm')).toBeHidden();
  await expect(done).toBeVisible();
  await expect(done).toBeEnabled();
  await expect(status).toBeEmpty();
  expect(await page.evaluate(storedMarks)).toEqual(marks);

  // ---- A new photo while the question is open: the question closes, and
  // Done is pressed again for a file with both photos.
  await page.click('#done');
  await downloadSheet(page, testInfo);
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(question).toBeHidden();
  await expect(status).toBeEmpty();
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  await expect(rows).toHaveCount(6);
  await expect(done).toBeVisible();
  await expect(done).toBeEnabled();
  expect((await page.evaluate(countStoredResults)).rows).toBe(6);

  // ---- An answer key change while the question is open closes it too: the
  // file holds what the key said before the change.
  await page.click('#done');
  await downloadSheet(page, testInfo);
  await page.fill('#assignment', 'Unit 4 exit slip');
  await expect(question).toBeHidden();
  await expect(status).toHaveText('The answer key changed after the download, so nothing was cleared. ' +
    'Press Done for a spreadsheet with the change.');
  await expect(done).toBeVisible();
  expect((await page.evaluate(countStoredResults)).rows).toBe(6);

  // ---- Yes: every result goes; the key and the answer key stay.
  await page.click('#done');
  const last = await downloadSheet(page, testInfo);
  expect(last.name).toMatch(/^TABot_Unit-4-exit-slip_\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(rosterNames(last)).toEqual(names.concat(names));
  await confirmSaved(page);
  await expect(status).toHaveText('Every result is cleared from this browser.');
  await expect(rows).toHaveCount(0);
  await expect(done).toBeVisible();
  await expect(done).toBeDisabled();
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });
  await page.reload();
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await expect(page.locator('#q2-answer')).toHaveValue('4');
  await expect(page.locator('#results-empty')).toBeVisible();

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 12

test('results never confirmed saved are cleared 24 hours after the last photo', async ({ page, context }) => {
  const trio = trioPhoto();
  // Three slips, one much larger than the rest: the page asks about it.
  const big = bigPhoto();
  let holding = false;
  const mock = createGroqMock((crop, model, entry) => {
    const reply = () => readingReply(model, TRIO_STUDENTS[trio.ordered[crop.slipIndex].student], crop.pass);
    return holding ? mock.hold(entry, reply) : reply();
  });
  const seen = await guard(page, context, mock);
  // The most result rows the page ever drew since it loaded.
  await page.addInitScript(() => {
    window.__tabotMostRowsShown = 0;
    new MutationObserver(() => {
      const n = document.querySelectorAll('#results tbody tr').length;
      if (n > window.__tabotMostRowsShown) window.__tabotMostRowsShown = n;
    }).observe(document, { childList: true, subtree: true });
  });
  // The page's timers run on a clock the test can move, so the check made
  // once a minute can be run on demand.
  await page.clock.install();
  await page.goto('/index.html');
  await setUp(page, SHORT_KEY);
  const rows = page.locator('#results tbody tr');
  const photoHeads = page.locator('#results .photo-head h3');
  const check = page.locator('#photo-check');
  const line = page.locator('#results-status');
  const EXPIRED = 'Results from more than 24 hours ago were cleared automatically, as they were never confirmed saved.';
  const ready = () => expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');

  await sendPhoto(page, 'trio.png', trio.png);
  await ready();
  await expect(rows).toHaveCount(3);
  expect(typeof (await page.evaluate(storedLastPhotoAt))).toBe('number');

  // ---- On load, a minute short of 24 hours: kept.
  await shiftClock(page, 24 * HOUR - 60000);
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(line).toBeEmpty();

  // ---- On load at 24 hours: cleared before any is shown; the settings stay.
  await shiftClock(page, 24 * HOUR);
  await page.reload();
  await expect(line).toHaveText(EXPIRED);
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#results-empty')).toBeVisible();
  expect(await page.evaluate(() => window.__tabotMostRowsShown)).toBe(0);
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });
  await expect(page.locator('#done')).toBeDisabled();
  await expect(page.locator('#question-count')).toBeEnabled();
  await expect(page.locator('#photo-error')).toBeHidden();
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await expect(page.locator('#q2-answer')).toHaveValue('4');
  await expect(page.locator('#take-photo')).toBeEnabled();

  // ---- While the page is open, by the check made once a minute. A new photo
  // takes the line away.
  await sendPhoto(page, 'trio.png', trio.png);
  await ready();
  await expect(rows).toHaveCount(3);
  await expect(line).toBeEmpty();
  await shiftClock(page, 48 * HOUR);
  await page.clock.runFor(60000);
  await expect(line).toHaveText(EXPIRED);
  await expect(rows).toHaveCount(0);
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });

  // ---- When the page is shown again, even with "Did the file save?" open,
  // which then closes.
  await sendPhoto(page, 'trio.png', trio.png);
  await ready();
  await page.click('#done');
  await Promise.all([page.waitForEvent('download'), page.click('#done-yes')]);
  await expect(page.locator('#done-saved')).toBeVisible();
  await shiftClock(page, 72 * HOUR);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(line).toHaveText(EXPIRED);
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#done-saved')).toBeHidden();
  await expect(page.locator('#done-status')).toBeEmpty();
  await expect(page.locator('#done')).toBeVisible();
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });

  // ---- Never while a photo is being read. Photo 1 is stored; the page is
  // loaded afresh, so its once-a-minute timer started as it loaded; photo 2's
  // reads are held; then photo 1 is past its 24 hours.
  await sendPhoto(page, 'trio.png', trio.png);
  await ready();
  await expect(rows).toHaveCount(3);
  await page.reload();
  await expect(rows).toHaveCount(3);
  const loadedAt = await page.evaluate(() => Date.now());
  holding = true;
  await sendPhoto(page, 'trio.png', trio.png);
  await expect.poll(() => mock.held.length).toBe(2);
  await shiftClock(page, 100 * HOUR);
  // The page shown again...
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // ...and the timer's first minute. The held reads started after the page
  // loaded, so their own 60 s time limit is still ahead.
  const pausedAt = (await page.evaluate(() => Date.now())) + 1;
  await page.clock.pauseAt(pausedAt);
  await page.clock.runFor(loadedAt + 60000 - pausedAt);
  expect(mock.held).toHaveLength(2);
  await expect(line).toBeEmpty();
  await expect(rows).toHaveCount(3);
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 3, meta: 3 });
  expect(await page.evaluate(storedMetaIds)).toEqual(['inflight', 'lastPhoto', 'meta']);

  // Photo 2's slips are stored at the new time, so nothing is 24 hours old.
  await page.clock.resume();
  holding = false;
  mock.release();
  await ready();
  await expect(rows).toHaveCount(6);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.clock.runFor(60000);
  await expect(rows).toHaveCount(6);
  await expect(line).toBeEmpty();

  // ---- Not held back by the question about a photo's slips: with it open,
  // the check made once a minute clears the results now past their 24
  // hours, the question stays, and the photo read after it is photo 1.
  await sendPhoto(page, 'big.png', big.png);
  await expect(check).toBeVisible();
  await shiftClock(page, 124 * HOUR);
  await page.clock.runFor(60000);
  await expect(line).toHaveText(EXPIRED);
  await expect(rows).toHaveCount(0);
  expect(await page.evaluate(countStoredResults)).toEqual({ rows: 0, meta: 0 });
  await expect(check).toBeVisible();
  await page.click('#read-anyway');
  await ready();
  await expect(photoHeads).toHaveText(['Photo 1 (3 slips)']);
  await expect(line).toHaveText(EXPIRED);

  // ---- A photo read before any check has run clears them first, so its
  // slips cannot renew results already past their 24 hours. The page is
  // loaded afresh, so its once-a-minute check is a minute away, and this
  // photo raises no question, so it goes straight to reading.
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(line).toBeEmpty();
  await shiftClock(page, 148 * HOUR);
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(line).toHaveText(EXPIRED);
  await ready();
  await expect(photoHeads).toHaveText(['Photo 1 (3 slips)']);
  await expect(rows).toHaveCount(3);
  expect(await page.evaluate(storedMetaIds)).toEqual(['lastPhoto', 'meta']);
  expect(readsIn(mock).every((e) => e.status === 200)).toBe(true);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 13

test('each question matches by value or in exact form', async ({ page, context }, testInfo) => {
  const trio = trioPhoto();
  // Both questions are keyed 3/4. Sam wrote 6/8 twice, and his second read
  // says 3/4 twice; Tia wrote 3/4 twice; Uma wrote 0.75 and 1/2.
  const MATCH_STUDENTS = [
    { name: 'Sam Fixture', answers: ['6/8', '6/8'], reviewerAnswers: ['3/4', '3/4'] },
    { name: 'Tia Fixture', answers: ['3/4', '3/4'] },
    { name: 'Uma Fixture', answers: ['0.75', '1/2'] }
  ];
  const names = trio.ordered.map((t) => MATCH_STUDENTS[t.student].name);
  const mock = createGroqMock((crop, model) => readingReply(model, MATCH_STUDENTS[trio.ordered[crop.slipIndex].student], crop.pass));
  const seen = await guard(page, context, mock);
  await page.goto('/index.html');
  await setUp(page, [['3/4', '1'], ['3/4', '1']]);

  // ---- One select per question, value by default, with its hint.
  const match1 = page.locator('#q1-match');
  const match2 = page.locator('#q2-match');
  await expect(match1).toHaveAttribute('aria-label', 'Match for question 1');
  await expect(match2).toHaveAttribute('aria-label', 'Match for question 2');
  await expect(match2.locator('option')).toHaveText(['Value', 'Exact form']);
  await expect(match1).toHaveValue('value');
  await expect(match2).toHaveValue('value');
  await expect(page.locator('#match-hint')).toHaveText('Value: 1/2, 0.5 and 2/4 all count. Exact form: the answer ' +
    'must be written the way the key is (6/8 does not count for 3/4).');

  // ---- At 360 px the answer keeps most of the row, and every control is a
  // 44 px tap target.
  const original = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 780 });
  const box = async (sel) => page.locator(sel).boundingBox();
  const row = await page.locator('#question-rows .q-row').first().boundingBox();
  const answer = await box('#q1-answer');
  const points = await box('#q1-points');
  const select = await box('#q1-match');
  expect(answer.width).toBeGreaterThan(row.width / 2);
  expect(answer.width).toBeGreaterThan(select.width);
  for (const b of [answer, points, select]) expect(b.height).toBeGreaterThanOrEqual(44);
  expect(select.x + select.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
  await page.setViewportSize(original);
  await expectNoSideScroll(page);

  // ---- By value: 6/8 counts for 3/4, and two reads that agree in value are
  // not flagged although they differ as text.
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  const byValue = { 'Sam Fixture': ['2/2', ''], 'Tia Fixture': ['2/2', ''], 'Uma Fixture': ['1/2', ''] };
  await expect(page.locator('#results td.student')).toHaveText(names);
  await expect(page.locator('#results td.score')).toHaveText(names.map((n) => byValue[n][0]));
  await expect(page.locator('#results td.flag')).toHaveText(names.map((n) => byValue[n][1]));
  const stamped = await page.evaluate(storedLastPhotoAt);

  // ---- Q2 set to exact form: saved at once, and the stored slips regraded
  // without moving the time of the last photo. 6/8 is now wrong on Q2, and
  // Sam's two reads of Q2 (6/8 and 3/4) are flagged there.
  await shiftClock(page, HOUR);
  await match2.selectOption('exact');
  const byExact = { 'Sam Fixture': ['1/2', '* Q2'], 'Tia Fixture': ['2/2', ''], 'Uma Fixture': ['1/2', ''] };
  await expect(page.locator('#results td.score')).toHaveText(names.map((n) => byExact[n][0]));
  await expect(page.locator('#results td.flag')).toHaveText(names.map((n) => byExact[n][1]));
  const right = { 'Sam Fixture': [true, false], 'Tia Fixture': [true, true], 'Uma Fixture': [true, false] };
  await expect.poll(() => page.evaluate(storedMarks)).toEqual(names.map((n) => [n, right[n].filter(Boolean).length, right[n]]));
  expect(await page.evaluate(storedLastPhotoAt)).toBe(stamped);
  const savedKey = await page.evaluate(() => JSON.parse(localStorage.getItem('tabot.answerKey')));
  expect(savedKey.questions).toEqual([{ answer: '3/4', points: 1 }, { answer: '3/4', points: 1, match: 'exact' }]);

  // ---- Restored after a reload.
  await page.reload();
  await expect(match1).toHaveValue('value');
  await expect(match2).toHaveValue('exact');
  await expect(page.locator('#results td.score')).toHaveText(names.map((n) => byExact[n][0]));
  await expect(page.locator('#results td.flag')).toHaveText(names.map((n) => byExact[n][1]));

  // ---- The spreadsheet names each question's setting, and marks the cells.
  await page.click('#done');
  const sheet = await downloadSheet(page, testInfo);
  const summary = sheetRows(sheet.wb.Sheets.Summary, 3);
  expect(summary).toContainEqual(['Question', 'Hit rate %', 'Match']);
  expect(summary).toContainEqual(['Q1', 100, 'value']);
  expect(summary).toContainEqual(['Q2', 33.3, 'exact form']);
  const roster = sheetRows(sheet.wb.Sheets.Roster, 8);
  expect(roster[0]).toEqual(['Student', 'Score', 'Max', 'Percent', 'Q1', 'Q2', 'Flags', 'Notes']);
  expect(roster.find((r) => r[0] === 'Sam Fixture')).toEqual(
    ['Sam Fixture', 1, 2, 50, '6/8' + CHECK, '6/8' + CROSS + ' *', '*', 'Q2: reader 6/8, reviewer 3/4']);

  // ---- Back to value: regraded again, and the saved key has no setting left.
  // (A key change closes the question about the file.)
  await match2.selectOption('value');
  await expect(page.locator('#done-saved')).toBeHidden();
  await expect(page.locator('#results td.score')).toHaveText(names.map((n) => byValue[n][0]));
  await expect(page.locator('#results td.flag')).toHaveText(names.map((n) => byValue[n][1]));
  const valueKey = await page.evaluate(() => JSON.parse(localStorage.getItem('tabot.answerKey')));
  expect(valueKey.questions).toEqual([{ answer: '3/4', points: 1 }, { answer: '3/4', points: 1 }]);

  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});

// ---------------------------------------------------------------- test 14

// Replaces navigator.wakeLock with a recorder, and lets the test hide and
// show the page. The log reads 'request screen' for each request, 'release'
// for each lock the page releases, and 'dropped' for each lock the browser
// takes away as the page is hidden. Calls to navigator.permissions.query are
// counted.
async function recordWakeLock(page) {
  await page.addInitScript(() => {
    const log = [];
    const held = new Set();
    let visibility = 'visible';
    let refuse = false;
    function end(sentinel, why) {
      sentinel.released = true;
      held.delete(sentinel);
      log.push(why);
      sentinel.events.dispatchEvent(new Event('release'));
    }
    function makeSentinel(type) {
      const events = new EventTarget();
      const sentinel = {
        type,
        released: false,
        events,
        addEventListener: (name, fn) => events.addEventListener(name, fn),
        removeEventListener: (name, fn) => events.removeEventListener(name, fn),
        release() {
          if (!sentinel.released) end(sentinel, 'release');
          return Promise.resolve();
        }
      };
      return sentinel;
    }
    const wakeLock = {
      request(type) {
        log.push('request ' + type);
        if (refuse) return Promise.reject(new DOMException('Refused by the test.', 'NotAllowedError'));
        if (visibility !== 'visible') return Promise.reject(new DOMException('The page is hidden.', 'NotAllowedError'));
        const sentinel = makeSentinel(type);
        held.add(sentinel);
        return Promise.resolve(sentinel);
      }
    };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => wakeLock });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility !== 'visible' });
    window.__tabotPermissionQueries = 0;
    const permissions = navigator.permissions;
    if (permissions && typeof permissions.query === 'function') {
      const query = permissions.query.bind(permissions);
      permissions.query = function () {
        window.__tabotPermissionQueries++;
        return query.apply(null, arguments);
      };
    }
    window.__tabotWake = {
      log: () => log.slice(),
      held: () => held.size,
      refuse: (on) => { refuse = on; },
      show: (state) => {
        visibility = state;
        if (state !== 'visible') Array.from(held).forEach((s) => end(s, 'dropped'));
        document.dispatchEvent(new Event('visibilitychange'));
      }
    };
  });
}

test('the screen stays on while slips are read, and only then', async ({ page, context }) => {
  const trio = trioPhoto();
  // Three slips, one much larger than the rest: the page asks about it.
  const big = bigPhoto();
  const size = { width: 1600, height: 1200, seed: 5 };
  const blank = encodePng(synth.makePhoto(Object.assign({ slips: [] }, size)).raster);
  let holding = true;
  let refusing = false; // every read refused, on every model
  const mock = createGroqMock((crop, model, entry) => {
    if (refusing) return errorReply(400, 'mock: this model refused the request');
    const reply = () => readingReply(model, TRIO_STUDENTS[trio.ordered[crop.slipIndex].student], crop.pass);
    return holding ? mock.hold(entry, reply) : reply();
  });
  const seen = await guard(page, context, mock);
  await recordWakeLock(page);
  await page.goto('/index.html');
  await setUp(page, SHORT_KEY);
  const wakeLog = () => page.evaluate(() => window.__tabotWake.log());
  const heldLocks = () => page.evaluate(() => window.__tabotWake.held());
  const show = (state) => page.evaluate((s) => window.__tabotWake.show(s), state);
  const ready = () => expect(page.locator('#photo-progress')).toHaveText('Ready for the next photo.');
  const filesInInput = () => page.locator('#upload-photo').evaluate((input) => input.files.length);
  const check = page.locator('#photo-check');

  // Nothing is asked for before a photo, not even as the page is shown again.
  await show('hidden');
  await show('visible');
  expect(await wakeLog()).toEqual([]);

  // ---- One request as the reading starts, held while the slips are read.
  await sendPhoto(page, 'trio.png', trio.png);
  await expect.poll(() => mock.held.length).toBe(2);
  expect(await wakeLog()).toEqual(['request screen']);
  expect(await heldLocks()).toBe(1);

  // ---- Hidden mid-read, the browser drops it; shown again, it is asked for again.
  await show('hidden');
  expect(await wakeLog()).toEqual(['request screen', 'dropped']);
  await show('visible');
  await expect.poll(wakeLog).toEqual(['request screen', 'dropped', 'request screen']);
  await expect.poll(heldLocks).toBe(1);

  // ---- The reading ends: released, and not asked for again.
  holding = false;
  mock.release();
  await ready();
  await expect.poll(wakeLog).toEqual(['request screen', 'dropped', 'request screen', 'release']);
  expect(await heldLocks()).toBe(0);
  await show('hidden');
  await show('visible');
  expect(await wakeLog()).toHaveLength(4);

  // ---- Stop reading: released at once, and not asked for again while the
  // photo winds down.
  holding = true;
  await sendPhoto(page, 'trio.png', trio.png);
  await expect.poll(() => mock.held.length).toBe(2);
  await expect.poll(heldLocks).toBe(1);
  await page.click('#stop-reading');
  expect(await heldLocks()).toBe(0);
  await ready();
  expect((await wakeLog()).slice(4)).toEqual(['request screen', 'release']);
  await show('hidden');
  await show('visible');
  expect(await wakeLog()).toHaveLength(6);
  mock.release(); // Stop cancelled those reads; the replies go nowhere

  // ---- A photo with no slips in it is never read: nothing is asked for.
  holding = false;
  await sendPhoto(page, 'empty-table.png', blank);
  await expect(page.locator('#photo-error')).toContainText('No slips found in this photo.');
  await ready();
  expect(await wakeLog()).toHaveLength(6);

  // ---- A photo whose every read fails: asked for as the reading starts,
  // released as it ends.
  refusing = true;
  await sendPhoto(page, 'trio.png', trio.png);
  await expect(page.locator('#photo-error')).toContainText('3 of 3 slips could not be read');
  await ready();
  await expect.poll(async () => (await wakeLog()).slice(6)).toEqual(['request screen', 'release']);
  expect(await heldLocks()).toBe(0);
  refusing = false;

  // ---- The question about the slips: nothing is held while it waits on
  // the teacher, not even after the page is hidden and shown again, and the
  // chosen file is already let go. Retake: nothing is asked for.
  await sendPhoto(page, 'big.png', big.png);
  await expect(check).toBeVisible();
  expect(await heldLocks()).toBe(0);
  expect(await filesInInput()).toBe(0);
  await show('hidden');
  await show('visible');
  expect(await wakeLog()).toHaveLength(8);
  await page.click('#retake');
  await expect(check).toBeHidden();
  await ready();
  expect(await wakeLog()).toHaveLength(8);

  // ---- Read anyway: one request as the reading starts, released as it ends.
  holding = true;
  await sendPhoto(page, 'big.png', big.png);
  await expect(check).toBeVisible();
  expect(await wakeLog()).toHaveLength(8);
  await page.click('#read-anyway');
  await expect.poll(() => mock.held.length).toBe(2);
  expect((await wakeLog()).slice(8)).toEqual(['request screen']);
  expect(await heldLocks()).toBe(1);
  holding = false;
  mock.release();
  await ready();
  await expect.poll(async () => (await wakeLog()).slice(8)).toEqual(['request screen', 'release']);
  expect(await heldLocks()).toBe(0);

  // ---- A refusal is silent and not retried; the photo is read as usual.
  await page.evaluate(() => window.__tabotWake.refuse(true));
  await sendPhoto(page, 'trio.png', trio.png);
  await ready();
  await expect(page.locator('#photo-error')).toBeHidden();
  // Photos 2 and 3 were stopped or failed before a slip was saved, and the
  // photo with no slips and the one retaken took no number, so this is
  // photo 5.
  await expect(page.locator('#results .photo-head h3').last()).toHaveText('Photo 5 (3 slips)');
  expect((await wakeLog()).slice(10)).toEqual(['request screen']);
  expect(await heldLocks()).toBe(0);

  expect(await page.evaluate(() => window.__tabotPermissionQueries)).toBe(0);
  await expectKeysOnlyInAuthorization(mock, seen, [KEY]);
  expectCleanRun(mock, seen);
});
