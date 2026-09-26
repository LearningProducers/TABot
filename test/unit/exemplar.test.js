'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const E = require(path.join(__dirname, '..', '..', 'js', 'exemplar.js'));
const S = require(path.join(__dirname, '..', '..', 'js', 'solve.js'));
const G = require(path.join(__dirname, '..', '..', 'js', 'grade.js'));

const TIMES = '×';
const DIVIDE = '÷';

function lines(r) {
  return r.rows.map((row) => row.map((c) => (c === null ? '' : c)).join('|'));
}

function answerRow(r) {
  return r.rows[r.rows.length - 1];
}

// Reads the digits of a grid row (cells after the sign cell, up to the first
// empty cell after a digit) back into a number.
function gridNumber(row) {
  let text = '';
  for (let i = 1; i < row.length; i++) {
    if (typeof row[i] === 'string' && /^[0-9]$/.test(row[i])) text += row[i];
    else if (text) break;
  }
  return BigInt(text || '0');
}

// The rows of a digit grid: a sign cell (or null) then one-character cells.
function gridRows(r) {
  return r.rows.filter((row) => row.length > 2 && (row[0] === null || row[0] === TIMES || row[0] === '=' || row[0] === '+' || row[0] === '-') &&
    row.slice(1).some((c) => typeof c === 'string' && /^[0-9]$/.test(c)));
}

test('standard algorithm: one digit to a cell, a partial product per digit, then the sum', () => {
  const r = E.build({ expression: '347 ' + TIMES + ' 26' });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'standard algorithm');
  assert.equal(r.answer, '9022');
  assert.deepEqual(r.rows[0], ['Question', '347 ' + TIMES + ' 26']);
  const grid = gridRows(r);
  assert.deepEqual(grid[0], [null, null, '3', '4', '7']);
  assert.deepEqual(grid[1], [TIMES, null, null, '2', '6']);
  assert.deepEqual(grid[2], [null, '2', '0', '8', '2', null, '347 ' + TIMES + ' 6 = 2082']);
  assert.deepEqual(grid[3], [null, '6', '9', '4', '0', null, '347 ' + TIMES + ' 20 = 6940']);
  assert.deepEqual(grid[4], ['=', '9', '0', '2', '2', null, 'Add: 2082 + 6940 = 9022']);
  assert.deepEqual(answerRow(r), ['Answer', '9022']);
  for (const row of grid) {
    for (const c of row.slice(1, 5)) assert.ok(c === null || (typeof c === 'string' && c.length === 1), 'one-character text or empty');
  }
});

test('the longer number goes on top, and a 0 digit below gets no row of zeros', () => {
  const r = E.build({ expression: '26 x 347' });
  assert.deepEqual(gridRows(r)[0], [null, null, '3', '4', '7']);
  const z = E.build({ expression: '305 x 40' });
  assert.equal(z.answer, '12200');
  assert.ok(lines(z).includes('|The 0 in the ones place of 40 gives a row of zeros, so it has no row.'));
});

test('every standard-algorithm grid adds up, for many products', () => {
  const pairs = [[12, 3], [99, 99], [1234, 5678], [305, 207], [1000, 10], [7, 8], [40506, 30]];
  for (const [a, b] of pairs) {
    const r = E.build({ expression: a + ' x ' + b });
    assert.equal(r.ok, true, a + ' x ' + b);
    assert.equal(r.answer, String(BigInt(a) * BigInt(b)));
    const grid = gridRows(r);
    assert.equal(gridNumber(grid[grid.length - 1]), BigInt(a) * BigInt(b), a + ' x ' + b + ' final row');
    const partials = grid.slice(2, -1).map(gridNumber);
    if (partials.length) assert.equal(partials.reduce((x, y) => x + y, 0n), BigInt(a) * BigInt(b), a + ' x ' + b + ' partials add up');
  }
});

