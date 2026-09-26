'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'js', 'solve.js'));

function answer(q) {
  const r = S.compute(q);
  return r.ok ? r.answer : 'FAIL ' + r.reason;
}

test('computes whole-number arithmetic exactly, with any number of digits', () => {
  assert.equal(answer('347 × 26'), '9022');
  assert.equal(answer('34 x 56 ='), '1904');
  assert.equal(answer('1,234 × 56'), '69104');
  assert.equal(answer('999999999999999 * 999999999999999'), '999999999999998000000000000001');
  assert.equal(answer('12 ÷ 4 + 2'), '5');
  assert.equal(answer('7 - 10'), '-3');
  assert.equal(answer('−5 − 3'), '-8');
});

test('fractions stay exact and come out in lowest terms', () => {
  assert.equal(answer('3/4 + 1/8'), '7/8');
  assert.equal(answer('1/3 + 1/6'), '1/2');
  assert.equal(answer('1 1/2 + 2 3/4'), '17/4');
  assert.equal(answer('½ + ¼'), '3/4');
  assert.equal(answer('2 × 3/4'), '3/2');
  assert.equal(answer('1/2 ÷ 1/4'), '2');
  assert.equal(answer('1 1/2 ÷ 3/4'), '2');
});

test('the division sign divides; a lone typed fraction is one number, not a question', () => {
  assert.equal(answer('10 ÷ 4'), '5/2');
  assert.equal(answer('10 ÷ 4 ÷ 5'), '1/2');
  assert.equal(answer('12/4'), 'FAIL no operation');
  assert.equal(answer('6/2/3'), 'FAIL ambiguous', 'two typed slashes round one number');
  assert.equal(answer('12 / 3/4'), 'FAIL ambiguous', 'a division sign read as a slash');
  assert.equal(answer('12 \u00f7 3/4'), '16');
});

test('decimals: no float error, and a decimal answer when the question used decimals', () => {
  assert.equal(answer('0.1+0.2'), '0.3');
  assert.equal(answer('2.5 × 1.2'), '3');
  assert.equal(answer('10 / 4.0'), '2.5');
  assert.equal(answer('1.5 × 0.25'), '0.375');
  assert.equal(answer('1 ÷ 3.0'), '1/3', 'a repeating value stays a fraction');
  assert.equal(answer('.5 + .25'), '0.75');
});

test('order of operations, powers, brackets and implied multiplication', () => {
  assert.equal(answer('2(3+4)'), '14');
  assert.equal(answer('[2 + 3] × 4'), '20');
  assert.equal(answer('(-2)^2'), '4');
  assert.equal(answer('-(2^2)'), '-4');
  assert.equal(answer('2^-2'), '1/4');
  assert.equal(answer('3/4^2'), '3/16');
  assert.equal(answer('2 + 3 × 4^2'), '50');
});

test('lead words and a trailing equals sign or question mark are dropped', () => {
  assert.equal(answer('Multiply. 347 × 26'), '9022');
  assert.equal(answer('What is 7 - 10?'), '-3');
  assert.equal(answer('Evaluate: 2 + 3 × 4 = ?'), '14');
  assert.equal(answer('Find the product of 12 x 12'), '144');
  assert.equal(answer('34 × 56 = ____'), '1904');
});

test('anything that is not arithmetic, or past the limits, is not computed', () => {
  assert.equal(answer('x + 3'), 'FAIL not arithmetic');
  assert.equal(answer('Round 347 to the nearest ten'), 'FAIL not arithmetic');
  assert.equal(answer('25% of 80'), 'FAIL not arithmetic');
  assert.equal(answer('12'), 'FAIL no operation');
  assert.equal(answer(''), 'FAIL empty');
  assert.equal(answer('5/0'), 'FAIL division by zero');
  assert.equal(answer('5 ÷ (2 - 2)'), 'FAIL division by zero');
  assert.equal(answer('2^13'), 'FAIL exponent out of range');
  assert.equal(answer('2^12'), '4096');
  assert.equal(answer('0^0'), 'FAIL zero to the power zero');
  assert.equal(answer('1234567890123456 + 1'), 'FAIL not arithmetic', '16 digits');
  assert.equal(answer('99999999999999 * 99999999999999 * 99999999999999'), 'FAIL too large');
  assert.equal(answer('((((((((1+1))))))))'), 'FAIL not arithmetic', 'brackets too deep');
  assert.equal(answer('2^(1/2)'), 'FAIL exponent not whole');
  assert.equal(answer('1 + '.repeat(30) + '1'), 'FAIL too long');
  assert.equal(answer('1 + '.repeat(50) + '1'), 'FAIL too long');
  assert.equal(answer('2 3'), 'FAIL not arithmetic');
});

