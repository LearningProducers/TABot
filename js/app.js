// TABot page wiring: setup, answer key, photos, results and Done. Browser
// only. Every other js/ file is a pure module; this one owns the DOM, the
// canvases, the order things happen in, and every message the teacher reads.
(function () {
  'use strict';

  var T = window.TABot;
  var PROVIDER = 'groq';

  var ANALYSIS_LONG_SIDE = 1000; // the raster segmentation runs on
  var CROP_LONG_SIDE = 1280;     // the image a model sees
  var CANVAS_MAX_SIDE = 4096;    // iOS Safari refuses bigger canvases
  var JPEG_QUALITY = 0.85;
  var CROP_PAD = 4;              // analysis pixels of surface kept round a slip
  var DEFAULT_QUESTIONS = 5;
  var MAX_QUESTIONS = 30;
  var DEFAULT_PASS = 70;
  var REGRADE_DELAY_MS = 400;
  // The spreadsheet's object URL is revoked this long after the download
  // click (Safari starts the download after the click returns), or when the
  // page is left, whichever comes first.
  var DOWNLOAD_URL_LIFETIME_MS = 30000;
  var XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  // Results nobody confirmed saved are cleared this long after the last
  // photo's last saved slip. The page checks as it loads, when it becomes
  // visible again, once a minute while it is open, and as a photo's reading
  // starts.
  var EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
  var EXPIRY_CHECK_MS = 60000;
  var EXPIRED_TEXT = 'Results from more than 24 hours ago were cleared automatically, as they were never confirmed saved.';

  // With one provider key saved (the only case until a second provider
  // lands), the second read is the same provider on an enhanced copy.
  var SECOND_READ_MODE = 'single-model';

  var CAPTURE_TIPS = [
    'Lay the slips on a dark or colored surface, not a white or pale table.',
    'Keep every slip fully inside the frame.',
    'Shoot straight down, in good and even light.',
    'Leave a gap of surface between slips.'
  ];

  var ELEMENT_IDS = [
    'storage-warning', 'api-key', 'check-key', 'setup-status', 'setup-storage', 'setup-error',
    'model-field', 'model', 'model-storage',
    'assignment', 'pass-percent', 'question-count', 'count-locked', 'question-rows', 'key-storage',
    'take-photo', 'take-photo-button', 'upload-photo', 'upload-photo-button',
    'photo-hint', 'photo-found', 'photo-check', 'photo-check-text', 'read-anyway', 'retake',
    'photo-progress', 'photo-wait', 'stop-reading', 'photo-storage', 'photo-error',
    'results-empty', 'results-status', 'results-legend', 'results', 'results-unread', 'results-storage',
    'done', 'done-hint', 'done-confirm', 'done-confirm-text', 'done-yes', 'done-no',
    'done-saved', 'done-saved-text', 'saved-yes', 'saved-no', 'done-status', 'done-storage'
  ];

  // Defined only by the e2e test, before this script runs. Production never has it.
  var testHook = window.__TABOT_TEST__ || null;
  var provider = T.providers.get(PROVIDER);
  var store = T.store;
  var queue = T.queue.createQueue(queueOptions());

  var state = {
    rows: [],
    visionModels: [],
    busy: false,         // a photo or Done is in progress
    finishing: false,    // Done's own store work is running
    job: null,           // the photo whose slips are being read
    asking: null,        // answers the question about a suspect slip
    waitToken: null,     // the read that owns the wait line
    regradeTimer: null,
    regradePending: false,
    // While "Did the file save?" is open: the ids of the rows in the file
    // just handed over, and whether results saved before a storage problem
    // were left out of it. Only ids are kept, never the file.
    saveCheck: null
  };
  var el = {};

  // The screen wake lock held while a photo's slips are read.
  var wake = { wanted: false, sentinel: null, pending: false };

  // Object URLs handed to a download, each with the timer that revokes it.
  // Only the URL string is kept here, never the Blob.
  var pendingUrls = {};

  // Store writes that read rows and put them back (regrade, discard, a slip
  // saved mid-photo, Done) run one at a time, so none of them can undo
  // another that is already running.
  var storeChain = Promise.resolve();
  function serial(fn) {
    var next = storeChain.then(fn, fn);
    storeChain = next.catch(function () {});
    return next;
  }

  function queueOptions() {
    var opts = { concurrency: 2 };
    var q = testHook && testHook.queue;
    if (q && typeof q.baseMs === 'number') opts.baseMs = q.baseMs;
    if (q && typeof q.capMs === 'number') opts.capMs = q.capMs;
    return opts;
  }

  // The page's clock in milliseconds: the test hook's when it has one (the
  // store reads the same one), otherwise Date.now().
  function now() {
    var t = testHook && typeof testHook.now === 'function' ? Number(testHook.now()) : NaN;
    return isFinite(t) ? t : Date.now();
  }

  // ---------------------------------------------------------------- DOM helpers

  function bindElements() {
    ELEMENT_IDS.forEach(function (id) {
      var node = document.getElementById(id);
      if (!node) throw new Error('TABot: index.html is missing #' + id);
      el[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = node;
    });
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(node, text) {
    node.textContent = text || '';
  }

  // A problem the teacher can act on: a headline plus optional lines.
  function problem(title, items) {
    var err = new Error(title);
    err.teacherMessage = { title: title, items: items || [] };
    return err;
  }

  function isDomException(err) {
    return typeof DOMException === 'function' && err instanceof DOMException;
  }

  // A browser storage error arrives as a DOMException whose text names
  // IDBDatabase and transactions; the teacher gets a plain line instead.
  function plainReason(err) {
    if (isDomException(err)) {
      return err.name === 'QuotaExceededError'
        ? 'this device is out of storage space'
        : 'the browser\'s storage failed';
    }
    return err && err.message ? err.message : String(err);
  }

  function unexpected(err) {
    if (isDomException(err)) {
      return {
        title: err.name === 'QuotaExceededError'
          ? 'This device is out of storage space for TABot\'s results.'
          : 'This browser could not save or read TABot\'s results just now.',
        items: ['Reload the page and try again. Results already saved are kept.']
      };
    }
    return {
      title: 'Something went wrong: ' + plainReason(err),
      items: ['Reload the page and try again. Results already saved are kept.']
    };
  }

  function showError(node, message) {
    var msg = typeof message === 'string' ? { title: message, items: [] } : message;
    node.textContent = '';
    node.appendChild(make('p', null, msg.title));
    if (msg.items && msg.items.length) {
      var list = make('ul');
      msg.items.forEach(function (item) { list.appendChild(make('li', null, item)); });
      node.appendChild(list);
    }
    node.hidden = false;
  }

  function hideError(node) {
    node.hidden = true;
    node.textContent = '';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function formatNumber(n) {
    var v = Number(n);
    return isFinite(v) ? String(Math.round(v * 100) / 100) : '0';
  }

  function isProviderError(err) {
    return !!err && typeof err.status === 'number';
  }

  // ---------------------------------------------------------------- storage notes

  // A storage problem is said in the page's flow, never over it, and never
  // above a control the teacher may be pressing. One known while the page
  // loads, before the teacher has touched it (a page from a file, blocked
  // storage, results kept in memory), goes in the banner at the top. One found
  // later, when a store call fails in use, goes in the note directly below the
  // control whose call found it: under the Check key status line for the key
  // field and Check key, under the model list, at the foot of the answer key,
  // under Stop reading, under the results, or under Done. The top banner is
  // not changed once the page has been touched, so it takes a problem found
  // later only on the next page load, if the problem is still there.
  var touched = false;
  var told = {}; // each kind of problem is said once, where it was found

  function noteTouched() {
    touched = true;
  }

  // -> the kinds of storage problem the store reports now.
  function storageProblems() {
    if (store.fileMode) return ['file'];
    var kinds = [];
    if (store.memoryReason === 'unavailable') kinds.push('results');
    if (store.memoryReason === 'lost') kinds.push('lost');
    if (store.settingsMemoryOnly) kinds.push('settings');
    return kinds;
  }

  function storageText(kinds) {
    function has(kind) { return kinds.indexOf(kind) >= 0; }
    var lines = [];
    if (has('file')) {
      lines.push('TABot is running from a file on this device, so nothing is saved: the key, the answer key and ' +
        'every result last only until this tab closes. Open the https copy of TABot instead.');
    } else if (has('results') && has('settings')) {
      lines.push('This browser is not letting TABot keep anything (private browsing or blocked site data can do this). ' +
        'This session works, but nothing is kept after the tab closes, so finish with Done before leaving the page.');
    } else {
      if (has('results')) {
        lines.push('This browser is not letting TABot keep results (private browsing can do this). This session works, ' +
          'but a refresh or a closed tab loses them, so finish with Done before leaving the page.');
      }
      if (has('lost')) {
        lines.push('This browser stopped letting TABot save results. Results read from now on are kept in this tab only, ' +
          'so finish with Done before closing or reloading it.');
      }
      if (has('settings')) {
        lines.push('This browser is not letting TABot save settings. This session works, but the key and answer key ' +
          'are not kept after the tab closes.');
      }
    }
    return lines.join(' ');
  }

  function showNote(node, text) {
    if (node.textContent !== text) setText(node, text);
    node.hidden = !text;
  }

  // Runs after each store call a control makes, with that control's note.
  // Without one (the page's own loading), a problem found after the first
  // touch goes under Stop reading, beside the other results messages.
  function tellStorage(note) {
    var kinds = storageProblems();
    if (!touched) {
      showNote(el.storageWarning, storageText(kinds));
      kinds.forEach(function (kind) { told[kind] = true; });
      return;
    }
    var found = kinds.filter(function (kind) { return !told[kind]; });
    if (!found.length) return;
    found.forEach(function (kind) { told[kind] = true; });
    var target = note || el.photoStorage;
    // A note only grows at its end, below everything already in it.
    showNote(target, (target.textContent ? target.textContent + ' ' : '') + storageText(found));
  }

  // ---------------------------------------------------------------- 1 Setup

  function restoreSetup() {
    var key = store.getKey(PROVIDER);
    if (key) el.apiKey.value = key;
    var verdicts = store.visionCache(PROVIDER).all();
    var vision = Object.keys(verdicts).filter(function (id) {
      return verdicts[id] && verdicts[id].vision === true;
    }).sort();
    if (key && vision.length) showModels(vision);
  }

  function showModels(visionModels) {
    state.visionModels = visionModels.slice();
    var chosen = store.getModel(PROVIDER);
    var ranked = T.providers.rankModels(visionModels, chosen);
    el.model.textContent = '';
    visionModels.forEach(function (id) {
      var option = make('option', null, id);
      option.value = id;
      el.model.appendChild(option);
    });
    el.modelField.hidden = visionModels.length === 0;
    if (ranked.length) {
      el.model.value = ranked[0];
      if (ranked[0] !== chosen) store.setModel(PROVIDER, ranked[0]);
    }
    updateReadiness();
  }

  async function checkKey() {
    hideError(el.setupError);
    var key = el.apiKey.value.trim();
    if (!key) {
      showError(el.setupError, 'Paste your Groq API key first.');
      return;
    }
    store.setKey(PROVIDER, key);
    tellStorage(el.setupStorage);
    el.checkKey.disabled = true;
    setText(el.setupStatus, 'Getting the list of models from Groq...');
    var total = 0;
    try {
      // recheck: a pressed Check key probes every model cached as blind
      // again, since a refusal can end (terms accepted, access granted).
      var result = await T.providers.resolveVisionModels({
        provider: provider,
        key: key,
        cache: store.visionCache(PROVIDER),
        recheck: true,
        onProgress: function (done, count) {
          total = count;
          setText(el.setupStatus, 'Checking which models read images: ' + done + '/' + count);
        }
      });
      showModels(result.visionModels);
      setText(el.setupStatus, checkSummary(result, total));
      if (!result.visionModels.length) showError(el.setupError, noVisionMessage(result));
    } catch (err) {
      setText(el.setupStatus, '');
      if (!isProviderError(err)) {
        showError(el.setupError, unexpected(err));
      } else {
        if (err.status === 401) showModels([]);
        showError(el.setupError, setupErrorMessage(err));
      }
    } finally {
      el.checkKey.disabled = false;
      updateReadiness();
      tellStorage(el.setupStorage);
    }
  }

  function checkSummary(result, total) {
    var n = result.visionModels.length;
    var line = n + ' of ' + plural(total, 'model', 'models') + (n === 1 ? ' reads' : ' read') + ' images.';
    var unknown = result.unknown.length;
    if (unknown) {
      line += ' ' + plural(unknown, 'model', 'models') + ' could not be checked just now; ' +
        'press Check key again later to try ' + (unknown === 1 ? 'it' : 'them') + '.';
    }
    return line;
  }

  function noVisionMessage(result) {
    if (result.unknown.length) {
      return {
        title: 'No model on this key could be confirmed to read images yet.',
        items: ['Groq was busy or out of reach for some models. Wait a minute, then press Check key again.']
      };
    }
    return {
      title: 'None of the models this key can use reads images right now, so TABot cannot read slips with it.',
      items: ['Groq adds and retires models over time. Press Check key again on another day.']
    };
  }

  function setupErrorMessage(err) {
    if (err.status === 401) {
      return 'Groq did not accept this key. Copy it again from your Groq account and paste it here.';
    }
    if (err.status === 0) return 'Could not reach Groq. Check the internet connection, then press Check key again.';
    if (err.status === 429) return 'Groq is busy right now. Wait a minute, then press Check key again.';
    if (err.status >= 500) return 'Groq is having trouble right now. Wait a minute, then press Check key again.';
    return 'Groq answered with an error: ' + err.message;
  }

  // ---------------------------------------------------------------- 2 Answer key

  function restoreAnswerKey() {
    var saved = store.getAnswerKey();
    var questions = saved ? saved.questions : [];
    el.assignment.value = saved ? saved.assignment : '';
    el.passPercent.value = String(saved ? saved.passPercent : DEFAULT_PASS);
    var count = Math.min(MAX_QUESTIONS, questions.length || DEFAULT_QUESTIONS);
    el.questionCount.value = String(count);
    renderQuestionRows(count, questions);
  }

  function questionInputs() {
    return Array.prototype.map.call(el.questionRows.querySelectorAll('.q-row'), function (row) {
      return {
        answer: row.querySelector('.q-answer'),
        points: row.querySelector('.q-points'),
        match: row.querySelector('.q-match')
      };
    });
  }

  // A question's match setting: 'exact' (exact form) only when it says so;
  // anything else, including a key saved before the setting existed, is 'value'.
  function matchOf(question) {
    return question && question.match === 'exact' ? 'exact' : 'value';
  }

  // Rebuilds the rows for count questions, keeping what is already typed.
  function renderQuestionRows(count, questions) {
    var typed = questionInputs().map(function (q) {
      return { answer: q.answer.value, points: q.points.value, match: q.match.value };
    });
    var rows = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      rows.appendChild(questionRow(i + 1, questions[i] || typed[i] || { answer: '', points: 1, match: 'value' }));
    }
    el.questionRows.textContent = '';
    el.questionRows.appendChild(rows);
  }

  function questionRow(n, q) {
    var row = make('div', 'q-row');
    row.appendChild(make('span', 'q-label', 'Q' + n));

    var answer = make('input', 'q-answer');
    answer.type = 'text';
    answer.id = 'q' + n + '-answer';
    answer.autocomplete = 'off';
    answer.spellcheck = false;
    answer.setAttribute('autocapitalize', 'off');
    answer.setAttribute('aria-label', 'Answer to question ' + n);
    answer.value = q.answer;
    row.appendChild(answer);

    var points = make('input', 'q-points');
    points.type = 'number';
    points.id = 'q' + n + '-points';
    points.min = '0';
    points.step = 'any';
    points.inputMode = 'decimal';
    points.setAttribute('aria-label', 'Points for question ' + n);
    points.value = String(q.points);
    row.appendChild(points);

    // After points in the page's order, so the keyboard moves along the
    // first line (answer, points) before the match setting under it.
    var match = make('select', 'q-match');
    match.id = 'q' + n + '-match';
    match.setAttribute('aria-label', 'Match for question ' + n);
    [['value', 'Value'], ['exact', 'Exact form']].forEach(function (choice) {
      var option = make('option', null, choice[1]);
      option.value = choice[0];
      match.appendChild(option);
    });
    match.value = matchOf(q);
    row.appendChild(match);
    return row;
  }

  function numberOr(raw, fallback) {
    var text = String(raw).trim();
    var n = Number(text);
    return text !== '' && isFinite(n) ? n : fallback;
  }

  function readAnswerKey() {
    return {
      assignment: el.assignment.value.trim(),
      passPercent: Math.min(100, Math.max(0, numberOr(el.passPercent.value, DEFAULT_PASS))),
      questions: questionInputs().map(function (q) {
        var points = numberOr(q.points.value, 1);
        return { answer: q.answer.value.trim(), points: points >= 0 ? points : 1, match: matchOf({ match: q.match.value }) };
      })
    };
  }

  // A blank answer could never be matched, so the key is not usable until
  // every question has one.
  function answerKeyProblem(key) {
    if (!key.questions.length) return 'Set the number of questions in step 2.';
    for (var i = 0; i < key.questions.length; i++) {
      if (!key.questions[i].answer) return 'Fill in the answer to Q' + (i + 1) + ' in step 2.';
    }
    return null;
  }

  // A change to the answer key while "Did the file save?" is open closes the
  // question: the file holds the marks, name and pass mark from before the
  // change, so clearing the results now would keep only an out-of-date copy.
  function onAnswerKeyInput() {
    store.setAnswerKey(readAnswerKey());
    tellStorage(el.keyStorage);
    if (state.saveCheck) {
      closeSaveQuestion();
      setText(el.doneStatus, 'The answer key changed after the download, so nothing was cleared. ' +
        'Press Done for a spreadsheet with the change.');
    }
    updateReadiness();
    scheduleRegrade();
  }

  function onQuestionCountInput() {
    var n = parseInt(el.questionCount.value, 10);
    if (!(n >= 1 && n <= MAX_QUESTIONS)) return; // still typing; settled on change
    if (n !== questionInputs().length) renderQuestionRows(n, []);
    onAnswerKeyInput();
  }

  function onQuestionCountChange() {
    var n = parseInt(el.questionCount.value, 10);
    if (!(n >= 1)) n = questionInputs().length || DEFAULT_QUESTIONS;
    el.questionCount.value = String(Math.min(MAX_QUESTIONS, n));
    onQuestionCountInput();
  }

  // Rows keep both parsed reads, so a corrected answer key regrades every
  // stored slip instead of leaving old marks behind. An edit made while a
  // photo is in progress regrades once it finishes (onPhotoChosen), even when
  // none of its slips is stored yet: a slip graded just before the edit lands
  // after it.
  function scheduleRegrade() {
    if (state.busy) state.regradePending = true;
    if (!state.rows.length) return;
    clearTimeout(state.regradeTimer);
    state.regradeTimer = setTimeout(function () {
      regrade().catch(function (err) { showError(el.photoError, unexpected(err)); });
    }, REGRADE_DELAY_MS);
  }

  function regrade() {
    if (state.busy) {
      state.regradePending = true;
      return Promise.resolve();
    }
    state.regradePending = false;
    return serial(async function () {
      try {
        var key = readAnswerKey();
        if (answerKeyProblem(key)) return; // a half-typed key keeps the last good marks
        var rows = await store.allRows();
        var updated = rows.filter(function (row) {
          return row.reading && Array.isArray(row.answers) && row.answers.length === key.questions.length;
        }).map(function (row) { return buildRow(key, row); });
        if (!updated.length) return;
        // A regrade stores no new slip, so the time of the last photo stays.
        await store.addRows(updated, { regrade: true });
        await refreshRows();
      } finally {
        // A regrade follows an edit to the answer key.
        tellStorage(el.keyStorage);
      }
    });
  }

  // ---------------------------------------------------------------- readiness

  function readinessProblem() {
    if (!store.getKey(PROVIDER)) return 'Paste your Groq key in step 1 and press Check key.';
    if (!state.visionModels.length) return 'Press Check key in step 1 to find a model that reads images.';
    return answerKeyProblem(readAnswerKey());
  }

  function updateReadiness() {
    var why = readinessProblem();
    var photosOn = !state.busy && !why;
    [[el.takePhoto, el.takePhotoButton], [el.uploadPhoto, el.uploadPhotoButton]].forEach(function (pair) {
      pair[0].disabled = !photosOn;
      pair[1].classList.toggle('is-disabled', !photosOn);
      pair[1].setAttribute('aria-disabled', photosOn ? 'false' : 'true');
    });
    setText(el.photoHint, why ? 'Before taking photos: ' + why : '');
    el.photoHint.hidden = !why || state.busy;

    var reading = !!state.job;
    el.stopReading.hidden = !reading;
    el.stopReading.disabled = reading && !!state.job.stopped;
    el.done.disabled = state.busy || state.rows.length === 0;
    var doneHint = reading ? 'Stop reading to finish.' : state.asking ? 'Choose Read anyway or Retake first.' : '';
    setText(el.doneHint, doneHint);
    el.doneHint.hidden = !doneHint;

    // The count sets how many answers every read returns, so it cannot move
    // while a photo is read or while rows graded on it are stored.
    el.questionCount.disabled = state.busy || state.rows.length > 0;
    var locked = state.rows.length > 0
      ? 'The number of questions is locked while results are stored. Finish with Done to change it.'
      : state.busy ? 'The number of questions is locked while a photo is read.' : '';
    setText(el.countLocked, locked);
    el.countLocked.hidden = !locked;
  }

  // ---------------------------------------------------------------- 3 Photos

  // While a photo is in progress, leaving or reloading the page asks first:
  // slips still being read would be lost.
  function holdPage(event) {
    event.preventDefault();
    event.returnValue = 'A photo is still being read.';
    return event.returnValue;
  }

  function setPhotoBusy(busy) {
    state.busy = busy;
    if (busy) window.addEventListener('beforeunload', holdPage);
    else window.removeEventListener('beforeunload', holdPage);
  }

  // The photo the teacher chose, held only until it is decoded. release()
  // empties the input and drops the File, so from then on nothing on the page
  // holds the original photo; calling it again does nothing more.
  function chosenPhoto(input) {
    var chosen = { file: (input.files && input.files[0]) || null, release: null };
    chosen.release = function () {
      chosen.file = null;
      input.value = '';
    };
    return chosen;
  }

  async function onPhotoChosen(input) {
    var chosen = chosenPhoto(input);
    if (!chosen.file || state.busy) {
      chosen.release();
      return;
    }
    var why = readinessProblem();
    if (why) {
      showError(el.photoError, why);
      chosen.release();
      return;
    }
    setPhotoBusy(true);
    // A new photo means the results were not confirmed saved: an open Done
    // question closes, and Done is pressed again once the photo is in.
    closeDoneConfirm();
    closeSaveQuestion();
    setText(el.doneStatus, '');
    setText(el.resultsStatus, '');
    hideError(el.photoError);
    setText(el.photoFound, '');
    updateReadiness();
    try {
      await processPhoto(chosen);
    } catch (err) {
      showError(el.photoError, err && err.teacherMessage ? err.teacherMessage : unexpected(err));
    } finally {
      // Released as the photo was decoded; this covers a failure before that.
      chosen.release();
      closeSlipQuestion();
      setPhotoBusy(false);
      setText(el.photoProgress, 'Ready for the next photo.');
      updateReadiness();
      tellStorage(el.photoStorage);
      if (state.regradePending) {
        // This regrade covers every edit so far, so a timer still waiting is not needed.
        clearTimeout(state.regradeTimer);
        regrade().catch(function (err) { showError(el.photoError, unexpected(err)); });
      }
    }
  }

  async function processPhoto(chosen) {
    var controller = new AbortController();
    var job = {
      key: store.getKey(PROVIDER),
      answerKey: readAnswerKey(),
      models: T.providers.rankModels(state.visionModels, store.getModel(PROVIDER)),
      photoIndex: null,
      controller: controller,
      signal: controller.signal,
      stopped: null,   // {reason: 'teacher' | 'key' | 'error', error}
      total: 0,
      saved: 0,
      modelGone: false,
      failure: null
    };
    setText(el.photoProgress, 'Opening the photo...');
    var cut = await cutPhoto(chosen);

    // The count shows before anything is read, so the teacher can hold it
    // against the stack.
    var found = cut.whole ? 'No paper edges found, so the whole photo is read as one paper.'
      : 'Found ' + plural(cut.crops.length, 'slip', 'slips') + '.';
    setText(el.photoFound, found);
    var concern = slipConcern(cut.slips);
    if (concern) {
      setText(el.photoFound, found + ' ' + concern);
      setText(el.photoProgress, '');
      var choice = await askAboutSlips();
      if (choice !== 'read') {
        cut = null;
        setText(el.photoFound, 'Photo set aside; nothing was read. Take it again once the slips are spread out.');
        return;
      }
      setText(el.photoFound, found);
    }

    // Reading starts in one step on the store chain. Results already past
    // their 24 hours are cleared first, so this photo's slips cannot renew
    // them; then the photo takes its index. From there until its reads end,
    // no expiry runs (expiryWaits).
    job.total = cut.crops.length;
    await serial(async function () {
      await expireNow().catch(function () { return false; });
      job.photoIndex = await store.nextPhotoIndex();
      state.job = job;
    });
    var results;
    try {
      holdScreen();
      updateReadiness();
      await store.setInFlight({ photoIndex: job.photoIndex, total: job.total, done: 0 });
      tellStorage(el.photoStorage);
      results = await readAll(job, cut.crops);
    } finally {
      cut = null;
      state.job = null;
      releaseScreen();
      clearWait();
      await store.clearInFlight().catch(function () {});
    }
    await refreshRows();
    reportOutcome(job, results);
  }

  // -> null, or the sentence naming why a found slip may not be one slip.
  // segment.js marks a blob 'touching' when its shape is two slips, and
  // 'large' when it is slip-shaped but far bigger than the rest.
  function slipConcern(slips) {
    function count(kind) {
      return slips.filter(function (s) { return s.suspect === kind; }).length;
    }
    var touching = count('touching');
    var large = count('large');
    var parts = [];
    if (touching) {
      parts.push(touching === 1 ? 'One looks like two slips touching.'
        : touching + ' of them look like two slips touching.');
    }
    if (large) {
      parts.push(large === 1 ? 'One is much larger than the rest; if it is two slips side by side, retake the photo.'
        : large + ' of them are much larger than the rest; if any is two slips side by side, retake the photo.');
    }
    return parts.join(' ');
  }

  // Nothing is read until the teacher answers: 'read' or 'retake'.
  function askAboutSlips() {
    return new Promise(function (resolve) {
      state.asking = resolve;
      setText(el.photoCheckText, 'Count the slips in the photo. Read anyway if the count is right; ' +
        'retake if it is short, with a gap of surface around each slip.');
      el.photoCheck.hidden = false;
      updateReadiness();
      el.retake.focus();
    });
  }

  function answerSlipQuestion(choice) {
    var resolve = state.asking;
    if (!resolve) return;
    closeSlipQuestion();
    resolve(choice);
  }

  function closeSlipQuestion() {
    state.asking = null;
    el.photoCheck.hidden = true;
    setText(el.photoCheckText, '');
  }

  // Decode, find the slips, cut one upright JPEG per slip plus its enhanced
  // copy. A mostly bright photo with no paper edges to find is one paper,
  // the whole photo (segment.js's 'whole' warning). The chosen file is let
  // go as soon as it is decoded, before the slips are looked for. Crops are
  // drawn straight from the decoded photo at full resolution; the decoded
  // photo is released after the last crop, and every canvas before this
  // returns. -> {crops, slips, whole} with slips from segment.js, whole true
  // when the photo is read whole.
  async function cutPhoto(chosen) {
    var photo;
    try {
      photo = await decodePhoto(chosen.file);
    } finally {
      chosen.release();
    }
    try {
      var analysis = drawScaled(photo, ANALYSIS_LONG_SIDE, true);
      var found, analysisWidth;
      try {
        found = T.segment.findSlipsDetailed(readPixels(analysis));
        analysisWidth = analysis.width;
      } finally {
        releaseCanvas(analysis);
      }
      if (!found.slips.length) throw problem('No slips found in this photo.', CAPTURE_TIPS);

      // A photo read whole is cut at its own edges, with no pad of surface.
      var scale = photo.width / analysisWidth;
      var crops = found.slips.map(function (slip) {
        return cutCrop(photo.image, T.segment.cropPlan(slip, scale, { pad: slip.whole ? 0 : CROP_PAD }));
      });
      return { crops: crops, slips: found.slips, whole: found.warnings.indexOf('whole') >= 0 };
    } finally {
      photo.release();
    }
  }

  // createImageBitmap applies the photo's EXIF rotation; older Safari rejects
  // the options bag, and <img> (which also honors EXIF) is the fallback.
  async function decodePhoto(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        var bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return {
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: function () { bitmap.close(); }
        };
      } catch (err) {
        // fall through to <img>
      }
    }
    return decodeWithImg(file);
  }

  // The object URL is the one link from the page to the file, so it is
  // revoked as soon as the image has loaded; a loaded image still draws.
  function decodeWithImg(file) {
    var url = URL.createObjectURL(file);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve({
          image: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          release: function () {
            img.removeAttribute('src');
          }
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(problem('This file could not be opened as a photo.', ['Take the photo again, or upload a JPEG or PNG.']));
      };
      img.src = url;
    });
  }

  function fitSize(width, height, longSide) {
    var long = Math.max(width, height);
    var k = Math.min(1, longSide / long, CANVAS_MAX_SIDE / long);
    return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
  }

  function makeCanvas(width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.min(CANVAS_MAX_SIDE, width);
    canvas.height = Math.min(CANVAS_MAX_SIDE, height);
    return canvas;
  }

  function context2d(canvas, willRead) {
    var ctx = canvas.getContext('2d', willRead ? { willReadFrequently: true } : undefined);
    if (!ctx) {
      throw problem('This device ran out of room to open the photo.', [
        'Close other tabs and try again, or take the photo at a lower resolution.'
      ]);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  // Setting a canvas to 0 x 0 frees its pixels now; iOS Safari has a small
  // total canvas budget and does not free them promptly otherwise.
  function releaseCanvas(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  function drawScaled(photo, longSide, willRead) {
    var size = fitSize(photo.width, photo.height, longSide);
    var canvas = makeCanvas(size.width, size.height);
    context2d(canvas, willRead).drawImage(photo.image, 0, 0, size.width, size.height);
    return canvas;
  }

  function readPixels(canvas) {
    return context2d(canvas, true).getImageData(0, 0, canvas.width, canvas.height);
  }

  // plan = {cx, cy, w, h, angle} in the photo's own pixels (segment.js's
  // convention). The crop is drawn upright from the full-resolution image,
  // scaled so its long side is at most CROP_LONG_SIDE.
  function cutCrop(image, plan) {
    var k = Math.min(1, CROP_LONG_SIDE / Math.max(plan.w, plan.h));
    var width = Math.max(1, Math.round(plan.w * k));
    var height = Math.max(1, Math.round(plan.h * k));
    var canvas = makeCanvas(width, height);
    try {
      var ctx = context2d(canvas, true);
      ctx.scale(width / plan.w, height / plan.h);
      ctx.translate(plan.w / 2, plan.h / 2);
      ctx.rotate(-plan.angle);
      ctx.translate(-plan.cx, -plan.cy);
      ctx.drawImage(image, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var reader = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

      var enhanced = T.enhance.enhance(ctx.getImageData(0, 0, width, height));
      var pixels = ctx.createImageData(width, height);
      pixels.data.set(enhanced.data);
      ctx.putImageData(pixels, 0, 0);
      return { reader: reader, reviewer: canvas.toDataURL('image/jpeg', JPEG_QUALITY) };
    } finally {
      releaseCanvas(canvas);
    }
  }

  // Every slip is read twice (reader on the crop, reviewer on the enhanced
  // copy), all through the one page queue. A slip is graded and stored the
  // moment its two reads finish.
  async function readAll(job, crops) {
    var total = crops.length * 2;
    var done = 0;
    var questionCount = job.answerKey.questions.length;
    job.questionCount = questionCount;
    job.messages = {
      reader: T.prompt.readerMessages({ questionCount: questionCount }),
      reviewer: T.prompt.reviewerMessages({ questionCount: questionCount })
    };
    function tick() {
      done++;
      if (!job.stopped) setText(el.photoProgress, 'Reading ' + done + '/' + total);
    }
    setText(el.photoProgress, 'Reading 0/' + total);
    var results = await Promise.all(crops.map(function (crop, slipIndex) {
      return readSlip(job, crop, slipIndex, tick).catch(function (err) {
        // Not a provider answer (a bug, or a store write that failed): stop
        // the other reads and report it once they have settled.
        if (!job.failure) job.failure = err;
        stopJob(job, 'error', err);
        return { slipIndex: slipIndex, reader: { ok: false, aborted: true }, reviewer: { ok: false, aborted: true }, saved: false };
      });
    }));
    if (job.failure) throw job.failure;
    return results;
  }

  async function readSlip(job, crop, slipIndex, tick) {
    function counted(result) {
      tick();
      return result;
    }
    var reads = await Promise.all([
      readPass(job, slipIndex, 'reader', crop.reader).then(counted),
      readPass(job, slipIndex, 'reviewer', crop.reviewer).then(counted)
    ]);
    crop.reader = null;
    crop.reviewer = null;
    var result = { slipIndex: slipIndex, reader: reads[0], reviewer: reads[1], saved: false };
    // Finished: the reader read it, and the second read ended on its own
    // (read, or failed on every model). A read cut short by a stop leaves
    // the slip unfinished, and it needs a retake.
    if (result.reader.ok && !result.reviewer.aborted) {
      await saveSlip(job, result);
      result.saved = true;
    }
    return result;
  }

  // The slip is graded when its turn on the store chain comes, on the answer
  // key as it stands then (gradingKey). The in-flight marker counts the slips
  // stored so far, so a reload or a closed tab can say which photo was cut
  // short and after how many slips.
  function saveSlip(job, result) {
    return serial(async function () {
      try {
        await store.addRows([slipRow(job, result)]);
        job.saved++;
        await store.setInFlight({ photoIndex: job.photoIndex, total: job.total, done: job.saved });
        await refreshRows();
      } finally {
        tellStorage(el.photoStorage);
      }
    });
  }

  // Walks the ranked models until one returns a usable reading. Never
  // rejects for a provider answer or a stop; the result says what happened.
  async function readPass(job, slipIndex, pass, imageDataUrl) {
    if (testHook && typeof testHook.onCrop === 'function') {
      await testHook.onCrop(job.photoIndex, slipIndex, pass, imageDataUrl);
    }
    var lastError = null;
    for (var i = 0; i < job.models.length; i++) {
      if (job.stopped) break;
      var attempt = await readWithModel(job, job.models[i], slipIndex, pass, imageDataUrl);
      if (attempt.ok || attempt.aborted) return attempt;
      lastError = attempt.error;
    }
    if (job.stopped) return { ok: false, aborted: true, error: job.stopped.error };
    return { ok: false, error: lastError || new Error('there was no model to read it with') };
  }

  // One model's try at one image. The queue retries 429, 5xx, network errors
  // and timeouts, reporting each wait; any other error, or a reply that is
  // not the expected JSON, sends the image on to the next model. A 401 stops
  // every read of this photo, and so does Stop reading (an AbortError).
  async function readWithModel(job, model, slipIndex, pass, imageDataUrl) {
    var messages = job.messages[pass];
    var waitToken = {};
    try {
      var res = await queue.run(function () {
        return provider.read({
          key: job.key,
          model: model,
          imageDataUrl: imageDataUrl,
          system: messages.system,
          user: messages.user,
          signal: job.signal
        });
      }, {
        signal: job.signal,
        onRetry: function (info) { showWait(job, waitToken, waitText(info, slipIndex)); }
      });
      var parsed = T.prompt.parseReading(res.text, job.questionCount);
      if (parsed.ok) return { ok: true, reading: parsed.reading, model: res.model || model };
      var bad = new Error(res.finishReason === 'length'
        ? 'the model\'s reply was cut off before it finished'
        : 'the model\'s reply was not in the expected form');
      bad.kind = 'reply';
      return { ok: false, error: bad };
    } catch (err) {
      if (T.queue.isAbortError(err)) return { ok: false, aborted: true, error: err };
      if (!isProviderError(err)) throw err;
      if (modelGone(err, model)) job.modelGone = true;
      if (err.status === 401) stopJob(job, 'key', err);
      return { ok: false, error: err };
    } finally {
      clearWait(waitToken);
    }
  }

  // A model the provider no longer serves: 404, or a 400 that names it
  // (Groq's decommissioned-model answer). Check key refreshes the list.
  function modelGone(err, model) {
    if (err.status === 404) return true;
    if (err.status !== 400 || err.kind === 'invalid_json') return false;
    return String(err.message).indexOf(model) >= 0 || /^model_/.test(String(err.code || ''));
  }

  function stopJob(job, reason, error) {
    if (job.stopped) return;
    job.stopped = { reason: reason, error: error || null };
    job.controller.abort();
    if (state.job === job) updateReadiness();
  }

  // Stop reading: queued and in-flight reads end now; slips already graded
  // stay stored.
  function stopReading() {
    var job = state.job;
    if (!job || job.stopped) return;
    stopJob(job, 'teacher');
    releaseScreen();
    clearWait();
    setText(el.photoProgress, 'Stopping...');
  }

  // ---------------------------------------------------------------- screen wake lock

  // The screen stays on while a photo's slips are read, so a phone left on
  // the desk does not sleep mid-class. It is asked for as reading starts
  // (after the question about the slips, when there is one; never while the
  // page waits on the teacher) and released as reading ends or is stopped.
  // The browser drops the lock when the page is hidden; it is asked for again
  // when the page is visible and the slips are still being read. Any failure
  // is ignored: no message, no retry.
  function holdScreen() {
    wake.wanted = true;
    requestScreen();
  }

  function requestScreen() {
    if (!wake.wanted || wake.pending) return;
    if (wake.sentinel && wake.sentinel.released !== true) return;
    var api = navigator.wakeLock;
    if (!api || typeof api.request !== 'function') return;
    var request;
    try {
      request = Promise.resolve(api.request('screen'));
    } catch (err) {
      return;
    }
    wake.pending = true;
    request.then(function (sentinel) {
      wake.pending = false;
      if (!sentinel) return;
      if (!wake.wanted) {
        releaseSentinel(sentinel);
        return;
      }
      wake.sentinel = sentinel;
      if (typeof sentinel.addEventListener === 'function') {
        sentinel.addEventListener('release', function () {
          if (wake.sentinel === sentinel) wake.sentinel = null;
        });
      }
    }, function () {
      wake.pending = false;
    });
  }

  function releaseScreen() {
    wake.wanted = false;
    var sentinel = wake.sentinel;
    wake.sentinel = null;
    if (sentinel) releaseSentinel(sentinel);
  }

  function releaseSentinel(sentinel) {
    try {
      Promise.resolve(sentinel.release()).catch(function () {});
    } catch (err) {
      // already released, or not releasable: nothing to do
    }
  }

  // The wait line: what the queue is waiting on right now, and for which slip.
  function waitText(info, slipIndex) {
    var seconds = Math.max(1, Math.round(info.delayMs / 1000));
    var slip = 'slip ' + (slipIndex + 1);
    if (info.kind === 'rate_limit') return 'Groq is busy; waiting ' + seconds + ' s before retrying ' + slip + '.';
    if (info.kind === 'server') return 'Groq is having trouble; waiting ' + seconds + ' s before retrying ' + slip + '.';
    if (info.kind === 'timeout' || info.kind === 'network') {
      return 'No answer from Groq; check the connection. Trying ' + slip + ' again in ' + seconds + ' s.';
    }
    return 'The reply for ' + slip + ' was not in the expected form; asking again in ' + seconds + ' s.';
  }

  function showWait(job, token, text) {
    if (state.job !== job || job.stopped) return;
    state.waitToken = token;
    setText(el.photoWait, text);
  }

  // With a token, the line is cleared only while that read still owns it.
  function clearWait(token) {
    if (token && state.waitToken !== token) return;
    state.waitToken = null;
    setText(el.photoWait, '');
  }

  // The key a slip is graded on as it is saved: the answer key as it stands
  // now, so a correction made while the photo is read reaches every slip. The
  // key the photo started with stands in while the current one is half-typed
  // (the regrade after the photo catches up) or asks a different number of
  // questions than the slips were read for (countDrift names that case).
  function gradingKey(job) {
    var key = readAnswerKey();
    if (answerKeyProblem(key) || key.questions.length !== job.questionCount) return job.answerKey;
    return key;
  }

  function slipRow(job, r) {
    var review = r.reviewer.ok ? r.reviewer.reading : null;
    return buildRow(gradingKey(job), {
      photoIndex: job.photoIndex,
      slipIndex: r.slipIndex,
      reading: r.reader.reading,
      review: review,
      readBy: r.reader.model,
      reviewedBy: review ? r.reviewer.model : '',
      reviewMode: review ? SECOND_READ_MODE : 'none'
    });
  }

  // A stored row: grade.gradeSlip's output plus where the slip came from, who
  // read it, and both parsed reads (kept so a key correction can regrade).
  function buildRow(answerKey, slip) {
    var graded = T.grade.gradeSlip({
      key: answerKey,
      reading: slip.reading,
      review: slip.review || null,
      reviewMode: slip.review ? slip.reviewMode : undefined
    });
    graded.id = 'p' + slip.photoIndex + '-s' + slip.slipIndex;
    graded.photoIndex = slip.photoIndex;
    graded.slipIndex = slip.slipIndex;
    graded.readBy = slip.readBy || '';
    graded.reviewedBy = slip.reviewedBy || '';
    graded.reading = slip.reading;
    graded.review = slip.review || null;
    return graded;
  }

  function reportOutcome(job, results) {
    var messages = [outcomeMessage(job, results), countDrift(job)].filter(Boolean);
    if (!messages.length) return;
    var first = messages[0];
    messages.slice(1).forEach(function (m) {
      first.items.push(m.title);
      first.items.push.apply(first.items, m.items);
    });
    showError(el.photoError, first);
  }

  function slipList(results) {
    var numbers = results.map(function (r) { return String(r.slipIndex + 1); });
    if (numbers.length === 1) return 'slip ' + numbers[0];
    return 'slips ' + numbers.slice(0, -1).join(', ') + ' and ' + numbers[numbers.length - 1];
  }

  function outcomeMessage(job, results) {
    var number = job.photoIndex + 1;
    var unsaved = results.filter(function (r) { return !r.saved; });
    if (job.stopped && job.stopped.reason === 'teacher') {
      if (!unsaved.length) return null;
      return {
        title: 'Stopped reading photo ' + number + '. ' + job.saved + ' of ' + plural(results.length, 'slip', 'slips') +
          (job.saved === 1 ? ' was' : ' were') + ' saved; the other ' + unsaved.length +
          (unsaved.length === 1 ? ' needs' : ' need') + ' a retake.',
        items: [
          'Not read: ' + slipList(unsaved) + ', counted left to right, top row first.',
          'Photograph just those slips, or discard photo ' + number + ' and take it again.'
        ]
      };
    }
    if (job.stopped && job.stopped.reason === 'key') {
      var items = ['Check the key in step 1 and press Check key, then take the photo again.'];
      if (job.saved) items.unshift('Slips read before that are saved below.');
      return { title: 'Groq did not accept the key, so this photo was not fully read.', items: items };
    }
    var failed = results.filter(function (r) { return !r.reader.ok; });
    if (!failed.length) return null;
    var lines = failed.map(function (r) {
      return 'Slip ' + (r.slipIndex + 1) + ': ' + failureReason(r.reader.error) + '.';
    });
    if (job.modelGone) lines.push('Press Check key in step 1 to refresh the model list.');
    lines.push('Slips are counted left to right, top row first. Grade those by hand, or discard this photo and take it again.');
    return {
      title: failed.length + ' of ' + plural(results.length, 'slip', 'slips') +
        ' could not be read, even after retries and trying every model.',
      items: lines
    };
  }

  // Busy (Groq answered, but with 429 or a server error) and unreachable
  // (no answer at all) are told apart: only the second is the connection.
  function failureReason(err) {
    if (!err) return 'no reason given';
    if (err.kind === 'reply') return err.message;
    if (err.kind === 'invalid_json') return 'the model\'s reply was not in the expected form';
    if (err.status === 429) return 'Groq stayed busy, even after waiting and retrying';
    if (err.status === 0) return 'No answer from Groq; check the connection';
    if (err.status >= 500) return 'Groq had a server problem';
    return 'Groq refused it (' + err.message + ')';
  }

  // The backstop behind the locked question count: if the key's count moved
  // while the photo was read, its slips were graded on the old count.
  function countDrift(job) {
    var now = readAnswerKey().questions.length;
    if (now === job.questionCount) return null;
    var number = job.photoIndex + 1;
    return {
      title: 'The number of questions changed from ' + job.questionCount + ' to ' + now + ' while photo ' + number +
        ' was read, so its slips were graded on ' + job.questionCount + ' questions.',
      items: ['Discard photo ' + number + ', then take it again to grade it on ' + now + '.']
    };
  }

  // A photo whose reading was cut off by a reload or a closed tab leaves its
  // in-flight marker behind; say so once, then clear it. A marker whose photo
  // has as many rows stored as it has slips was left by a storage loss, not an
  // interruption (the store could not reach it when the photo ended), so it
  // is cleared without a word: a retake would only put those students in the
  // spreadsheet twice.
  function noteInterrupted() {
    return store.getInFlight().then(function (marker) {
      if (!marker || state.busy) return null;
      var stored = state.rows.filter(function (row) { return row.photoIndex === marker.photoIndex; }).length;
      if (stored >= marker.total) return store.clearInFlight();
      var number = marker.photoIndex + 1;
      var items = [];
      if (marker.done) {
        items.push('The ' + plural(marker.done, 'slip', 'slips') + ' read before that ' + (marker.done === 1 ? 'is' : 'are') +
          ' saved below. Discard photo ' + number + ' first if you retake every slip in it.');
      }
      showError(el.photoError, {
        title: 'Photo ' + number + ' was interrupted after ' + marker.done + ' of ' + plural(marker.total, 'slip', 'slips') +
          '; take it again to read the rest.',
        items: items
      });
      return store.clearInFlight();
    });
  }

  // ---------------------------------------------------------------- 4 Results

  async function refreshRows() {
    state.rows = await store.allRows();
    renderResults();
    updateReadiness();
  }

  function groupByPhoto(rows) {
    var groups = [];
    var byIndex = {};
    rows.forEach(function (row) {
      var k = String(row.photoIndex);
      if (!byIndex[k]) {
        byIndex[k] = { photoIndex: row.photoIndex, rows: [] };
        groups.push(byIndex[k]);
      }
      byIndex[k].rows.push(row);
    });
    return groups;
  }

  function renderResults() {
    var groups = groupByPhoto(state.rows);
    el.results.textContent = '';
    el.resultsEmpty.hidden = groups.length > 0;
    el.resultsLegend.hidden = groups.length === 0;
    groups.forEach(function (group) { el.results.appendChild(renderGroup(group)); });
    // After a storage loss, says why results saved before it are missing from
    // the list, for as long as they are; it changes with the list it explains.
    el.resultsUnread.hidden = !store.earlierRowsUnread;
  }

  function renderGroup(group) {
    var n = group.rows.length;
    var number = group.photoIndex + 1;
    var box = make('div', 'photo-group');
    box.setAttribute('data-photo', String(group.photoIndex));

    var head = make('div', 'photo-head');
    var title = make('h3', null, 'Photo ' + number + ' ');
    title.appendChild(make('span', 'photo-count', '(' + plural(n, 'slip', 'slips') + ')'));
    var discard = make('button', 'btn btn-secondary btn-small discard', 'Discard this photo');
    discard.type = 'button';
    // The photo still being read is stopped with Stop reading, not discarded
    // under the reads that are about to store more of its slips.
    discard.disabled = !!state.job && state.job.photoIndex === group.photoIndex;
    head.appendChild(title);
    head.appendChild(discard);
    box.appendChild(head);

    var confirm = make('div', 'confirm');
    confirm.hidden = true;
    confirm.appendChild(make('p', null, 'Discard photo ' + number + ' and its ' + plural(n, 'result', 'results') +
      '? You can take the photo again afterwards.'));
    var actions = make('div', 'confirm-actions');
    var yes = make('button', 'btn btn-primary', 'Discard');
    var no = make('button', 'btn btn-secondary', 'Keep');
    yes.type = 'button';
    no.type = 'button';
    actions.appendChild(yes);
    actions.appendChild(no);
    confirm.appendChild(actions);
    box.appendChild(confirm);

    discard.addEventListener('click', function () {
      confirm.hidden = false;
      discard.hidden = true;
      yes.focus();
    });
    no.addEventListener('click', function () {
      confirm.hidden = true;
      discard.hidden = false;
    });
    yes.addEventListener('click', function () {
      yes.disabled = true;
      serial(function () {
        return store.removePhoto(group.photoIndex).then(refreshRows);
      }).catch(function (err) { showError(el.photoError, unexpected(err)); }).then(function () {
        tellStorage(el.resultsStorage);
      });
    });

    box.appendChild(resultsTable(group.rows));
    return box;
  }

  function resultsTable(rows) {
    var table = make('table', 'results-table');
    var head = make('tr');
    [['Student', 'col-student'], ['Score', 'col-score'], ['Flags', 'col-flags']].forEach(function (c) {
      var th = make('th', c[1], c[0]);
      th.scope = 'col';
      head.appendChild(th);
    });
    var thead = make('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    var body = make('tbody');
    rows.forEach(function (row) {
      var tr = make('tr');
      tr.setAttribute('data-row', row.id);
      tr.appendChild(make('td', 'student', (row.studentName || '(no name)') + (row.nameFlag ? ' *' : '')));
      tr.appendChild(make('td', 'num score', formatNumber(row.score) + '/' + formatNumber(row.maxScore)));
      tr.appendChild(make('td', 'flag', flagsText(row)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  function flagsText(row) {
    var parts = [];
    if (row.nameFlag) parts.push('name');
    (row.answers || []).forEach(function (a) {
      if (a && a.flagged) parts.push('Q' + a.q);
    });
    if (row.reviewMode === 'none') parts.push('no second read');
    return row.flagged || parts.length ? ('* ' + parts.join(', ')).trim() : '';
  }

  // ---------------------------------------------------------------- Done

  // After a storage loss, whether the results saved before it can be read may
  // have changed since the list was drawn, so the list is read again first and
  // the count asked about is the one Done downloads.
  function openDoneConfirm() {
    if (!state.rows.length || state.busy) return Promise.resolve();
    var fresh = store.memoryReason === 'lost' ? serial(refreshRows) : Promise.resolve();
    return fresh.then(function () {
      tellStorage(el.doneStorage);
      showDoneConfirm();
    });
  }

  function showDoneConfirm() {
    var n = state.rows.length;
    if (!n || state.busy) return;
    var text = 'The spreadsheet for ' + plural(n, 'student', 'students') + ' downloads, and then TABot asks whether it saved.';
    if (store.earlierRowsUnread) {
      text += ' Results saved before the storage problem cannot be read right now, so they are left out and stay in this browser.';
    }
    setText(el.doneConfirmText, text + ' Nothing is deleted from this browser until you say the file saved. ' +
      'Your key and answer key stay.');
    el.doneConfirm.hidden = false;
    el.done.hidden = true;
    el.doneYes.focus();
  }

  function closeDoneConfirm() {
    el.doneConfirm.hidden = true;
    el.done.hidden = !!state.saveCheck;
  }

  // "Did the file save?", asked after every download.
  function openSaveQuestion() {
    el.doneSaved.hidden = false;
    el.done.hidden = true;
    el.savedYes.focus();
  }

  // Closes the question without clearing anything; Done asks again next time.
  function closeSaveQuestion() {
    state.saveCheck = null;
    el.doneSaved.hidden = true;
    el.done.hidden = !el.doneConfirm.hidden;
  }

  // While Done's own store work runs, the page is busy (no photo starts), no
  // expiry runs, and the question's buttons wait.
  async function doneTask(task) {
    if (state.busy) return;
    state.busy = true;
    state.finishing = true;
    el.savedYes.disabled = true;
    el.savedNo.disabled = true;
    updateReadiness();
    try {
      await serial(task);
    } finally {
      state.busy = false;
      state.finishing = false;
      el.savedYes.disabled = false;
      el.savedNo.disabled = false;
      updateReadiness();
      tellStorage(el.doneStorage);
    }
  }

  // Download on the confirm, and No on the question: the spreadsheet is made
  // again from the stored rows and handed over, then the page asks whether it
  // saved. Nothing is cleared here. Runs on the store chain, so a regrade or a
  // discard already running finishes before the rows are read.
  function downloadSpreadsheet() {
    closeDoneConfirm();
    return doneTask(sendSpreadsheet);
  }

  async function sendSpreadsheet() {
    var rows = await store.allRows();
    if (!rows.length) {
      closeSaveQuestion();
      await refreshRows();
      return;
    }
    // Read with the rows: after a storage loss, whether this file leaves out
    // the results saved before it.
    var leftOut = store.earlierRowsUnread;
    var name;
    try {
      name = handOverSpreadsheet(rows);
    } catch (err) {
      closeSaveQuestion();
      setText(el.doneStatus, 'The spreadsheet could not be made (' + plainReason(err) + '). Nothing was cleared.');
      return;
    }
    var ids = {};
    rows.forEach(function (row) { ids[row.id] = true; });
    state.saveCheck = { ids: ids, leftOut: leftOut };
    setText(el.doneStatus, 'Sent ' + name + ' to your downloads.');
    openSaveQuestion();
  }

  // Yes on the question.
  function confirmSaved() {
    var check = state.saveCheck;
    if (!check) return Promise.resolve();
    return doneTask(function () { return clearSaved(check); });
  }

  // Clears the results the file holds. The rows are read again first, so the
  // store clears exactly what this read lists: when results saved before a
  // storage problem have come back since the file was made, they are not in
  // it, so only the photos in the file are removed and the rest stay.
  async function clearSaved(check) {
    if (state.saveCheck !== check) return; // closed meanwhile: a new photo, a key edit or an expiry
    var rows = await store.allRows();
    var inFile = rows.filter(function (row) { return check.ids[row.id] === true; });
    var message;
    try {
      if (inFile.length === rows.length) {
        message = savedMessage(await store.wipeAfterDownload(), check.leftOut);
      } else {
        var photos = [];
        inFile.forEach(function (row) {
          if (photos.indexOf(row.photoIndex) < 0) photos.push(row.photoIndex);
        });
        for (var i = 0; i < photos.length; i++) await store.removePhoto(photos[i]);
        message = 'The results in the file are cleared from this browser. The results saved before the storage problem ' +
          'were not in the file and are still in this browser, to be finished with Done.';
      }
    } catch (err) {
      setText(el.doneStatus, 'The results could not be cleared from this browser (' + plainReason(err) + '). ' +
        'Press Yes to try again.');
      return;
    }
    closeSaveQuestion();
    await refreshRows();
    setText(el.doneStatus, message);
  }

  // Says every result is cleared only when the store cleared every one. After
  // a storage loss the results saved before it can stay behind: left out of
  // the file when they could not be read, or read but not cleared.
  function savedMessage(cleared, leftOut) {
    if (cleared.diskCleared) return 'Every result is cleared from this browser.';
    if (leftOut) {
      return 'The results in the file are cleared from this browser. The results saved before the storage problem ' +
        'were not in the file and are still in this browser. They come back after a reload, to be finished with Done.';
    }
    return 'The results saved before the storage problem are in the file, but they could not be cleared from ' +
      'this browser. When they show again, discard them: they are already in the file.';
  }

  // ---------------------------------------------------------------- expiry

  // The expiry waits only while slips are being read (their rows are being
  // stored) or Done's own store work runs. A photo still being opened, or
  // waiting on the question about its slips, does not hold it back: that
  // photo takes its index on the store chain after any expiry, and runs one
  // more check itself as its reading starts (processPhoto).
  function expiryWaits() {
    return !!state.job || state.finishing;
  }

  // Clears the results once they are 24 hours past the last photo's last
  // saved slip, never having been confirmed saved. Runs on the store chain,
  // and never while expiryWaits(), so no slip is stored between the store's
  // check and its clear. -> whether it cleared. A check that fails is left
  // for the next one.
  function expireStale() {
    if (expiryWaits()) return Promise.resolve(false);
    return serial(function () {
      if (expiryWaits()) return false;
      return expireNow();
    }).catch(function () {
      return false;
    });
  }

  // The check itself, for a caller already on the store chain.
  async function expireNow() {
    var result = await store.expireIfStale({ now: now(), maxAgeMs: EXPIRE_AFTER_MS });
    if (!result.expired) return false;
    closeDoneConfirm();
    closeSaveQuestion();
    setText(el.doneStatus, '');
    setText(el.resultsStatus, EXPIRED_TEXT);
    await refreshRows();
    return true;
  }

  // The once-a-minute check and the check when the page is shown again.
  function checkExpiry() {
    expireStale().then(function () { tellStorage(); });
  }

  // Builds the workbook and hands it to the browser as a download. The page
  // keeps no link to it afterwards: the anchor is removed at once, and the
  // object URL is revoked DOWNLOAD_URL_LIFETIME_MS later, or on pagehide.
  // -> the file name.
  function handOverSpreadsheet(rows) {
    var key = readAnswerKey();
    var date = new Date();
    var summary = T.grade.summarize(rows, key, { passPercent: key.passPercent });
    var workbook = T.sheet.buildWorkbook({ rows: rows, key: key, summary: summary, assignment: key.assignment, date: date });
    var name = T.sheet.fileName(key.assignment, date);
    var url = URL.createObjectURL(new Blob([T.sheet.toArrayBuffer(workbook)], { type: XLSX_TYPE }));
    var link = make('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      link.removeAttribute('href');
      revokeLater(url);
    }
    return name;
  }

  function revokeLater(url) {
    pendingUrls[url] = setTimeout(function () { revokeUrl(url); }, DOWNLOAD_URL_LIFETIME_MS);
  }

  function revokeUrl(url) {
    clearTimeout(pendingUrls[url]);
    delete pendingUrls[url];
    URL.revokeObjectURL(url);
  }

  function revokeAllUrls() {
    Object.keys(pendingUrls).forEach(revokeUrl);
  }

  // ---------------------------------------------------------------- start

  function wireEvents() {
    el.checkKey.addEventListener('click', function () {
      checkKey().catch(function (err) { showError(el.setupError, unexpected(err)); });
    });
    el.apiKey.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') el.checkKey.click();
    });
    // The key field changes as it loses focus, often to a press on Check key:
    // a failed write is told below that button, so the press still lands.
    el.apiKey.addEventListener('change', function () {
      store.setKey(PROVIDER, el.apiKey.value);
      updateReadiness();
      tellStorage(el.setupStorage);
    });
    el.model.addEventListener('change', function () {
      store.setModel(PROVIDER, el.model.value);
      tellStorage(el.modelStorage);
    });

    el.assignment.addEventListener('input', onAnswerKeyInput);
    el.passPercent.addEventListener('input', onAnswerKeyInput);
    el.questionRows.addEventListener('input', onAnswerKeyInput);
    // A select also reports its change here, for a browser that sends no input event for it.
    el.questionRows.addEventListener('change', function (event) {
      if (event.target && event.target.tagName === 'SELECT') onAnswerKeyInput();
    });
    el.questionCount.addEventListener('input', onQuestionCountInput);
    el.questionCount.addEventListener('change', onQuestionCountChange);

    [el.takePhoto, el.uploadPhoto].forEach(function (input) {
      input.addEventListener('change', function () {
        onPhotoChosen(input).catch(function (err) { showError(el.photoError, unexpected(err)); });
      });
    });
    el.readAnyway.addEventListener('click', function () { answerSlipQuestion('read'); });
    el.retake.addEventListener('click', function () { answerSlipQuestion('retake'); });
    el.stopReading.addEventListener('click', stopReading);

    el.done.addEventListener('click', function () {
      openDoneConfirm().catch(function (err) { setText(el.doneStatus, unexpected(err).title); });
    });
    el.doneNo.addEventListener('click', closeDoneConfirm);
    el.doneYes.addEventListener('click', function () {
      downloadSpreadsheet().catch(function (err) { setText(el.doneStatus, unexpected(err).title); });
    });
    el.savedNo.addEventListener('click', function () {
      downloadSpreadsheet().catch(function (err) { setText(el.doneStatus, unexpected(err).title); });
    });
    el.savedYes.addEventListener('click', function () {
      confirmSaved().catch(function (err) { setText(el.doneStatus, unexpected(err).title); });
    });
    window.addEventListener('pagehide', revokeAllUrls);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      requestScreen(); // asks again only while slips are being read
      checkExpiry();
    });

    // The first touch, key, focus or input ends the page's loading for the top
    // banner (tellStorage). Capture listeners run before a press moves focus,
    // so a write that fails as a field loses focus is already a later problem.
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'focusin', 'input'].forEach(function (type) {
      window.addEventListener(type, noteTouched, { capture: true, passive: true });
    });
  }

  function start() {
    bindElements();
    restoreSetup();
    restoreAnswerKey();
    wireEvents();
    updateReadiness();
    tellStorage();
    // Results past the 24 hours are cleared before any is shown.
    store.ready().then(function () {
      tellStorage();
      return expireStale();
    }).then(refreshRows).then(noteInterrupted).catch(function (err) {
      showError(el.photoError, unexpected(err));
    }).then(function () {
      tellStorage();
    });
    setInterval(checkExpiry, EXPIRY_CHECK_MS);
  }

  start();
})();