test('partial products and area model give the same product and say how; lattice is not laid out', () => {
  const pp = E.build({ expression: '347 x 26', method: 'partial products' });
  assert.equal(pp.method, 'partial products');
  assert.ok(lines(pp).includes('|300 ' + TIMES + ' 20 = 6000'));
  assert.ok(lines(pp).some((l) => l.endsWith('= 9022')));

  const area = E.build({ expression: '347 x 26', method: 'area model' });
  assert.equal(area.method, 'area model');
  assert.deepEqual([...area.rows[3]], [TIMES, '300', '40', '7']);
  assert.deepEqual([...area.rows[4]], ['20', '6000', '800', '140']);
  assert.deepEqual([...area.rows[5]], ['6', '1800', '240', '42']);
  assert.ok(area.rows[3].table && area.rows[5].table, 'an area model is a table, placed apart in the sheet');

  const lat = E.build({ expression: '347 x 26', method: 'lattice' });
  assert.equal(lat.ok, false);
  assert.match(lat.reason, /lattice method, which TABot does not lay out yet/);

  assert.deepEqual(E.methodsFor('347 x 26'), ['standard algorithm', 'partial products', 'area model']);
  assert.deepEqual(E.methodsFor('3/4 + 1/8'), []);
  assert.deepEqual(E.methodsFor('a word problem'), []);
});

test('an unknown method falls back to the standard algorithm', () => {
  assert.equal(E.build({ expression: '12 x 34', method: 'repeated addition' }).method, 'standard algorithm');
});

test('decimals are multiplied as whole numbers, then the point is placed', () => {
  const r = E.build({ expression: '3.47 x 2.6' });
  assert.equal(r.answer, '9.022');
  assert.ok(lines(r).some((l) => l.includes('3 decimal places, so 9022 becomes 9.022')));
});

test('column addition names each carry; subtraction names each borrow', () => {
  const add = E.build({ expression: '4,567 + 389 + 12' });
  assert.equal(add.answer, '4968');
  assert.ok(lines(add).includes('|ones: 7 + 9 + 2 = 18; write 8, carry 1.'));
  const sub = E.build({ expression: '503 - 278' });
  assert.equal(sub.answer, '225');
  assert.deepEqual(lines(sub).filter((l) => /^\|(ones|tens|hundreds):/.test(l)), [
    '|ones: 3 + 10 borrowed - 8 = 5.',
    '|tens: 0 - 1 lent + 10 borrowed - 7 = 2.',
    '|hundreds: 5 - 1 lent - 2 = 2.'
  ]);
  const dec = E.build({ expression: '52.3 - 7.85' });
  assert.equal(dec.answer, '44.45');
});

test('long division shows each step, the quotient and remainder, and the exact value', () => {
  const r = E.build({ expression: '1,234 ' + DIVIDE + ' 7' });
  assert.equal(r.method, 'long division');
  assert.equal(r.answer, '1234/7');
  assert.ok(lines(r).includes('|7 does not go into 1, so start with 12: 7 goes into 12 once; 1 ' + TIMES + ' 7 = 7; 12 - 7 = 5.'));
  assert.ok(lines(r).includes('|Bring down 4: 7 goes into 44 6 times; 6 ' + TIMES + ' 7 = 42; 44 - 42 = 2.'));
  assert.ok(lines(E.build({ expression: '3 ' + DIVIDE + ' 4' })).includes('|Quotient 0, remainder 3. As a number: 3/4 = 0.75.'));
  assert.deepEqual(answerRow(r), ['Answer', '176 R 2 (176 2/7)']);
  assert.deepEqual(answerRow(E.build({ expression: '84 ' + DIVIDE + ' 4' })), ['Answer', '21']);
});

test('fraction steps: common denominator, multiply across, reciprocal, lowest terms', () => {
  const add = E.build({ expression: '3/4 + 5/6' });
  assert.equal(add.method, 'fraction steps');
  assert.deepEqual(answerRow(add), ['Answer', '19/12 (1 7/12)']);
  const mul = E.build({ expression: '2/3 x 9/10' });
  assert.equal(mul.answer, '3/5');
  assert.ok(lines(mul).includes('|Lowest terms: 18/30 = 3/5.'));
  const div = E.build({ expression: '1 1/2 ' + DIVIDE + ' 3/4' });
  assert.equal(div.answer, '2');
  assert.ok(lines(div).includes('|Write 1 1/2 as a fraction: 3/2.'));
});