test('notation read two ways is refused, never given a convention', () => {
  assert.equal(answer('-3^2'), 'FAIL ambiguous');
  assert.equal(answer('2 + -3^2'), 'FAIL ambiguous');
  assert.equal(answer('2^3^2'), 'FAIL ambiguous');
  assert.equal(answer('8 \u00f7 2(2+2)'), 'FAIL ambiguous');
  assert.equal(answer('8/2(2+2)'), 'FAIL ambiguous');
  assert.equal(answer('1 1/2(4)'), 'FAIL ambiguous');
  assert.equal(answer('\u00bd(4)'), '2', 'a fraction glyph is one number');
  assert.equal(answer('2(3+4)'), '14');
});

test('numberOf reads a printed choice as one exact number, or nothing', () => {
  const text = (c) => { const v = S.numberOf(c); return v ? S.canonical(v) : null; };
  assert.equal(text('1,288'), '1288');
  assert.equal(text('-3'), '-3');
  assert.equal(text('7/8'), '7/8');
  assert.equal(text('1 1/2'), '3/2');
  assert.equal(text('$4.50'), '9/2');
  assert.equal(text('25%'), '1/4');
  assert.equal(text('0.875'), '7/8');
  assert.equal(text('B'), null);
  assert.equal(text('2 + 3'), null);
});

test('canonical, decimalText and withCommas write values a teacher and equivalent() read', () => {
  const v = (n, d) => S.frac(n, d);
  assert.equal(S.canonical(v(9022)), '9022');
  assert.equal(S.canonical(v(5, 2)), '5/2');
  assert.equal(S.canonical(v(5, 2), { decimal: true }), '2.5');
  assert.equal(S.canonical(v(1, 3), { decimal: true }), '1/3');
  assert.equal(S.canonical(v(-1, 8), { decimal: true }), '-0.125');
  assert.equal(S.decimalText(v(1, 3)), null);
  assert.equal(S.decimalText(v(-7, 4)), '-1.75');
  assert.equal(S.withCommas('9022'), '9022');
  assert.equal(S.withCommas('12345'), '12,345');
  assert.equal(S.withCommas('-1234567.5'), '-1,234,567.5');
});

test('asksForValue: the arithmetic word for word in the question, and only plain instruction words around it', () => {
  const T = '×', D = '÷';
  const cases = [
    ['Multiply. 347 ' + T + ' 26', '347 ' + T + ' 26', true],
    ['2. Multiply. Show your work. 347 ' + T + ' 26 = ____', '347 x 26', true],
    ['347\n' + T + ' 26', '347 ' + T + ' 26', true],
    ['1,234 ' + T + ' 56', '1234*56', true],
    ['b) 12 ' + D + ' 4 + 2', '12 ' + D + ' 4 + 2', true],
    ['What is 7 - 10?', '7 - 10', true],
    ['Use the standard algorithm to multiply 48 x 26.', '48 ' + T + ' 26', true],
    ['Which is 6 x 7?', '6 x 7', true],
    ['Round 347 ' + T + ' 26 to the nearest hundred', '347 ' + T + ' 26', false],
    ['Estimate 48 ' + T + ' 26', '48 ' + T + ' 26', false],
    ['What is 3/4 of 24?', '3/4 ' + T + ' 24', false],
    ['Simplify 6/8 + 1/8', '6/8 + 1/8', false],
    ['Find the product of 12 and 5', '12 ' + T + ' 5', false],
    ['48 ' + T + ' 26 = 1248', '48 ' + T + ' 26', false],
    ['Which is greater, 3/4 or 5/8?', '3/4 - 5/8', false],
    ['What is the remainder of 13 ' + D + ' 4?', '13 ' + D + ' 4', false],
    ['', '2 + 2', false],
    ['2 + 2', '', false]
  ];
  for (const [q, e, want] of cases) assert.equal(S.asksForValue(q, e), want, JSON.stringify(q));
});

