'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readerMessages, reviewerMessages, parseReading } = require('../../js/prompt.js');

function reply(obj) {
  return JSON.stringify(obj);
}

function answer(q, text, confidence) {
  return { q, answer: text, confidence };
}

// --- prompts ---

for (const [name, build] of [['reader', readerMessages], ['reviewer', reviewerMessages]]) {
  test(`${name} prompt: written for a vision model transcribing a photographed math exit slip`, () => {
    const { system, user } = build({ questionCount: 5 });
    const all = system + '\n' + user;
    assert.match(system, /photographed math exit slip/);
    assert.match(system, /name is usually at the top/);
    assert.match(system, /questions are numbered/);
    assert.match(all, /exactly as/);
    assert.match(all, /Do not solve any problem/);
    assert.match(all, /Do not correct/);
    assert.match(all, /a\/b/);
    assert.match(all, /minus sign/);
    assert.match(all, /unit/);
    assert.match(all, /empty string ""/);
    assert.match(all, /crossed out/);
    assert.match(all, /two different answers/);
    assert.match(all, /illegible/);
    assert.match(all, /confidence is a number from 0 to 1/);
    assert.match(all, /Return only the JSON object/);
    assert.match(user, /"student_name": string/);
    assert.match(user, /"answers": \[\{"q": integer, "answer": string, "confidence": number\}\]/);
    assert.match(user, /"note": string/);
    assert.match(user, /5 questions, numbered 1 to 5/);
    assert.match(user, /exactly 5 entries/);
    assert.ok(!all.includes(String.fromCharCode(0x2014)), 'no em-dash');
  });

  test(`${name} prompt: singular wording for one question, and a bad count throws`, () => {
    const { user } = build({ questionCount: 1 });
    assert.match(user, /1 question, numbered 1 as printed/);
    assert.match(user, /exactly 1 entry,/);
    for (const bad of [0, -2, 2.5, 'x', undefined, null]) {
      assert.throws(() => build({ questionCount: bad }), RangeError, String(bad));
    }
    assert.throws(() => build(), RangeError);
  });
}

test('reviewer prompt is independent and reads digit by digit', () => {
  const reader = readerMessages({ questionCount: 4 });
  const reviewer = reviewerMessages({ questionCount: 4 });
  assert.notEqual(reviewer.system, reader.system);
  assert.match(reviewer.system, /digit by digit/);
  assert.match(reviewer.system, /independent/);
  assert.match(reviewer.system, /from the image alone/);
  assert.equal(reviewer.user, reader.user, 'same question, so the two reads are comparable');
  assert.ok(!/first reader|previous reading|reader said/i.test(reviewer.system + reviewer.user));
});

// --- parseReading ---

test('parseReading: a clean reply', () => {
  const out = parseReading(reply({
    student_name: 'Test Student A',
    answers: [answer(1, '1/2', 0.95), answer(2, '-3', 0.9), answer(3, '12 cm', 0.8)],
    note: ''
  }), 3);
  assert.deepEqual(out, {
    ok: true,
    reading: {
      student_name: 'Test Student A',
      answers: [answer(1, '1/2', 0.95), answer(2, '-3', 0.9), answer(3, '12 cm', 0.8)],
      note: ''
    }
  });
});

test('parseReading: strips code fences', () => {
  const text = '```json\n' + reply({ student_name: 'B', answers: [answer(1, '4', 1)], note: 'ok' }) + '\n```';
  const out = parseReading(text, 1);
  assert.equal(out.ok, true);
  assert.deepEqual(out.reading.answers, [answer(1, '4', 1)]);
  assert.equal(out.reading.note, 'ok');
  const bare = parseReading('```\n' + reply({ student_name: 'B', answers: [] }) + '\n```', 1);
  assert.equal(bare.ok, true);
});

test('parseReading: takes the outermost object out of junk and thinking', () => {
  const body = reply({ student_name: 'C', answers: [answer(1, 'x^2', 0.9), answer(2, '{3}', 0.6)], note: '' });
  const out = parseReading('Sure! Here is the JSON:\n' + body + '\nHope that helps.', 2);
  assert.equal(out.ok, true);
  assert.deepEqual(out.reading.answers, [answer(1, 'x^2', 0.9), answer(2, '{3}', 0.6)]);
  const thinking = '<think>The slip shows {a} and {b}. I think Q2 is 7.</think>\n' + body;
  assert.deepEqual(parseReading(thinking, 2).reading.answers, out.reading.answers);
});

test('parseReading: forgives a trailing comma', () => {
  const out = parseReading('{"student_name": "D", "answers": [{"q": 1, "answer": "5", "confidence": 0.9},], "note": "",}', 1);
  assert.equal(out.ok, true);
  assert.equal(out.reading.answers[0].answer, '5');
});

test('parseReading: fills missing questions with a blank at confidence 0', () => {
  const out = parseReading(reply({ student_name: 'E', answers: [answer(3, '7', 0.9), answer(1, '2', 0.8)], note: '' }), 4);
  assert.deepEqual(out.reading.answers, [
    answer(1, '2', 0.8),
    answer(2, '', 0),
    answer(3, '7', 0.9),
    answer(4, '', 0)
  ]);
});

