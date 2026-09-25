'use strict';

// Unit tests for js/grade.js. All data is synthetic; no network, no keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const grade = require('../../js/grade.js');

const { normalize, equivalent, exactForm, gradeSlip, summarize } = grade;

// Unicode spellings kept as escapes so the source stays ASCII.
const MINUS = '\u2212';
const TIMES = '\u00d7';
const DIVIDE = '\u00f7';
const FRAC_SLASH = '\u2044';
const HALF = '\u00bd';
const SQUARED = '\u00b2';
const PI = '\u03c0';
const ROOT = '\u221a';
const DEG = '\u00b0';
const MIDDOT = '\u00b7';
const SUP4 = '\u2074';
const EN_DASH = '\u2013';
const FIG_DASH = '\u2012';
const NB_HYPHEN = '\u2011';
const ELLIPSIS = '\u2026';
// "10^-13" in superscripts: minus, one, three.
const SUP_NEG13 = '\u207b\u00b9\u00b3';
const QUARTER = '\u00bc';
const THREE_QUARTERS = '\u00be';
const THIRD = '\u2153';
const TWO_THIRDS = '\u2154';
const SUP3 = '\u00b3';
const SUP5 = '\u2075';
const SUP_MINUS = '\u207b';
const LE = '\u2264';
const GE = '\u2265';
const NE = '\u2260';