test('accepts: exact values, quotient and remainder, and rounding named as a near miss', () => {
  const t = (a, q) => S.accepts(a, S.compute(q));
  const D = '÷';
  assert.deepEqual(t('13 R1', '157 ' + D + ' 12'), { match: true, nearMiss: false });
  assert.deepEqual(t('13 r 1', '157 ' + D + ' 12'), { match: true, nearMiss: false });
  assert.deepEqual(t('13 remainder 1', '157 ' + D + ' 12'), { match: true, nearMiss: false });
  assert.deepEqual(t('13 R 2', '157 ' + D + ' 12'), { match: false, nearMiss: false });
  assert.deepEqual(t('13 1/12', '157 ' + D + ' 12'), { match: true, nearMiss: false });
  assert.deepEqual(t('157/12', '157 ' + D + ' 12'), { match: true, nearMiss: false });
  assert.deepEqual(t('13.08', '157 ' + D + ' 12'), { match: false, nearMiss: true });
  assert.deepEqual(t('3.33', '10 ' + D + ' 3'), { match: false, nearMiss: true });
  assert.deepEqual(t('3.34', '10 ' + D + ' 3'), { match: false, nearMiss: false });
  assert.deepEqual(t('9,022', '347 x 26'), { match: true, nearMiss: false });
  assert.deepEqual(t('= 9022.', '347 x 26'), { match: true, nearMiss: false });
  assert.deepEqual(t('2 R2', '10 ' + D + ' 4'), { match: true, nearMiss: false });
  assert.deepEqual(t('25%', '1 ' + D + ' 4'), { match: true, nearMiss: false });
  assert.equal(t('9022 apples', '347 x 26'), null, 'not one number: the caller compares another way');
  assert.deepEqual(t('3 R1', '3.5 x 2'), { match: false, nearMiss: false }, 'a remainder only for whole-number division');
});

test('multiple choice: labels normalized, one mark resolved, two marks and unknown marks named', () => {
  const L = [{ label: 'A', text: '36' }, { label: 'B', text: '42' }, { label: 'C', text: '48' }];
  const N = [{ label: '1', text: '4' }, { label: '2', text: '6' }, { label: '3', text: '2' }];
  const U = [{ label: '', text: '1/2' }, { label: '', text: '0.75' }, { label: '', text: '2/3' }];
  assert.deepEqual(S.resolveMark('B', L), { index: 1 });
  assert.deepEqual(S.resolveMark('(b)', L), { index: 1 });
  assert.deepEqual(S.resolveMark('b.', L), { index: 1 });
  assert.deepEqual(S.resolveMark('42', L), { index: 1 });
  assert.deepEqual(S.resolveMark('B, C', L), { two: true });
  assert.deepEqual(S.resolveMark('B and C', L), { two: true });
  assert.deepEqual(S.resolveMark('D', L), { unknown: true });
  assert.deepEqual(S.resolveMark('', L), { none: true });
  assert.deepEqual(S.resolveMark('2', N), { index: 1 }, 'a digit is a label first');
  assert.deepEqual(S.resolveMark('3/4', U), { index: 1 }, 'unlabeled choices match by value');
  assert.deepEqual(S.resolveMark('5', U), { unknown: true });
  assert.equal(S.findChoice(L, { value: S.frac(42) }), 1);
  assert.equal(S.findChoice([{ label: 'A', text: '23 x 47' }, { label: 'B', text: '1000' }], { value: S.frac(1081) }), 0);
  assert.equal(S.findChoice([{ label: 'A', text: '42' }, { label: 'B', text: '42.0' }], { value: S.frac(42) }), -1, 'two matches is none');
});

