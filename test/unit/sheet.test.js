'use strict';
// Unit tests for js/sheet.js: build the workbook, write it to an ArrayBuffer,
// read it back with SheetJS, and check what a teacher would open.

const test = require('node:test');
const assert = require('node:assert/strict');
const sheet = require('../../js/sheet.js');
const XLSX = require('../../vendor/xlsx.mini.min.js');

// A synthetic class, graded by hand.
// Key: Q1 1/2 (1 pt), Q2 -3 (1 pt), Q3 2x+6 (2 pts), Q4 12 (1 pt); max 5; pass at 70%.
//   Ana  two-model     0.5 ✓, -3 ✓, 2(x+3) ✓, 12 ✓           5/5 = 100%
//   Ben  two-model     1/2 ✓, 3 ✗, 2x+6 ✓ * (reviewer 2x+8), blank ✗   3/5 = 60%
//   Cy   single-model  2/4 ✓, -3 ✓, 2x ✗, 21 ✗, name flagged   2/5 = 40%
// Mean 66.7, median 60, pass rate 1/3 = 33.3, rows with flags 2 (Ben, Cy),
// single-model rows 1. Hit rates: Q1 100, Q2 66.7, Q3 66.7, Q4 33.3.
// Bands: 40-49% 1, 60-69% 1, 90-100% 1.
const KEY = {
  assignment: 'Unit 3 Quiz',
  passPercent: 70,
  questions: [
    { answer: '1/2', points: 1 },
    { answer: '-3', points: 1 },
    { answer: '2x+6', points: 2 },
    { answer: '12', points: 1 }
  ]
};

function ans(q, read, correct, maxPoints, extra) {
  return Object.assign({
    q, read, reviewRead: read, confidence: 0.95, correct,
    points: correct ? maxPoints : 0, maxPoints, flagged: false, reason: ''
  }, extra || {});
}

const ROWS = [
  {
    id: 'p0-s0', photoIndex: 0, slipIndex: 0, studentName: 'Ana', nameFlag: false,
    answers: [ans(1, '0.5', true, 1), ans(2, '-3', true, 1), ans(3, '2(x+3)', true, 2), ans(4, '12', true, 1)],
    score: 5, maxScore: 5, flagged: false, notes: '',
    readBy: 'vision-model-a', reviewedBy: 'vision-model-b', reviewMode: 'two-model'
  },
  {
    id: 'p0-s1', photoIndex: 0, slipIndex: 1, studentName: 'Ben', nameFlag: false,
    answers: [
      ans(1, '1/2', true, 1),
      ans(2, '3', false, 1),
      ans(3, '2x+6', true, 2, { reviewRead: '2x+8', flagged: true, reason: 'reviewer disagrees' }),
      ans(4, '', false, 1, { reviewRead: '' })
    ],
    score: 3, maxScore: 5, flagged: true, notes: 'Q3: reader 2x+6, reviewer 2x+8',
    readBy: 'vision-model-a', reviewedBy: 'vision-model-b', reviewMode: 'two-model'
  },
  {
    id: 'p1-s0', photoIndex: 1, slipIndex: 0, studentName: 'Cy', nameFlag: true,
    answers: [ans(1, '2/4', true, 1), ans(2, '-3', true, 1), ans(3, '2x', false, 2), ans(4, '21', false, 1)],
    score: 2, maxScore: 5, flagged: true, notes: 'name unclear',
    readBy: 'vision-model-a', reviewedBy: 'vision-model-a', reviewMode: 'single-model'
  }
];

const BANDS = ['0-9%', '10-19%', '20-29%', '30-39%', '40-49%', '50-59%', '60-69%', '70-79%', '80-89%', '90-100%'];
const BAND_COUNTS = [0, 0, 0, 0, 1, 0, 1, 0, 0, 1];

const SUMMARY = {
  students: 3,
  mean: 200 / 3,
  median: 60,
  passRate: 100 / 3,
  perQuestion: [
    { q: 1, hitRate: 100 },
    { q: 2, hitRate: 200 / 3 },
    { q: 3, hitRate: 200 / 3 },
    { q: 4, hitRate: 100 / 3 }
  ],
  distribution: BANDS.map((bucket, i) => ({ bucket, count: BAND_COUNTS[i] })),
  flaggedRows: 2,
  singleModelRows: 1
};