test('order of operations: one operation per step, each step equal to the question', () => {
  const r = E.build({ expression: '2 + 3 x (4 - 1)^2' });
  assert.equal(r.method, 'order of operations');
  assert.deepEqual(r.rows.slice(3, 9).map((row) => row[1]), [
    '2 + 3 ' + TIMES + ' (4 - 1)^2', '= 2 + 3 ' + TIMES + ' 3^2', '= 2 + 3 ' + TIMES + ' 9', '= 2 + 27', '= 29', undefined
  ]);
  assert.equal(E.build({ expression: '-(2^2) + 10' }).answer, '6');
  assert.match(E.build({ expression: '-2^2 + 10' }).reason, /can be worked two ways/);
});

test('multiple choice: the one matching choice is named; none or two is no exemplar', () => {
  const choices = [{ label: 'A', text: '36' }, { label: 'B', text: '42' }, { label: 'C', text: '48' }];
  const r = E.build({ expression: '6 x 7', choices });
  assert.deepEqual(answerRow(r), ['Answer', 'B (42)']);
  assert.ok(lines(r).includes('|The choice that matches is B (42).'));
  const none = E.build({ expression: '6 x 8', choices: choices.slice(0, 2) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /No choice matches/);
  const two = E.build({ expression: '6 x 7', choices: [{ label: 'A', text: '42' }, { label: 'B', text: '42.0' }] });
  assert.equal(two.ok, false);
  assert.match(two.reason, /More than one choice/);
});

test('a key given as a label, a value or a remainder is checked against the worked answer', () => {
  const eq = G.equivalent;
  const choices = [{ label: 'A', text: '36' }, { label: 'B', text: '42' }];
  assert.equal(E.build({ expression: '6 x 7', choices, keyAnswer: 'B', equivalent: eq }).ok, true);
  assert.equal(E.build({ expression: '6 x 7', choices, keyAnswer: '42', equivalent: eq }).ok, true);
  assert.match(E.build({ expression: '6 x 7', choices, keyAnswer: 'A', equivalent: eq }).reason, /works out to B \(42\), but the answer key says A/);
  assert.equal(E.build({ expression: '157 ' + DIVIDE + ' 12', keyAnswer: '13 R1', equivalent: eq }).ok, true);
});

test('a fraction or mixed number raised to a power keeps its brackets in every step', () => {
  for (const [q, want] of [['(3/4)^2', '9/16'], ['(1 1/2)^2', '9/4'], ['(5 ' + DIVIDE + ' 4)^2 x 16', '25']]) {
    const r = E.build({ expression: q });
    assert.equal(r.answer, want, q);
    for (const row of r.rows.slice(3)) {
      if (row[0] !== null || typeof row[1] !== 'string') continue;
      assert.doesNotMatch(row[1], /\d\/\d+\^/, q + ': ' + row[1]);
    }
  }
});

test('fraction steps use the fractions as printed, reducing only at the end', () => {
  const r = E.build({ expression: '6/8 x 4/3' });
  assert.ok(lines(r).includes('|Multiply across: (6 ' + TIMES + ' 4)/(8 ' + TIMES + ' 3) = 24/24.'));
  assert.ok(lines(r).includes('|Lowest terms: 24/24 = 1.'));
  assert.deepEqual(lines(E.build({ expression: '2/4 + 1/4' })).filter((l) => l.startsWith('|Add')), ['|Add the numerators: 2 + 1 = 3, so 3/4.']);
});

test('a digit key names a choice label first, the way grading reads it', () => {
  const C = [{ label: '1', text: '4' }, { label: '2', text: '6' }, { label: '3', text: '8' }, { label: '4', text: '2' }];
  assert.match(E.build({ expression: '2 x 2', choices: C, keyAnswer: '4', equivalent: G.equivalent }).reason, /but the answer key says 4/);
  assert.equal(E.build({ expression: '2 x 2', choices: C, keyAnswer: '1', equivalent: G.equivalent }).ok, true);
});

test('the steps sent to the analysis keep the result, and say when the middle is left out', () => {
  const t = E.stepsText('123456789012 ' + DIVIDE + ' 7');
  assert.ok(t.length <= 600);
  assert.match(t, /; \(some steps left out\); Quotient 17,636,684,144, remainder 4\. As a number: 17636684144 4\/7$/);
  assert.equal(E.stepsText('347 x 26'), '347 ' + TIMES + ' 6 = 2082; 347 ' + TIMES + ' 20 = 6940; Add: 2082 + 6940 = 9022');
});

test('fraction glyphs work in fraction steps', () => {
  assert.equal(E.build({ expression: '\u00bd + \u00bc' }).answer, '3/4');
  assert.equal(E.build({ expression: '3 ' + DIVIDE + ' \u00bd' }).answer, '6');
});

test('a second parse that disagrees means no exemplar', () => {
  assert.equal(E.build({ expression: '347 x 26', exactValue: () => ({ n: '9023', d: '1' }) }).reason, E.CHECK_FAILED);
  assert.equal(E.build({ expression: '347 x 26', exactValue: G.exactValue }).ok, true);
});

test('forClass: an exemplar per settled question, the support and method named, a reason for the rest', () => {
  const settled = { questions: [
    { q: 1, computed: { expression: '347 x 26', support: { agree: 20, of: 21 }, versions: [] },
      method: { method: 'standard algorithm', count: 17, of: 21 }, choices: [], keyAnswer: '' },
    { q: 2, computed: null, text: 'Sam has 24 apples and gives away 9. How many are left?' },
    { q: 3, computed: null, readsDisagree: true },
    { q: 4, computed: { expression: '12 x 34', support: { agree: 3, of: 3 }, versions: [] },
      method: { method: 'lattice', count: 3, of: 3 }, choices: [], keyAnswer: '' },
    { q: 5, computed: null, text: '', anyExpression: false },
    { q: 6, computed: { expression: '12 x 34', support: { agree: 1, of: 1 }, versions: [] }, method: null, choices: [], keyAnswer: '' },
  ] };
  const out = E.forClass(settled, { equivalent: G.equivalent, exactValue: G.exactValue });
  assert.equal(out[0].ok, true);
  assert.deepEqual(out[0].rows[0], ['Question', '347 ' + TIMES + ' 26', 'read this way on 20 of 21 papers']);
  assert.deepEqual(out[0].rows[1], ['Method', 'standard algorithm (as read by AI on 17 of 21 papers)']);
  assert.match(out[1].reason, /not arithmetic TABot's code can work out and check/);
  assert.match(out[2].reason, /reads of the printed question disagree/);
  assert.match(out[3].reason, /lattice method/);
  assert.match(out[4].reason, /No printed question was read at this number/);
  assert.deepEqual(out[5].rows[0], ['Question', '12 ' + TIMES + ' 34', 'read this way on 1 of 1 paper']);
  assert.deepEqual(out[5].rows[1], ['Method', 'standard algorithm (no one method was read on most papers)']);
});

test('forClass: a question whose layout throws is listed with a reason, and the rest still build', () => {
  const settled = { questions: [
    { q: 1, get computed() { throw new Error('boom'); } },
    { q: 2, computed: { expression: '6 x 7', support: { agree: 1, of: 1 }, versions: [] }, choices: [], keyAnswer: '' },
  ] };
  const out = E.forClass(settled, {});
  assert.deepEqual(out[0], { q: 1, ok: false, reason: 'TABot could not lay this one out.' });
  assert.equal(out[1].ok, true);
});

test('a key that disagrees with the printed question means no exemplar, with the reason', () => {
  const eq = (a, b) => S.equal(S.numberOf(a), S.numberOf(b));
  const r = E.build({ expression: '12 x 12', keyAnswer: '140', equivalent: eq });
  assert.equal(r.ok, false);
  assert.match(r.reason, /works out to 144, but the answer key says 140/);
  assert.equal(E.build({ expression: '12 x 12', keyAnswer: '144', equivalent: eq }).ok, true);
});

test('no exemplar, with a plain reason, when code cannot work the question', () => {
  assert.match(E.build({ expression: '' }).reason, /No printed arithmetic/);
  assert.match(E.build({ expression: 'Round 347 to the nearest ten' }).reason, /not arithmetic/);
  assert.match(E.build({ expression: '5 ' + DIVIDE + ' 0' }).reason, /divides by zero/);
  assert.match(E.build({ expression: '2^100' }).reason, /too large/);
  assert.match(E.build({ expression: '123456789 x 987654321' }).reason, /too long/);
});
