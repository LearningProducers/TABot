// TABot.prompt: the reader and reviewer prompts, and the tolerant parser that
// turns a model's reply into a reading grade.js can trust the shape of.
//
// A reading is {student_name, answers: [{q, answer, confidence}], note}, the
// same field names the prompts ask the model for, with exactly questionCount
// answers in q order 1..N.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.prompt = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var NOTE_MAX_CHARS = 300;

  var SHAPE = '{"student_name": string, "answers": [{"q": integer, "answer": string, ' +
    '"confidence": number}], "note": string}';

  // Shared by both prompts, so the two reads are held to the same rules.
  var RULES = [
    'Transcribe, never grade. Copy each answer exactly as the student wrote it, even when it is wrong.',
    'Do not solve any problem. Do not correct, simplify, reduce or reformat any answer.',
    'When a question shows working, transcribe only the final answer (often circled, boxed, ' +
      'underlined, written after an equals sign or on an answer line), not the working.',
    'Write a fraction as a/b; a stacked fraction becomes a/b, with parentheses when the top or ' +
      'bottom has more than one term, as in (x+1)/2.',
    'Write a mixed number as the whole number, a space, then the fraction: 1 1/2.',
    'Keep every minus sign, decimal point, percent sign and unit exactly as written. ' +
      'Write exponents with ^ (x^2) and square roots as sqrt(...).',
    'If a question is left blank, its answer is the empty string "".',
    'If work is crossed out, transcribe only what is not crossed out.',
    'If one question shows two different answers, transcribe the one marked as final ' +
      '(circled, boxed or underlined); if none is marked, the one that looks final. Give it a low confidence.',
    'student_name is the name exactly as written; it is usually at the top of the slip. ' +
      'Use "" if there is no name or you cannot read it.',
    'confidence is a number from 0 to 1: near 1 when the writing is clear, below 0.7 when ' +
      'you are unsure of any character in that answer.',
    'note is one or two short sentences naming anything unclear, calling questions Q1, Q2 and ' +
      'so on: crossed-out work, two answers to one question, illegible writing, a name you ' +
      'could not read. Use "" when nothing is unclear.'
  ];

  var ONLY_JSON = 'Return only the JSON object: no other text, no explanation, no markdown, no code fences.';

  function checkCount(questionCount) {
    var n = Number(questionCount);
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError('questionCount must be a whole number, 1 or more');
    }
    return n;
  }

  function bullets(lines) {
    return lines.map(function (line) { return '- ' + line; }).join('\n');
  }

  function userText(n) {
    var questions = n === 1 ? '1 question, numbered 1' : n + ' questions, numbered 1 to ' + n;
    return 'This exit slip has ' + questions + ' as printed on the slip.\n' +
      'Return this JSON object and nothing else:\n' + SHAPE + '\n' +
      'The answers array has exactly ' + n + (n === 1 ? ' entry' : ' entries') +
      ', one per question, in order, with q set to the question number as printed (1 to ' + n + ').';
  }

  function readerMessages(opts) {
    var n = checkCount(opts && opts.questionCount);
    var system = [
      'You read photographed math exit slips for a teacher.',
      'The image is one exit slip: a small sheet of paper on which a student wrote answers by hand. ' +
        'The student\'s name is usually at the top. The questions are numbered.',
      'Your job is to transcribe what the student wrote, exactly as written. The teacher grades it; you do not.',
      '',
      'Rules:',
      bullets(RULES),
      '',
      ONLY_JSON
    ].join('\n');
    return { system: system, user: userText(n) };
  }

  // Independent of the reader: it never sees the reader's output, so the two
  // reads can disagree, and a disagreement is what puts an asterisk on a cell.
  function reviewerMessages(opts) {
    var n = checkCount(opts && opts.questionCount);
    var system = [
      'You are the second, independent reader of a photographed math exit slip for a teacher.',
      'The image is one exit slip: a small sheet of paper on which a student wrote answers by hand. ' +
        'The student\'s name is usually at the top. The questions are numbered.',
      'Form your own reading from the image alone.',
      'Read carefully, digit by digit and symbol by symbol. Check every digit, sign, decimal point, ' +
        'fraction bar and exponent before you write it down. Look twice at characters that are easy ' +
        'to confuse: 1 and 7, 4 and 9, 5 and 6, 0 and 6, 2 and z, x and a multiplication sign, a ' +
        'minus sign and a stray mark.',
      '',
      'Rules:',
      bullets(RULES),
      '',
      ONLY_JSON
    ].join('\n');
    return { system: system, user: userText(n) };
  }

  // --- parsing ---

  function fail(error) {
    return { ok: false, error: error };
  }

  // Reasoning models may prefix <think>...</think>, which can hold braces.
  function stripNoise(text) {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```[A-Za-z0-9_-]*/g, '');
  }

  function parseObject(text) {
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start < 0 || end < start) return undefined;
    var slice = text.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (err) {
      // One common slip from models: a trailing comma before } or ].
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      } catch (err2) {
        return undefined;
      }
    }
  }

  function toText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return '';
  }

  // 3, "3", "Q3", "q 3", "Question 3", "#3", "3." -> 3; anything else -> null.
  function toQuestionNumber(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    if (typeof value !== 'string') return null;
    var m = /^\s*(?:q(?:uestion)?)?\s*#?\s*(\d+)\s*[.):]?\s*$/i.exec(value);
    return m ? parseInt(m[1], 10) : null;
  }

  function toConfidence(value) {
    var c = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof c !== 'number' || !isFinite(c)) return 0;
    return Math.min(1, Math.max(0, c));
  }

  // One entry of the answers array -> {q, answer, confidence}, or null to drop.
  // An entry with no q takes its position; a bare string or number is an
  // answer at its position with confidence 0, so it gets flagged for a look.
  function toAnswer(entry, index) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      return { q: index + 1, answer: toText(entry), confidence: 0 };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    var q = entry.q === undefined || entry.q === null ? index + 1 : toQuestionNumber(entry.q);
    if (q === null) return null;
    return { q: q, answer: toText(entry.answer), confidence: toConfidence(entry.confidence) };
  }

  function pickName(obj) {
    var candidates = [obj.student_name, obj.studentName, obj.name];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'string' || typeof candidates[i] === 'number') return toText(candidates[i]);
    }
    return '';
  }

  // -> {ok: true, reading} or {ok: false, error}. Never throws.
  function parseReading(text, questionCount) {
    var n = Number(questionCount);
    if (!Number.isInteger(n) || n < 1) return fail('questionCount must be a whole number, 1 or more');
    if (typeof text !== 'string' || !text.trim()) return fail('The model returned no text.');

    var obj = parseObject(stripNoise(text));
    if (obj === undefined) return fail('The model reply held no readable JSON object.');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('The model reply was not a JSON object.');
    if (!Array.isArray(obj.answers)) return fail('The model reply had no answers list.');

    var byQ = {};
    obj.answers.forEach(function (entry, index) {
      var a = toAnswer(entry, index);
      if (!a || a.q < 1 || a.q > n || byQ[a.q]) return;
      byQ[a.q] = a;
    });

    var answers = [];
    for (var q = 1; q <= n; q++) {
      answers.push(byQ[q] || { q: q, answer: '', confidence: 0 });
    }
    return {
      ok: true,
      reading: {
        student_name: pickName(obj),
        answers: answers,
        note: toText(obj.note).slice(0, NOTE_MAX_CHARS)
      }
    };
  }

  return {
    readerMessages: readerMessages,
    reviewerMessages: reviewerMessages,
    parseReading: parseReading
  };
});