const HEADERS = ['Student', 'Score', 'Max', 'Percent', 'Q1', 'Q2', 'Q3', 'Q4',
  'Flags', 'Notes', 'Read by', 'Reviewed by', 'Review'];

function roundTrip(wb) {
  const buf = sheet.toArrayBuffer(wb);
  assert.ok(buf instanceof ArrayBuffer, 'toArrayBuffer returns an ArrayBuffer');
  const bytes = new Uint8Array(buf);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK', 'an xlsx is a zip');
  return XLSX.read(buf, { type: 'array' });
}

function grid(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: null, raw: true });
}

function cell(ws, row, col) {
  return ws[XLSX.utils.encode_cell({ r: row, c: col })];
}

test('fileName: TABot_<assignment>_<YYYY-MM-DD>.xlsx', () => {
  assert.equal(sheet.fileName('Unit 3 Quiz', '2026-09-24'), 'TABot_Unit-3-Quiz_2026-09-24.xlsx');
  assert.equal(sheet.fileName('  Quiz #4: fractions/decimals! ', '2026-09-24'), 'TABot_Quiz-4-fractionsdecimals_2026-09-24.xlsx');
  assert.equal(sheet.fileName('exit_slip-7', '2026-01-05'), 'TABot_exit_slip-7_2026-01-05.xlsx');
  assert.equal(sheet.fileName('', '2026-09-24'), 'TABot_assignment_2026-09-24.xlsx');
  assert.equal(sheet.fileName(null, '2026-09-24'), 'TABot_assignment_2026-09-24.xlsx');
  assert.equal(sheet.fileName('###', '2026-09-24'), 'TABot_assignment_2026-09-24.xlsx');
  assert.equal(sheet.fileName('Warm up', new Date(2026, 8, 4, 23, 30)), 'TABot_Warm-up_2026-09-04.xlsx');
  assert.match(sheet.fileName('x'), /^TABot_x_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('workbook has Roster and Summary, survives write and read', () => {
  const wb = sheet.buildWorkbook({ rows: ROWS, key: KEY, summary: SUMMARY, assignment: 'Unit 3 Quiz', date: '2026-09-24' });
  assert.deepEqual(wb.SheetNames, ['Roster', 'Summary']);
  const back = roundTrip(wb);
  assert.deepEqual(back.SheetNames, ['Roster', 'Summary']);
});

test('Roster: headers, answer cells, flags, numbers, review mode', () => {
  const wb = roundTrip(sheet.buildWorkbook({ rows: ROWS, key: KEY, summary: SUMMARY, assignment: 'Unit 3 Quiz', date: '2026-09-24' }));
  const ws = wb.Sheets.Roster;
  const g = grid(ws);

  assert.deepEqual(g[0], HEADERS);
  assert.equal(g.length, 4);

  assert.deepEqual(g[1], ['Ana', 5, 5, 100, '0.5 ✓', '-3 ✓', '2(x+3) ✓', '12 ✓', '', '', 'vision-model-a', 'vision-model-b', 'two-model']);
  assert.deepEqual(g[2], ['Ben', 3, 5, 60, '1/2 ✓', '3 ✗', '2x+6 ✓ *', '(blank) ✗', '*', 'Q3: reader 2x+6, reviewer 2x+8', 'vision-model-a', 'vision-model-b', 'two-model']);
  assert.deepEqual(g[3], ['Cy *', 2, 5, 40, '2/4 ✓', '-3 ✓', '2x ✗', '21 ✗', '*', 'name unclear', 'vision-model-a', 'vision-model-a', 'single-model review']);

  // The flagged answer and the blank answer, cell by cell.
  assert.equal(cell(ws, 2, 6).v, '2x+6 ✓ *');
  assert.equal(cell(ws, 2, 7).v, '(blank) ✗');

  // Score, Max, Percent are numbers, not text.
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 3; c++) assert.equal(cell(ws, r, c).t, 'n', 'row ' + r + ' col ' + c);
  }
});

test('Roster: percent rounds to one decimal, flagged blank, missing answer, no name', () => {
  const key = { passPercent: 70, questions: [{ answer: '1', points: 1 }, { answer: '2', points: 1 }, { answer: '3', points: 1 }] };
  const rows = [{
    studentName: '', nameFlag: false,
    answers: [ans(1, '1', true, 1), ans(2, '  ', false, 1, { flagged: true })],
    score: 1, maxScore: 3, flagged: true, notes: ['reader note', 'reviewer note'],
    readBy: 'm', reviewedBy: 'm', reviewMode: 'single-model'
  }];
  const summary = { students: 1, mean: 100 / 3, median: 100 / 3, passRate: 0, perQuestion: [], distribution: [], flaggedRows: 1, singleModelRows: 1 };
  const g = grid(roundTrip(sheet.buildWorkbook({ rows, key, summary, assignment: 'x', date: '2026-09-24' })).Sheets.Roster);
  assert.deepEqual(g[1], ['(no name)', 1, 3, 33.3, '1 ✓', '(blank) ✗ *', '(blank) ✗', '*', 'reader note\nreviewer note', 'm', 'm', 'single-model review']);
});

test('Summary: label/value block, per-question table, distribution', () => {
  const wb = roundTrip(sheet.buildWorkbook({ rows: ROWS, key: KEY, summary: SUMMARY, assignment: 'Unit 3 Quiz', date: '2026-09-24' }));
  const ws = wb.Sheets.Summary;
  const g = grid(ws).map((r) => r.slice(0, 2));

  const expected = [
    ['Students', 3],
    ['Mean %', 66.7],
    ['Median %', 60],
    ['Pass rate % (pass at 70%)', 33.3],
    ['Rows with flags', 2],
    ['Single-model review rows', 1],
    [null, null],
    ['Question', 'Hit rate %'],
    ['Q1', 100],
    ['Q2', 66.7],
    ['Q3', 66.7],
    ['Q4', 33.3],
    [null, null],
    ['Score band', 'Students']
  ].concat(BANDS.map((b, i) => [b, BAND_COUNTS[i]]));
  assert.deepEqual(g, expected);

  for (const r of [0, 1, 2, 3, 4, 5, 8, 9, 10, 11]) assert.equal(cell(ws, r, 1).t, 'n', 'Summary row ' + r);
});

// The same key with a match setting per question. Q1 has no match field, as a
// key saved before the setting existed would.
const MATCH_KEY = Object.assign({}, KEY, {
  questions: [
    { answer: '1/2', points: 1 },
    { answer: '-3', points: 1, match: 'value' },
    { answer: '2x+6', points: 2, match: 'exact' },
    { answer: '12', points: 1, match: 'exact' }
  ]
});

test('Summary: the per-question table has a Match column from the key', () => {
  const ws = roundTrip(sheet.buildWorkbook({ rows: ROWS, key: MATCH_KEY, summary: SUMMARY, assignment: 'a', date: '2026-09-24' })).Sheets.Summary;
  const g = grid(ws);

  assert.deepEqual(g[7], ['Question', 'Hit rate %', 'Match']);
  assert.deepEqual(g.slice(8, 12), [
    ['Q1', 100, 'value'],
    ['Q2', 66.7, 'value'],
    ['Q3', 66.7, 'exact form'],
    ['Q4', 33.3, 'exact form']
  ]);
  for (const r of [8, 9, 10, 11]) assert.equal(cell(ws, r, 2).t, 's', 'Match is text on row ' + r);

  // Nothing else in the sheet gains a third column.
  for (let r = 0; r < g.length; r++) {
    if (r >= 7 && r <= 11) continue;
    assert.equal(g[r][2], null, 'row ' + r + ' has no Match cell');
  }
});

test('Summary: a key saved without match settings reads as value throughout', () => {
  const g = grid(roundTrip(sheet.buildWorkbook({ rows: ROWS, key: KEY, summary: SUMMARY, assignment: 'a', date: '2026-09-24' })).Sheets.Summary);
  assert.deepEqual(g[7], ['Question', 'Hit rate %', 'Match']);
  assert.deepEqual(g.slice(8, 12).map((r) => r[2]), ['value', 'value', 'value', 'value']);
});

test('Summary: an unknown match value or a missing key reads as value', () => {
  const odd = Object.assign({}, KEY, {
    questions: KEY.questions.map((q, i) => Object.assign({}, q, { match: ['', 'fuzzy', null, 42][i] }))
  });
  const g = grid(roundTrip(sheet.buildWorkbook({ rows: ROWS, key: odd, summary: SUMMARY, assignment: 'a', date: '2026-09-24' })).Sheets.Summary);
  assert.deepEqual(g.slice(8, 12).map((r) => r[2]), ['value', 'value', 'value', 'value']);

  const g2 = grid(roundTrip(sheet.buildWorkbook({ rows: ROWS, key: null, summary: SUMMARY, assignment: 'a', date: '2026-09-24' })).Sheets.Summary);
  assert.deepEqual(g2[7], ['Question', 'Hit rate %', 'Match']);
  assert.deepEqual(g2.slice(8, 12).map((r) => r[2]), ['value', 'value', 'value', 'value']);
});

test('Roster: unchanged by match settings', () => {
  const plain = grid(roundTrip(sheet.buildWorkbook({ rows: ROWS, key: KEY, summary: SUMMARY, assignment: 'a', date: '2026-09-24' })).Sheets.Roster);
  const withMatch = grid(roundTrip(sheet.buildWorkbook({ rows: ROWS, key: MATCH_KEY, summary: SUMMARY, assignment: 'a', date: '2026-09-24' })).Sheets.Roster);
  assert.deepEqual(withMatch, plain);
  assert.deepEqual(withMatch[0], HEADERS);
});

test('pass mark in the label follows the key', () => {
  const key = Object.assign({}, KEY, { passPercent: 80 });
  const g = grid(sheet.buildWorkbook({ rows: ROWS, key, summary: SUMMARY, assignment: 'a', date: '2026-09-24' }).Sheets.Summary);
  assert.equal(g[3][0], 'Pass rate % (pass at 80%)');
  const noPass = { questions: KEY.questions };
  const g2 = grid(sheet.buildWorkbook({ rows: ROWS, key: noPass, summary: SUMMARY, assignment: 'a', date: '2026-09-24' }).Sheets.Summary);
  assert.equal(g2[3][0], 'Pass rate % (pass at 70%)');
});

test('column widths are set on both sheets', () => {
  const wb = sheet.buildWorkbook({ rows: ROWS, key: KEY, summary: SUMMARY, assignment: 'a', date: '2026-09-24' });
  const cols = wb.Sheets.Roster['!cols'];
  assert.equal(cols.length, HEADERS.length);
  assert.ok(cols.every((c) => Number.isFinite(c.wch) && c.wch >= 6 && c.wch <= 60));
  assert.ok(cols[9].wch >= 20, 'Notes is wide enough to read');
  assert.equal(wb.Sheets.Summary['!cols'].length, 3);
  const exact = sheet.buildWorkbook({ rows: ROWS, key: MATCH_KEY, summary: SUMMARY, assignment: 'a', date: '2026-09-24' });
  assert.ok(exact.Sheets.Summary['!cols'][2].wch >= 'exact form'.length, 'Match fits "exact form"');
});

test('Review column: a row with no second read says so', () => {
  const key = { passPercent: 70, questions: [{ answer: '1', points: 1 }] };
  const rows = [{
    studentName: 'Dee', nameFlag: false, answers: [ans(1, '1', true, 1, { reviewRead: null })],
    score: 1, maxScore: 1, flagged: true, notes: 'No second read: answers were not cross-checked.',
    readBy: 'm', reviewedBy: '', reviewMode: 'none'
  }];
  const summary = { students: 1, mean: 100, median: 100, passRate: 100, perQuestion: [], distribution: [], flaggedRows: 1, singleModelRows: 0 };
  const g = grid(roundTrip(sheet.buildWorkbook({ rows, key, summary, assignment: 'x', date: '2026-09-24' })).Sheets.Roster);
  assert.equal(g[1][g[1].length - 1], 'no second read');
});

test('an empty class still builds: headers only, zeros in Summary', () => {
  const summary = {
    students: 0, mean: 0, median: 0, passRate: 0,
    perQuestion: KEY.questions.map((_, i) => ({ q: i + 1, hitRate: 0 })),
    distribution: BANDS.map((bucket) => ({ bucket, count: 0 })),
    flaggedRows: 0, singleModelRows: 0
  };
  const wb = roundTrip(sheet.buildWorkbook({ rows: [], key: KEY, summary, assignment: '', date: '2026-09-24' }));
  assert.deepEqual(grid(wb.Sheets.Roster), [HEADERS]);
  assert.deepEqual(grid(wb.Sheets.Summary)[0].slice(0, 2), ['Students', 0]);
});

test('buildWorkbook without a summary is a clear error', () => {
  assert.throws(() => sheet.buildWorkbook({ rows: ROWS, key: KEY }), /summary/);
});