test('the gate fails closed on a stray symbol, and a leading decimal is not a question number', () => {
  const T = '×', M = '−';
  assert.equal(S.asksForValue('Find ' + M + '7 ' + T + ' 6', '7 ' + T + ' 6'), false, 'a dropped minus sign');
  assert.equal(S.asksForValue('Find ' + M + '7 ' + T + ' 6', M + '7 ' + T + ' 6'), true);
  assert.equal(S.asksForValue('What is 50 + 10%?', '50 + 10'), false);
  assert.equal(S.asksForValue('Find |2 ' + M + ' 9|', '2 ' + M + ' 9'), false);
  assert.equal(S.asksForValue('Find 2 ' + T + ' 3!', '2 ' + T + ' 3'), false);
  assert.equal(S.asksForValue('1.5 ' + T + ' 4', '5 ' + T + ' 4'), false);
  for (const t of ['12.5 ' + M + ' 3', '2.5 ' + T + ' 4', '0.75 + 0.5', '10.2 ÷ 3', '3) 12.5 ' + M + ' 3']) {
    assert.equal(S.asksForValue(t, t.replace(/^3\) /, '')), true, t);
  }
  assert.equal(S.asksForValue('Find 12 ÷ 3', '12 / 3'), false, 'a division sign is never a slash');
});

test('x is times after a bracket or a fraction glyph, and before a point or a sign', () => {
  assert.equal(answer('(3 + 4) x 2'), '14');
  assert.equal(answer('(3+4)x(2+1)'), '21');
  assert.equal(answer('½ x 8'), '4');
  assert.equal(answer('4 x .5'), '2');
  assert.equal(answer('2 x -3'), '-6');
});

test('a whole written choice is matched before the answer is split into marks', () => {
  const N = [{ label: '1', text: '1/2' }, { label: '2', text: '2/3' }, { label: '3', text: '3/4' }, { label: '4', text: '4/5' }];
  assert.deepEqual(S.resolveMark('3/4', N), { index: 2 });
  assert.deepEqual(S.resolveMark('1, 3', N), { two: true });
  assert.deepEqual(S.resolveMark('1,388', [{ label: '1', text: '1,288' }, { label: '2', text: '1,388' }]), { index: 1 });
});

test('choiceNamed: a label, "B) 42", the bracketed number of an unlabeled choice, text or value, then position', () => {
  const L = [{ label: 'A', text: '36' }, { label: 'B', text: '42' }];
  const U = [{ label: '', text: '2' }, { label: '', text: '4' }, { label: '', text: '8' }];
  assert.equal(S.choiceNamed('b', L), 1);
  assert.equal(S.choiceNamed('B) 42', L), 1);
  assert.equal(S.choiceNamed('42', L), 1);
  assert.equal(S.choiceNamed('(2)', U), 1);
  assert.equal(S.choiceNamed('2', U), -1, 'value 2 is the first choice, position 2 the second: neither');
  assert.equal(S.choiceNamed('2)', U), 1, 'a bracket form is a position');
  assert.equal(S.choiceNamed('4', U), 1, 'a value when no choice is at that position');
  assert.equal(S.choiceNamed('3', U), 2, 'a position when no choice is that number');
  assert.equal(S.choiceNamed('9', U), -1);
});

test('x before a sign is times only when the sign is attached; "4x - 3" is algebra', () => {
  assert.equal(answer('2 x -3'), '-6');
  assert.equal(answer('4x \u2212 3'), 'FAIL not arithmetic');
  assert.equal(answer('2 x - 3'), 'FAIL not arithmetic');
});

test('the gate refuses an expression that is part of a longer number, and keeps a sentence apart', () => {
  assert.equal(S.asksForValue('Find .5 \u00d7 4', '5 \u00d7 4'), false);
  assert.equal(S.asksForValue('What is .25 + 1?', '25 + 1'), false);
  assert.equal(S.asksForValue('Find .5 \u00d7 4', '.5 \u00d7 4'), true);
  assert.equal(S.asksForValue('Multiply. 347 \u00d7 26.', '347 \u00d7 26'), true);
  assert.equal(S.asksForValue('Find 11/2 + 2', '1 1/2 + 2'), false);
});