function expectPairs(pairs, expected) {
  for (const [a, b] of pairs) {
    assert.equal(equivalent(a, b), expected, `equivalent(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.equal(equivalent(b, a), expected, `equivalent(${JSON.stringify(b)}, ${JSON.stringify(a)})`);
  }
}

// ------------------------------------------------------------------ normalize

test('normalize: trims, lowercases, collapses spaces, drops trailing period', () => {
  assert.equal(normalize('  Right   Triangle. '), 'right triangle');
  // Reversed on purpose: this row read 'yes', and the same strip turned
  // the repeating decimal "0.333..." into 0.333. An ellipsis is kept.
  assert.equal(normalize('YES...'), 'yes...');
  assert.equal(normalize('3.50'), '3.50');
  assert.equal(normalize('a\tb\n c'), 'a b c');
});

test('normalize: unicode minus, fraction slash, multiplication and division signs', () => {
  assert.equal(normalize(MINUS + '3'), '-3');
  assert.equal(normalize('1' + FRAC_SLASH + '2'), '1/2');
  assert.equal(normalize('3' + TIMES + '4'), '3*4');
  assert.equal(normalize('6' + DIVIDE + '2'), '6/2');
});

test('normalize: thousands commas dropped, list commas kept', () => {
  assert.equal(normalize('1,000'), '1000');
  assert.equal(normalize('12,345,678.5'), '12345678.5');
  assert.equal(normalize('3,4'), '3,4');
  assert.equal(normalize('(1, 200)'), '(1, 200)');
});

test('normalize: thousands commas dropped only when the whole answer is one number', () => {
  assert.equal(normalize('-$1,234.50'), '-$1234.50');
  assert.equal(normalize('$ -1,000'), '$ -1000');
  assert.equal(normalize('2,000 m'), '2000 m');
  assert.equal(normalize('1,500 sq. ft'), '1500 sq. ft');
  assert.equal(normalize('12,000 cm' + SQUARED), '12000 cm^2');
  assert.equal(normalize('(1,120)'), '(1,120)');
  // The one-number test reads past a leading "x =", so "x = 2,100" is
  // x = 2100 (its body is one number); a list keeps its comma only when the
  // body after the assignment is not one number.
  assert.equal(normalize('x = 2,100'), 'x = 2100');
  assert.equal(normalize('x = 2, 100'), 'x = 2, 100');
  assert.equal(normalize('1,000, 2,000'), '1,000, 2,000');
  assert.equal(normalize('1,000 + 2,000'), '1,000 + 2,000');
  assert.equal(normalize('1,000 and 2'), '1,000 and 2');
});

test('normalize: x between two digits is times, after the char map', () => {
  assert.equal(normalize('3 x 10^4'), '3 * 10^4');
  assert.equal(normalize('3 X 10^4'), normalize('3 ' + TIMES + ' 10^4'));
  assert.equal(normalize('3 x 10' + SUP4), '3 * 10^4');
  assert.equal(normalize('2x3x4'), '2*3*4');
  assert.equal(normalize('3' + MIDDOT + '4'), '3*4');
  assert.equal(normalize('2' + MIDDOT + 'x'), '2*x');
  // Algebra keeps its x.
  assert.equal(normalize('2x'), '2x');
  assert.equal(normalize('x^2'), 'x^2');
  assert.equal(normalize('2x+6'), '2x+6');
  assert.equal(normalize('2x' + SQUARED), '2x^2');
  assert.equal(normalize('x2'), 'x2');
});

test('normalize: mixed numbers', () => {
  assert.equal(normalize('1 1/2'), '1+1/2');
  assert.equal(normalize('-1 1/2'), '-(1+1/2)');
  assert.equal(normalize('x + 2 1/2'), 'x + (2+1/2)');
  assert.equal(normalize('1' + HALF), '1+1/2');
  assert.equal(normalize('1 / 2'), '1 / 2');
});

test('normalize: superscripts, pi sign, root sign', () => {
  assert.equal(normalize('x' + SQUARED), 'x^2');
  assert.equal(normalize(PI + 'r' + SQUARED), 'pi r^2');
  assert.equal(normalize(ROOT + '16'), 'sqrt(16)');
  assert.equal(normalize(ROOT + '(x+1)'), 'sqrt(x+1)');
});

test('normalize: non-strings and missing values', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(12), '12');
  assert.equal(normalize(0.5), '0.5');
});

// ----------------------------------------------------------------- equivalent

test('equivalent: the spec table, halves', () => {
  const halves = ['1/2', '0.5', '2/4', '.5', '1 / 2', '50%'];
  for (const a of halves) for (const b of halves) {
    assert.equal(equivalent(a, b), true, `${a} vs ${b}`);
  }
});

test('equivalent: the spec table, signs, mixed numbers, algebra, letters', () => {
  expectPairs([
    ['-3', MINUS + '3'],
    ['1 1/2', '3/2'],
    ['2x+6', '2(x+3)'],
  ], true);
  expectPairs([['x', 'y']], false);
});

test('equivalent: text answers', () => {
  expectPairs([
    ['Yes', 'yes.'],
    ['Right triangle', 'right  triangle'],
    ['acute', 'ACUTE'],
    ['x > 3', 'x>3'],
  ], true);
  expectPairs([
    ['acute', 'obtuse'],
    ['yes', 'no'],
    ['yes', 'sey'],
  ], false);
});

test('equivalent: empty never equals anything', () => {
  expectPairs([
    ['', ''],
    ['', '0'],
    ['   ', '   '],
    [null, undefined],
    [null, ''],
    ['.', ''],
  ], false);
});

test('equivalent: negative fractions', () => {
  expectPairs([
    ['-1/2', '-0.5'],
    ['-1/2', '1/-2'],
    ['-(1/2)', '-.5'],
    [MINUS + '3/4', '-0.75'],
    ['-1 1/2', '-3/2'],
    ['-1 1/2', '-1.5'],
  ], true);
  expectPairs([
    ['-1/2', '1/2'],
    ['-1 1/2', '-1/2'],
    ['-3/4', '3/4'],
  ], false);
});

test('equivalent: exact within float noise, so 0.333 is not 1/3', () => {
  expectPairs([
    ['0.333', '1/3'],
    ['0.33', '1/3'],
    ['3.05', '3.5'],
    // Reversed on purpose. This row was true under an older 1e-9 rule, but
    // twelve threes is a different number from 1/3 (it is 1e-12 relative
    // away), so it was itself a wrong answer marked right. The relative
    // tolerance is now 1e-13, float noise.
    ['0.333333333333', '1/3'],
  ], false);
  expectPairs([
    ['3.50', '3.5'],
    // Documented: 0.1+0.2 is 0.30000000000000004 in floating point, a
    // relative gap near 2e-16, inside 1e-13, so it matches 0.3. It could have
    // gone either way; this is the choice, pinned here.
    ['0.1+0.2', '0.3'],
    ['007', '7'],
  ], true);
});

test('equivalent: two numbers joined by a dash are a range or a score, never a subtraction', () => {
  // The same range in every spelling the reader might return.
  expectPairs([
    ['70-79', '70' + EN_DASH + '79'],
    ['70-79', '70 - 79'],
    ['70 ' + EN_DASH + ' 79', '70-79'],
    ['70-79', '70' + MINUS + '79'],
    ['70-79', '70' + FIG_DASH + '79'],
    ['70-79', '70' + NB_HYPHEN + '79'],
    ['3-2', '3 - 2'],
    ['0.5-1.5', '.5 - 1.50'],
    ['70-79%', '70 - 79%'],
    ['x = 70-79', '70-79'],
    ['70-79 years', '70-79'],
    ['5-10 cm', '5-10'],
  ], true);
  // Every same-width bin used to equal every other (all are -9).
  expectPairs([
    ['70-79', '80-89'],
    ['10-19', '20-29'],
    ['0-9', '10-19'],
    ['70' + EN_DASH + '79', '80' + EN_DASH + '89'],
    ['70' + EN_DASH + '79', '60' + EN_DASH + '69'],
    ['12-14', '11-13'],
    ['3-2', '2-1'],
    ['3-2', '1'],
    ['70-79', '-9'],
    ['70-79', '79-70'],
    ['5-10 cm', '6-11 cm'],
    // A sign keeps the shape: "-5-5" is a range from -5 to 5, not -10.
    ['-5-5', '-4-6'],
    ['-5-5', '-10'],
    // An unevaluated difference is compared as written, never by value.
    ['10-3', '7'],
  ], false);
  // Algebra and signed values still evaluate.
  expectPairs([
    ['-3', MINUS + '3'],
    ['x-3', '-3+x'],
    ['10-(-2)', '12'],
    ['5-3x', '-3x+5'],
    ['2x-6', '2(x-3)'],
    ['-1/2', '-0.5'],
  ], true);
});

test('equivalent: no absolute tolerance, so tiny values and zero keep their size', () => {
  expectPairs([
    // Written numbers (compared digit by digit).
    ['6.4 x 10^-13', '6.4 x 10^-14'],
    ['6.4 x 10^-13', '0'],
    ['6.4 ' + TIMES + ' 10' + SUP_NEG13, '0'],
    ['9.11 x 10^-31', '1.67 x 10^-27'],
    ['9.11 x 10^-31 kg', '1.67 x 10^-27 kg'],
    ['1 x 10^-20', '-1 x 10^-20'],
    // Computed values (compared by the relative rule): zero matches only zero.
    ['6.4/10^13', '6.4/10^14'],
    ['1/10^13', '0'],
    ['1/10^13', '1/10^14'],
    ['1/10^13', '-1/10^13'],
    // Documented: floating-point noise is not zero. 0.1+0.2-0.3 is about
    // 5.6e-17, so it does not match 0 (a right answer marked wrong, the lesser
    // mistake). An unsimplified expression is rarely the answer a key wants.
    ['0.1+0.2-0.3', '0'],
  ], false);
  expectPairs([
    ['6.4 x 10^-13', '6.4 ' + TIMES + ' 10' + SUP_NEG13],
    ['6.4 x 10^-13', '0.00000000000064'],
    ['6.4 x 10^-13', '64 x 10^-14'],
    ['6.4/10^13', '6.4 x 10^-13'],
    ['1/3', '2/6'],
    ['0', '0.0'],
    ['0', '-0'],
    ['0', '0/5'],
  ], true);
});

test('normalize: an ellipsis is kept; only a single sentence-end period is dropped', () => {
  assert.equal(normalize('0.333...'), '0.333...');
  assert.equal(normalize('0.333' + ELLIPSIS), '0.333...');
  assert.equal(normalize('0.666...'), '0.666...');
  assert.equal(normalize('12.'), '12');
  assert.equal(normalize('Yes.'), 'yes');
  assert.equal(normalize('5 ft.'), '5 ft');
  assert.equal(normalize('yes..'), 'yes..');
  // Reversed on purpose: a period after a percent sign, a closing bracket or
  // the degree sign was kept, so "75%." did not match "75%". It ends a
  // sentence there too.
  assert.equal(normalize('50%.'), '50%');
  assert.equal(normalize('(2, 3).'), '(2, 3)');
  assert.equal(normalize('[0, 1].'), '[0, 1]');
  assert.equal(normalize('{1, 2}.'), '{1, 2}');
  assert.equal(normalize('90' + DEG + '.'), '90' + DEG);
  // An ellipsis after them is still part of the answer, and a lone dot or
  // one after a sign is not a sentence end.
  assert.equal(normalize('50%...'), '50%...');
  assert.equal(normalize('(2, 3)..'), '(2, 3)..');
  assert.equal(normalize('90' + DEG + ELLIPSIS), '90' + DEG + '...');
  assert.equal(normalize('.'), '.');
  assert.equal(normalize('x +.'), 'x +.');
});

test('normalize: a decimal point that starts a number gets its zero', () => {
  assert.equal(normalize('.75'), '0.75');
  assert.equal(normalize('-.5'), '-0.5');
  assert.equal(normalize('$.50'), '$0.50');
  assert.equal(normalize('x > .5'), 'x > 0.5');
  assert.equal(normalize('.5 < x'), '0.5 < x');
  assert.equal(normalize('(.5, 2)'), '(0.5, 2)');
  assert.equal(normalize('(.5,.25)'), '(0.5,0.25)');
  assert.equal(normalize('{.5, 1}'), '{0.5, 1}');
  assert.equal(normalize('x = .5, y = 2'), 'x = 0.5, y = 2');
  assert.equal(normalize('.5.'), '0.5');
  // A point after a digit, a letter, a closing bracket or another point does
  // not start a number, with or without a space between, and keeps its form.
  assert.equal(normalize('1 .5'), '1 .5');
  assert.equal(normalize('x.5'), 'x.5');
  assert.equal(normalize('x .5'), 'x .5');
  assert.equal(normalize('(2).5'), '(2).5');
  assert.equal(normalize('0.333...'), '0.333...');
  assert.equal(normalize('...5'), '...5');
  assert.equal(normalize('1.5'), '1.5');
});

test('equivalent: a repeating decimal written with an ellipsis is not the terminating one', () => {
  expectPairs([
    ['0.333...', '0.333'],
    ['0.666...', '0.666'],
    ['0.333' + ELLIPSIS, '0.333'],
    ['0.333...', '0.3333'],
    ['0.333...', '0.666...'],
    // Documented: "0.333..." is compared as written, so it does not match 1/3
    // either. The reader cannot know how many threes the student meant.
    ['0.333...', '1/3'],
  ], false);
  expectPairs([
    ['0.333...', '0.333' + ELLIPSIS],
    ['0.333 ...', '0.333...'],
    ['12.', '12'],
    ['3.5 in.', '3.5'],
  ], true);
});

test('equivalent: whole numbers compare exactly, however large', () => {
  expectPairs([
    ['4,567,891,230', '4,567,891,234'],
    ['1,000,000,000', '1,000,000,001'],
    ['2,345,678,900', '2,345,678,902'],
    ['2.5 x 10^9', '2,500,000,003'],
    // Computed whole numbers (the relative rule would have let these pass).
    ['10^9 + 1', '10^9'],
    ['4567891230/1', '4567891234'],
    // Past 2^53 two doubles cannot tell these apart; the digits can.
    ['9,007,199,254,740,993', '9,007,199,254,740,992'],
    // Reversed on purpose. The values are equal, but "/1" makes the
    // right side computed, and a computed value of 2^53 or more now compares
    // as written: past 2^53 a double cannot tell 2^64 - 1 from 2^64 either.
    // A right answer marked wrong, the lesser mistake; the written standard
    // form below still matches.
    ['6.02 x 10^23', '602000000000000000000000/1'],
  ], false);
  expectPairs([
    ['1,000,000,000', '1000000000'],
    ['1,000,000,000', '10^9'],
    ['1,000,000,000', '1 x 10^9'],
    ['10^9', '1 x 10^9'],
    ['1,000,000,001', '10^9 + 1'],
    // Scientific notation and standard form stay the same number past 2^53.
    ['6.02 x 10^23', '602,000,000,000,000,000,000,000'],
    ['6.02 x 10^23', '602 x 10^21'],
  ], true);
});

test('equivalent: money compares to the cent', () => {
  expectPairs([
    ['1.5', '1.50'],
    ['$1.50', '1.5'],
    ['$1.50', '$1.5'],
    ['$1,234.56', '1234.56'],
    ['$0.50', '$.5'],
  ], true);
  expectPairs([
    ['$1.50', '$1.05'],
    ['$0.50', '$0.05'],
    ['$10.00', '$100'],
    ['$1,000.50', '$1,000.05'],
    ['$19.99', '$19.90'],
  ], false);
});

test('equivalent: a leading single-variable assignment is stripped', () => {
  expectPairs([
    ['x=4', '4'],
    ['x = 4', '4'],
    ['X = 4', 'x=4'],
    ['y=2x+3', '3+2x'],
    ['=4', '4'],
  ], true);
  expectPairs([
    ['x=4', 'y=4'],
    ['x=4', 'x=5'],
    ['x=4, y=2', '4'],
  ], false);
});

test('equivalent: units on one side are ignored, units on both sides must match', () => {
  expectPairs([
    ['5 cm', '5'],
    ['5cm', '5 cm'],
    ['12 inches', '12 in'],
    ['3 ft', '3 feet'],
    ['90' + DEG, '90 degrees'],
    ['$5.00', '5'],
    ['5 cm' + SQUARED, '5 cm^2'],
    ['5 cm^2', '5 sq cm'],
    ['8 square units', '8 units^2'],
    ['1/2 cup', '0.5 cups'],
    ['7 units', '7'],
  ], true);
  expectPairs([
    ['5 cm', '5 in'],
    ['5 cm', '6'],
    ['5 cm', '5 cm^2'],
  ], false);
});

test('equivalent: single-letter units m, g, L, s, h beside a plain number', () => {
  expectPairs([
    ['5 m', '5'],
    ['5 m', '5 meters'],
    ['5m', '5 m'],
    ['2.5 L', '2.5'],
    ['2.5 L', '2.5 liters'],
    ['3 g', '3 grams'],
    ['10 s', '10'],
    ['10 s', '10 sec'],
    ['2 h', '2 hours'],
    ['1/2 h', '0.5'],
    ['-1 1/2 m', '-1.5'],
    ['25 m' + SQUARED, '25'],
    ['25 m^2', '25 sq m'],
    ['2,000 m', '2000'],
    ['x = 5 m', '5'],
    ['4.5 x 10^-3 g', '0.0045'],
  ], true);
  expectPairs([
    ['5 m', '6'],
    ['5 m', '5 g'],
    ['5 m', '5 cm'],
    ['5 m', '5 s'],
    ['25 m^2', '25 m'],
    ['2.5 L', '2.5 ml'],
    ['2 x 10^3 m', '2 km'],
    // "5m" with no space is algebra against a bare number (this row was once
    // true and is reversed on purpose).
    ['5m', '5'],
  ], false);
});

test('equivalent: a no-space letter is algebra unless the other side names that unit', () => {
  // The reported rows, then the rest of m, g, l, s, h.
  expectPairs([
    ['5m', '5'],
    ['8h', '8'],
    ['7s', '7'],
    ['4g', '4'],
    ['3l', '3'],
    ['6h', '6'],
    ['3s', '3'],
    ['y = 5m', '5'],
    ['-2m', '-2'],
    ['5m', '5 square meters'],
    ['12m', '12 min'],
    ['5 m', '6m'],
    ['5 m', '5g'],
  ], false);
  expectPairs([
    ['12 m', '12'],
    ['12 m', '12 meters'],
    ['12m', '12 meters'],
    ['12m', '12 m'],
    ['12m', '12 metres'],
    ['2.5L', '2.5 liters'],
    ['2h', '2 hours'],
    ['10s', '10 sec'],
    ['3g', '3 grams'],
    ['5m' + SQUARED, '5 sq m'],
    ['5m' + SQUARED, '5 square meters'],
    ['5m', '5*m'],
  ], true);
});

test('gradeSlip: a student who drops the variable from "5m" scores zero', () => {
  const key = { questions: [{ answer: '5m', points: 2 }] };
  const agree = gradeSlip({
    key,
    reading: reading('Ola Fixture', ['5']),
    review: reading('Ola Fixture', ['5']),
  });
  assert.equal(agree.answers[0].correct, false);
  assert.equal(agree.score, 0);
  // The reader and reviewer disagreeing on the letter is a flag, not hidden.
  const differ = gradeSlip({
    key,
    reading: reading('Ola Fixture', ['5m']),
    review: reading('Ola Fixture', ['5']),
  });
  assert.equal(differ.answers[0].correct, true);
  assert.equal(differ.answers[0].flagged, true);
  assert.equal(differ.answers[0].reason, 'reader 5m, reviewer 5');
});

test('equivalent: a single letter beside algebra stays a variable', () => {
  expectPairs([
    ['5m', '5*m'],
    ['10m', 'm*10'],
    ['10m', '5m + 5m'],
    ['2m + 3', '3 + 2m'],
    ['2m + 3', '3 + 2*m'],
    ['h', 'h'],
  ], true);
  expectPairs([
    ['2m + 3', '5'],
    ['2m + 3', '5 m'],
    ['3 + 2 m', '5'],
    ['5m', '5n'],
    ['m', '5m'],
    ['5 m', 'm'],
    // "2m*5" multiplies two written numbers, so it is an unevaluated
    // product compared as text, the same as "3 m x 4 m" (this row was once
    // true and moved here on purpose; "m*10" above keeps m a variable).
    ['10m', '2m*5'],
  ], false);
});

test('equivalent: percent is a value, not a unit', () => {
  expectPairs([['50%', '.5'], ['12.5%', '1/8'], ['50 %', '0.5']], true);
  expectPairs([['50%', '50'], ['0.5%', '0.5']], false);
});

test('equivalent: thousands commas and unicode operators', () => {
  expectPairs([
    ['1,000', '1000'],
    ['1,000.5', '1000.5'],
    ['3' + TIMES + '4', '3*4'],
    ['6' + DIVIDE + '2', '3'],
    [HALF, '0.5'],
    ['1' + HALF, '3/2'],
    [ROOT + '16', '4'],
  ], true);
  // A product of two plain numbers is a size, never its value.
  expectPairs([['3' + TIMES + '4', '12']], false);
});

test('equivalent: x, X and the middle dot between digits mean times', () => {
  expectPairs([
    ['3 x 10^4', '3' + TIMES + '10^4'],
    ['3 x 10^4', '30000'],
    ['3' + TIMES + '10^4', '30000'],
    ['3 X 10' + SUP4, '30000'],
    ['4.5 x 10^-3', '0.0045'],
    ['2 x 3', '2*3'],
    ['2X3', '2' + TIMES + '3'],
    ['2 x ' + HALF, '2*1/2'],
    ['3' + MIDDOT + '4', '3*4'],
    ['2' + MIDDOT + 'x', '2x'],
    ['2x+6', '2(x+3)'],
  ], true);
  expectPairs([
    ['2 x 3', '5'],
    ['2x', '2'],
    ['x^2', '2x'],
    ['4.5 x 10^-3', '0.045'],
    // Reversed on purpose. These were once true, which let a size key like
    // "3 x 4" accept 12, and so also "2 x 6". A product of plain numbers is
    // now compared as text; only a x 10^k is still evaluated.
    ['2 x 3', '6'],
    ['2X3', '6'],
    ['2 x ' + HALF, '1'],
    ['3' + MIDDOT + '4', '12'],
  ], false);
});

test('equivalent: a product of plain numbers is compared as text, never by value', () => {
  expectPairs([
    ['3 x 4', '3' + TIMES + '4'],
    ['3 x 4', '3 * 4'],
    ['3 x 4', '3' + MIDDOT + '4'],
    ['3 X 4', '3x4'],
    ['3 * 4', '3' + TIMES + '4'],
    ['2 x 3 x 4', '2*3*4'],
    ['3 ft x 4 ft', '3 FT X 4 FT'],
    // Scientific notation stays a value.
    ['3 x 10^4', '30000'],
    ['3 x 10^4', '3 * 10^4'],
    ['3' + TIMES + '10^-2', '0.03'],
  ], true);
  expectPairs([
    ['3 x 4', '12'],
    ['3 x 4', '2 x 6'],
    ['3x4', '1x12'],
    ['3 x 4', '4 x 3'],
    ['2 x 3', '6'],
    [HALF + ' x 4', '2'],
    ['3 x 10', '30'],
    ['2 x 3 x 10^4', '60000'],
    // The letter-product path: letters between the numbers change nothing.
    ['3 ft x 4 ft', '2 ft x 6 ft'],
    ['3 by 4', '2 by 6'],
    ['3 cm ' + TIMES + ' 4 cm', '2 cm ' + TIMES + ' 6 cm'],
    ['3m ' + TIMES + ' 4m', '2m ' + TIMES + ' 6m'],
    ['3 m x 4 m', '2 m x 6 m'],
  ], false);
});

test('gradeSlip: a size key does not accept another size with the same area', () => {
  const key = { questions: [{ answer: '3 x 4', points: 1 }, { answer: '12', points: 1 }] };
  const r = gradeSlip({
    key,
    reading: reading('Pat Fixture', ['2 x 6', '3 x 4']),
    review: reading('Pat Fixture', ['2 x 6', '3 x 4']),
  });
  assert.deepEqual(r.answers.map((a) => a.correct), [false, false]);
  assert.equal(r.score, 0);
});

test('equivalent: a comma inside a pair or a list is kept', () => {
  expectPairs([
    ['(1,120)', '(1, 120)'],
    ['(3,4)', '(3, 4)'],
    ['x = 2, 100', 'x = 2 , 100'],
    ['$1,200', '1200'],
    ['1,000.5 km', '1000.5'],
  ], true);
  expectPairs([
    // Parentheses make a pair: "(1,234)" is the point (1, 234), never 1234.
    ['(1,234)', '(1234)'],
    ['(1,120)', '1120'],
    ['x = (1,120)', '1120'],
    // A list after "x =" keeps its comma, so "x = 2, 100" is not 2100.
    ['x = 2, 100', '2100'],
    ['x = 1,000, 2', '1000'],
    // Reversed on purpose: this once read "x = 2,100" as a list. Its body is
    // one number, the same shape as "x = 1,000", so it is now x = 2100 and
    // no longer matches the list "x = 2, 100".
    ['x = 2,100', 'x = 2, 100'],
  ], false);
  expectPairs([['x = 2,100', '2100']], true);
});

test('equivalent: the comma rule reads the body after a leading "x ="', () => {
  assert.equal(normalize('x = 1,000'), 'x = 1000');
  assert.equal(normalize('X=1,000'), 'x=1000');
  assert.equal(normalize('= 1,000'), '= 1000');
  assert.equal(normalize('x = $1,200.50'), 'x = $1200.50');
  assert.equal(normalize('x = (1,120)'), 'x = (1,120)');
  assert.equal(normalize('x = 1,000, 2'), 'x = 1,000, 2');
  expectPairs([
    ['x = 1,000', '1000'],
    ['x = 1,000', '1,000'],
    ['x = 1,000', 'x=1000'],
    ['n = 1,000', '1000'],
    ['y = 12,500', '12500'],
    ['x = 2,000 m', '2000'],
    ['x = -1,500', '-1500'],
  ], true);
  expectPairs([
    ['x = 1,000', 'y = 1000'],
    ['x = 1,000', '100'],
    ['(1,120)', '1120'],
    ['x = (1,120)', '1120'],
    ['x = 2, 100', '2100'],
  ], false);
});

test('equivalent: algebra at sample points', () => {
  expectPairs([
    ['(x+1)(x-1)', 'x^2-1'],
    ['x' + SQUARED + '+2x', 'x(x+2)'],
    ['2xy', '2yx'],
    ['a+b', 'b+a'],
    ['2xy^2', '2x y^2'],
    [PI + 'r' + SQUARED, 'pi r^2'],
    ['pir^2', 'pi r^2'],
    ['sqrt(x^2)', 'abs(x)'],
    ['sqrt(x)', 'x^(1/2)'],
    ['x/2', '0.5x'],
    ['x', '1x'],
  ], true);
  expectPairs([
    ['x+1', 'x+2'],
    ['2x', 'x^2'],
    ['2xy^2', '2x^2y^2'],
    ['sqrt(x^2)', 'x'],
    ['x+y', 'x+z'],
    ['2x', '2'],
  ], false);
});

test('equivalent: non-string inputs', () => {
  assert.equal(equivalent(5, '5'), true);
  assert.equal(equivalent(0.5, '1/2'), true);
  assert.equal(equivalent({}, 'x'), false);
  assert.equal(equivalent([], []), false);
});

test('equivalent: math.js functions and structures are never evaluated', () => {
  const hostile = [
    'import({}, {})',
    'createUnit("foo")',
    'evaluate("1+1")',
    'parse("2")',
    'a.constructor',
    'f(x) = x',
    'x = 2; x',
    '[1, 2]',
    '{a: 2}',
    'x ? 2 : 2',
    '1:3',
    '"2"',
    "'2'",
    '2 == 2',
    '10 % 4',
    '0x02',
    'cos(0)',
  ];
  for (const h of hostile) {
    assert.equal(equivalent(h, '2'), false, h);
    assert.equal(equivalent('2', h), false, h);
    assert.equal(equivalent(h, h), true, `${h} equals itself as text`);
  }
});

test('equivalent: non-finite results are rejected, not compared', () => {
  expectPairs([
    ['1e400', '2e400'],
    ['1/0', '2/0'],
    ['9^9^9', '9^9^9^9'],
    ['sqrt(-1)', 'sqrt(-4)'],
  ], false);
});

test('equivalent: pathological input stays fast and never throws', () => {
  const longSum = Array(150).fill('0').join('+') + '+1';   // over 200 chars
  assert.ok(longSum.length > 200);
  assert.equal(equivalent(longSum, '1'), false, 'over the cap: compared as text');
  assert.equal(equivalent(longSum, longSum), true);

  const started = Date.now();
  assert.equal(equivalent('('.repeat(100000), '1'), false);
  assert.equal(equivalent('1+'.repeat(50000) + '1', '50001'), false);
  assert.equal(equivalent('x'.repeat(100000), 'x'), false);
  assert.equal(equivalent('('.repeat(99) + '1' + ')'.repeat(99), '1'), true);
  assert.equal(equivalent('(('.repeat(99) + '1' + '))'.repeat(99), '1'), false);
  assert.equal(equivalent('5' + ' cm'.repeat(20000), '5'), false);
  assert.ok(Date.now() - started < 2000, 'pathological inputs took too long');
});

test('equivalent: returns a boolean for random junk (seeded)', () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const alphabet = '0123456789xyz+-*/^()=.,% $abc' + MINUS + HALF + SQUARED + PI + ROOT + DEG;
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rand() * 20);
    let a = '';
    let b = '';
    for (let j = 0; j < len; j++) {
      a += alphabet[Math.floor(rand() * alphabet.length)];
      b += alphabet[Math.floor(rand() * alphabet.length)];
    }
    const r = equivalent(a, b);
    assert.equal(typeof r, 'boolean');
    assert.equal(r, equivalent(b, a), `symmetry: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

// ---------------------------------------------------------- regression tests
// Each test below failed before its fix and passes after it.

test('equivalent: two or more plain numbers joined by dashes compare as written, never subtracted', () => {
  expectPairs([
    // Fraction and mixed-number bounds were subtracted: every pair is -1/4 or -1/2.
    ['1/2-3/4', '1/4-1/2'],
    ['1/4-1/2', '3/4-1'],
    ['1 1/2-2', '2-2 1/2'],
    ['1/2' + EN_DASH + '1', '1' + EN_DASH + '1 1/2'],
    ['2 1/2-3', '3-3 1/2'],
    [HALF + '-1', '1-1' + HALF],
    // Three or more numbers: a record or a triple, never a chain subtraction.
    ['10-4-2', '8-2-2'],
    ['3-4-5', '1-2-5'],
    ['3-4-5', '4-5-5'],
    ['1-2-3', '0-1-3'],
    ['1/2-3/4', '-1/4'],
    ['10-4-2', '4'],
  ], false);
  expectPairs([
    ['1/2-3/4', '1/2 - 3/4'],
    ['1/2-3/4', '1/2' + EN_DASH + '3/4'],
    ['1 1/2-2', '1 1/2 - 2'],
    [HALF + '-1', '1/2-1'],
    ['1' + HALF + '-2', '1 1/2-2'],
    ['10-4-2', '10 - 4 - 2'],
    ['3-4-5', '3' + EN_DASH + '4' + EN_DASH + '5'],
  ], true);
});

test('equivalent: a fraction glyph is one fraction in parentheses', () => {
  assert.equal(normalize('9^' + HALF), '9^(1/2)');
  assert.equal(normalize('1' + HALF), '1+1/2');
  assert.equal(normalize(HALF + 'h'), '(1/2)h');
  // Right answers the bare expansion marked wrong.
  expectPairs([
    ['9^' + HALF, '3'],
    ['x^' + HALF, 'sqrt(x)'],
    ['3' + DIVIDE + HALF, '6'],
    [THREE_QUARTERS + SQUARED, '9/16'],
    [ROOT + QUARTER, '1/2'],
    ['1/' + HALF, '2'],
    ['2/' + THIRD, '6'],
    ['27^' + THIRD, '3'],
    [HALF + DIVIDE + HALF, '1'],
    // Spaced, the glyph is still a number with a unit: half an hour.
    [HALF + ' h', '0.5'],
    ['2 x ' + HALF, '2*1/2'],
  ], true);
  // Wrong answers it marked right.
  expectPairs([
    ['9^' + HALF, '4.5'],
    ['x^' + HALF, 'x/2'],
    ['3' + DIVIDE + HALF, '1.5'],
    [THREE_QUARTERS + SQUARED, '3/16'],
    [ROOT + QUARTER, '1/4'],
    [ROOT + HALF, '1/2'],
    ['1/' + HALF, '0.5'],
    ['2/' + THIRD, '2/3'],
    ['x^' + TWO_THIRDS, 'x^2/3'],
    [HALF + DIVIDE + HALF, '0.25'],
    // Against its letter the glyph is half of h, g or m, never a spaced unit.
    [HALF + 'h', '0.5'],
    [HALF + 'g', '0.5'],
    [HALF + 'm', '1/2'],
  ], false);
});

test('equivalent: a run of superscripts is one exponent', () => {
  assert.equal(normalize('2' + SUP5 + SUP_MINUS + SUP3), '2^(5-3)');
  assert.equal(normalize('x' + SQUARED), 'x^2');
  assert.equal(normalize('10' + SUP_NEG13), '10^-13');
  expectPairs([
    ['2' + SUP5 + SUP_MINUS + SUP3, '4'],
    ['x' + SUP5 + SUP_MINUS + SUP3, 'x^2'],
  ], true);
  expectPairs([
    ['2' + SUP5 + SUP_MINUS + SUP3, '29'],
    ['x' + SUP5 + SUP_MINUS + SUP3, 'x^5-3'],
  ], false);
});

test('equivalent: a function name compares as written, never as a product of letters', () => {
  expectPairs([
    ['log(3x)', '3log(x)'],
    ['sin(2x)', '2sin(x)'],
    ['log(x)-log(y)', 'log(x-y)'],
    ['log(6)', 'log(4)+log(2)'],
    ['cos(-x)', '-cos(x)'],
    ['tan(a+b)', 'tan(a)+tan(b)'],
    ['sin(a+b)', 'sin(a)+sin(b)'],
    ['ln(2x)', '2ln(x)'],
    ['exp(2x)', '2exp(x)'],
    ['log(xx)', 'x log(x)'],
    ['tan(16-27)', 'tan(16)-tan(27)'],
    ['sec(2x)', '2sec(x)'],
    ['lnx', 'l*n*x'],
  ], false);
  expectPairs([
    ['sin(2x)', 'SIN(2x)'],
    ['log(3x)', 'log (3x)'],
    // sqrt and abs still evaluate.
    ['sqrt(x)', 'x^(1/2)'],
    ['abs(x)', 'sqrt(x^2)'],
  ], true);
});

test('equivalent: algebra is sampled over both signs and larger values, and a constant cannot swamp it', () => {
  expectPairs([
    ['abs(x+2)', 'x+2'],
    ['abs(x-3)', '3-x'],
    ['sqrt((x+2)^2)', 'x+2'],
    ['abs(x+1.4)', 'x+1.4'],
    ['abs(x)+abs(y)', 'abs(x+y)'],
    ['x^2 + 10^10', 'x + 10^10'],
    ['2x + 10000000000', 'x + 10000000000'],
    ['x^2 + 10^14', 'x + 10^14'],
    ['2x + 10^15', 'x + 10^15'],
    ['sqrt(x^2)', 'x'],
    // Guards for the second variable: the pairs must include both negative.
    ['sqrt(x)*sqrt(y)', 'sqrt(xy)'],
    ['sqrt(x/y)', 'sqrt(x)/sqrt(y)'],
  ], false);
  expectPairs([
    ['2x+6', '2(x+3)'],
    ['abs(x+2)', 'sqrt((x+2)^2)'],
    ['((6mg)/28+8/x)^' + HALF, '(8/x+(6mg)/28)^' + HALF],
    ['x^2 + 10^10', '10^10 + x*x'],
    ['(x+y)^2', 'x^2 + 2xy + y^2'],
    // A root beside a sample point: a fixed share of the value would call
    // these different; the rounding bound does not.
    ['(x-12)(x-11)', 'x^2-23x+132'],
    ['(x-5)(x-6)', 'x^2-11x+30'],
    ['(x-0.37)^2', 'x^2-0.74x+0.1369'],
    ['x^3-6x^2+11x-6', '(x-1)(x-2)(x-3)'],
  ], true);
});

test('equivalent: computed values meet within float noise; past 2^53 they compare as written', () => {
  expectPairs([
    ['2^64 - 1', '2^64'],
    ['2^64', '18446744073700000000'],
    ['10^18 + 10^8', '10^18'],
    ['2^53 + 1', '2^53'],
    ['999999999/2', '500000000'],
    ['1000000000 + 0.5', '1000000000'],
    ['22/7', '3.142857146'],
    ['1/3', '0.3333333333'],
    ['663/18', '36.83333335'],
    ['799/205', '3.897560975610'],
    ['634273781480323', '(1268547562960647)/2'],
    ['5.29+4799^3', '5.291 + 4799^3'],
  ], false);
  expectPairs([
    ['0.1+0.2', '0.3'],
    ['6.02 x 10^23', '602,000,000,000,000,000,000,000'],
    ['1/3', '2/6'],
    ['sqrt(2)*sqrt(2)', '2'],
    ['10^9 + 1', '1,000,000,001'],
    ['2^52 + 1', '4503599627370497'],
    ['6.4/10^13', '6.4 x 10^-13'],
  ], true);
});

test('equivalent: a thousands group never starts with 0', () => {
  assert.equal(normalize('0,500'), '0,500');
  assert.equal(normalize('0,001'), '0,001');
  assert.equal(normalize('x = 0,500'), 'x = 0,500');
  assert.equal(normalize('1,000'), '1000');
  expectPairs([
    ['0,500', '500'],
    ['0,001', '1'],
    ['x = 0,500', '500'],
    ['-0,250', '-250'],
    ['00,100', '100'],
    ['0', '0,000'],
    ['741', '0,741'],
    [' 0983', ' 0,983'],
  ], false);
});

test('equivalent: a percent sign is a value only as one trailing % on a plain number', () => {
  expectPairs([
    ['200 + 10%', '220'],
    ['200 + 10%', '200.1'],
    ['x + 20%', '1.2x'],
    ['(100) - 20%', '80'],
    ['0 + 115%', '0'],
    ['15+(x-100%)', '15-(x-100%)'],
    ['5% (1+2', '0.05'],
    ['x%+', 'x/100'],
    ['10%+*5', '0.5'],
    ['(0 + 54%) * 3', '(0 + 54%) * 30'],
    ['x - x - 102%', 'x - x - 103%'],
  ], false);
  expectPairs([
    ['50%', '0.5'],
    ['12.5%', '1/8'],
    ['-50%', '-0.5'],
    ['50 %', '1/2'],
    ['200 + 10%', '200+10%'],
  ], true);
});

test('equivalent: a step that is not a number leaves the answer with no value', () => {
  expectPairs([
    ['5/(1/0)', '0'],
    ['sqrt(-1)^0', '1'],
    ['(1/0)^0', '1'],
    ['96.802/((7/9)/0)', '96.802/((8/9)/0)'],
    ['sqrt(14 - 39.667) ^ 0', '(14 - 39.667) ^ 0'],
    ['sqrt(x)^0', 'x ^ 0'],
    ['(sqrt(x) * 3) ^ 0', '(x*3)^0'],
  ], false);
});

test('equivalent: calculator E-notation compares as written', () => {
  expectPairs([
    ['2e3', '2000'],
    ['2e+3', '2000'],
    ['2E+3', '2000'],
    ['4e-5', '0.00004'],
    ['4e+5', '400000'],
    ['5.2 x 10^3', '5.2e3'],
    ['2e-3', '0.002'],
  ], false);
  // As written: e is a variable, so "2e-3" is 2e - 3 either way it is spaced.
  expectPairs([['2e3', '2E3'], ['2e-3', '2e - 3']], true);
});

test('equivalent: the text fallback keeps the spaces beside a single decimal point', () => {
  expectPairs([
    ['1 .5', '1.5'],
    ['1 4 .7', '1 4.7.'],
    ['1. 5', '1.5'],
  ], false);
  expectPairs([
    ['0.333 ...', '0.333...'],
    ['x > 3', 'x>3'],
    ['1 .5', '1  .5'],
  ], true);
});

test('equivalent: "v =" is stripped only when v is not in the rest; an equation matches only an equation', () => {
  expectPairs([
    ['x = 2x + 3', '2x+3'],
    ['x = x', 'x'],
    ['y = y^2', 'y^2'],
    ['x = 2x + 3', 'y = 2x + 3'],
    ['x = 2x + 3', 'x = 2x + 4'],
  ], false);
  expectPairs([
    ['x = 4', '4'],
    ['y = 2x + 3', '2x+3'],
    ['t = 5 feet', '5 ft'],
    ['h = 3 h', '3'],
    ['p = 2pi', '2pi'],
    ['s = abs(-3)', '3'],
    ['x = 2x + 3', 'x = 3 + 2x'],
    ['x = 8yx', 'x = 8xy'],
  ], true);
});

test('equivalent: a written number past the exact range compares as written, never as 0', () => {
  expectPairs([
    ['0', '10^-401'],
    ['0', '1 x 10^-500'],
    ['10^-401', '10^-402'],
    // A computed underflow is not 0 either.
    ['1/10^200/10^200', '0'],
  ], false);
  expectPairs([
    ['10^-401', '10^-401'],
    ['1 x 10^-500', '1 ' + TIMES + ' 10^-500'],
  ], true);
});

// ----------------------------------------------------- more regression tests
// Each test below failed before its fix and passes after it.

test('equivalent: a mixed-number or glyph percent is a value', () => {
  expectPairs([
    ['12' + HALF + '%', '12 1/2%'],
    ['12' + HALF + '%', '12.5%'],
    ['12 1/2%', '12.5%'],
    ['12 1/2%', '0.125'],
    ['12' + HALF + '%', '0.125'],
    ['33' + THIRD + '%', '1/3'],
    ['33 1/3%', '1/3'],
    ['(50%)', '0.5'],
    ['-12' + HALF + '%', '-0.125'],
    [HALF + '%', '0.5%'],
  ], true);
  // Still a value, so still not the bare number, and not money.
  expectPairs([
    ['12' + HALF + '%', '12.5'],
    ['33 1/3%', '33 1/3'],
    ['(50%)', '50'],
    ['12' + HALF + '%', '1/4'],
  ], false);
});

test('equivalent: function answers that differ only by spaces or * match, and never evaluate', () => {
  expectPairs([
    ['2sin(x)', '2 sin(x)'],
    ['2sin(x)', '2*sin(x)'],
    ['2 sin(x)', '2*sin(x)'],
    ['3log(x)', '3 log(x)'],
    ['sin(2x)', 'sin(2 x)'],
    ['xln(x)', 'x ln(x)'],
    ['x*ln(x)', 'x ln(x)'],
  ], true);
  expectPairs([
    // Never a product of letters.
    ['2sin(x)', '2 s i n(x)'],
    ['2 sin(x)', '2*s*i*n*x'],
    // Two digits keep their space or *: 23 is not 2 times 3.
    ['2 3sin(x)', '23sin(x)'],
    ['2*3sin(x)', '23sin(x)'],
    // A * before a sign stays: sin(x) times -1 is not sin(x) - 1.
    ['sin(x)*-1', 'sin(x)-1'],
    ['sin(2x)', '2sin(x)'],
  ], false);
});

test('equivalent: in the as-written comparison a fraction glyph and a/b are the same text', () => {
  expectPairs([
    ['x > ' + HALF, 'x > 1/2'],
    ['x ' + LE + ' -' + THREE_QUARTERS, 'x ' + LE + ' -3/4'],
    ['(' + HALF + ', 2)', '(1/2, 2)'],
    [THIRD + ' cup flour', '1/3 cup flour'],
    [HALF + '%', '1/2%'],
  ], true);
  // Where parentheses change the reading they stay.
  expectPairs([
    ['x > 2^' + HALF, 'x > 2^1/2'],
    ['x > 3/' + HALF, 'x > 3/1/2'],
    ['x > ' + HALF + '^2', 'x > 1/2^2'],
    ['x > 2^-' + HALF, 'x > 2^-1/2'],
    ['x > ' + HALF, 'x > 1/3'],
  ], false);
});

test('equivalent: an answer defined only near zero still gets three sample points', () => {
  expectPairs([
    ['2sqrt(4-x^2)', 'sqrt(16-4x^2)'],
    ['sqrt(4x-x^2)', 'sqrt(x(4-x))'],
    ['sqrt(3-x^2)*2', 'sqrt(12-4x^2)'],
    ['(x-y)^(1/2)', 'sqrt(x-y)'],
  ], true);
  expectPairs([
    ['sqrt(4-x^2)', 'sqrt(4-x^4)'],
    ['sqrt(x-y)', 'sqrt(y-x)'],
  ], false);
});

test('equivalent: a percent never matches a side that carries a unit', () => {
  expectPairs([
    ['$0.25', '25%'],
    ['$0.05', '5%'],
    ['25%', '$0.25'],
    ['0.5 m', '50%'],
    ['0.5 cm', '50%'],
  ], false);
  // Each still matches its bare value.
  expectPairs([['$0.25', '0.25'], ['25%', '0.25'], ['25%', '1/4']], true);
});

test('equivalent: a range whose bounds all carry the same unit is a range, compared as written', () => {
  expectPairs([
    ['10 s - 20 s', '20 s - 30 s'],
    ['1 m - 2 m', '3 m - 4 m'],
    ['2 m ' + EN_DASH + ' 3 m', '4 m ' + EN_DASH + ' 5 m'],
    ['$5 - $10', '$10 - $15'],
    ['2 m - 3 m', '-m'],
    ['10 s - 20 s', '10 g - 20 g'],
  ], false);
  expectPairs([
    ['10 s - 20 s', '10-20'],
    ['10 s - 20 s', '10 s ' + EN_DASH + ' 20 s'],
    ['1 m - 2 m', '1 meter - 2 meters'],
    ['5 cm - 10 cm', '5-10 cm'],
  ], true);
});

test('equivalent: the sample points reach far enough to see a kink away from zero', () => {
  expectPairs([
    ['abs(x+8)', 'x+8'],
    ['abs(x-25)', '25-x'],
    ['abs(x-30)', '30-x'],
    ['sqrt((x+8)^2)', 'x+8'],
    ['abs(2x+20)', '2x+20'],
  ], false);
  expectPairs([
    ['abs(x+8)', 'sqrt((x+8)^2)'],
    ['(x-30)^2', 'x^2-60x+900'],
  ], true);
});

test('equivalent: numbers side by side are a product, compared as written; a mixed number still evaluates', () => {
  expectPairs([
    [HALF + ' ' + HALF, '1/4'],
    [HALF + ' ' + THREE_QUARTERS, '3/8'],
    [HALF + ' 6', '3'],
    [HALF + HALF, '1/4'],
    // A fraction is a written number wherever it multiplies another one, as
    // "12(3)x" against 36x already was: a size with a fraction side never
    // equals another size of the same area. The cost, named: an unevaluated
    // fraction coefficient ("12(3/4)x" against 9x) is refused too.
    [HALF + ' ft ' + TIMES + ' 8 ft', QUARTER + ' ft ' + TIMES + ' 16 ft'],
    ['12(3/4)x', '9x'],
  ], false);
  expectPairs([
    ['1 ' + HALF, '3/2'],
    ['1 1/2', '1.5'],
    ['6' + HALF, '6.5'],
    [HALF + ' ' + HALF, HALF + ' ' + HALF],
  ], true);
});

test('equivalent: a function word glued to letters is still a function word', () => {
  expectPairs([
    ['yln(x)', 'xln(y)'],
    ['aln(5)', 'aln(2)+aln(3)'],
    ['kln(x)', 'xln(k)'],
    ['xlg(y)', 'ylg(x)'],
    ['piln(x)', 'xln(pi)'],
  ], false);
  expectPairs([['xln(x)', 'x ln(x)'], ['yln(x)', 'y ln(x)']], true);
});

// Pairs of DIFFERENT math values that a careless rule could equate. A wrong
// answer marked right is invisible to the teacher, so every row must be false.
const FALSE_POSITIVES = {
  'dropped variable': [
    ['5m', '5'],
    ['8h', '8'],
    ['7s', '7'],
    ['4g', '4'],
    ['3l', '3'],
    ['-2m', '-2'],
    ['y = 5m', '5'],
    ['2x', '2'],
    ['3xy', '3x'],
    ['4ab', '4'],
    ['2pi', '2'],
    ['x^2', 'x'],
  ],
  'units of different kinds': [
    ['5 m', '5 cm'],
    ['5 m', '5 mi'],
    ['5 kg', '5 lb'],
    ['5 g', '5 kg'],
    ['5 ft', '5 in'],
    ['5 m^2', '5 m'],
    ['5 cm^3', '5 cm' + SQUARED],
    ['5 min', '5 h'],
    ['5 hr', '5 min'],
    ['2.5 L', '2.5 ml'],
    ['$5', '5 cents'],
    ['5 mph', '5 kph'],
    ['90' + DEG, '90%'],
    ['12m', '12 min'],
    ['5m', '5 g'],
  ],
  'product vs value': [
    ['3 x 4', '12'],
    ['2 x 3', '6'],
    ['3' + TIMES + '4', '12'],
    ['3' + MIDDOT + '4', '12'],
    ['2 x ' + HALF, '1'],
    ['3 x 10', '30'],
    ['2 x 3 x 4', '24'],
    ['3 x 4', '2 x 6'],
    ['3x4', '1x12'],
    ['3 ft x 4 ft', '2 ft x 6 ft'],
    ['3 ft x 4 ft', '12 ft'],
    ['3 by 4', '2 by 6'],
    ['3 by 4', '12'],
    ['3 cm ' + TIMES + ' 4 cm', '2 cm ' + TIMES + ' 6 cm'],
    ['3 m ' + TIMES + ' 4 m', '2 m ' + TIMES + ' 6 m'],
    ['5 ft 3 in', '3 ft 5 in'],
    ['2 h 30 min', '30 h 2 min'],
  ],
  'reordered': [
    ['(1,2)', '(2,1)'],
    ['(3, -4)', '(-4, 3)'],
    ['(1,120)', '(120,1)'],
    ['x = 1, y = 2', 'x = 2, y = 1'],
    ['2/3', '3/2'],
    ['2^3', '3^2'],
    ['x - y', 'y - x'],
    // Ordered, as a matrix size: 3 x 4 and 4 x 3 differ.
    ['3 x 4', '4 x 3'],
  ],
  'sign slip': [
    ['-3', '3'],
    ['-1/2', '1/2'],
    ['1/2', '1/-2'],
    ['x - 3', 'x + 3'],
    ['-(x+1)', '-x+1'],
    ['-2x', '2x'],
    ['-$5', '$5'],
    ['-5 m', '5 m'],
    ['-3^2', '(-3)^2'],
    ['-3 x 4', '3 x 4'],
  ],
  'percent vs value': [
    ['50%', '50'],
    ['5%', '5'],
    ['0.5%', '0.5'],
    ['50%', '5'],
    ['100%', '100'],
    ['12.5%', '12.5'],
    ['50%', '0.05'],
  ],
  'commas and assignments': [
    ['1,000', '1.000'],
    ['(1,120)', '1120'],
    ['x = (1,120)', '1120'],
    ['x = 2, 100', '2100'],
    ['1,000, 2,000', '1000'],
    ['x = 1,000', 'y = 1000'],
  ],
  'close but not equal': [
    ['0.333', '1/3'],
    ['3.14', 'pi'],
    ['1.414', 'sqrt(2)'],
    ['3.05', '3.5'],
  ],
  // The first seven rows are the reported cases; the rest are new.
  'ranges and scores': [
    ['70-79', '80-89'],
    ['10-19', '20-29'],
    ['0-9', '10-19'],
    ['70' + EN_DASH + '79', '80' + EN_DASH + '89'],
    ['70' + EN_DASH + '79', '60' + EN_DASH + '69'],
    ['12-14', '11-13'],
    ['3-2', '2-1'],
    ['3-2', '1'],
    ['70-79', '-9'],
    ['70-79', '79-70'],
    ['90-100', '80-90'],
    ['0.5-1.5', '1.5-2.5'],
    ['70 - 79', '80 - 89'],
    ['70-79%', '80-89%'],
    ['5-10 cm', '6-11 cm'],
    ['-5-5', '-4-6'],
    ['10-3', '7'],
    ['21-14', '14-7'],
    ['70' + FIG_DASH + '79', '80' + NB_HYPHEN + '89'],
  ],
  // The first seven rows are the reported cases (the last two of them were
  // already false above an old 1e-12 floor); the rest are new.
  'tiny magnitudes': [
    ['6.4 x 10^-13', '6.4 x 10^-14'],
    ['6.4 x 10^-13', '0'],
    ['9.11 x 10^-31', '1.67 x 10^-27'],
    ['9.11 x 10^-31 kg', '1.67 x 10^-27 kg'],
    ['6.4 ' + TIMES + ' 10' + SUP_NEG13, '0'],
    ['1 x 10^-12', '0'],
    ['5 x 10^-10', '5 x 10^-11'],
    ['1 x 10^-15', '1 x 10^-16'],
    ['1.6 x 10^-19', '0'],
    ['6.4/10^13', '6.4/10^14'],
    ['1/10^13', '0'],
    ['1 x 10^-20', '-1 x 10^-20'],
    ['0.000000000000001', '0.000000000000002'],
    ['6.63 x 10^-34', '6.63 x 10^-43'],
  ],
  // The first four rows are the reported cases (the fourth was already
  // false); the rest are new.
  'huge whole numbers': [
    ['4,567,891,230', '4,567,891,234'],
    ['1,000,000,000', '1,000,000,001'],
    ['2,345,678,900', '2,345,678,902'],
    ['2.5 x 10^9', '2,500,000,003'],
    ['10^9 + 1', '10^9'],
    ['4567891230/1', '4567891234'],
    ['12,345,678,901', '12,345,678,900'],
    ['602,000,000,000,000,000,000,000', '602,000,000,000,000,100,000,000'],
    ['6.02 x 10^23', '6.03 x 10^23'],
    ['9,007,199,254,740,993', '9,007,199,254,740,992'],
  ],
  // The first two rows are the reported cases; the rest are new.
  'ellipses and repeating decimals': [
    ['0.333...', '0.333'],
    ['0.666...', '0.666'],
    ['0.333...', '1/3'],
    ['0.333' + ELLIPSIS, '0.333'],
    ['0.142857...', '0.142857'],
    ['0.1666...', '0.1666'],
    ['0.333...', '0.666...'],
    ['3.14...', '3.14'],
    ['yes...', 'yes'],
  ],
  'money': [
    ['$1.50', '$1.05'],
    ['$0.50', '$0.05'],
    ['$10.00', '$100'],
    ['$1,000.50', '$1,000.05'],
    ['$19.99', '$19.90'],
  ],
  // Reported cases, then new rows. The named limits in the grade.js header
  // (form, a one-sided multi-letter unit, case) are not fixed and are not in
  // this table.
  'fraction ranges and dash chains': [
    ['1/2-3/4', '1/4-1/2'],
    ['1/4-1/2', '3/4-1'],
    ['1 1/2-2', '2-2 1/2'],
    ['1/2' + EN_DASH + '1', '1' + EN_DASH + '1 1/2'],
    ['2 1/2-3', '3-3 1/2'],
    [HALF + '-1', '1-1' + HALF],
    ['10-4-2', '8-2-2'],
    ['3-4-5', '1-2-5'],
    ['3-4-5', '4-5-5'],
    ['1-2-3', '0-1-3'],
    ['1/2-3/4', '-1/4'],
    ['10-4-2', '4'],
  ],
  'fraction glyphs': [
    ['9^' + HALF, '4.5'],
    ['x^' + HALF, 'x/2'],
    ['3' + DIVIDE + HALF, '1.5'],
    [THREE_QUARTERS + SQUARED, '3/16'],
    [ROOT + QUARTER, '1/4'],
    [ROOT + HALF, '1/2'],
    [HALF + 'h', '0.5'],
    [HALF + 'g', '0.5'],
    [HALF + 'm', '1/2'],
    ['1/' + HALF, '0.5'],
    ['2/' + THIRD, '2/3'],
    ['27^' + THIRD, '9'],
    ['x^' + TWO_THIRDS, 'x^2/3'],
    [HALF + DIVIDE + HALF, '0.25'],
    ['8.5^' + THIRD, '8.5' + DIVIDE + THIRD],
    ['1.86 ' + DIVIDE + ' ' + QUARTER + ' - 0.45', '1.86*' + QUARTER + '-0.45'],
    [QUARTER + SUP4 + '(26-1640)', '(1/4)^4/(26-1640)'],
  ],
  'superscript runs': [
    ['2' + SUP5 + SUP_MINUS + SUP3, '29'],
    ['x' + SUP5 + SUP_MINUS + SUP3, 'x^5-3'],
  ],
  'function names': [
    ['log(3x)', '3log(x)'],
    ['sin(2x)', '2sin(x)'],
    ['log(x)-log(y)', 'log(x-y)'],
    ['log(6)', 'log(4)+log(2)'],
    ['cos(-x)', '-cos(x)'],
    ['tan(a+b)', 'tan(a)+tan(b)'],
    ['sin(a+b)', 'sin(a)+sin(b)'],
    ['ln(2x)', '2ln(x)'],
    ['exp(2x)', '2exp(x)'],
    ['log(xx)', 'x log(x)'],
    ['tan(16-27)', 'tan(16)-tan(27)'],
    ['sec(2x)', '2sec(x)'],
    ['csc(2x)', '2csc(x)'],
    ['cot(2x)', '2cot(x)'],
    ['lnx', 'l*n*x'],
  ],
  'sample window and swamping': [
    ['abs(x+2)', 'x+2'],
    ['abs(x-3)', '3-x'],
    ['sqrt((x+2)^2)', 'x+2'],
    ['abs(x+1.4)', 'x+1.4'],
    ['x^2 + 10^10', 'x + 10^10'],
    ['2x + 10000000000', 'x + 10000000000'],
    ['14-79380^4+(3/5)/x', '14-79380^4+(3/6)/x'],
    ['x^2 + 10^14', 'x + 10^14'],
    ['2x + 10^15', 'x + 10^15'],
    ['abs(x)+abs(y)', 'abs(x+y)'],
  ],
  'float noise and 2^53': [
    ['2^64 - 1', '2^64'],
    ['2^64', '18446744073700000000'],
    ['10^18', '10^18 + 10^8'],
    ['500000000', '999999999/2'],
    ['22/7', '3.142857146'],
    ['1000000000 + 0.5', '1000000000'],
    ['1/3', '0.3333333333'],
    ['663/18', '36.83333335'],
    ['0.333333333333', '1/3'],
    ['2^53 + 1', '2^53'],
    ['799/205', '3.897560975610'],
    ['634273781480323', '(1268547562960647)/2'],
    ['7552643641910800', '7552643641910800 + 0.5'],
    ['5.29+4799^3', '5.291 + 4799^3'],
  ],
  'leading-zero comma': [
    ['500', '0,500'],
    ['1', '0,001'],
    ['x = 0,500', '500'],
    ['-0,250', '-250'],
    ['00,100', '100'],
    ['0', '0,000'],
    ['741', '0,741'],
    [' 0983', ' 0,983'],
  ],
  'percent inside an expression': [
    ['200.1', '200 + 10%'],
    ['220', '200 + 10%'],
    ['x + 20%', '1.2x'],
    ['(100) - 20%', '80'],
    ['0', '0 + 115%'],
    ['15+(x-100%)', '15-(x-100%)'],
    ['0.05', '5% (1+2'],
    ['x%+', 'x/100'],
    ['10%+*5', '0.5'],
    ['-x^4-(6829*77%)^3', '-4^x-(6829x77%)^3'],
  ],
  'a step that is not a number': [
    ['0', '5/(1/0)'],
    ['1', 'sqrt(-1)^0'],
    ['1', '(1/0)^0'],
    ['96.802/((7/9)/0)', '96.802/((8/9)/0)'],
    ['sqrt(14 - 39.667) ^ 0', '(14 - 39.667) ^ 0'],
    ['sqrt(x)^0', 'x ^ 0'],
  ],
  'E-notation': [
    ['2e+3', '2000'],
    ['2E+3', '2000'],
    ['4e-5', '0.00004'],
    ['4e+5', '400000'],
    ['5.2 x 10^3', '5.2e3'],
    ['0.002', '2e-3'],
    ['2e3', '2000'],
  ],
  'decimal point spacing': [
    ['1.5', '1 .5'],
    ['1 4 .7', '1 4.7.'],
    ['1. 5', '1.5'],
  ],
  'equations': [
    ['2x+3', 'x = 2x + 3'],
    ['x = x', 'x'],
    ['y = y^2', 'y^2'],
  ],
  'past the exact range': [
    ['0', '10^-401'],
    ['0', '1 x 10^-500'],
    ['10^-401', '10^-402'],
    ['1/10^200/10^200', '0'],
  ],
  // More reported cases. The named limits (a spaced one-sided letter unit,
  // "1/2x", float resolution, form) are not fixed and are not in this table.
  'money or a unit against a percent': [
    ['$0.25', '25%'],
    ['$1.25', '125%'],
    ['25%', '$0.25'],
    ['$0.50', '50%'],
    ['$0.05', '5%'],
    ['$0.10', '10%'],
    ['$0.30', '30%'],
    ['$0.08', '8%'],
    ['$0.15', '15%'],
    ['$2.50', '250%'],
    ['$1', '100%'],
    ['0.5 m', '50%'],
  ],
  'ranges with a unit on every bound': [
    ['1 m - 2 m', '3 m - 4 m'],
    ['2 h - 3 h', '5 h - 6 h'],
    ['10 s - 20 s', '20 s - 30 s'],
    ['5 g - 10 g', '10 g - 15 g'],
    ['1 L - 2 L', '3 L - 4 L'],
    ['2 m ' + EN_DASH + ' 3 m', '4 m ' + EN_DASH + ' 5 m'],
    ['10 s ' + EN_DASH + ' 20 s', '20 s ' + EN_DASH + ' 30 s'],
  ],
  'kinks far from zero': [
    ['abs(x+8)', 'x+8'],
    ['abs(x+10)', 'x+10'],
    ['abs(x-25)', '25-x'],
    ['abs(x-30)', '30-x'],
    ['abs(2x+20)', '2x+20'],
    ['sqrt((x+8)^2)', 'x+8'],
    ['abs(x^2 - 1000)', '1000 - x^2'],
    ['sqrt(x^2+16x+64)', 'x+8'],
    ['abs(x-y+27)', 'x-y+27'],
    ['abs(3x+43)', '3x+43'],
    ['sqrt((x-53)^2)', '53-x'],
  ],
  'numbers side by side': [
    [HALF + ' ' + HALF, '1/4'],
    ['3/8', HALF + ' ' + THREE_QUARTERS],
    ['1/2', TWO_THIRDS + ' ' + THREE_QUARTERS],
    ['3', HALF + ' 6'],
    [HALF + HALF, '1/4'],
    ['(1/2)(1/2)', '1/4'],
    // The same rule with letters between: a size with a fraction side.
    [HALF + ' ft ' + TIMES + ' 8 ft', QUARTER + ' ft ' + TIMES + ' 16 ft'],
    [HALF + ' by 8', QUARTER + ' by 16'],
  ],
  'function names glued to letters': [
    ['yln(x)', 'xln(y)'],
    ['aln(5)', 'aln(2)+aln(3)'],
    ['aln(x+1)', 'aln(x)+aln(1)'],
    ['kln(x)', 'xln(k)'],
    ['xlg(y)', 'ylg(x)'],
    ['piln(x)', 'xln(pi)'],
  ],
};

test('equivalent: adversarial table, different values are never equal', () => {
  let rows = 0;
  for (const [kind, pairs] of Object.entries(FALSE_POSITIVES)) {
    for (const [a, b] of pairs) {
      assert.equal(equivalent(a, b), false, `${kind}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      assert.equal(equivalent(b, a), false, `${kind}: ${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
      rows++;
    }
  }
  // A floor, so the table cannot shrink quietly.
  assert.ok(rows >= 291, `the table has ${rows} rows`);
});

// Pairs of the SAME value (or the same answer as written) that a careless
// rule refuses. A right answer marked wrong costs the student, so every row
// must be true, both orders: reported regressions, then guards. The
// by-design refusals (a calculator display against an exact value,
// E-notation, a computed step of 2^53 or more, an unevaluated difference of
// fractions, "1. 5") are named limits in the grade.js header and are not in
// this table.
const ACCEPTED = {
  'mixed-number and glyph percents': [
    ['33 1/3%', '1/3'],
    ['33' + THIRD + '%', '1/3'],
    ['33 1/3 %', '1/3'],
    ['x = 33 1/3%', '1/3'],
    ['66 2/3%', '2/3'],
    ['66' + TWO_THIRDS + '%', '2/3'],
    ['16 2/3%', '1/6'],
    ['83 1/3%', '5/6'],
    ['11 1/9%', '1/9'],
    ['12 1/2%', '0.125'],
    ['12 ' + HALF + ' %', '0.125'],
    ['12' + HALF + '%', '1/8'],
    ['12' + HALF + '%', '12.5%'],
    ['37' + HALF + '%', '3/8'],
    ['37 1/2%', '0.375'],
    ['62 1/2%', '5/8'],
    ['87 1/2%', '7/8'],
    ['3' + HALF + '%', '3.5%'],
    ['3 1/2%', '0.035'],
    ['(50%)', '0.5'],
    ['12 1/2%', '12.5%'],
    ['24' + HALF + '%', '0.245'],
    ['2' + HALF + '%', '2.5%'],
  ],
  'function answers with a space or *': [
    ['2sin(x)', '2 sin(x)'],
    ['3log(x)', '3 log(x)'],
    ['xln(x)', 'x ln(x)'],
    ['2^xln(2)', '2^x ln(2)'],
    ['sin(2x)', 'sin(2 x)'],
    ['2sin(x)', '2*sin(x)'],
  ],
  'fraction glyphs as written': [
    ['x > ' + HALF, 'x > 1/2'],
    ['x ' + LE + ' -' + THREE_QUARTERS, 'x ' + LE + ' -3/4'],
    ['x < ' + THIRD, 'x < 1/3'],
    [HALF + ' < x', '1/2 < x'],
    [HALF + ' ' + LE + ' x ' + LE + ' 1', '1/2 ' + LE + ' x ' + LE + ' 1'],
    ['-' + HALF + ' < x < ' + HALF, '-1/2 < x < 1/2'],
    ['(' + HALF + ', 2)', '(1/2, 2)'],
    ['(-' + HALF + ', ' + THREE_QUARTERS + ')', '(-1/2, 3/4)'],
    ['x = ' + HALF + ', y = 2', 'x = 1/2, y = 2'],
    ['{' + HALF + ', 2}', '{1/2, 2}'],
    [HALF + ', ' + QUARTER, '1/2, 1/4'],
    [HALF + ' : 1', '1/2 : 1'],
    [THIRD + ' cup flour', '1/3 cup flour'],
    [HALF + '%', '1/2%'],
    [QUARTER + '%', '1/4%'],
  ],
  'answers defined only near zero': [
    ['2sqrt(4-x^2)', 'sqrt(16-4x^2)'],
    ['1/sqrt(4-x^2)', '(4-x^2)^(-1/2)'],
    ['sqrt(3-x^2)*2', 'sqrt(12-4x^2)'],
    ['sqrt(4x-x^2)', 'sqrt(x(4-x))'],
    ['(x-y)^(1/2)', 'sqrt(x-y)'],
    ['2sqrt(x-y)', 'sqrt(4x-4y)'],
  ],
  // Guards: answers the fixes above must leave matching.
  'guards': [
    ['y = ' + HALF + 'x + 1', 'y = 0.5x + 1'],
    [HALF + ' hour', '0.5'],
    [HALF + ' + x', 'x + 1/2'],
    ['x ' + GE + ' 1' + HALF, 'x ' + GE + ' 1 1/2'],
    ['1 ' + HALF, '3/2'],
    ['1 1/2', '1.5'],
    [HALF + '%', '0.5%'],
    ['$0.25', '0.25'],
    ['25%', '0.25'],
    ['10 s - 20 s', '10-20'],
    ['5 cm - 10 cm', '5-10 cm'],
    ['$5 - $10', '$5-$10'],
    ['abs(x+8)', 'sqrt((x+8)^2)'],
    ['(x-12)(x-11)', 'x^2-23x+132'],
    ['x^3-6x^2+11x-6', '(x-1)(x-2)(x-3)'],
  ],
};

test('equivalent: accepted table, right answers match in both orders', () => {
  let rows = 0;
  for (const [kind, pairs] of Object.entries(ACCEPTED)) {
    for (const [a, b] of pairs) {
      assert.equal(equivalent(a, b), true, `${kind}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      assert.equal(equivalent(b, a), true, `${kind}: ${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
      rows++;
    }
  }
  // A floor, so the table cannot shrink quietly.
  assert.ok(rows >= 65, `the table has ${rows} rows`);
});

// ----------------------------------------------------------------- exactForm

// Pairs written the same way once case, spacing, look-alike characters, a
// sentence-ending period and a bare decimal point are set aside. Every row
// must match in exact form, both orders.
const EXACT_SAME = [
  // A decimal point with no digit before it gets its zero.
  ['.75', '0.75'],
  ['-.5', '-0.5'],
  ['$.50', '$0.50'],
  ['.5x', '0.5x'],
  // The same zero inside an inequality, an ordered pair, a set or a list,
  // which compare as written.
  ['x > .5', 'x > 0.5'],
  ['x > .5', 'x>0.5'],
  ['.5 < x', '0.5<x'],
  ['(.5, 2)', '(0.5, 2)'],
  ['(.5,.25)', '(0.5,0.25)'],
  ['(-.5, 3)', '(-0.5,3)'],
  ['{.5, 1}', '{0.5,1}'],
  ['x = .5, y = 2', 'x=0.5,y=2'],
  // Case.
  ['X', 'x'],
  ['Yes', 'yes'],
  ['2X+6', '2x+6'],
  // Spacing.
  ['x = 4', 'x=4'],
  ['2x + 6', '2x+6'],
  ['3 (x + 2)', '3(x+2)'],
  ['5 cm', '5cm'],
  ['(3, 4)', '(3,4)'],
  ['0.333 ...', '0.333...'],
  // A sentence-ending period, after a letter, a digit, a closing bracket, a
  // percent sign or the degree sign.
  ['12.', '12'],
  ['Yes.', 'yes'],
  ['75%.', '75%'],
  ['(2, 3).', '(2, 3)'],
  ['3(x+2).', '3(x+2)'],
  ['sqrt(2).', 'sqrt(2)'],
  ['90' + DEG + '.', '90' + DEG],
  ['{1, 2}.', '{1, 2}'],
  // Minus signs and dashes.
  [MINUS + '3', '-3'],
  ['x ' + MINUS + ' 3', 'x-3'],
  ['(3, ' + MINUS + '4)', '(3,-4)'],
  ['70' + EN_DASH + '79', '70-79'],
  // Times and division signs, and x between two digits.
  ['3' + TIMES + '4', '3*4'],
  ['3 x 4', '3*4'],
  ['3' + MIDDOT + '4', '3 * 4'],
  ['3 x 10^4', '3' + TIMES + '10^4'],
  ['6' + DIVIDE + '2', '6/2'],
  // Fraction glyphs read as a/b, and a digit before one as a mixed number.
  [HALF, '1/2'],
  [THREE_QUARTERS, '3/4'],
  ['1' + FRAC_SLASH + '2', '1/2'],
  ['1' + HALF, '1 1/2'],
  ['2 ' + THIRD, '2 1/3'],
  ['x > ' + HALF, 'x > 1/2'],
  [HALF + 'x', '1/2x'],
  ['9^' + HALF, '9^(1/2)'],
  [HALF + '%', '1/2%'],
  // Superscripts.
  ['x' + SQUARED, 'x^2'],
  ['x' + SQUARED + ' + 2x', 'x^2+2x'],
  ['10' + SUP_NEG13, '10^-13'],
  ['6.4 x 10' + SUP_NEG13, '6.4*10^-13'],
  // Inequality signs.
  ['x ' + GE + ' 4', 'x >= 4'],
  ['x ' + LE + ' 5', 'x<=5'],
  ['y ' + NE + ' 0', 'y != 0'],
  // The pi and root signs, and the one-character ellipsis.
  ['2' + PI, '2pi'],
  [ROOT + '16', 'sqrt(16)'],
  ['0.333' + ELLIPSIS, '0.333...'],
  // The same form, digits and all.
  ['3.40', '3.40'],
  ['1,000', '1,000'],
  ['x = 4', 'x = 4'],
  ['75%', '75%'],
  ['3(x+2)', '3(x+2)'],
  ['1 1/2', '1 1/2'],
];

// Pairs in different forms (most of them the same value) and pairs that can
// never match. Every row must be refused in exact form, both orders.
const EXACT_DIFFERENT = [
  // Trailing zeros count.
  ['3.40', '3.4'],
  ['12', '12.0'],
  ['0.75', '0.750'],
  ['$5', '$5.00'],
  // Fraction form counts. The page's hint: 1/2, 0.5 and 2/4 are one value
  // in three forms.
  ['6/8', '3/4'],
  ['1/2', '0.5'],
  ['1/2', '2/4'],
  ['0.5', '2/4'],
  [HALF, '0.5'],
  ['-1/2', '1/-2'],
  // A mixed number is not an improper fraction, a decimal or a sum.
  ['1 1/2', '3/2'],
  ['1' + HALF, '3/2'],
  ['1 1/2', '1.5'],
  ['1 1/2', '1+1/2'],
  // An assignment, a percent sign and a power count.
  ['x = 4', '4'],
  ['y = 2x + 3', '2x+3'],
  ['75%', '0.75'],
  ['50%', '1/2'],
  ['2^4', '16'],
  ['4^2', '2^4'],
  ['x' + SQUARED, 'x*x'],
  ['sqrt(16)', '4'],
  ['9^(1/2)', '3'],
  ['3 x 10^4', '30000'],
  // Expanded, factored and reordered forms count.
  ['3(x+2)', '3x+6'],
  ['2(x+3)', '2x+6'],
  ['(x+1)(x-1)', 'x^2-1'],
  ['x+1', '1+x'],
  ['2xy', '2yx'],
  // Units and thousands commas count.
  ['5 cm', '5'],
  ['5 cm', '5 centimeters'],
  ['$5', '5'],
  ['1,000', '1000'],
  ['x = 1,000', 'x = 1000'],
  // A space between two numerals is part of the answer, so a point after
  // one does not get a zero.
  ['1 1/2', '11/2'],
  ['1 .5', '1.5'],
  ['1 .5', '1 0.5'],
  // An ellipsis is not a sentence-ending period, after any character.
  ['75%...', '75%'],
  ['(2, 3)..', '(2, 3)'],
  ['0.333...', '0.333'],
  // Different values stay different.
  ['3/4', '3/5'],
  ['-3', '3'],
  ['x > 1/2', 'x < 1/2'],
  // An empty answer never matches.
  ['', ''],
  ['', '0'],
  ['   ', '   '],
  [null, null],
  [null, ''],
  [undefined, '0'],
];

test('exactForm: a table of pairs in the same and in different forms, both orders', () => {
  for (const [a, b] of EXACT_SAME) {
    const label = `${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    assert.equal(exactForm(a, b), true, label);
    assert.equal(exactForm(b, a), true, label);
    assert.equal(equivalent(a, b), true, `${label} also matches by value`);
  }
  for (const [a, b] of EXACT_DIFFERENT) {
    const label = `${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    assert.equal(exactForm(a, b), false, label);
    assert.equal(exactForm(b, a), false, label);
  }
  // A floor, so the table cannot shrink quietly.
  assert.ok(EXACT_SAME.length + EXACT_DIFFERENT.length >= 40);
});

test('exactForm: the examples in the page hint and the documented rule', () => {
  // Value: 1/2, 0.5 and 2/4 all count. Exact form: 6/8 does not count for 3/4.
  for (const a of ['1/2', '0.5', '2/4']) {
    for (const b of ['1/2', '0.5', '2/4']) {
      assert.equal(equivalent(a, b), true, `${a} vs ${b} by value`);
      assert.equal(exactForm(a, b), a === b, `${a} vs ${b} in exact form`);
    }
  }
  assert.equal(exactForm('6/8', '3/4'), false);
  assert.equal(exactForm('3/4', '3/4'), true);
  assert.equal(exactForm('.75', '0.75'), true);
  for (const [a, b] of [['3.40', '3.4'], ['1 1/2', '3/2'], ['x = 4', '4'], ['75%', '0.75'],
    ['2^4', '16'], ['3(x+2)', '3x+6']]) {
    assert.equal(equivalent(a, b), true, `${a} vs ${b} by value`);
    assert.equal(exactForm(a, b), false, `${a} vs ${b} in exact form`);
  }
});

test('exactForm: never accepts a pair equivalent() rejects', () => {
  let rows = 0;
  for (const [kind, pairs] of Object.entries(FALSE_POSITIVES)) {
    for (const [a, b] of pairs) {
      assert.equal(exactForm(a, b), false, `${kind}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      assert.equal(exactForm(b, a), false, `${kind}: ${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
      rows++;
    }
  }
  assert.ok(rows >= 291, `the adversarial table has ${rows} rows`);

  // Over every pair in the tables and seeded variants of random junk:
  // exact form implies a match by value, and exact form is symmetric.
  const pairs = [...EXACT_SAME, ...EXACT_DIFFERENT, ...Object.values(ACCEPTED).flat()];
  let seed = 424242;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const alphabet = '0123456789xyz+-*/^()=.,% $ab' + MINUS + HALF + SQUARED + PI + ROOT + TIMES;
  // A variant of s that exact form may call the same: spaces put in, case
  // changed, and look-alikes swapped.
  const variant = (s) => s.split('').map((c) => {
    const r = rand();
    if (r < 0.15) return ' ' + c;
    if (r < 0.25) return c.toUpperCase();
    if (c === '-' && r < 0.6) return MINUS;
    if (c === '*' && r < 0.6) return TIMES;
    return c;
  }).join('');
  for (let i = 0; i < 1500; i++) {
    const len = 1 + Math.floor(rand() * 16);
    let a = '';
    for (let j = 0; j < len; j++) a += alphabet[Math.floor(rand() * alphabet.length)];
    pairs.push([a, variant(a)]);
  }
  let exactPairs = 0;
  for (const [a, b] of pairs) {
    const label = `${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    const ab = exactForm(a, b);
    assert.equal(typeof ab, 'boolean', label);
    assert.equal(ab, exactForm(b, a), `symmetry: ${label}`);
    if (ab) {
      assert.equal(equivalent(a, b), true, `exact form but not value: ${label}`);
      exactPairs++;
    }
  }
  // The variants are not all refused, so the implication is exercised.
  assert.ok(exactPairs >= 200, `${exactPairs} pairs matched in exact form`);
});

// ------------------------------------------------------------------ gradeSlip

const KEY = {
  questions: [
    { answer: '1/2', points: 1 },
    { answer: '-3', points: 1 },
    { answer: '2(x+3)', points: 2 },
    { answer: '5', points: 1 },
  ],
};

function reading(name, answers, note, confidence) {
  return {
    student_name: name,
    answers: answers.map((answer, i) => ({ q: i + 1, answer, confidence: confidence ? confidence[i] : 0.95 })),
    note: note || '',
  };
}

test('gradeSlip: scores the reader answers and flags a reviewer disagreement', () => {
  const r = gradeSlip({
    key: KEY,
    reading: reading('Ana Fixture', ['0.5', MINUS + '3', '2x+6', '6']),
    review: reading('ana fixture', ['1/2', '-3', '2x + 6', '5']),
    reviewMode: 'two-model',
  });
  assert.equal(r.studentName, 'Ana Fixture');
  assert.equal(r.nameFlag, false);
  assert.equal(r.score, 4);
  assert.equal(r.maxScore, 5);
  assert.deepEqual(r.answers.map((a) => a.correct), [true, true, true, false]);
  assert.deepEqual(r.answers.map((a) => a.points), [1, 1, 2, 0]);
  assert.deepEqual(r.answers.map((a) => a.maxPoints), [1, 1, 2, 1]);
  // Reversed on purpose: every KEY question is a value question (no match
  // field), and there "0.5" and "1/2" score the same, so Q1 carries no
  // asterisk. Q2 and Q3 differ only in the minus sign and spacing.
  assert.deepEqual(r.answers.map((a) => a.flagged), [false, false, false, true]);
  assert.equal(r.answers[0].reason, '');
  assert.equal(r.answers[3].read, '6');
  assert.equal(r.answers[3].reviewRead, '5');
  assert.equal(r.answers[3].reason, 'reader 6, reviewer 5');
  assert.equal(r.flagged, true);
  assert.equal(r.reviewMode, 'two-model');
  assert.ok(r.notes.split('\n').includes('Q4: reader 6, reviewer 5'));
});

test('gradeSlip: a clean slip has no flags and no notes', () => {
  // The review spells the same answers with other spacing, case and minus
  // sign, which agree on every kind of question.
  const r = gradeSlip({
    key: KEY,
    reading: reading('Ben Fixture', ['1/2', '-3', '2x+6', '5']),
    review: reading('Ben Fixture', ['1 / 2', MINUS + '3', '2X + 6', '5']),
    reviewMode: 'two-model',
  });
  assert.equal(r.score, 5);
  assert.equal(r.flagged, false);
  assert.equal(r.notes, '');
  assert.ok(r.answers.every((a) => !a.flagged && a.reason === ''));
});

test('gradeSlip: low reader confidence flags the question', () => {
  const r = gradeSlip({
    key: KEY,
    reading: reading('Cy Fixture', ['1/2', '-3', '2x+6', '5'], '', [0.95, 0.5, 0.95, 0.7]),
    review: reading('Cy Fixture', ['1/2', '-3', '2x+6', '5']),
  });
  assert.deepEqual(r.answers.map((a) => a.flagged), [false, true, false, false]);
  assert.equal(r.answers[1].reason, 'low confidence 0.50');
  assert.equal(r.answers[1].correct, true, 'a flag never changes the score');
  assert.equal(r.score, 5);

  const strict = gradeSlip({
    key: KEY,
    reading: reading('Cy Fixture', ['1/2', '-3', '2x+6', '5'], '', [0.95, 0.5, 0.95, 0.7]),
    review: reading('Cy Fixture', ['1/2', '-3', '2x+6', '5']),
    lowConfidence: 0.8,
  });
  assert.deepEqual(strict.answers.map((a) => a.flagged), [false, true, false, true]);
});

test('gradeSlip: the reader note flags the questions it names', () => {
  const cases = [
    ['Q3 has crossed-out work', [3]],
    ['question 2 and 4 are smudged', [2, 4]],
    ['Questions 1, 3 unclear', [1, 3]],
    ['#2 illegible', [2]],
    ['Q2-4 faint', [2, 3, 4]],
    ['q.1 has two answers', [1]],
    ['Q12 is off the page', []],
    ['the answer 3 is circled', []],
    ['unique handwriting 3', []],
    ['', []],
  ];
  for (const [note, expected] of cases) {
    const r = gradeSlip({
      key: KEY,
      reading: reading('Di Fixture', ['1/2', '-3', '2x+6', '5'], note),
      review: reading('Di Fixture', ['1/2', '-3', '2x+6', '5']),
    });
    const flagged = r.answers.filter((a) => a.flagged).map((a) => a.q);
    assert.deepEqual(flagged, expected, note);
    for (const q of expected) assert.equal(r.answers[q - 1].reason, 'reader note mentions it');
  }
});

test('gradeSlip: a spaced hyphen in a note is a dash, not a range', () => {
  const cases = [
    ['Q2 - 3 or 8?', [2]],
    ['Q3 - 4 looks like 9', [3]],
    ['Q1 -4 or 4?', [1]],
    ['Q2- 4 is faint', [2]],
    ['Q2-4 faint', [2, 3, 4]],
    ['q1-q3 smudged', [1, 2, 3]],
    ['Q2 - Q4 faint', [2, 3, 4]],
    ['#1 - #3 smudged', [1, 2, 3]],
    ['Q1 to 3 unclear', [1, 2, 3]],
    ['Q1, 3 unclear', [1, 3]],
  ];
  for (const [note, expected] of cases) {
    const r = gradeSlip({
      key: KEY,
      reading: reading('Di Fixture', ['1/2', '-3', '2x+6', '5'], note),
      review: reading('Di Fixture', ['1/2', '-3', '2x+6', '5']),
    });
    assert.deepEqual(r.answers.filter((a) => a.flagged).map((a) => a.q), expected, note);
  }
});

test('gradeSlip: notes join reader note, reviewer note and one line per flag', () => {
  const r = gradeSlip({
    key: KEY,
    reading: reading('Eve Fixture', ['3/4', '-3', '2x+6', '5'], 'Q1 looks like 3/4 or 3/5'),
    review: reading('Eve Fixture', ['3/5', '-3', '2x+6', '5'], 'numbers are faint'),
  });
  assert.deepEqual(r.notes.split('\n'), [
    'Reader note: Q1 looks like 3/4 or 3/5',
    'Reviewer note: numbers are faint',
    'Q1: reader 3/4, reviewer 3/5; reader note mentions it',
  ]);
});

test('gradeSlip: blank answers score zero; two blanks agree, one blank disagrees', () => {
  const r = gradeSlip({
    key: KEY,
    reading: reading('Fay Fixture', ['', '', '2x+6', '5']),
    review: reading('Fay Fixture', ['', '-3', '2x+6', '5']),
  });
  assert.deepEqual(r.answers.map((a) => a.correct), [false, false, true, true]);
  assert.equal(r.score, 3);
  assert.deepEqual(r.answers.map((a) => a.flagged), [false, true, false, false]);
  assert.equal(r.answers[1].reason, 'reader (blank), reviewer -3');
});

// Reversed on purpose, for value questions. Reads in different forms with
// the same value score the same on a value question, so they carry no
// asterisk there; on an exact-form question only one of them can score, so
// they do.
test('gradeSlip: reads in different forms flag only on exact-form questions', () => {
  const readerAnswers = ['0.5', '-3', '2x+6', '5 cm'];
  const reviewerAnswers = ['2/4', MINUS + '3', '2(x+3)', '5'];
  const byValue = gradeSlip({
    key: KEY,
    reading: reading('Gus Fixture', readerAnswers),
    review: reading('Gus Fixture', reviewerAnswers),
  });
  assert.deepEqual(byValue.answers.map((a) => a.flagged), [false, false, false, false]);
  assert.deepEqual(byValue.answers.map((a) => a.correct), [true, true, true, true]);
  assert.equal(byValue.score, 5);
  assert.equal(byValue.flagged, false);
  assert.equal(byValue.notes, '');

  const exactKey = { questions: KEY.questions.map((q) => ({ ...q, match: 'exact' })) };
  const byForm = gradeSlip({
    key: exactKey,
    reading: reading('Gus Fixture', readerAnswers),
    review: reading('Gus Fixture', reviewerAnswers),
  });
  assert.deepEqual(byForm.answers.map((a) => a.flagged), [true, false, true, true]);
  assert.equal(byForm.answers[0].reason, 'reader 0.5, reviewer 2/4');
  // The reader's answer in exact form: "0.5" is not "1/2", the minus sign is
  // a look-alike, "2x+6" is not "2(x+3)", and "5 cm" is not "5".
  assert.deepEqual(byForm.answers.map((a) => a.correct), [false, true, false, false]);
  assert.equal(byForm.score, 1);
  assert.equal(byForm.flagged, true);
});

test('gradeSlip: missing answers are blank with confidence 0 and flagged', () => {
  const partial = { student_name: 'Hal Fixture', answers: [{ q: 1, answer: '1/2', confidence: 0.9 }], note: '' };
  const r = gradeSlip({ key: KEY, reading: partial, review: partial });
  assert.equal(r.answers.length, 4);
  assert.deepEqual(r.answers.map((a) => a.read), ['1/2', '', '', '']);
  assert.deepEqual(r.answers.map((a) => a.confidence), [0.9, 0, 0, 0]);
  assert.deepEqual(r.answers.map((a) => a.flagged), [false, true, true, true]);
  assert.equal(r.score, 1);
});

test('gradeSlip: name mismatch and missing name set nameFlag', () => {
  const answers = ['1/2', '-3', '2x+6', '5'];
  const differ = gradeSlip({
    key: KEY,
    reading: reading('Ida Fixture', answers),
    review: reading('Ida Fixtura', answers),
  });
  assert.equal(differ.nameFlag, true);
  assert.equal(differ.flagged, true);
  assert.ok(differ.notes.includes('Name: reader Ida Fixture, reviewer Ida Fixtura'));

  const blank = gradeSlip({ key: KEY, reading: reading('', answers), review: reading('', answers) });
  assert.equal(blank.nameFlag, true);
  assert.equal(blank.studentName, '(no name)');

  const fallback = gradeSlip({ key: KEY, reading: reading('', answers), review: reading('Jo Fixture', answers) });
  assert.equal(fallback.studentName, 'Jo Fixture');
  assert.equal(fallback.nameFlag, true);
});

test('gradeSlip: points default to 1, accept numeric strings, keep 0', () => {
  const key = { questions: [{ answer: '1' }, { answer: '2', points: '3' }, { answer: '3', points: 0 }, { answer: '4', points: 'x' }] };
  const r = gradeSlip({
    key,
    reading: reading('Kai Fixture', ['1', '2', '3', '4']),
    review: reading('Kai Fixture', ['1', '2', '3', '4']),
  });
  assert.deepEqual(r.answers.map((a) => a.maxPoints), [1, 3, 0, 1]);
  assert.equal(r.maxScore, 5);
  assert.equal(r.score, 5);
});

test('gradeSlip: single-model mode passes through; no review flags the row', () => {
  const answers = ['1/2', '-3', '2x+6', '5'];
  const single = gradeSlip({
    key: KEY,
    reading: reading('Lu Fixture', answers),
    review: reading('Lu Fixture', answers),
    reviewMode: 'single-model',
  });
  assert.equal(single.reviewMode, 'single-model');
  assert.equal(single.flagged, false);

  const none = gradeSlip({ key: KEY, reading: reading('Lu Fixture', answers) });
  assert.equal(none.reviewMode, 'none');
  assert.equal(none.flagged, true);
  assert.ok(none.answers.every((a) => a.reviewRead === null && !a.flagged));
  assert.ok(none.notes.includes('No second read'));
  assert.equal(none.score, 5);
});

// Reported slips, reader and reviewer agreeing on a wrong answer. Each one
// once scored 1 of 1, unflagged.
test('gradeSlip: a wrong range, exponent, zero, ellipsis or last digit scores zero', () => {
  const cases = [
    ['70-79', '80-89'],
    ['70' + EN_DASH + '79', '60' + EN_DASH + '69'],
    ['3-2', '2-1'],
    ['6.4 x 10^-13', '6.4 x 10^-14'],
    ['6.4 ' + TIMES + ' 10' + SUP_NEG13, '0'],
    ['9.11 x 10^-31', '1.67 x 10^-27'],
    ['0.333...', '0.333'],
    ['4,567,891,230', '4,567,891,234'],
  ];
  for (const [answer, read] of cases) {
    const r = gradeSlip({
      key: { questions: [{ answer, points: 1 }] },
      reading: reading('Quin Fixture', [read]),
      review: reading('Quin Fixture', [read]),
    });
    const label = `key ${answer}, read ${read}`;
    assert.equal(r.answers[0].correct, false, label);
    assert.equal(r.score, 0, label);
    assert.equal(r.maxScore, 1, label);
  }
});

test('gradeSlip: a reader and reviewer split between two ranges is flagged', () => {
  const key = { questions: [{ answer: '70-79', points: 1 }] };
  const split = gradeSlip({
    key,
    reading: reading('Rae Fixture', ['70-79']),
    review: reading('Rae Fixture', ['80-89']),
  });
  assert.equal(split.answers[0].correct, true);
  assert.equal(split.answers[0].flagged, true);
  assert.equal(split.answers[0].reason, 'reader 70-79, reviewer 80-89');
  // The same range in two spellings is agreement, not a flag.
  const same = gradeSlip({
    key,
    reading: reading('Rae Fixture', ['70' + EN_DASH + '79']),
    review: reading('Rae Fixture', ['70 - 79']),
  });
  assert.equal(same.answers[0].correct, true);
  assert.equal(same.answers[0].flagged, false);
});

// Reader and reviewer agreeing on a wrong answer. Each one once scored 1 of
// 1, unflagged.
test('gradeSlip: a wrong answer from the regression tests scores zero', () => {
  const cases = [
    ['1/2-3/4', '1/4-1/2'],
    ['10-4-2', '8-2-2'],
    ['4.5', '9^' + HALF],
    ['29', '2' + SUP5 + SUP_MINUS + SUP3],
    ['3log(x)', 'log(3x)'],
    ['x+2', 'abs(x+2)'],
    ['2^64', '2^64 - 1'],
    ['3.142857146', '22/7'],
    ['500', '0,500'],
    ['220', '200 + 10%'],
    ['0', '5/(1/0)'],
    ['2000', '2e+3'],
    ['1.5', '1 .5'],
    ['2x+3', 'x = 2x + 3'],
    ['0', '10^-401'],
  ];
  for (const [answer, read] of cases) {
    const r = gradeSlip({
      key: { questions: [{ answer, points: 1 }] },
      reading: reading('Vic Fixture', [read]),
      review: reading('Vic Fixture', [read]),
    });
    const label = `key ${answer}, read ${read}`;
    assert.equal(r.answers[0].correct, false, label);
    assert.equal(r.score, 0, label);
    assert.equal(r.maxScore, 1, label);
  }
});

// Reader and reviewer agreeing. Each right answer below once scored 0 and
// each wrong one 1, unflagged.
test('gradeSlip: regression right answers score and wrong ones do not', () => {
  const cases = [
    ['12.5%', '12' + HALF + '%', true],
    ['2sin(x)', '2 sin(x)', true],
    ['x > 1/2', 'x > ' + HALF, true],
    ['sqrt(16-4x^2)', '2sqrt(4-x^2)', true],
    ['$0.05', '5%', false],
    ['10 s - 20 s', '20 s - 30 s', false],
    ['x+8', 'abs(x+8)', false],
    ['1/4', HALF + ' ' + HALF, false],
    ['xln(y)', 'yln(x)', false],
  ];
  for (const [answer, read, correct] of cases) {
    const r = gradeSlip({
      key: { questions: [{ answer, points: 1 }] },
      reading: reading('Wes Fixture', [read]),
      review: reading('Wes Fixture', [read]),
    });
    const label = `key ${answer}, read ${read}`;
    assert.equal(r.answers[0].correct, correct, label);
    assert.equal(r.score, correct ? 1 : 0, label);
    assert.equal(r.answers[0].flagged, false, label);
  }
});

// One question, one reader and one reviewer answer, with a match setting.
function oneQuestion(answer, match, read, reviewRead) {
  const question = match === undefined ? { answer, points: 1 } : { answer, points: 1, match };
  return gradeSlip({
    key: { questions: [question] },
    reading: reading('Uma Fixture', [read]),
    review: reading('Uma Fixture', [reviewRead]),
  });
}

// Reversed on purpose, for value questions: the reviewer check compared the
// transcriptions as text on every question. It now does so only on
// exact-form questions; on value questions it compares them by value.
test('gradeSlip: the reviewer check is by value on value questions and as written on exact-form ones', () => {
  // A different transcription with the same value: the reviewer's is in the
  // key's form, the reader's is not.
  const sameValue = [
    ['3/4', '6/8', '3/4'],
    ['2^4', '4^2', '2^4'],
    ['3.40', '3.4', '3.40'],
    ['1/2', '0.5', '1/2'],
    ['5', '5 cm', '5'],
    ['3x+6', '3(x+2)', '3x+6'],
  ];
  for (const [answer, read, reviewRead] of sameValue) {
    const label = `key ${answer}, reader ${read}, reviewer ${reviewRead}`;
    for (const match of [undefined, 'value']) {
      const r = oneQuestion(answer, match, read, reviewRead);
      assert.equal(r.answers[0].correct, true, `${label}, match ${match}`);
      assert.equal(r.answers[0].flagged, false, `${label}, match ${match}`);
      assert.equal(r.answers[0].reason, '', `${label}, match ${match}`);
      assert.equal(r.flagged, false, `${label}, match ${match}`);
    }
    const exact = oneQuestion(answer, 'exact', read, reviewRead);
    assert.equal(exact.answers[0].correct, false, `${label}, exact`);
    assert.equal(exact.score, 0, `${label}, exact`);
    assert.equal(exact.answers[0].flagged, true, `${label}, exact`);
    assert.equal(exact.answers[0].reason, `reader ${read}, reviewer ${reviewRead}`, `${label}, exact`);
    assert.equal(exact.flagged, true, `${label}, exact`);
  }
  // Reads that differ in value carry the asterisk on both kinds of question.
  const differ = [
    // A wrong answer credited from a misread, with nothing on the sheet.
    ['1/2-3/4', '1/4-1/2', '1/2-3/4'],
    ['70-79', '70-79', '80-89'],
    ['5m', '5', '5m'],
    ['3/4', '3/4', '3/5'],
    ['-3', '', '-3'],
  ];
  for (const [answer, read, reviewRead] of differ) {
    for (const match of [undefined, 'value', 'exact']) {
      const r = oneQuestion(answer, match, read, reviewRead);
      const label = `key ${answer}, reader ${read}, reviewer ${reviewRead}, match ${match}`;
      assert.equal(r.answers[0].flagged, true, label);
      const shownRead = read === '' ? '(blank)' : read;
      assert.equal(r.answers[0].reason, `reader ${shownRead}, reviewer ${reviewRead}`, label);
    }
  }
  // Agreement on both kinds of question: case, spacing around symbols, the
  // minus sign, dashes, a sentence-ending period, and two blanks.
  const same = [
    ['x=4', 'X = 4'],
    ['-3', MINUS + '3'],
    ['2x+6', '2x + 6'],
    ['70-79', '70' + EN_DASH + '79'],
    ['Yes.', 'yes'],
    ['', ''],
  ];
  for (const [read, reviewRead] of same) {
    for (const match of [undefined, 'value', 'exact']) {
      const r = oneQuestion(read || '1', match, read, reviewRead);
      assert.equal(r.answers[0].flagged, false, `${read} vs ${reviewRead}, match ${match}`);
    }
  }
  // Moved here on purpose from the agreement list: normalize reads these
  // pairs alike, but exact form does not, so on an exact-form question only
  // one of the two reads can score and the cell is flagged.
  const formOnly = [
    ['1,000', '1000'],
    ['1 1/2', '1+1/2'],
  ];
  for (const [read, reviewRead] of formOnly) {
    assert.equal(oneQuestion(read, 'value', read, reviewRead).answers[0].flagged, false, `${read} vs ${reviewRead}, value`);
    const exact = oneQuestion(read, 'exact', read, reviewRead);
    assert.equal(exact.answers[0].correct, true, `${read} vs ${reviewRead}, exact`);
    assert.equal(exact.answers[0].flagged, true, `${read} vs ${reviewRead}, exact`);
  }
});

// Reversed on purpose, for value questions: two reads that matched each
// other by value were never flagged. Matching by value does not chain, so
// one read can match the key while the other, matching the first, does not.
test('gradeSlip: two reads that would score differently are flagged on value questions', () => {
  // Key, then two reads that match each other by value but not both the key.
  const split = [
    // A unit on one side.
    ['5 in', '5 cm', '5'],
    ['12 ft', '12', '12 in'],
    // An assignment on one side.
    ['y = 4', 'x = 4', '4'],
    // A percent against an amount.
    ['$0.25', '25%', '0.25'],
  ];
  for (const [answer, a, b] of split) {
    for (const [read, reviewRead] of [[a, b], [b, a]]) {
      const label = `key ${answer}, reader ${read}, reviewer ${reviewRead}`;
      assert.equal(equivalent(read, reviewRead), true, `${label}: the reads match each other`);
      assert.notEqual(equivalent(read, answer), equivalent(reviewRead, answer), `${label}: one read scores`);
      for (const match of [undefined, 'value']) {
        const r = oneQuestion(answer, match, read, reviewRead);
        assert.equal(r.answers[0].correct, equivalent(read, answer), `${label}, match ${match}`);
        assert.equal(r.answers[0].flagged, true, `${label}, match ${match}`);
        assert.equal(r.answers[0].reason, `reader ${read}, reviewer ${reviewRead}`, `${label}, match ${match}`);
        assert.equal(r.flagged, true, `${label}, match ${match}`);
      }
    }
  }
  // Reads that match each other and score the same stay unflagged, whether
  // both are right or both are wrong, and so do two blanks.
  const agree = [
    ['3/4', '6/8', '3/4'],
    ['1/2', '6/8', '3/4'],
    ['5 in', '5 in', '5 inches'],
    ['5 in', '5 cm', '5 centimeters'],
    ['5', '5 cm', '5'],
    ['4', '', ''],
  ];
  for (const [answer, read, reviewRead] of agree) {
    for (const match of [undefined, 'value']) {
      const r = oneQuestion(answer, match, read, reviewRead);
      assert.equal(r.answers[0].flagged, false, `key ${answer}, reader ${read}, reviewer ${reviewRead}, match ${match}`);
    }
  }
  // Two reads that both match the key but not each other are flagged.
  assert.equal(oneQuestion('5', 'value', '5 cm', '5 in').answers[0].flagged, true);
});

test('gradeSlip: over every key and pair of reads, a split score always carries the asterisk', () => {
  const pool = [
    '', '5', '5 cm', '5 in', '5m', 'x = 5', 'y = 5', '4', 'x = 4',
    '12', '12 ft', '12 in', '12 m', '0.25', '.25', '25%', '$0.25',
    '1/2', '0.5', '2/4', '50%', '3/4', '6/8', '0.75', '.75', '75%', '75%.',
    '3.40', '3.4', '2^4', '16', '3(x+2)', '3x+6', 'x > .5', 'x > 0.5',
    '1,000', '1000', '1 1/2', '1+1/2',
  ];
  const memo = new Map();
  const cached = (fn, x, y) => {
    const k = fn.name + '\u0000' + x + '\u0000' + y;
    if (!memo.has(k)) memo.set(k, fn(x, y));
    return memo.get(k);
  };
  const pairs = pool.flatMap((a) => pool.map((b) => [a, b]));
  const answers = (i) => pairs.map((p, q) => ({ q: q + 1, answer: p[i], confidence: 0.95 }));
  const reader = { student_name: 'Pat Fixture', answers: answers(0), note: '' };
  const reviewer = { student_name: 'Pat Fixture', answers: answers(1), note: '' };
  let splits = 0;
  let quiet = 0;
  for (const match of ['value', 'exact']) {
    const scores = (s, key) => cached(match === 'exact' ? exactForm : equivalent, s, key);
    for (const answer of pool) {
      const key = { questions: pairs.map(() => ({ answer, points: 1, match })) };
      const r = gradeSlip({ key, reading: reader, review: reviewer });
      r.answers.forEach((cell, i) => {
        const [a, b] = pairs[i];
        const label = `key ${JSON.stringify(answer)}, reader ${JSON.stringify(a)}, reviewer ${JSON.stringify(b)}, ${match}`;
        const split = scores(a, answer) !== scores(b, answer);
        assert.equal(cell.correct, scores(a, answer), label);
        if (split) {
          assert.equal(cell.flagged, true, label);
          splits++;
        }
        if (match === 'value') {
          const blanks = normalize(a) === '' && normalize(b) === '';
          const agree = blanks || (!split && cached(equivalent, a, b));
          assert.equal(cell.flagged, !agree, label);
          if (agree && a !== b) quiet++;
        }
      });
    }
  }
  // Both halves are exercised: many split scores, and many reads written
  // differently that score the same and stay quiet.
  assert.ok(splits >= 10000, `${splits} split scores`);
  assert.ok(quiet >= 2000, `${quiet} quiet pairs written differently`);
});

test('gradeSlip: each question scores by its own match setting', () => {
  const key = {
    questions: [
      { answer: '3/4', points: 1, match: 'exact' },
      { answer: '3/4', points: 1, match: 'value' },
      { answer: '3/4', points: 1 },
      { answer: '2^4', points: 2, match: 'exact' },
      { answer: '0.75', points: 1, match: 'exact' },
      { answer: 'x = 4', points: 1, match: 'exact' },
      { answer: '16', points: 1, match: 'value' },
    ],
  };
  const read = ['6/8', '6/8', '6/8', '2' + SUP4, '.75', '4', '2^4'];
  const r = gradeSlip({ key, reading: reading('Mo Fixture', read), review: reading('Mo Fixture', read) });
  assert.deepEqual(r.answers.map((a) => a.correct), [false, true, true, true, true, false, true]);
  assert.deepEqual(r.answers.map((a) => a.points), [0, 1, 1, 2, 1, 0, 1]);
  assert.equal(r.score, 6);
  assert.equal(r.maxScore, 8);
  assert.equal(r.flagged, false);

  // In the key's form, every question scores.
  const inForm = ['3/4', '0.75', '3/4', '2^4', '0.75', 'X=4', '16'];
  const all = gradeSlip({ key, reading: reading('Mo Fixture', inForm), review: reading('Mo Fixture', inForm) });
  assert.deepEqual(all.answers.map((a) => a.correct), [true, true, true, true, true, true, true]);
  assert.equal(all.score, 8);

  // Confidence and note flags are the same on both kinds of question.
  const confidence = [0.5, 0.5, 0.95, 0.95, 0.95, 0.95, 0.95];
  const noted = gradeSlip({
    key,
    reading: reading('Mo Fixture', read, 'Q1 and Q2 are faint', confidence),
    review: reading('Mo Fixture', read),
  });
  assert.deepEqual(noted.answers.map((a) => a.flagged), [true, true, false, false, false, false, false]);
  assert.equal(noted.answers[0].reason, 'low confidence 0.50; reader note mentions it');
  assert.equal(noted.answers[1].reason, 'low confidence 0.50; reader note mentions it');
});

test('gradeSlip: a saved key with no match field reads as value', () => {
  // A key saved before questions had a match setting.
  const saved = { questions: [{ answer: '3/4', points: 1 }, { answer: '1/2' }] };
  const reads = ['6/8', '0.5'];
  const reviews = ['3/4', '1/2'];
  const score = (key) => gradeSlip({
    key,
    reading: reading('Nia Fixture', reads),
    review: reading('Nia Fixture', reviews),
  });
  const withMatch = (match) => ({ questions: saved.questions.map((q) => ({ ...q, match })) });

  const r = score(saved);
  assert.deepEqual(r.answers.map((a) => a.correct), [true, true]);
  assert.deepEqual(r.answers.map((a) => a.flagged), [false, false]);
  assert.equal(r.score, 2);
  // Only the exact word 'exact' makes a question exact-form.
  for (const match of ['value', '', 'fuzzy', null, undefined, 42, 'EXACT', 'exact form']) {
    const m = score(withMatch(match));
    assert.deepEqual(m.answers.map((a) => a.correct), [true, true], `match ${JSON.stringify(match)}`);
    assert.deepEqual(m.answers.map((a) => a.flagged), [false, false], `match ${JSON.stringify(match)}`);
  }
  const exact = score(withMatch('exact'));
  assert.deepEqual(exact.answers.map((a) => a.correct), [false, false]);
  assert.deepEqual(exact.answers.map((a) => a.flagged), [true, true]);
  assert.equal(exact.score, 0);
});

// ------------------------------------------------------------------ summarize

// A hand-computed class of 6. Key: 4 questions worth 1, 2, 3, 4 (max 10).
// Student  answers right   score  percent  flagged  review
// S1       1 2 3 4         10     100      no       two-model
// S2       - 2 3 4          9      90      yes      two-model
// S3       1 2 - 4          7      70      no       single-model
// S4       - - 3 4          7      70      no       two-model
// S5       - - - 4          4      40      yes      two-model
// S6       - - - -          0       0      no       single-model
// mean = (100+90+70+70+40+0)/6 = 370/6 = 61.666...
// median = (70+70)/2 = 70
// pass at 70: S1..S4 = 4/6 = 66.666...%; pass at 90: S1, S2 = 33.333...%
// hit rates: Q1 2/6, Q2 3/6, Q3 3/6, Q4 5/6
// bands: 90-100% 2, 70-79% 2, 40-49% 1, 0-9% 1
const CLASS_KEY = {
  passPercent: 70,
  questions: [
    { answer: '2', points: 1 },
    { answer: '3/4', points: 2 },
    { answer: 'x+1', points: 3 },
    { answer: '7', points: 4 },
  ],
};
const RIGHT = ['2', '0.75', '1+x', '7'];
const WRONG = ['3', '3/5', 'x-1', '1'];

function student(name, rightMask, opts) {
  const answers = rightMask.map((ok, i) => (ok ? RIGHT[i] : WRONG[i]));
  const reviewAnswers = answers.slice();
  if (opts.flag) reviewAnswers[3] = reviewAnswers[3] === '7' ? '1' : '7';
  return gradeSlip({
    key: CLASS_KEY,
    reading: reading(name, answers),
    review: reading(name, reviewAnswers),
    reviewMode: opts.mode,
  });
}

function hand6() {
  return [
    student('S1', [1, 1, 1, 1], { mode: 'two-model' }),
    student('S2', [0, 1, 1, 1], { mode: 'two-model', flag: true }),
    student('S3', [1, 1, 0, 1], { mode: 'single-model' }),
    student('S4', [0, 0, 1, 1], { mode: 'two-model' }),
    student('S5', [0, 0, 0, 1], { mode: 'two-model', flag: true }),
    student('S6', [0, 0, 0, 0], { mode: 'single-model' }),
  ];
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);
}

test('summarize: hand-computed class of 6', () => {
  const rows = hand6();
  assert.deepEqual(rows.map((r) => r.score), [10, 9, 7, 7, 4, 0], 'fixture scores');
  const s = summarize(rows, CLASS_KEY, { passPercent: 70 });
  assert.equal(s.students, 6);
  near(s.mean, 370 / 6, 'mean');
  near(s.median, 70, 'median');
  near(s.passRate, 400 / 6, 'passRate');
  assert.equal(s.passPercent, 70);
  assert.deepEqual(s.perQuestion.map((p) => p.q), [1, 2, 3, 4]);
  near(s.perQuestion[0].hitRate, 200 / 6, 'Q1');
  near(s.perQuestion[1].hitRate, 50, 'Q2');
  near(s.perQuestion[2].hitRate, 50, 'Q3');
  near(s.perQuestion[3].hitRate, 500 / 6, 'Q4');
  assert.deepEqual(s.distribution, [
    { bucket: '0-9%', count: 1 },
    { bucket: '10-19%', count: 0 },
    { bucket: '20-29%', count: 0 },
    { bucket: '30-39%', count: 0 },
    { bucket: '40-49%', count: 1 },
    { bucket: '50-59%', count: 0 },
    { bucket: '60-69%', count: 0 },
    { bucket: '70-79%', count: 2 },
    { bucket: '80-89%', count: 0 },
    { bucket: '90-100%', count: 2 },
  ]);
  assert.equal(s.flaggedRows, 2);
  assert.equal(s.singleModelRows, 2);
});

test('summarize: pass percent option, key fallback, default 70', () => {
  const rows = hand6();
  near(summarize(rows, CLASS_KEY, { passPercent: 90 }).passRate, 200 / 6, 'pass at 90');
  near(summarize(rows, { ...CLASS_KEY, passPercent: 40 }).passRate, 500 / 6, 'key pass at 40');
  const noPass = { questions: CLASS_KEY.questions };
  assert.equal(summarize(rows, noPass).passPercent, 70);
});

test('summarize: odd count median and band edges', () => {
  const rows = [
    { score: 1, maxScore: 3, answers: [] },       // 33.3
    { score: 899, maxScore: 1000, answers: [] },  // 89.9
    { score: 9, maxScore: 10, answers: [] },      // 90
    { score: 1, maxScore: 10, answers: [] },      // 10
    { score: 99, maxScore: 1000, answers: [] },   // 9.9
  ];
  const s = summarize(rows, { questions: [] });
  near(s.median, 100 / 3, 'median');
  const count = (b) => s.distribution.find((d) => d.bucket === b).count;
  assert.equal(count('0-9%'), 1);
  assert.equal(count('10-19%'), 1);
  assert.equal(count('30-39%'), 1);
  assert.equal(count('80-89%'), 1);
  assert.equal(count('90-100%'), 1);
});

function assertNoNaN(value, path) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) assertNoNaN(value[k], `${path}.${k}`);
  }
}

test('summarize: empty rows give zeros and no NaN', () => {
  const s = summarize([], CLASS_KEY);
  assert.equal(s.students, 0);
  assert.equal(s.mean, 0);
  assert.equal(s.median, 0);
  assert.equal(s.passRate, 0);
  assert.deepEqual(s.perQuestion, [1, 2, 3, 4].map((q) => ({ q, hitRate: 0 })));
  assert.ok(s.distribution.every((d) => d.count === 0));
  assert.equal(s.distribution.length, 10);
  assert.equal(s.flaggedRows, 0);
  assert.equal(s.singleModelRows, 0);
  assertNoNaN(s, 'summary');
  assertNoNaN(summarize(undefined, undefined), 'summary(undefined)');
});

test('summarize: a zero-point key gives 0 percent, not NaN', () => {
  const s = summarize([{ score: 0, maxScore: 0, answers: [] }], { questions: [] });
  assert.equal(s.mean, 0);
  assertNoNaN(s, 'summary');
});

test('equivalent: a typed >= and the handwritten sign are the same relation', () => {
  const GE = '≥';
  const LE = '≤';
  const NE = '≠';
  const same = [
    ['x >= 4', 'x ' + GE + ' 4'],
    ['x>=4', 'x' + GE + '4'],
    ['x <= 5', 'x ' + LE + ' 5'],
    ['y != 0', 'y ' + NE + ' 0'],
  ];
  for (const [a, b] of same) {
    assert.equal(equivalent(a, b), true, `equivalent(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.equal(equivalent(b, a), true, `equivalent(${JSON.stringify(b)}, ${JSON.stringify(a)})`);
  }
  const different = [
    ['x >= 4', 'x ' + LE + ' 4'],
    ['x >= 4', 'x > 4'],
    ['x ' + GE + ' 4', 'x ' + GE + ' 5'],
    ['y != 0', 'y = 0'],
  ];
  for (const [a, b] of different) {
    assert.equal(equivalent(a, b), false, `equivalent(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.equal(equivalent(b, a), false, `equivalent(${JSON.stringify(b)}, ${JSON.stringify(a)})`);
  }
});