test('parseReading: drops q outside 1..N and keeps the first of a repeated q', () => {
  const out = parseReading(reply({
    student_name: 'F',
    answers: [answer(0, 'zero', 1), answer(1, 'first', 0.9), answer(1, 'second', 0.9), answer(3, 'three', 1), answer(-1, 'neg', 1)],
    note: ''
  }), 2);
  assert.deepEqual(out.reading.answers, [answer(1, 'first', 0.9), answer(2, '', 0)]);
});

test('parseReading: coerces q written as a string', () => {
  const out = parseReading(reply({
    student_name: 'G',
    answers: [
      { q: '1', answer: 'a', confidence: 1 },
      { q: 'Q2', answer: 'b', confidence: 1 },
      { q: 'Question 3', answer: 'c', confidence: 1 },
      { q: '#4', answer: 'd', confidence: 1 },
      { q: '5.', answer: 'e', confidence: 1 },
      { q: 'six', answer: 'dropped', confidence: 1 },
      { q: 2.5, answer: 'dropped', confidence: 1 }
    ],
    note: ''
  }), 6);
  assert.deepEqual(out.reading.answers.map((a) => a.answer), ['a', 'b', 'c', 'd', 'e', '']);
});

test('parseReading: an entry without q takes its position; a bare value is an answer at confidence 0', () => {
  const out = parseReading(reply({
    student_name: 'H',
    answers: [{ answer: '10', confidence: 0.9 }, '3/4', 12],
    note: ''
  }), 3);
  assert.deepEqual(out.reading.answers, [answer(1, '10', 0.9), answer(2, '3/4', 0), answer(3, '12', 0)]);
});

test('parseReading: bad confidence is clamped to 0..1, missing or junk becomes 0', () => {
  const out = parseReading(reply({
    student_name: 'I',
    answers: [
      { q: 1, answer: 'a', confidence: 1.7 },
      { q: 2, answer: 'b', confidence: -0.2 },
      { q: 3, answer: 'c' },
      { q: 4, answer: 'd', confidence: 'high' },
      { q: 5, answer: 'e', confidence: '0.4' },
      { q: 6, answer: 'f', confidence: null },
      { q: 7, answer: 'g', confidence: 85 },
      { q: 8, answer: 'h', confidence: '' }
    ],
    note: ''
  }), 8);
  assert.deepEqual(out.reading.answers.map((a) => a.confidence), [1, 0, 0, 0, 0.4, 0, 1, 0]);
});

test('parseReading: trims strings, keeps the answer exactly otherwise, numbers become text', () => {
  const out = parseReading(reply({
    student_name: '  Test Student J \n',
    answers: [answer(1, '  -3.50 kg ', 1), answer(2, 0.5, 1), answer(3, null, 1), answer(4, { x: 1 }, 1), answer(5, '   ', 1)],
    note: '  Q3 was left blank.  '
  }), 5);
  assert.equal(out.reading.student_name, 'Test Student J');
  assert.deepEqual(out.reading.answers.map((a) => a.answer), ['-3.50 kg', '0.5', '', '', '']);
  assert.equal(out.reading.note, 'Q3 was left blank.');
});

test('parseReading: caps the note at 300 characters', () => {
  const out = parseReading(reply({ student_name: 'K', answers: [], note: 'n'.repeat(1000) }), 1);
  assert.equal(out.reading.note.length, 300);
});

test('parseReading: a missing or odd name or note becomes empty', () => {
  const out = parseReading(reply({ answers: [answer(1, '1', 1)], note: ['x'] }), 1);
  assert.equal(out.reading.student_name, '');
  assert.equal(out.reading.note, '');
  const alt = parseReading(reply({ studentName: 'L', answers: [] }), 1);
  assert.equal(alt.reading.student_name, 'L');
});

test('parseReading: failures come back as ok:false, never a throw', () => {
  const cases = [
    [undefined, 2],
    [null, 2],
    ['', 2],
    ['   ', 2],
    ['no json here at all', 2],
    ['{ "student_name": "M", "answers": [ }', 2],
    ['[1, 2, 3]', 2],
    ['} backwards {', 2],
    [reply({ student_name: 'N' }), 2],
    [reply({ student_name: 'N', answers: 'none' }), 2],
    [reply({ student_name: 'N', answers: [] }), 0],
    [reply({ student_name: 'N', answers: [] }), 'x']
  ];
  for (const [text, n] of cases) {
    const out = parseReading(text, n);
    assert.equal(out.ok, false, JSON.stringify(text));
    assert.equal(typeof out.error, 'string');
    assert.ok(out.error.length > 0);
  }
});

test('parseReading: an empty answers list means every question blank at confidence 0', () => {
  const out = parseReading(reply({ student_name: 'O', answers: [], note: 'Slip is blank.' }), 3);
  assert.equal(out.ok, true);
  assert.deepEqual(out.reading.answers, [answer(1, '', 0), answer(2, '', 0), answer(3, '', 0)]);
});
