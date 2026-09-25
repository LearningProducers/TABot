/*
 * TABot.grade: answer matching, slip scoring, flags, summary stats.
 *
 * Every answer-key question has a match setting. 'value', the default and
 * what a question with no setting reads as, accepts any answer worth the
 * same as the key: 1/2, 0.5 and 2/4 all count (equivalent() below). 'exact'
 * also requires the answer to be written the way the key is: 6/8 does not
 * count for 3/4 (exactForm() below).
 *
 * Safety model for math.js: math.js is used ONLY to parse. The parse tree is
 * then walked by a whitelist (numbers, single-letter variables, pi, + - * / ^,
 * unary minus/plus, parentheses, sqrt, abs) and compiled into a plain JS
 * closure. No math.js evaluate, no scope object, no function reachable from an
 * answer string (import, createUnit, evaluate, accessors, assignments are all
 * rejected at the walk). Anything that fails the walk is compared as text.
 * Every step of the closure is checked: a step that is not a finite number
 * (a division by zero, the root of a negative) leaves the answer with no
 * value there, and a step of 2^53 or more, or a non-zero value that
 * underflows to 0, is past what a double holds exactly, so it is not trusted.
 *
 * Matching by value, the choices a teacher would notice (all symmetric:
 * equivalent(a, b) === equivalent(b, a)):
 *   - "x=4" matches "4": a leading single-variable assignment is stripped,
 *     but only when its variable does not appear in the rest. "x = 2x + 3"
 *     is an equation in x: it matches "x = 3 + 2x" and never "2x+3". If both
 *     sides carry one, the variable must be the same ("x=4" vs "y=4" does not
 *     match).
 *   - Units: a unit on only one side is ignored ("5 cm" matches "5"), because
 *     the reader is told to keep units and most keys are bare numbers. Units on
 *     both sides must be the same unit ("5 cm" vs "5 in" does not match; no
 *     conversion). Unit words of two or more letters, $ and the degree sign are
 *     always units. The single letters m, g, l (L), s and h beside a plain
 *     number are units only when a space sets them apart ("12 m") and the
 *     other side has no variables, or when the other side names the same unit
 *     with a space or a unit word ("12m" matches "12 m" and "12 meters").
 *     Otherwise the letter is a variable: "5m" is algebra, so a key of "5m"
 *     never accepts "5", and "2m + 3" and "5m" vs "5*m" are algebra. A
 *     percent never matches a side that carries a unit: "$0.25" does not
 *     match "25%", and "0.5 m" does not match "50%".
 *   - Times: x or X between two digits, the times sign, the middle dot and *
 *     all mean times, and a middle dot is never a decimal point. A product of
 *     plain numbers ("3 x 4", "2 x 1/2") is a size or an unevaluated product,
 *     so it is compared as text, never by value: "3 x 4" matches "3*4" but not
 *     12, "4 x 3" or "2 x 6". Scientific notation is the one exception: a plain
 *     number times a power of ten ("3 x 10^4") is a value and matches 30000.
 *     Letters do not change this: any answer that multiplies two written
 *     numbers ("3 ft x 4 ft", "3 by 4", "5 ft 3 in") is compared as text.
 *     Numbers side by side are a product too, whether a space or nothing
 *     joins them, and a fraction (a glyph, or a/b in parentheses) or a mixed
 *     number counts as a written number: two fraction glyphs with a space
 *     between (half, half), a glyph then a number (half, 6), "(1/2)(1/2)"
 *     and "12(3/4)x" compare as written, never as 1/4, 3 or 9x, the same as
 *     "12(3)x" is never 36x. A digit then a glyph is a mixed number, not a
 *     product, and still evaluates.
 *   - Thousands commas are dropped only when the answer, after a leading
 *     single-variable assignment, is one number (sign, $, decimals and a unit
 *     allowed) whose first group does not start with 0: "1,000 m" is 1000 m
 *     and "x = 1,000" is x = 1000, but "0,500" (0.5 where the comma is the
 *     decimal point) keeps its comma, "(1,234)" is the point (1, 234), never
 *     1234, and "x = 2, 100" keeps its comma, so it does not match 2100.
 *   - Percent is a value, not a unit: "50%" matches 0.5 and does NOT match 50.
 *     Only one trailing % on one number is read that way: a decimal, a mixed
 *     number ("12 1/2%", or 12 and the half glyph, matches 12.5% and 1/8; 33
 *     and the third glyph matches 1/3), a fraction glyph (the half glyph with
 *     % is 0.005), or one of these in parentheses ("(50%)" matches 0.5). A
 *     typed "1/2%" is not one number, since math.js reads it as 1/(2%) = 50,
 *     so it compares as written (and matches the half glyph with %). A %
 *     anywhere else ("200 + 10%", "x + 20%", "5% (1+2") makes the answer
 *     compare as written, because math.js reads "200 + 10%" as 220 and drops
 *     what follows a stray %.
 *   - Two or more plain numbers (whole, decimal, a/b, a mixed number or a
 *     fraction glyph) joined by dashes and nothing else ("70-79", "70 - 79",
 *     the same with an en dash, "3-2", "1/2-3/4", "1 1/2-2", "10-4-2") are a
 *     range, a score or a record, never a subtraction. They compare as
 *     written, number by number: "70-79" matches "70 - 79" but not "80-89",
 *     "1/2-3/4" does not match "1/4-1/2", "10-4-2" does not match "8-2-2",
 *     and "3-2" matches neither "2-1" nor 1. A sign on any number keeps the
 *     shape ("-5-5" is not -10), and a percent sign or a unit may follow.
 *     When every bound carries the same unit (a unit word, $, the degree
 *     sign, or m, g, l, s or h set apart by a space: "10 s - 20 s",
 *     "1 m - 2 m", "$5 - $10") it is a range in that unit, never algebra:
 *     "10 s - 20 s" matches "10-20" but not "20 s - 30 s", and "2 m - 3 m" is
 *     not -m. Algebra and signed values still evaluate: "x-3" matches "-3+x",
 *     "10-(-2)" matches 12, "-3" matches the minus sign.
 *   - Written numbers (a decimal, or a decimal times a power of ten) compare
 *     exactly, digit by digit: "1.5" matches "1.50" and "1 x 10^9" matches
 *     "1,000,000,000", while "4,567,891,230" does not match "4,567,891,234".
 *     Past 10^400 either way there are no digits to compare, so such a number
 *     compares as written: "10^-401" is not 0.
 *   - A computed value (a fraction, sum, root or pi) matches within float
 *     noise, never within a fixed share: every step carries a bound on how
 *     far its roundings can have moved it, and two values match when they
 *     are no further apart than four times their two bounds together. So
 *     0.333 and 0.333333333333 do not match 1/3, "22/7" does not match
 *     3.142857146, while 1/3 matches 2/6, "0.1+0.2" matches 0.3 and
 *     "(x-12)(x-11)" still matches its expansion. Two whole numbers must be
 *     equal, and a value half a unit or more from a whole number is never
 *     that number ("999999999/2" does not match 500000000; "sqrt(2)*sqrt(2)"
 *     matches 2). There is no absolute tolerance: zero matches only zero, so
 *     "6.4 x 10^-13" does not match 0, and "0.1+0.2-0.3" does not match 0 (a
 *     right answer marked wrong, the lesser mistake). A computed value, or
 *     any step of one, of 2^53 or more cannot be trusted to the last digit,
 *     so the answer compares as written: "2^64 - 1" does not match "2^64",
 *     and "602000000000000000000000/1" does not match "6.02 x 10^23" (two
 *     written numbers still compare digit by digit, so "6.02 x 10^23"
 *     matches its standard form).
 *   - Algebra is compared at seventeen sample points of both signs: eight
 *     within 3 of zero, so an answer defined only there still has
 *     three or more ("2sqrt(4-x^2)" matches "sqrt(16-4x^2)"), and the rest
 *     out to about -103 and 211, so a kink far from zero is seen ("abs(x+8)"
 *     does not match "x+8", "abs(x-30)" does not match "30-x"). A second
 *     variable takes the next point along, so the pairs meet every mix of
 *     signs. At least three points must be usable, and every point where
 *     either side has a value must agree, so "abs(x+2)" does not match
 *     "x+2", "sqrt(x^2)" does not match x and "sqrt(x)*sqrt(y)" does not
 *     match "sqrt(xy)". A constant cannot swamp the comparison: it adds only
 *     its own rounding to the bound, so "x^2 + 10^10" does not match
 *     "x + 10^10".
 *   - An ellipsis is part of the answer, never stripped: "0.333..." (or with
 *     the one-character ellipsis) matches neither 0.333 nor 1/3; it compares
 *     as written. Only a single trailing period after a letter, a digit, a
 *     closing bracket, a percent sign or the degree sign, a sentence end, is
 *     dropped: "12." matches 12, "75%." matches 75% and "(2, 3)." matches
 *     "(2, 3)".
 *   - A decimal point that starts a number gets its zero, wherever the
 *     number stands: ".5" is 0.5, and "x > .5", "(.5, 2)" and "{.5, 1}"
 *     match "x > 0.5", "(0.5, 2)" and "{0.5, 1}". A point right after the
 *     end of a term (a letter, a digit, a closing bracket, a percent sign or
 *     the degree sign) or after another point, with or without a space
 *     between, does not start a number: "1 .5" and "x.5" keep their form.
 *   - Letters are variables, including e and i. A digit, e or E, an optional
 *     sign and a digit is calculator E-notation, never 2000: "2e3" and
 *     "5.2E-3" compare as written. pi (and the pi sign) is the constant. A
 *     letter run of up to 3 letters in an algebraic answer is a product
 *     ("2xy" = 2*x*y); a longer word makes the answer text. A function name
 *     (sin, cos, tan, sec, csc, cot, log, ln, lg, exp, min, max, mod, gcd,
 *     lcm, det, sgn, arg) makes the answer compare as written, never as a
 *     product of letters: "sin(2x)" does not match "2sin(x)". That holds
 *     when letters are glued in front of the name too: "yln(x)" does not
 *     match "xln(y)". In such an answer a space or * between a letter or
 *     digit and the next factor does not count: "2sin(x)", "2 sin(x)" and
 *     "2*sin(x)" match, and "xln(x)" matches "x ln(x)"; so a letter against
 *     the name reads as a product ("asin(x)" matches "a sin(x)"). Between
 *     two digits the space or * stays. Reordered factors do not match
 *     ("sin(x)+1" vs "1+sin(x)"). sqrt and abs are the only functions that
 *     evaluate.
 *   - A fraction glyph (the one-character 1/2, 3/4 and the rest) is one
 *     fraction in parentheses: 9 to the power of the half glyph is 3, 3
 *     divided by it is 6, and the glyph written against h is half of h, never
 *     a spaced unit. A digit right before a glyph makes a mixed number (1 and
 *     the half glyph is 1 1/2). A run of superscripts is one exponent: 2 with
 *     the superscripts 5, minus, 3 is 2^(5-3) = 4.
 *   - Text comparison ignores spaces around symbols ("x > 3" equals "x>3"),
 *     except around a single "." (a decimal point): "1 .5" does not match
 *     "1.5". In it a fraction glyph reads the same as a/b ("x > 1/2", the
 *     ordered pair "(1/2, 2)", "1/3 cup flour" match their glyph spellings),
 *     and so does any fraction in parentheses, except where the parentheses
 *     change the reading: after ^ or / (a sign between counts through, as in
 *     "2^-(1/2)"), before ^, or right against a letter, digit or point, a
 *     ")" before it or a "(" after it.
 *   - Inputs longer than 200 characters are never parsed; they compare as text.
 *
 * Matching in exact form (exactForm(answer, key), symmetric the same way):
 *   - The two must read the same once case, spacing and look-alike
 *     characters are set aside. The look-alikes: the minus signs and dashes;
 *     the times and division signs (and x between two digits); fraction
 *     glyphs, read as a/b (and a digit before one as a mixed number, "1 1/2");
 *     superscripts, read as ^; the inequality signs; the pi and root signs;
 *     the one-character ellipsis. A sentence-ending period is dropped (the
 *     same rule as above: "75%." is "75%"), and a decimal point with no digit
 *     before it gets its zero: ".75" is "0.75", and "x > .5" is "x > 0.5".
 *   - Spacing is dropped everywhere except between two numerals (a digit or
 *     a single decimal point), where it is part of the answer: "2x + 6" is
 *     "2x+6", but "1 1/2" is not "11/2" and "1 .5" is not "1.5".
 *   - A fraction in parentheses reads as a/b wherever the parentheses change
 *     nothing, the same rule as the text comparison above, and also right
 *     before a letter: the half glyph against x reads as the typed "1/2x".
 *   - Nothing else is forgiven. Trailing zeros count ("3.40" is not "3.4"),
 *     fraction form counts ("6/8" is not "3/4", "1 1/2" is not "3/2"), and
 *     so do an assignment ("x = 4" is not "4"), a percent sign ("75%" is not
 *     "0.75"), a power ("2^4" is not "16"), expansion ("3(x+2)" is not
 *     "3x+6"), order ("x+1" is not "1+x"), units ("5 cm" is not "5") and
 *     thousands commas ("1,000" is not "1000").
 *   - The two must also match by value, so exact form never accepts an
 *     answer equivalent() refuses. An empty answer never matches.
 *
 * gradeSlip scores the reader's answer against the key with each question's
 * match setting. The reviewer's transcription is checked against the
 * reader's, and a disagreement puts an asterisk on the cell. Two reads that
 * would score differently against the key always disagree, on either kind
 * of question. On a value question two reads that score the same disagree
 * only when they differ in value: a reader's "6/8" and a reviewer's "3/4"
 * are not flagged there (both right against a key of 3/4, both wrong against
 * 1/2). Matching each other by value is not enough on its own, because it
 * does not chain: "5 cm" matches "5", yet against a key of "5 in" only "5"
 * scores, so that pair is flagged. On an exact-form question they disagree
 * when they differ as text (case, spacing around symbols, the minus sign and
 * dashes aside) or in exact form, so "6/8" and "3/4" are flagged there.
 * Two blanks agree; a blank and an answer never do.
 *
 * Named limits, not fixed here:
 *   - A value question ignores the form an item asks for (simplify, convert,
 *     expand, factor, evaluate, scientific notation, rounding place, write as
 *     a power): "6/8" matches a key of 3/4, and "4^2" matches a key of 2^4.
 *     A question where the form is the point is set to exact form.
 *   - A multi-letter unit on one side is ignored ("12cm" matches 12), and so
 *     "2mg" matches 2 although a physics answer may mean 2*m*g.
 *   - Lowercasing merges case-distinct units: "5 Mm" matches "5 mm".
 *   - A spaced single-letter unit on one side is ignored when the other side
 *     has no variables: "4 h" matches 4 and "6 s^2" matches 6, although a
 *     reader who put a space into "4h" or "6s^2" meant algebra.
 *   - "1/2x" reads as (1/2)x, never 1/(2x), so it matches "x/2".
 *   - Differences below float resolution are not seen: catastrophic
 *     cancellation ("10^15 + 0.3 - 10^15" matches 0.5), sums with a term
 *     of 10^14 or more ("x + 10^14" matches "x + 10^14 + 10^-6"), and a
 *     power so high that it is past 2^53 at every sample point beyond 1 and
 *     too small to move the sum at the points near zero ("x^723 - 42"
 *     matches "5x^423 - 42").
 *   - An unevaluated difference of fractions ("1/2 - 1/4") reads as a range
 *     and does not match its value. E-notation ("2e3") and a computed step
 *     of 2^53 or more ("2^64" against its digits) compare as written. A
 *     calculator display ("0.3333333333") does not match an exact value.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.grade = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var math = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('../vendor/math.js')
    : root.math;
  if (!math || typeof math.parse !== 'function') {
    // Fail loud: grading without math.js would silently mark "2(x+3)" wrong.
    throw new Error('TABot.grade needs vendor/math.js loaded first');
  }

  // Longer answers are never parsed. The cap also bounds parse-tree depth, so
  // the recursive walk below needs no separate depth guard.
  var MAX_PARSE = 200;
  // The most one rounding moves a double, as a share of it: 2^-53.
  var ROUNDING = 1.1102230246251565e-16;
  // Two computed values match when they differ by no more than this many
  // times the sum of their rounding bounds. Float noise, never a fixed share:
  // 1e-9 let "22/7" match "3.142857146", and any fixed share either lets a
  // large constant hide the rest of an answer or marks a right factoring
  // wrong where a sample point sits near a root. An absolute floor made every
  // value under it equal to 0 ("6.4 x 10^-13" matched "0").
  var NOISE_FACTOR = 4;
  // 2^53. From here up a double skips whole numbers, so no step may reach it.
  var EXACT_LIMIT = 9007199254740992;
  // A written power of ten past this is not expanded into digits.
  var MAX_EXPONENT = 400;
  var BLANK = '(blank)';
  var NO_NAME = '(no name)';

  // ---------------------------------------------------------------- normalize

  var CHAR_MAP = {
    '\u2212': '-', '\u2013': '-', '\u2012': '-', '\u2010': '-', '\u2011': '-',
    '\ufe63': '-', '\uff0d': '-',
    '\u2044': '/', '\u2215': '/', '\u00f7': '/',
    '\u00d7': '*', '\u22c5': '*', '\u2217': '*', '\u00b7': '*',
    '\u00ba': '\u00b0',
    // A teacher types >= on a keyboard; the reader returns the handwritten
    // sign. Both are the same relation, compared as written.
    '\u2265': '>=', '\u2264': '<=', '\u2260': '!=',
    '\u03c0': ' pi ',
    '\u2026': '...'
  };
  var CHAR_RE = new RegExp('[' + Object.keys(CHAR_MAP).join('') + ']', 'g');

  var VULGAR = {
    '\u00bd': '1/2', '\u2153': '1/3', '\u2154': '2/3', '\u00bc': '1/4',
    '\u00be': '3/4', '\u2155': '1/5', '\u2156': '2/5', '\u2157': '3/5',
    '\u2158': '4/5', '\u2159': '1/6', '\u215a': '5/6', '\u2150': '1/7',
    '\u215b': '1/8', '\u215c': '3/8', '\u215d': '5/8', '\u215e': '7/8',
    '\u2151': '1/9', '\u2152': '1/10'
  };
  var GLYPHS = Object.keys(VULGAR).join('');
  var VULGAR_RE = new RegExp('[' + GLYPHS + ']', 'g');
  // A digit right before a glyph makes a mixed number: "1" and the half glyph
  // becomes "1 1/2", which mixedNumbers reads as 1 + 1/2.
  var MIXED_GLYPH_RE = new RegExp('(\\d)\\s*([' + GLYPHS + '])', 'g');

  var SUPER = {
    '\u2070': '0', '\u00b9': '1', '\u00b2': '2', '\u00b3': '3', '\u2074': '4',
    '\u2075': '5', '\u2076': '6', '\u2077': '7', '\u2078': '8', '\u2079': '9',
    '\u207b': '-'
  };
  var SUPER_RE = new RegExp('[' + Object.keys(SUPER).join('') + ']+', 'g');

  // A run of superscripts is one exponent: 2 with the superscripts 5, minus,
  // 3 is 2^(5-3), never 2^5 - 3. A plain integer needs no parentheses, so
  // "x^2" and "10^-13" read as they always have.
  function superscript(run) {
    var exponent = run.split('').map(function (c) { return SUPER[c]; }).join('');
    return /^-?\d+$/.test(exponent) ? '^' + exponent : '^(' + exponent + ')';
  }

  function mapChars(s) {
    s = s
      .replace(CHAR_RE, function (c) { return CHAR_MAP[c]; })
      .replace(SUPER_RE, superscript);
    // Times before the glyphs expand, while a glyph still sits against its
    // x: "2 x" and the half glyph is a product of two numbers.
    s = timesX(s);
    return s
      .replace(MIXED_GLYPH_RE, function (m, digit, c) { return digit + ' ' + VULGAR[c]; })
      // Parentheses keep the fraction whole: 9 to the half-glyph power is
      // 9^(1/2), 3 divided by the glyph is 3/(1/2), the glyph squared is
      // (1/2)^2, and the glyph against h is (1/2)h, half of h.
      .replace(VULGAR_RE, function (c) { return '(' + VULGAR[c] + ')'; })
      .replace(/\u221a\s*\(/g, 'sqrt(')
      .replace(/\u221a\s*(\d+(?:\.\d+)?|[a-z])/g, 'sqrt($1)');
  }

  // The answer is one number with thousands commas: an optional sign, an
  // optional $, 3-digit comma groups after a first group that does not start
  // with 0 (no thousands number is written "0,500"), decimals, and a trailing
  // unit made of letters (no digits, so "1,000 and 2" and "1,000, 2,000"
  // never qualify).
  var ONE_NUMBER_RE = new RegExp(
    '^[+-]?\\s*(?:\\$\\s*[+-]?\\s*)?[1-9]\\d{0,2}(?:,\\d{3})+(?:\\.\\d+)?' +
    '(?:\\s*[a-z\\u00b0\\u00a2%][a-z\\u00b0\\u00a2%.\\s]*(?:\\^\\s*[23])?)?$');

  // A leading single-variable assignment ("x = "), the same shape
  // splitAssignment strips later. The one-number test reads what follows it,
  // so "x = 1,000" is x = 1000 while "x = 2, 100" and "x = (1,120)" keep
  // their commas.
  var ASSIGNMENT_RE = /^([a-z]?\s*=\s*)([^=]+)$/;

  function dropThousandsCommas(s) {
    var eq = ASSIGNMENT_RE.exec(s);
    var head = eq ? eq[1] : '';
    var body = eq ? eq[2] : s;
    return ONE_NUMBER_RE.test(body) ? head + body.replace(/,/g, '') : s;
  }

  // x between two digits is times ("3 x 10^4", "2x3"), and so is x between a
  // digit and a fraction glyph. Run after the superscripts map and before the
  // glyphs expand; "2x", "x^2" and "2x+6" have no digit on both sides and
  // keep their x.
  var TIMES_X_RE = new RegExp('([\\d' + GLYPHS + ']\\s*)x(?=\\s*[\\d' + GLYPHS + '])', 'g');

  function timesX(s) {
    return s.replace(TIMES_X_RE, '$1*');
  }

  function mixedNumbers(s) {
    var whole = /^([+-]?)\s*(\d+) (\d+)\s*\/\s*(\d+)$/.exec(s);
    if (whole) {
      var sum = whole[2] + '+' + whole[3] + '/' + whole[4];
      return whole[1] === '-' ? '-(' + sum + ')' : sum;
    }
    // Inside a longer expression the mixed number needs its own parentheses,
    // or "3 1/2 * 2" would become 3 + 1/2*2.
    return s.replace(/(^|[^\d.\/^])(\d+) (\d+)\/(\d+)(?![\d.])/g, '$1($2+$3/$4)');
  }

  // The characters a term ends with: a letter, a digit, a closing bracket,
  // a percent sign or the degree sign.
  var TERM_END = 'a-z0-9)\\]}%\\u00b0';
  // One period after the end of a term ends a sentence: "12.", "Yes.",
  // "75%.", "(2, 3)." and "90" with the degree sign and a period. Two or
  // more dots are an ellipsis and part of the answer: "0.333..." is not
  // 0.333, since the dot before the last one is not the end of a term.
  var SENTENCE_END_RE = new RegExp('([' + TERM_END + '])\\.$');
  // A decimal point that starts a number gets its zero: ".75" is "0.75", and
  // so is the ".5" in "-.5", "$.50", "x > .5", "(.5, 2)" and "{.5, 1}". A
  // point right after the end of a term or another point, with or without a
  // space between, does not start a number and keeps its form: "1 .5" is not
  // "1 0.5", and "x.5" and "0.333..." stay as written. s has single spaces.
  var START_POINT_RE = new RegExp('(^|[^' + TERM_END + '.\\s] ?)\\.(?=\\d)', 'g');

  function normalize(answer) {
    if (answer === null || answer === undefined) return '';
    var s = String(answer).toLowerCase();
    s = mapChars(s);
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(SENTENCE_END_RE, '$1');
    s = s.replace(START_POINT_RE, function (m, before) { return before + '0.'; });
    s = dropThousandsCommas(s);
    s = mixedNumbers(s);
    return s.trim();
  }

  // ------------------------------------------------------- assignment, units

  // A leading "v =" is stripped when v does not appear in the rest, so
  // "x = 4" is 4. When v does appear, as in "x = 2x + 3", the answer is an
  // equation in v (equation: true): it matches only an equation in the same
  // variable with the same right side ("x = 3 + 2x"), never "2x+3".
  function splitAssignment(s) {
    var m = /^([a-z])?\s*=\s*([^=]+)$/.exec(s);
    if (!m) return { name: '', body: s, equation: false };
    var name = m[1] || '';
    var body = m[2].trim();
    return { name: name, body: body, equation: !!name && usesVariable(body, name) };
  }

  // Whether the letter v is a variable in body: it sits in a letter run of up
  // to 3 letters (a product, the way splitLetterRuns reads it), and not in a
  // trailing unit ("t = 5 feet", "h = 3 h"), a function name or pi.
  function usesVariable(body, v) {
    var rest = splitUnit(body).body;
    var su = shortUnit(rest);
    if (su && su.spaced) rest = su.body;
    return (rest.match(/[a-z]+/g) || []).some(function (w) {
      if (Object.prototype.hasOwnProperty.call(FUNCS, w) || FUNCTION_WORD_RE.test(w)) return false;
      if (/^pi[a-z]{0,2}$/.test(w)) w = w.slice(2);
      else if (w.length > 3) return false;
      return w.indexOf(v) >= 0;
    });
  }

  var UNIT_GROUPS = {
    mm: ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'],
    cm: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'],
    km: ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'],
    m: ['meter', 'meters', 'metre', 'metres'],
    in: ['in', 'inch', 'inches'],
    ft: ['ft', 'foot', 'feet'],
    yd: ['yd', 'yds', 'yard', 'yards'],
    mi: ['mi', 'mile', 'miles'],
    mg: ['mg', 'milligram', 'milligrams'],
    g: ['gram', 'grams'],
    kg: ['kg', 'kgs', 'kilogram', 'kilograms'],
    lb: ['lb', 'lbs', 'pound', 'pounds'],
    oz: ['oz', 'ounce', 'ounces'],
    ton: ['ton', 'tons'],
    ml: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
    l: ['liter', 'liters', 'litre', 'litres'],
    gal: ['gal', 'gallon', 'gallons'],
    qt: ['qt', 'quart', 'quarts'],
    pt: ['pt', 'pint', 'pints'],
    cup: ['cup', 'cups'],
    s: ['sec', 'secs', 'second', 'seconds'],
    min: ['min', 'mins', 'minute', 'minutes'],
    h: ['hr', 'hrs', 'hour', 'hours'],
    day: ['day', 'days'],
    wk: ['wk', 'wks', 'week', 'weeks'],
    yr: ['yr', 'yrs', 'year', 'years'],
    deg: ['\u00b0', 'deg', 'degree', 'degrees'],
    $: ['dollar', 'dollars'],
    cent: ['\u00a2', 'cent', 'cents'],
    unit: ['unit', 'units'],
    mph: ['mph'],
    kph: ['kph']
  };
  var UNIT_CANON = {};
  Object.keys(UNIT_GROUPS).forEach(function (canon) {
    UNIT_GROUPS[canon].forEach(function (word) { UNIT_CANON[word] = canon; });
  });
  var UNIT_WORDS = Object.keys(UNIT_CANON).sort(function (a, b) { return b.length - a.length; });

  // A value ending in a digit or ")", then an optional square/cubic prefix, the
  // unit, and an optional power.
  function unitRe(units) {
    return new RegExp(
      '^(.*?[0-9)])\\s*(?:(sq|square|cubic|cu)\\.?\\s*)?(' + units +
      ')(?:\\s*\\^\\s*([23])|\\s+(squared|cubed))?$'
    );
  }
  var UNIT_RE = unitRe(UNIT_WORDS.join('|'));

  // Single-letter abbreviations; each letter is its own canonical name, the
  // same name its long words carry in UNIT_GROUPS ("5 m" and "5 meters" agree).
  var SHORT_UNITS = { m: 'm', g: 'g', l: 'l', s: 's', h: 'h' };
  var SHORT_UNIT_RE = unitRe('[' + Object.keys(SHORT_UNITS).join('') + ']');

  // A plain number: sign, decimal, a/b, a * 10^k, the "(a/b)" a fraction
  // glyph becomes, or the "(a+b/c)" a mixed number becomes. Never a sum or
  // product with anything else ("3 + 2 m").
  var NUM = '(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  var PLAIN_NUMBER_RE = new RegExp('^[+-]?\\s*(?:' + NUM +
    '(?:\\s*\\/\\s*' + NUM + '|\\s*\\*\\s*10\\s*\\^\\s*[+-]?\\d+)?|\\(' +
    NUM + '\\/' + NUM + '\\)|\\(' + NUM + '\\+' + NUM + '\\/' + NUM + '\\))$');

  function unitOf(m, canon) {
    var power = '';
    if (m[4]) power = '^' + m[4];
    else if (m[5]) power = m[5] === 'squared' ? '^2' : '^3';
    else if (m[2]) power = m[2] === 'cubic' || m[2] === 'cu' ? '^3' : '^2';
    return { body: m[1].trim(), unit: canon + power };
  }

  function splitUnit(s) {
    var money = /^([+-]?)\s*\$\s*(.+)$/.exec(s);
    if (money) return { body: (money[1] + money[2]).trim(), unit: '$' };
    var m = UNIT_RE.exec(s);
    if (!m) return { body: s, unit: '' };
    return unitOf(m, UNIT_CANON[m[3]]);
  }

  // {body, unit, spaced} when s is a plain number followed by m, g, l, s or h;
  // else null. spaced: whitespace sets the letter (or its sq/cubic prefix)
  // apart from the number, as in "12 m", never "12m".
  function shortUnit(s) {
    var m = SHORT_UNIT_RE.exec(s);
    if (!m || !PLAIN_NUMBER_RE.test(m[1].trim())) return null;
    var su = unitOf(m, SHORT_UNITS[m[3]]);
    su.spaced = /\s/.test(s.charAt(m[1].length));
    return su;
  }

  // A trailing m, g, l, s or h is a unit when the OTHER side names the same
  // unit in a form that cannot be algebra: a unit word ("12 meters") or a
  // letter set apart by a space ("12 m"). A spaced letter is also a unit when
  // the other side has no variables ("12 m" matches "12"). A letter written
  // against its number ("5m") is otherwise algebra, so a key of "5m" never
  // accepts a bare "5": a wrong answer marked right is the worse mistake.
  // Both sides are judged from the pair as it stood before this split, so the
  // result is symmetric.
  function splitShortUnits(ua, ub) {
    var sa = ua.unit ? null : shortUnit(ua.body);
    var sb = ub.unit ? null : shortUnit(ub.body);
    function named(u, su) {
      return u.unit || (su && su.spaced ? su.unit : '');
    }
    function variableFree(u, su) {
      if (su && su.spaced) return true;
      var an = analyze(u.body);
      return !!an && an.vars.length === 0;
    }
    function side(u, su, other, otherSu) {
      if (!su) return u;
      if (su.unit === named(other, otherSu)) return su;
      if (!su.spaced) return u;
      // "5 m" vs "5m": the other side names this unit, so it reads as m too.
      if (otherSu && otherSu.unit === su.unit) return su;
      return variableFree(other, otherSu) ? su : u;
    }
    return [side(ua, sa, ub, sb), side(ub, sb, ua, sa)];
  }

  // ------------------------------------------------ whitelisted tree compiler

  // Thrown by a compiled answer (never by math.js) when a step leaves it with
  // no value there: UNDEFINED for a step that is not a finite number (a
  // division by zero, the root of a negative, so no NaN^0 = 1 and no
  // x/Infinity = 0), IMPRECISE for a step of 2^53 or more, a non-zero value
  // that underflows to 0, or a divisor its own rounding could make 0.
  var UNDEFINED = { reason: 'not a number' };
  var IMPRECISE = { reason: 'past what a double holds exactly' };

  // Every step of a compiled answer is {v, e}: the double v, and e, a bound on
  // how far the roundings so far can have moved it from the exact value of
  // what was written. Whole numbers and sample points are exact (e = 0), and
  // whole arithmetic on exact whole numbers stays exact; a decimal literal is
  // off by at most one rounding; any other operation adds its own rounding
  // and carries its inputs' bounds forward. A bound of one half or more means
  // the step could stand for either of two whole numbers ("4503599627370496
  // + 0.5" rounds back to 4503599627370496), so it is not trusted.
  function step(v, e) {
    if (typeof v !== 'number' || !isFinite(v)) throw UNDEFINED;
    if (Math.abs(v) >= EXACT_LIMIT || !(e < 0.5)) throw IMPRECISE;
    return { v: v, e: e };
  }

  // A zero made from non-zero inputs is an underflow, not a zero.
  function noUnderflow(r, nonZeroInputs) {
    if (r === 0 && nonZeroInputs) throw IMPRECISE;
    return r;
  }

  function rounded(v) {
    return ROUNDING * Math.abs(v);
  }

  function whole(v) {
    return Math.floor(v) === v;
  }

  // Both inputs exact whole numbers: a whole sum, difference or product below
  // 2^53 is exact.
  function exactWholes(a, b) {
    return a.e === 0 && b.e === 0 && whole(a.v) && whole(b.v);
  }

  // An exact whole number to an exact whole power, by multiplication, so the
  // result is exact below 2^53 whatever the engine's pow does.
  function wholePower(base, exponent) {
    if (exponent === 0) return 1;
    if (base === 0 || base === 1) return base;
    if (base === -1) return exponent % 2 ? -1 : 1;
    if (exponent > 53) throw IMPRECISE;
    var r = 1;
    for (var i = 0; i < exponent; i++) {
      r *= base;
      if (Math.abs(r) >= EXACT_LIMIT) throw IMPRECISE;
    }
    return r;
  }

  var OPS = {
    add: function (a, b) {
      var v = a.v + b.v;
      return step(v, exactWholes(a, b) ? 0 : a.e + b.e + rounded(v));
    },
    subtract: function (a, b) {
      var v = a.v - b.v;
      return step(v, exactWholes(a, b) ? 0 : a.e + b.e + rounded(v));
    },
    multiply: function (a, b) {
      var v = noUnderflow(a.v * b.v, a.v !== 0 && b.v !== 0);
      return step(v, exactWholes(a, b) ? 0
        : Math.abs(a.v) * b.e + Math.abs(b.v) * a.e + a.e * b.e + rounded(v));
    },
    divide: function (a, b) {
      if (b.v === 0) throw UNDEFINED;
      if (b.e >= Math.abs(b.v)) throw IMPRECISE;
      var v = noUnderflow(a.v / b.v, a.v !== 0);
      if (exactWholes(a, b) && whole(v) && v * b.v === a.v) return step(v, 0);
      return step(v, (a.e + Math.abs(v) * b.e) / (Math.abs(b.v) - b.e) + rounded(v));
    },
    pow: function (a, b) {
      if (a.v === 0 && b.v < 0) throw UNDEFINED;
      if (exactWholes(a, b) && b.v >= 0) return step(wholePower(a.v, b.v), 0);
      var v = noUnderflow(Math.pow(a.v, b.v), a.v !== 0);
      // First order: a share e/|a| of the base moves a^b by b times that
      // share, and e of the exponent moves it by ln|a| times e. The library
      // pow itself is allowed one unit in the last place.
      var e = a.v === 0
        ? (a.e > 0 && b.v > 0 ? Math.pow(a.e, b.v) : 0)
        : Math.abs(v) * (Math.abs(b.v) * a.e / Math.abs(a.v) +
          Math.abs(Math.log(Math.abs(a.v))) * b.e);
      return step(v, e + 2 * rounded(v));
    },
    unaryMinus: function (a) { return { v: -a.v, e: a.e }; },
    unaryPlus: function (a) { return a; }
  };
  var FUNCS = {
    sqrt: function (a) {
      var v = Math.sqrt(a.v);
      return step(v, (v > 0 ? a.e / (2 * v) : Math.sqrt(a.e)) + rounded(v));
    },
    abs: function (a) { return { v: Math.abs(a.v), e: a.e }; }
  };

  function reject() { throw new Error('not allowed'); }

  // A symbol name becomes a list of factors: 'pi' or single letters.
  function symbolFactors(name) {
    if (/^[a-z]$/.test(name)) return [name];
    if (name === 'pi') return ['pi'];
    if (/^pi[a-z]{1,2}$/.test(name)) return ['pi'].concat(name.slice(2).split(''));
    if (/^[a-z]{2,3}$/.test(name)) return name.split('');
    return reject();
  }

  function product(fns) {
    return function (env) {
      var r = { v: 1, e: 0 };
      for (var i = 0; i < fns.length; i++) r = OPS.multiply(r, fns[i](env));
      return r;
    };
  }

  var PI = { v: Math.PI, e: ROUNDING * Math.PI };

  function symbolFn(name, vars) {
    var fns = symbolFactors(name).map(function (f) {
      if (f === 'pi') return function () { return PI; };
      vars[f] = true;
      return function (env) { return { v: env[f], e: 0 }; };
    });
    return fns.length === 1 ? fns[0] : product(fns);
  }

  function compileNode(node, vars) {
    switch (node.type) {
      case 'ConstantNode': {
        if (typeof node.value !== 'number') return reject();
        var v = node.value;
        // A whole literal is exact; "0.1" is one rounding off.
        var e = Math.floor(v) === v ? 0 : rounded(v);
        return function () { return step(v, e); };
      }
      case 'ParenthesisNode':
        return compileNode(node.content, vars);
      case 'SymbolNode':
        return symbolFn(node.name, vars);
      case 'OperatorNode': {
        var op = Object.prototype.hasOwnProperty.call(OPS, node.fn) ? OPS[node.fn] : null;
        if (!op) return reject();
        var nary = node.fn === 'add' || node.fn === 'multiply';
        var count = node.args.length;
        if (nary ? count < 2 : count !== op.length) return reject();
        var args = node.args.map(function (a) { return compileNode(a, vars); });
        if (count === 1) return function (env) { return op(args[0](env)); };
        return function (env) {
          var r = args[0](env);
          for (var i = 1; i < args.length; i++) r = op(r, args[i](env));
          return r;
        };
      }
      case 'FunctionNode': {
        if (!node.fn || node.fn.type !== 'SymbolNode' || node.args.length !== 1) return reject();
        var name = node.fn.name;
        var arg = compileNode(node.args[0], vars);
        if (Object.prototype.hasOwnProperty.call(FUNCS, name)) {
          var f = FUNCS[name];
          return function (env) { return f(arg(env)); };
        }
        // "x(x+1)" parses as a call of x; in a math answer it is x times (x+1).
        return product([symbolFn(name, vars), arg]);
      }
      default:
        return reject();
    }
  }

  // Letter runs are split into factors BEFORE parsing: math.js reads "2xy^2"
  // as 2*(xy)^2, which would square x too. Runs longer than 3 letters are left
  // whole, and symbolFactors rejects them, so the answer compares as text.
  function splitLetterRuns(s) {
    return s.replace(/[a-z]+/g, function (w) {
      if (w === 'pi' || Object.prototype.hasOwnProperty.call(FUNCS, w)) return w;
      if (/^pi[a-z]{1,2}$/.test(w)) return 'pi ' + w.slice(2).split('').join(' ');
      if (w.length <= 3) return w.split('').join(' ');
      return w;
    });
  }

  // ------------------------------------------- products of written numbers

  // A product of plain numbers ("3 * 4" from "3 x 4", "2 * 1/2", "3*4*5") is
  // a size or an unevaluated product, never a value, so it is compared as
  // text. Scientific notation, one plain number times a power of ten
  // ("3 * 10^4"), is the one exception and is evaluated. This is a string
  // test because math.js reads "2 * 1/2" as (2*1)/2, which hides the product.
  var FACTOR = '(?:[+-]?\\s*(?:' + NUM + '(?:\\s*\\/\\s*' + NUM + ')?|\\(' +
    NUM + '\\+' + NUM + '\\/' + NUM + '\\))|\\(\\s*[+-]?\\s*' + NUM +
    '(?:\\s*\\/\\s*' + NUM + ')?\\s*\\))';
  var POWER_OF_TEN = '10\\s*\\^\\s*(?:[+-]?\\d+|\\(\\s*[+-]?\\d+\\s*\\))';
  var ANY_FACTOR = '(?:' + FACTOR + '|' + POWER_OF_TEN + ')';
  var NUMBER_PRODUCT_RE = new RegExp('^' + ANY_FACTOR + '(?:\\s*\\*\\s*' + ANY_FACTOR + ')+$');
  var SCIENTIFIC_RE = new RegExp('^' + FACTOR + '\\s*\\*\\s*' + POWER_OF_TEN + '$');
  // A fraction in parentheses, the way a fraction glyph is written out.
  var PAREN_FRACTION_RE = new RegExp('\\(\\s*([+-]?\\s*' + NUM + '\\s*\\/\\s*' + NUM + ')\\s*\\)', 'g');

  // A node without its parentheses and leading sign: "-(3)" is read as 3.
  function bare(node) {
    for (;;) {
      if (node.type === 'ParenthesisNode') node = node.content;
      else if (node.type === 'OperatorNode' && node.args.length === 1 &&
        (node.fn === 'unaryMinus' || node.fn === 'unaryPlus')) node = node.args[0];
      else return node;
    }
  }

  // The factors of a product, flattened: "3 f t x 4" gives 3, f, t, x, 4.
  function factorsOf(node, out) {
    node = bare(node);
    if (node.type === 'OperatorNode' && node.fn === 'multiply') {
      node.args.forEach(function (a) { factorsOf(a, out); });
    } else if (node.type === 'FunctionNode' && node.fn && node.fn.type === 'SymbolNode' &&
      !Object.prototype.hasOwnProperty.call(FUNCS, node.fn.name) && node.args.length === 1) {
      // "x(4)" is x times 4, as compileNode reads it.
      out.push(node.fn);
      factorsOf(node.args[0], out);
    } else {
      out.push(node);
    }
    return out;
  }

  function isConstant(node) {
    return bare(node).type === 'ConstantNode';
  }

  // A written number as a factor: a number, a fraction of two numbers (the
  // "(1/2)" a fraction glyph becomes) or a mixed number ("(1+1/2)").
  function writtenFactor(node) {
    node = bare(node);
    if (node.type === 'ConstantNode') return true;
    if (node.type !== 'OperatorNode' || node.args.length !== 2) return false;
    if (node.fn === 'divide') return isConstant(node.args[0]) && isConstant(node.args[1]);
    if (node.fn !== 'add' || !isConstant(node.args[0])) return false;
    var part = bare(node.args[1]);
    return part.type === 'OperatorNode' && part.fn === 'divide' && part.args.length === 2 &&
      isConstant(part.args[0]) && isConstant(part.args[1]);
  }

  // How many written numbers the answer's top-level product multiplies. Two or
  // more makes it an unevaluated product whatever letters sit between them:
  // "3 by 4" (3*b*y*4), "3 ft x 4 ft" and "5 ft 3 in" would otherwise equal
  // "2 by 6", "2 ft x 6 ft" and "3 ft 5 in". A fraction or a mixed number is
  // a written number too, and numbers side by side count the same: two
  // fraction glyphs with a space between become "(1/2) (1/2)", which math.js
  // reads as 1/4, and "12(3/4)x" is no more 9x than "12(3)x" is 36x. A power
  // of ten is not a written number here, so "3 * 10^4 m" is still a value.
  function numbersMultiplied(tree) {
    return factorsOf(tree, []).filter(writtenFactor).length;
  }

  // One number with a single trailing percent sign: a decimal ("12.5%",
  // "-50 %"), the "(a/b)" a fraction glyph becomes ("(1/2)%"), or the
  // "(a+b/c)" a mixed number becomes ("(12+1/2)%" from "12 1/2%"), alone or
  // in one pair of parentheses ("(50%)"). A bare "1/2%" is not one number:
  // math.js reads it as 1/(2%).
  var PERCENT_NUMBER = '[+-]?\\s*(?:' + NUM + '|\\(\\s*[+-]?\\s*' + NUM + '\\s*\\/\\s*' +
    NUM + '\\s*\\)|\\(' + NUM + '\\+' + NUM + '\\/' + NUM + '\\))\\s*%';
  var PERCENT_RE = new RegExp('^(?:' + PERCENT_NUMBER + '|[+-]?\\s*\\(\\s*' +
    PERCENT_NUMBER + '\\s*\\))$');
  // A digit, e or E, an optional sign and a digit: calculator E-notation,
  // which math.js reads as a number although e is a variable here.
  var E_NOTATION_RE = /[0-9.]e[+-]?[0-9]/;
  // A function name at the end of a letter run, whatever letters are glued
  // in front of it ("yln", "aln", "xsin"; ln and lg also run into their
  // argument, as in "lnx"). splitLetterRuns would turn a run of up to 3
  // letters into a product of letters, so "sin(2x)" would equal "2sin(x)"
  // and "yln(x)" would equal "xln(y)". Longer runs (arcsin, sinh) are text
  // already.
  var FUNCTION_WORD_RE = new RegExp('(?:sin|cos|tan|sec|csc|cot|log|exp|' +
    'min|max|mod|gcd|lcm|det|sgn|arg|ln[a-z]?|lg[a-z]?)(?![a-z])');

  // Returns {vars: sorted names, fn} or null when the answer is not math.
  function analyze(s) {
    if (!s || s.length > MAX_PARSE) return null;
    // Plain words are text; a lone letter (or pi) is still math.
    if (!/[0-9+\-*\/^()%]/.test(s) && !/^([a-z]|pi)$/.test(s)) return null;
    if (/(^|[^0-9.])0[xbo]/.test(s)) return null;   // no hex/binary/octal literals
    if (E_NOTATION_RE.test(s)) return null;
    // math.js reads "a + b%" as a*(1 + b/100) and drops what follows a stray
    // "%", so only a lone percentage is a value.
    if (s.indexOf('%') >= 0 && !PERCENT_RE.test(s)) return null;
    if (FUNCTION_WORD_RE.test(s)) return null;
    if (NUMBER_PRODUCT_RE.test(s) && !SCIENTIFIC_RE.test(s)) return null;
    try {
      var vars = {};
      var tree = math.parse(splitLetterRuns(s));
      if (numbersMultiplied(tree) >= 2) return null;
      var fn = compileNode(tree, vars);
      return { vars: Object.keys(vars).sort(), fn: fn };
    } catch (e) {
      return null;
    }
  }

  // The value of a compiled answer at env: {v, e}, or UNDEFINED or IMPRECISE
  // when a step leaves it with no value there.
  function valueAt(an, env) {
    try {
      return an.fn(env);
    } catch (e) {
      return e === IMPRECISE ? IMPRECISE : UNDEFINED;
    }
  }

  // ------------------------------------------------- written numbers, ranges

  // A written number: a sign, a decimal, and an optional "* 10^k", or a bare
  // "10^k". Groups: 1 sign, 2 digits, 3 or 4 the exponent after the digits,
  // 5 or 6 the exponent of a bare power.
  var EXPONENT = '10\\s*\\^\\s*(?:([+-]?\\d+)|\\(\\s*([+-]?\\d+)\\s*\\))';
  var WRITTEN_RE = new RegExp('^([+-]?)\\s*(?:(' + NUM + ')(?:\\s*\\*\\s*' +
    EXPONENT + ')?|' + EXPONENT + ')$');

  // One number of a range (every dash is "-" by now): a sign, then a
  // decimal, a/b, the "(a/b)" a fraction glyph becomes or the "(a+b/c)" a
  // mixed number becomes, then an optional percent sign ("70%-79%").
  // Groups: 1 sign, 2 the number, 3 the percent sign.
  var RANGE_NUMBER = NUM + '(?:\\s*\\/\\s*' + NUM + ')?|\\(' + NUM + '\\/' + NUM +
    '\\)|\\(' + NUM + '\\+' + NUM + '\\/' + NUM + '\\)';
  var RANGE_PART_RE = new RegExp('^([+-]?)\\s*(' + RANGE_NUMBER + ')\\s*(%?)');
  var RANGE_DASH_RE = /^\s*-\s*/;

  // One bound of a range that carries a unit: a sign, an optional $, a range
  // number, then a unit word (the degree and cent signs among them) or m, g,
  // l, s or h set apart by a space, then an optional power. Groups: 1 sign,
  // 2 the $, 3 the number, 4 a unit word, 5 a spaced letter, 6 the power.
  var UNIT_BOUND_RE = new RegExp('^([+-]?)\\s*(\\$)?\\s*(' + RANGE_NUMBER + ')' +
    '(?:\\s*(' + UNIT_WORDS.join('|') + ')(?![a-z])|\\s+([' +
    Object.keys(SHORT_UNITS).join('') + '])(?![a-z]))?(?:\\s*\\^\\s*([23]))?');

  function zeros(n) {
    return new Array(n + 1).join('0');
  }

  // The exact decimal text of sign, digits times 10^exp: no leading or
  // trailing zeros, "-" only on a non-zero value. Strings only, never floats,
  // so two numerals that differ in any digit never meet. null past
  // MAX_EXPONENT.
  function exactDecimal(sign, digitsText, exp) {
    if (!isFinite(exp) || Math.abs(exp) > MAX_EXPONENT) return null;
    var dot = digitsText.indexOf('.');
    var whole = dot < 0 ? digitsText : digitsText.slice(0, dot);
    var digits = whole + (dot < 0 ? '' : digitsText.slice(dot + 1));
    var point = whole.length + exp;
    if (point < 1) {
      digits = zeros(1 - point) + digits;
      point = 1;
    }
    if (point > digits.length) digits += zeros(point - digits.length);
    var intPart = digits.slice(0, point).replace(/^0+(?=\d)/, '');
    var frac = digits.slice(point).replace(/0+$/, '');
    var out = frac ? intPart + '.' + frac : intPart;
    return sign === '-' && out !== '0' ? '-' + out : out;
  }

  // The exact decimal text of a written number ("1,000,000,000" with its
  // commas already dropped, "10^9" and "1 x 10^9" all give "1000000000");
  // false for a written number past MAX_EXPONENT, which has no digits to
  // compare; null when s is not a written number.
  function writtenNumber(s) {
    var m = WRITTEN_RE.exec(s);
    if (!m) return null;
    var exp = m[3] || m[4] || m[5] || m[6] || '0';
    var text = exactDecimal(m[1], m[2] || '1', parseInt(exp, 10));
    return text === null ? false : text;
  }

  // One range number as written: "1.50" is "1.5", the glyph's "(1/2)" is
  // "1/2" and a mixed number's "(1+1/2)" is "1 1/2".
  function rangeNumber(sign, text) {
    var inner = text.replace(/^\(|\)$/g, '');
    var whole = '';
    var plus = inner.indexOf('+');
    if (plus >= 0) {
      whole = exactDecimal('', inner.slice(0, plus), 0) + ' ';
      inner = inner.slice(plus + 1);
    }
    var out = whole + inner.split('/').map(function (p) {
      return exactDecimal('', p.trim(), 0);
    }).join('/');
    return sign === '-' && out !== '0' ? '-' + out : out;
  }

  // The text of a range, score or record, number by number ("0.5 - 1.50"
  // gives "0.5-1.5", "1 1/2 - 2" gives "1 1/2-2"), or null when s is not two
  // or more plain numbers joined by dashes and nothing else.
  function rangeText(s) {
    var parts = [];
    var rest = s;
    for (;;) {
      var m = RANGE_PART_RE.exec(rest);
      if (!m) return null;
      parts.push(rangeNumber(m[1], m[2]) + m[3]);
      rest = rest.slice(m[0].length);
      if (!rest) break;
      var dash = RANGE_DASH_RE.exec(rest);
      if (!dash) return null;
      rest = rest.slice(dash[0].length);
    }
    return parts.length >= 2 ? parts.join('-') : null;
  }

  // A range whose every bound carries the same unit ("10 s - 20 s",
  // "1 m - 2 m", "$5 - $10", "10 deg - 20 deg"): {body, unit}, the body the
  // bare range ("10-20"), which rangeText then reads as a range; or null. A
  // spaced letter on every bound makes it a unit, so "2 m - 3 m" is never
  // the algebra -m, and every range of one width does not match every other.
  function unitRange(s) {
    var parts = [];
    var unit = null;
    var rest = s;
    for (;;) {
      var m = UNIT_BOUND_RE.exec(rest);
      if (!m) return null;
      var u = (m[2] || '') + (m[4] ? UNIT_CANON[m[4]] : m[5] ? SHORT_UNITS[m[5]] : '');
      if (!u) return null;
      if (m[6]) u += '^' + m[6];
      if (unit !== null && u !== unit) return null;
      unit = u;
      parts.push(m[1] + m[3]);
      rest = rest.slice(m[0].length);
      if (!rest) break;
      var dash = RANGE_DASH_RE.exec(rest);
      if (!dash) return null;
      rest = rest.slice(dash[0].length);
    }
    return parts.length >= 2 ? { body: parts.join('-'), unit: unit } : null;
  }

  // Two computed values {v, e} (both below 2^53, as step guarantees):
  // identical; or both non-zero, not both whole, and apart by no more than
  // NOISE_FACTOR times the sum of their rounding bounds. Zero matches only
  // zero, two whole numbers must be equal, and a value half a unit or more
  // from a whole number is never that number ("999999999/2" is not
  // 500000000). A constant cannot swamp the bound: 10^10 adds only its own
  // rounding, about 10^-6, so "x^2 + 10^10" does not match "x + 10^10".
  function close(x, y) {
    var a = x.v;
    var b = y.v;
    if (a === b) return true;
    if (a === 0 || b === 0) return false;
    var wholeA = Math.floor(a) === a;
    var wholeB = Math.floor(b) === b;
    if (wholeA && wholeB) return false;
    var gap = Math.abs(a - b);
    if ((wholeA || wholeB) && gap >= 0.5) return false;
    return gap <= NOISE_FACTOR * (x.e + y.e);
  }

  function hasValue(r) {
    return r !== UNDEFINED && r !== IMPRECISE;
  }

  // Seventeen fixed non-integer points of both signs. Eight sit within 3 of
  // zero (the first five, then -2.2173, 0.3719 and 1.9031), so an answer
  // defined only near zero ("sqrt(4-x^2)", "sqrt(4x-x^2)") has three or
  // more usable points. The rest reach out to about -103 and 211, so a sign
  // change far from zero ("abs(x+8)", "abs(x-30)", "sqrt((x-53)^2)") is
  // seen. A second variable takes the next point along, shifted by 0.1373,
  // so two variables never share a value and the pairs meet every mix of
  // signs: both negative at -7.3129 and at -103.2917, so "sqrt(x)*sqrt(y)"
  // does not match "sqrt(xy)"; x above y at five pairs, so "sqrt(x-y)" has
  // usable points; and x - y below -60 at -31.4441, so "abs(x-y+27)" does
  // not match "x-y+27".
  var SAMPLES = [0.5377, -1.3077, 1.8339, -0.4336, 2.7694,
    -7.3129, -2.2173, 0.3719, 1.9031, 5.6287, 11.9043, 23.7011,
    -103.2917, -31.4441, 31.1213, 47.5383, 211.3319];

  function sampleEnv(i, names) {
    var env = Object.create(null);
    names.forEach(function (n, j) {
      env[n] = SAMPLES[(i + j) % SAMPLES.length] + 0.1373 * j;
    });
    return env;
  }

  // true/false, or null when fewer than 3 points are usable. Every usable
  // point must agree. A point where only one side has a value is a
  // difference ("sqrt(x)^2" and x at -2.2); a point where both sides have
  // none, or where either is IMPRECISE, is skipped.
  function sampleCompare(ax, ay) {
    var used = 0;
    for (var i = 0; i < SAMPLES.length; i++) {
      var env = sampleEnv(i, ax.vars);
      var vx = valueAt(ax, env);
      var vy = valueAt(ay, env);
      if (vx === IMPRECISE || vy === IMPRECISE) continue;
      if (vx === UNDEFINED && vy === UNDEFINED) continue;
      if (vx === UNDEFINED || vy === UNDEFINED || !close(vx, vy)) return false;
      used++;
    }
    return used >= 3 ? true : null;
  }

  function sameVars(a, b) {
    return a.length === b.length && a.every(function (v, i) { return v === b[i]; });
  }

  // Text comparison ignores spaces around symbols: "x > 3" equals "x>3". A
  // single "." keeps its spaces, since "1 .5" (1 times .5) is not 1.5; the
  // dots of an ellipsis do not ("0.333 ..." equals "0.333...").
  function textForm(s) {
    return s.replace(/(\s*)([^a-z0-9\s])(\s*)/g, function (m, before, c, after, at) {
      var pos = at + before.length;
      var single = c === '.' && s.charAt(pos - 1) !== '.' && s.charAt(pos + 1) !== '.';
      return single ? m : c;
    });
  }

  // The nearest character of s before index i (going back) or from index i
  // (going forward) that is not a space; '' past either end.
  function nonSpace(s, i, step) {
    while (i >= 0 && i < s.length && /\s/.test(s.charAt(i))) i += step;
    return s.charAt(i);
  }

  // A fraction in parentheses reads the same as a/b wherever the parentheses
  // change nothing, so the "(1/2)" a fraction glyph becomes matches a typed
  // 1/2: "x > 1/2", "(1/2, 2)", "1/3 cup flour", "1/2%". They stay after ^
  // or / (a sign between counts through: "2^-(1/2)"), before ^, and right
  // against a letter, digit or point, a ")" before or a "(" after, where
  // they are part of the reading ("9^(1/2)", "3/(1/2)", "(1/2)^2", "(1/2)x",
  // "(1/2)(1/2)").
  function looseFractions(s) {
    return s.replace(PAREN_FRACTION_RE, function (m, fraction, at) {
      var end = at + m.length;
      if (/[a-z0-9.)]/.test(s.charAt(at - 1)) || /[a-z0-9.(]/.test(s.charAt(end))) return m;
      var i = at - 1;
      while (i >= 0 && /\s/.test(s.charAt(i))) i--;
      var prev = s.charAt(i);
      if (prev === '+' || prev === '-') prev = nonSpace(s, i - 1, -1);
      if (prev === '^' || prev === '/' || nonSpace(s, end, 1) === '^') return m;
      return fraction;
    });
  }

  // In an answer that names a function, a space or * between a letter, digit
  // or ")" and the next letter, digit or "(" does not count: "2sin(x)",
  // "2 sin(x)" and "2*sin(x)" read the same, and so do "xln(x)" and
  // "x ln(x)". Between two digits it stays ("2 3" is not 23), a * before a
  // sign stays ("sin(x)*-1"), and so does anything beside a point.
  function functionText(s) {
    return s.replace(/([a-z0-9)])(?:\s+|\*)(?=[a-z0-9(])/g, function (m, before, at) {
      return /\d/.test(before) && /\d/.test(s.charAt(at + m.length)) ? m : before;
    });
  }

  // The text an answer that is not a value compares by: textForm, with a
  // fraction in parentheses read as a/b where that changes nothing, and in
  // an answer that names a function, spaces and * between factors dropped.
  function asWritten(s) {
    s = textForm(looseFractions(s));
    return FUNCTION_WORD_RE.test(s) ? functionText(s) : s;
  }

  // The text an answer that is not a value compares by. In a product of plain
  // numbers a fraction factor reads the same with or without parentheses, so
  // "2 x" and the half glyph ("2 * (1/2)") still matches "2*1/2".
  function writtenText(s) {
    if (NUMBER_PRODUCT_RE.test(s)) s = s.replace(PAREN_FRACTION_RE, '$1');
    return asWritten(s);
  }

  function compareBodies(x, y) {
    if (x === y) return true;
    // A range or score is never evaluated: "70-79" is not -9, so it can only
    // match the same range.
    var rx = rangeText(x);
    var ry = rangeText(y);
    if (rx !== null || ry !== null) return rx === ry;
    // Two written numbers compare digit by digit; no tolerance is needed. One
    // past MAX_EXPONENT has no digits, so it compares as written: "10^-401"
    // must not underflow to 0.
    var wx = writtenNumber(x);
    var wy = writtenNumber(y);
    if (wx === false || wy === false) return asWritten(x) === asWritten(y);
    if (wx !== null && wy !== null) return wx === wy;
    var ax = analyze(x);
    var ay = analyze(y);
    if (ax && ay && sameVars(ax.vars, ay.vars)) {
      if (ax.vars.length === 0) {
        var vx = valueAt(ax, Object.create(null));
        var vy = valueAt(ay, Object.create(null));
        if (hasValue(vx) && hasValue(vy)) return close(vx, vy);
      } else {
        var r = sampleCompare(ax, ay);
        if (r !== null) return r;
      }
    }
    return writtenText(x) === writtenText(y);
  }

  function equivalent(a, b) {
    try {
      var na = normalize(a);
      var nb = normalize(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      if (na.length > MAX_PARSE || nb.length > MAX_PARSE) return asWritten(na) === asWritten(nb);
      var sa = splitAssignment(na);
      var sb = splitAssignment(nb);
      if (sa.equation !== sb.equation) return asWritten(na) === asWritten(nb);
      if (sa.name && sb.name && sa.name !== sb.name) return false;
      var split = splitShortUnits(unitRange(sa.body) || splitUnit(sa.body),
        unitRange(sb.body) || splitUnit(sb.body));
      var ua = split[0];
      var ub = split[1];
      if (ua.unit && ub.unit && ua.unit !== ub.unit) return false;
      // A percent never matches a side that carries a unit: "$0.25" is an
      // amount and "25%" a rate, although both are 0.25. Two percents
      // compare as usual.
      if ((ua.body.indexOf('%') >= 0) !== (ub.body.indexOf('%') >= 0) &&
        (ua.unit || ub.unit)) return false;
      if (!ua.body || !ub.body) return false;
      return compareBodies(ua.body, ub.body);
    } catch (e) {
      return false;
    }
  }

  // --------------------------------------------------------------- exact form

  // A digit, or a single decimal point (never a dot of an ellipsis), at i.
  function numeral(s, i) {
    var c = s.charAt(i);
    if (/\d/.test(c)) return true;
    return c === '.' && s.charAt(i - 1) !== '.' && s.charAt(i + 1) !== '.';
  }

  // Spacing is dropped, except a space between two numerals, which is part
  // of the answer: "1 1/2" is not "11/2", "2 3" is not 23 and "1 .5" is not
  // 1.5. s has single spaces only.
  function formSpacing(s) {
    return s.replace(/ /g, function (space, at) {
      return numeral(s, at - 1) && numeral(s, at + 1) ? ' ' : '';
    });
  }

  // A decimal point with no digit before it gets its zero: ".75" is "0.75",
  // "-.5" is "-0.5" and "$.50" is "$0.50". A point after a kept space ("1 .5")
  // is not the start of a number and keeps its form.
  var BARE_POINT_RE = /(^|[^0-9. ])\.(?=\d)/g;

  // A fraction in parentheses (the "(a/b)" a fraction glyph becomes, or one
  // typed that way) reads as a/b wherever the parentheses change nothing:
  // they stay after ^ or / (a sign between counts through), before ^, after
  // a letter, digit, point or ")", and before a digit, point or "(". Before a
  // letter they go, so the half glyph against x is the typed "1/2x".
  function formFractions(s) {
    return s.replace(PAREN_FRACTION_RE, function (m, fraction, at) {
      var end = at + m.length;
      var before = s.charAt(at - 1);
      var after = s.charAt(end);
      if (/[a-z0-9.)]/.test(before) || /[0-9.(]/.test(after)) return m;
      if (before === '+' || before === '-') before = s.charAt(at - 2);
      if (before === '^' || before === '/' || after === '^') return m;
      return fraction;
    });
  }

  // The text an exact-form question compares: case and the look-alike
  // characters read the way normalize reads them, a sentence-ending period
  // dropped, then spacing, a bare decimal point and a fraction in
  // parentheses as above. Unlike normalize it keeps thousands commas and
  // never rewrites a mixed number as a sum, since both are form.
  function exactText(answer) {
    if (answer === null || answer === undefined) return '';
    var s = mapChars(String(answer).toLowerCase());
    s = s.replace(/\s+/g, ' ').trim().replace(SENTENCE_END_RE, '$1');
    s = formSpacing(s).replace(BARE_POINT_RE, function (m, before) {
      return before + '0.';
    });
    return formFractions(s);
  }

  // true when the answer is written the way the key is (see the header) and
  // matches it by value. Never true where equivalent() is false.
  function exactForm(answer, key) {
    try {
      var a = exactText(answer);
      if (!a || a !== exactText(key)) return false;
      return equivalent(answer, key);
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------------ grading

  // Question numbers a free-text note refers to: "Q3", "question 2 and 4",
  // "#5", "Q2-4" (a range). Numbers outside 1..count are ignored. A hyphen is
  // a range only with no spaces around it ("Q2-4") or with q/# on the second
  // number ("Q2 - Q4"); in "Q2 - 3 or 8?" it is a dash and only Q2 is named.
  function questionsMentioned(note, count) {
    var found = {};
    if (!note) return found;
    var text = String(note).toLowerCase().slice(0, 1000);
    var prefix = '(?:(?:q|#)\\s*)';
    var sep = '(?:\\s*(?:,|and|&|\\/|to|through)\\s*' + prefix + '?' +
      '|-' + prefix + '?' +
      '|\\s*-\\s*' + prefix + ')';
    var re = new RegExp(
      '(?:^|[^a-z0-9])(?:q|questions?|problems?|items?|#)\\s*\\.?\\s*#?\\s*' +
      '(\\d{1,3}(?:' + sep + '\\d{1,3})*)', 'g');
    var m;
    while ((m = re.exec(text)) !== null) {
      var tokens = m[1].match(/\d{1,3}|-|to|through/g) || [];
      var prev = null;
      var ranging = false;
      tokens.forEach(function (t) {
        if (!/^\d/.test(t)) { ranging = prev !== null; return; }
        var n = parseInt(t, 10);
        if (ranging && n > prev && n - prev <= 50) {
          for (var k = prev + 1; k < n; k++) found[k] = true;
        }
        found[n] = true;
        prev = n;
        ranging = false;
      });
    }
    Object.keys(found).forEach(function (k) {
      if (k < 1 || k > count) delete found[k];
    });
    return found;
  }

  function answerFor(reading, q) {
    var list = reading && Array.isArray(reading.answers) ? reading.answers : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].q) === q) return list[i];
    }
    return null;
  }

  function text(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function shown(v) {
    return text(v) === '' ? BLANK : text(v);
  }

  function pointsOf(question) {
    if (!question || question.points === undefined || question.points === null || question.points === '') return 1;
    var p = Number(question.points);
    return isFinite(p) && p >= 0 ? p : 1;
  }

  // The same text after normalize and the text spacing rule: case, spaces
  // around symbols, the minus sign, dashes and thousands commas do not count.
  function sameRead(a, b) {
    return textForm(normalize(a)) === textForm(normalize(b));
  }

  // A question's match setting: 'exact' only when the key says so, 'value'
  // for anything else, including a saved key with no match field.
  function matchOf(question) {
    return question && question.match === 'exact' ? 'exact' : 'value';
  }

  // Whether an answer scores against the key under a match setting.
  function scores(answer, keyAnswer, match) {
    return match === 'exact' ? exactForm(answer, keyAnswer) : equivalent(answer, keyAnswer);
  }

  // Whether the reader's and reviewer's transcriptions agree. Two reads that
  // would score differently against the key never agree, on either kind of
  // question. Past that, two blanks agree and a blank never agrees with an
  // answer. On a value question the two must also match each other by value:
  // "6/8" and "3/4" agree there (both right against a key of 3/4, both wrong
  // against 1/2), while "5 cm" and "5 in" do not, although both match a key
  // of 5. Matching each other is not enough on its own, because matching by
  // value does not chain: "5 cm" matches "5", yet against a key of "5 in"
  // only "5" scores. On an exact-form question they agree only when they are
  // the same text and the same exact form, so "6/8" and "3/4" (or "1,000"
  // and "1000") are flagged there.
  function readsAgree(a, b, match, keyAnswer) {
    if (scores(a, keyAnswer, match) !== scores(b, keyAnswer, match)) return false;
    if (match === 'exact') return sameRead(a, b) && exactText(a) === exactText(b);
    if (normalize(a) === '' && normalize(b) === '') return true;
    return equivalent(a, b);
  }

  function gradeSlip(opts) {
    opts = opts || {};
    var key = opts.key || { questions: [] };
    var reading = opts.reading || {};
    var review = opts.review || null;
    var lowConfidence = opts.lowConfidence === undefined ? 0.7 : opts.lowConfidence;
    var questions = Array.isArray(key.questions) ? key.questions : [];
    var mentioned = questionsMentioned(reading.note, questions.length);

    var answers = questions.map(function (question, i) {
      var q = i + 1;
      var r = answerFor(reading, q);
      var read = text(r && r.answer);
      var confidence = r && isFinite(Number(r.confidence)) ? Number(r.confidence) : 0;
      var v = review ? answerFor(review, q) : null;
      var reviewRead = review ? text(v && v.answer) : null;
      var maxPoints = pointsOf(question);
      var match = matchOf(question);
      var keyAnswer = question && question.answer;
      var correct = scores(read, keyAnswer, match);

      var reasons = [];
      if (review && !readsAgree(read, reviewRead, match, keyAnswer)) {
        reasons.push('reader ' + shown(read) + ', reviewer ' + shown(reviewRead));
      }
      if (confidence < lowConfidence) reasons.push('low confidence ' + confidence.toFixed(2));
      if (mentioned[q]) reasons.push('reader note mentions it');

      return {
        q: q,
        read: read,
        reviewRead: reviewRead,
        confidence: confidence,
        correct: correct,
        points: correct ? maxPoints : 0,
        maxPoints: maxPoints,
        flagged: reasons.length > 0,
        reason: reasons.join('; ')
      };
    });

    var readerName = text(reading.student_name);
    var reviewerName = review ? text(review.student_name) : '';
    var nameFlag = readerName === '' ||
      (review !== null && normalize(readerName) !== normalize(reviewerName));
    var studentName = readerName || reviewerName || NO_NAME;

    var notes = [];
    if (text(reading.note)) notes.push('Reader note: ' + text(reading.note));
    if (review && text(review.note)) notes.push('Reviewer note: ' + text(review.note));
    if (!review) notes.push('No second read: answers were not cross-checked.');
    if (nameFlag) {
      notes.push(review
        ? 'Name: reader ' + shown(readerName) + ', reviewer ' + shown(reviewerName)
        : 'Name: reader ' + shown(readerName));
    }
    answers.forEach(function (a) { if (a.flagged) notes.push('Q' + a.q + ': ' + a.reason); });

    var score = 0;
    var maxScore = 0;
    answers.forEach(function (a) { score += a.points; maxScore += a.maxPoints; });

    return {
      studentName: studentName,
      nameFlag: nameFlag,
      answers: answers,
      score: score,
      maxScore: maxScore,
      flagged: nameFlag || !review || answers.some(function (a) { return a.flagged; }),
      notes: notes.join('\n'),
      reviewMode: opts.reviewMode || (review ? 'two-model' : 'none')
    };
  }

  // ------------------------------------------------------------------ summary

  var BUCKETS = ['0-9%', '10-19%', '20-29%', '30-39%', '40-49%',
    '50-59%', '60-69%', '70-79%', '80-89%', '90-100%'];

  function percentOf(row) {
    var max = Number(row && row.maxScore);
    var score = Number(row && row.score);
    if (!isFinite(max) || max <= 0 || !isFinite(score)) return 0;
    return score * 100 / max;
  }

  function median(sorted) {
    if (sorted.length === 0) return 0;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function summarize(rows, key, opts) {
    rows = Array.isArray(rows) ? rows : [];
    opts = opts || {};
    var passPercent = Number(opts.passPercent !== undefined ? opts.passPercent
      : (key && key.passPercent !== undefined ? key.passPercent : 70));
    if (!isFinite(passPercent)) passPercent = 70;
    var questionCount = key && Array.isArray(key.questions) ? key.questions.length : 0;
    var n = rows.length;

    var percents = rows.map(percentOf);
    var total = percents.reduce(function (s, p) { return s + p; }, 0);
    var passed = percents.filter(function (p) { return p + 1e-9 >= passPercent; }).length;

    var perQuestion = [];
    for (var q = 1; q <= questionCount; q++) {
      var hits = rows.filter(function (row) {
        var a = row && Array.isArray(row.answers) ? row.answers[q - 1] : null;
        return !!(a && a.correct);
      }).length;
      perQuestion.push({ q: q, hitRate: n ? hits * 100 / n : 0 });
    }

    var counts = BUCKETS.map(function () { return 0; });
    percents.forEach(function (p) {
      counts[Math.max(0, Math.min(9, Math.floor((p + 1e-9) / 10)))]++;
    });

    return {
      students: n,
      mean: n ? total / n : 0,
      median: median(percents.slice().sort(function (a, b) { return a - b; })),
      passRate: n ? passed * 100 / n : 0,
      passPercent: passPercent,
      perQuestion: perQuestion,
      distribution: BUCKETS.map(function (b, i) { return { bucket: b, count: counts[i] }; }),
      flaggedRows: rows.filter(function (row) { return !!(row && row.flagged); }).length,
      singleModelRows: rows.filter(function (row) {
        return !!(row && row.reviewMode === 'single-model');
      }).length
    };
  }

  return {
    normalize: normalize,
    equivalent: equivalent,
    exactForm: exactForm,
    gradeSlip: gradeSlip,
    summarize: summarize
  };
});
