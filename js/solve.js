/*
 * TABot.solve: exact arithmetic on a printed question, so a question with no
 * answer key can be graded against an answer code computed, never one a model
 * guessed.
 *
 * Numbers are exact fractions of BigInts ({n, d}, d > 0, lowest terms). No
 * floating point anywhere, so 0.1 + 0.2 is exactly 3/10 and 347 x 26 is
 * exactly 9022, however many digits.
 *
 * What parses (anything else is not arithmetic, and the question is not
 * computed):
 *   - whole numbers, with thousands commas in groups of three ("1,288");
 *     decimals ("2.5", ".5"); a fraction of two whole numbers ("3/4" is read
 *     as one number when it stands alone between operators, which is also
 *     its value as a division); a mixed number, a whole number, a space and
 *     a fraction ("1 1/2"); the one-character fraction glyphs.
 *   - + and the minus signs; *, the times sign, the middle dot, and x between
 *     two numbers; / and the division sign, which never writes a fraction
 *     ("10 \u00f7 4" is a division to compute, while "10/4" standing alone
 *     is one number); ^ with a whole-number exponent
 *     (limits below); parentheses and brackets; a leading minus. A number or
 *     a closing bracket right before an opening bracket multiplies ("2(3+4)").
 *   - A trailing "=", "= ?", "= __" or "?" is dropped, as is a leading
 *     "Solve:", "Find", "Compute", "Evaluate", "Multiply", "Add",
 *     "Subtract", "Divide" or "What is" with its punctuation. ("Simplify"
 *     asks for a form, not a value, so it is kept and the text does not
 *     parse.)
 * Limits: 120 characters, 15 digits in one number, 60 numbers and operators,
 * brackets 6 deep, a whole exponent from -12 to 12, and every result at most
 * 40 digits in its numerator and its denominator; past any of them the
 * question is not computed. So is notation read two ways: a minus sign
 * right before a power ("-3^2"), a power of a power ("2^3^2"), a bracket
 * right after a division or a typed fraction ("8 / 2(2+2)"), and two typed
 * slashes around one number ("12 / 3/4": a division sign read as a slash,
 * or a fraction of a fraction).
 * 0^0 has no value.
 *
 * canonical(value, opts) writes a value the way grade.equivalent reads it:
 * a whole number plainly ("9022"), a terminating value as a decimal when the
 * question used decimals ("2.5"), anything else as a fraction in lowest terms
 * ("7/8", "-3/2").
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.solve = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ZERO = BigInt(0);
  var ONE = BigInt(1);
  var TWO = BigInt(2);
  var FIVE = BigInt(5);
  var TEN = BigInt(10);

  var MAX_CHARS = 120;
  // math.js, the second parser that checks every computed value, reads a
  // number as a double, which holds 15 digits exactly.
  var MAX_NUMBER_DIGITS = 15;
  var MAX_TOKENS = 60;
  var MAX_RESULT_DIGITS = 40;
  var MAX_EXPONENT = 12;
  var MAX_DEPTH = 6;

  var GLYPHS = {
    '\u00bd': [1, 2], '\u2153': [1, 3], '\u2154': [2, 3], '\u00bc': [1, 4], '\u00be': [3, 4],
    '\u2155': [1, 5], '\u2156': [2, 5], '\u2157': [3, 5], '\u2158': [4, 5], '\u2159': [1, 6],
    '\u215a': [5, 6], '\u2150': [1, 7], '\u215b': [1, 8], '\u215c': [3, 8], '\u215d': [5, 8],
    '\u215e': [7, 8], '\u2151': [1, 9], '\u2152': [1, 10]
  };

  // ---------------------------------------------------------------- fractions

  function abs(v) { return v < ZERO ? -v : v; }

  function gcd(a, b) {
    a = abs(a);
    b = abs(b);
    while (b !== ZERO) { var t = a % b; a = b; b = t; }
    return a;
  }

  function frac(n, d) {
    n = BigInt(n);
    d = d === undefined ? ONE : BigInt(d);
    if (d === ZERO) throw new RangeError('division by zero');
    if (d < ZERO) { n = -n; d = -d; }
    var g = gcd(n, d);
    if (g > ONE) { n /= g; d /= g; }
    if (n === ZERO) d = ONE;
    return { n: n, d: d };
  }

  function add(a, b) { return frac(a.n * b.d + b.n * a.d, a.d * b.d); }
  function sub(a, b) { return frac(a.n * b.d - b.n * a.d, a.d * b.d); }
  function mul(a, b) { return frac(a.n * b.n, a.d * b.d); }
  function div(a, b) {
    if (b.n === ZERO) throw new RangeError('division by zero');
    return frac(a.n * b.d, a.d * b.n);
  }
  function neg(a) { return { n: -a.n, d: a.d }; }

  function pow(a, e) {
    var k = Number(e);
    if (!Number.isInteger(k) || Math.abs(k) > MAX_EXPONENT) throw new RangeError('exponent out of range');
    if (k === 0 && a.n === ZERO) throw new RangeError('zero to the power zero');
    if (k < 0) {
      if (a.n === ZERO) throw new RangeError('division by zero');
      return pow(frac(a.d, a.n), -k);
    }
    var n = ONE, d = ONE;
    for (var i = 0; i < k; i++) { n *= a.n; d *= a.d; }
    return frac(n, d);
  }

  function equal(a, b) { return a.n === b.n && a.d === b.d; }
  function isWhole(a) { return a.d === ONE; }
  function isZero(a) { return a.n === ZERO; }
  function compare(a, b) {
    var l = a.n * b.d, r = b.n * a.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  function digits(v) { return abs(v).toString().length; }

  function tooBig(a) {
    return digits(a.n) > MAX_RESULT_DIGITS || digits(a.d) > MAX_RESULT_DIGITS;
  }

  // Whether a/b ends as a decimal: its denominator has no prime but 2 and 5.
  function terminates(a) {
    var d = a.d;
    while (d % TWO === ZERO) d /= TWO;
    while (d % FIVE === ZERO) d /= FIVE;
    return d === ONE;
  }

  // Exact decimal text of a terminating value: "2.5", "-0.125", "12".
  function decimalText(a) {
    if (!terminates(a)) return null;
    if (a.d === ONE) return a.n.toString();
    var places = 0, scale = ONE;
    while (scale % a.d !== ZERO) { scale *= TEN; places++; }
    var scaled = a.n * (scale / a.d);
    var text = abs(scaled).toString();
    while (text.length <= places) text = '0' + text;
    var whole = text.slice(0, text.length - places);
    var part = text.slice(text.length - places).replace(/0+$/, '');
    return (scaled < ZERO ? '-' : '') + whole + (part ? '.' + part : '');
  }

  function fractionText(a) {
    return a.d === ONE ? a.n.toString() : a.n.toString() + '/' + a.d.toString();
  }

  // opts.decimal: write a terminating value as a decimal.
  function canonical(a, opts) {
    if (a.d === ONE) return a.n.toString();
    if (opts && opts.decimal) {
      var dec = decimalText(a);
      if (dec !== null) return dec;
    }
    return fractionText(a);
  }

  // Whole numbers with thousands commas, for a teacher to read: 9022 -> 9,022.
  function withCommas(text) {
    var m = /^(-?)(\d+)(\.\d+)?$/.exec(text);
    if (!m || m[2].length < 5) return text;
    return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[3] || '');
  }

  // ---------------------------------------------------------------- tokens

  var LEAD_WORDS = /^\s*(?:solve|find|compute|evaluate|multiply|add|subtract|divide|calculate|what\s+is)\b\s*(?:the\s+(?:value|product|sum|difference|quotient)\s+of\s*)?[:.,-]?\s*/i;

  function clean(text) {
    var s = String(text === undefined || text === null ? '' : text);
    s = s.replace(/[\u2212\u2012\u2013\u2014\ufe63\uff0d]/g, '-')
      .replace(/[\u00d7\u2715\u2716\u22c5\u00b7\u2219]/g, '*')
      .replace(/\u2215/g, '/')
      .replace(/[\[{]/g, '(').replace(/[\]}]/g, ')')
      .trim();
    s = s.replace(LEAD_WORDS, '');
    s = s.replace(/\s*=\s*(?:\?|_+|\.\.\.)?\s*$/, '').replace(/\s*\?\s*$/, '').trim();
    return s;
  }

  // -> tokens [{t: 'num', value, text, decimal, kind} | {t: 'op', v} | {t: '(' | ')'}] or null.
  function tokenize(s) {
    var out = [], i = 0;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (GLYPHS[c]) {
        var g = GLYPHS[c];
        out.push({ t: 'num', value: frac(g[0], g[1]), text: g[0] + '/' + g[1], decimal: false, kind: 'fraction', glyph: true,
          num: BigInt(g[0]), den: BigInt(g[1]) });
        i++;
        continue;
      }
      if (/[0-9.]/.test(c)) {
        var m = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|^\.\d+/.exec(s.slice(i));
        if (!m) return null;
        var raw = m[0], plain = raw.replace(/,/g, '');
        if (plain.replace('.', '').length > MAX_NUMBER_DIGITS) return null;
        var dot = plain.indexOf('.');
        var value = dot < 0 ? frac(plain) : frac(plain.replace('.', '').replace(/^0+(?=\d)/, '') || '0',
          TEN ** BigInt(plain.length - dot - 1));
        out.push({ t: 'num', value: value, text: plain.charAt(0) === '.' ? '0' + plain : plain, decimal: dot >= 0, kind: dot >= 0 ? 'decimal' : 'whole' });
        i += raw.length;
        continue;
      }
      if (c === 'x' || c === 'X') {
        // x is a times sign only between two numbers (or brackets).
        var prev = out[out.length - 1], rest = s.slice(i + 1).replace(/^\s+/, '');
        // A sign after x counts only when x stands apart with spaces and the
        // sign is attached to its number ("2 x -3"); "4x - 3" and "4x-3"
        // are algebra.
        var spaced = /\s/.test(s.charAt(i - 1)) && /\s/.test(s.charAt(i + 1));
        if (prev && (prev.t === 'num' || prev.t === ')') &&
          (/^[0-9.(\u00bc-\u00be\u2150-\u215e]/.test(rest) || (spaced && /^[-+](?=[0-9.(\u00bc-\u00be\u2150-\u215e])/.test(rest)))) {
          out.push({ t: 'op', v: '*' });
          i++;
          continue;
        }
        return null;
      }
      // The division sign divides; it never writes a fraction.
      if (c === '\u00f7') { out.push({ t: 'op', v: '/', sign: true }); i++; continue; }
      if ('+-*/^'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }
      if (c === '(' || c === ')') { out.push({ t: c }); i++; continue; }
      return null;
    }
    return out.length && out.length <= MAX_TOKENS ? out : null;
  }

  // Two typed slashes around one number ("12 / 3/4", "6/2/3"): a division
  // sign read as a slash, or a fraction over a fraction; read two ways.
  function slashRun(tokens) {
    for (var i = 0; i + 4 < tokens.length; i++) {
      var a = tokens[i + 1], b = tokens[i + 2], c = tokens[i + 3];
      if (tokens[i].t === 'num' && a.t === 'op' && a.v === '/' && !a.sign && b.t === 'num' &&
        c.t === 'op' && c.v === '/' && !c.sign && tokens[i + 4].t === 'num') return true;
    }
    return false;
  }

  // "1 1/2" (whole, space, whole/whole) is one mixed number, and a lone
  // whole/whole is one fraction number; both are found before parsing so the
  // tree keeps them as written numbers.
  function joinFractions(tokens, s) {
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var a = tokens[i], b = tokens[i + 1], c = tokens[i + 2], d = tokens[i + 3];
      var before = out[out.length - 1];
      var afterIdx = i + 3;
      var bar = function (tok) { return tok && tok.t === 'op' && tok.v === '/' && !tok.sign; };
      // A number right after a typed / or ^ belongs to that operator.
      var bound = before && before.t === 'op' && ((before.v === '/' && !before.sign) || before.v === '^');
      var isFrac = a && a.t === 'num' && a.kind === 'whole' && bar(b) &&
        c && c.t === 'num' && c.kind === 'whole';
      // a mixed number: whole, then whole/whole right after it
      if (a && a.t === 'num' && a.kind === 'whole' && b && b.t === 'num' && b.kind === 'whole' &&
        bar(c) && d && d.t === 'num' && d.kind === 'whole' && !bound) {
        if (d.value.n === ZERO) return null;
        var mixed = add(a.value, frac(b.value.n, d.value.n));
        out.push({ t: 'num', value: mixed, text: a.text + ' ' + b.text + '/' + d.text, decimal: false, kind: 'mixed',
          whole: a.value.n, num: b.value.n, den: d.value.n });
        i += 3;
        continue;
      }
      if (isFrac && !bound &&
        !(tokens[afterIdx] && tokens[afterIdx].t === 'op' && tokens[afterIdx].v === '^')) {
        if (c.value.n === ZERO) return null;
        out.push({ t: 'num', value: frac(a.value.n, c.value.n), text: a.text + '/' + c.text, decimal: false, kind: 'fraction',
          num: a.value.n, den: c.value.n });
        i += 2;
        continue;
      }
      out.push(a);
    }
    return out;
  }

  // ---------------------------------------------------------------- parser

  // Precedence climbing. Nodes:
  //   {type: 'num', value, text, decimal, kind, num?, den?, whole?}
  //   {type: 'bin', op: '+' | '-' | '*' | '/' | '^', left, right}
  //   {type: 'neg', arg}
  //   {type: 'group', arg}   (brackets, kept for showing the steps)
  function Ambiguous() {}

  function parseTokens(tokens) {
    var pos = 0, depth = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function primary() {
      var tok = next();
      if (!tok) throw new Error('end');
      if (tok.t === 'num') {
        return { type: 'num', value: tok.value, text: tok.text, decimal: tok.decimal, kind: tok.kind,
          num: tok.num, den: tok.den, whole: tok.whole, glyph: !!tok.glyph };
      }
      if (tok.t === '(') {
        if (++depth > MAX_DEPTH) throw new Error('depth');
        var inner = sum();
        var close = next();
        depth--;
        if (!close || close.t !== ')') throw new Error('bracket');
        return { type: 'group', arg: inner };
      }
      if (tok.t === 'op' && tok.v === '-') {
        var arg = power();
        // "-3^2": is it -(3^2) or (-3)^2? A lost bracket reads the same, so
        // the question is not computed.
        if (arg.type === 'bin' && arg.op === '^') throw new Ambiguous();
        return { type: 'neg', arg: arg };
      }
      if (tok.t === 'op' && tok.v === '+') return power();
      throw new Error('token');
    }

    // ^ binds tighter than a leading minus on its base ("-2^2" is -(2^2)) and
    // is right-associative.
    function power() {
      var base = primary();
      var tok = peek();
      if (tok && tok.t === 'op' && tok.v === '^') {
        next();
        var exp = unaryExponent();
        // 2^3^2 is read two ways by students and textbooks.
        if (exp.type === 'bin' && exp.op === '^') throw new Ambiguous();
        return { type: 'bin', op: '^', left: base, right: exp };
      }
      return base;
    }

    function unaryExponent() {
      var tok = peek();
      if (tok && tok.t === 'op' && tok.v === '-') { next(); return { type: 'neg', arg: power() }; }
      return power();
    }

    function product() {
      var left = power();
      for (;;) {
        var tok = peek();
        if (tok && tok.t === 'op' && (tok.v === '*' || tok.v === '/')) {
          next();
          left = { type: 'bin', op: tok.v, left: left, right: power(), sign: !!tok.sign };
        } else if (tok && tok.t === '(') {
          // implicit multiplication: 2(3+4), (1+2)(3+4); but "8 / 2(2+2)"
          // is read two ways, so it is not computed.
          if ((left.type === 'bin' && left.op === '/') ||
            (left.type === 'num' && (left.kind === 'fraction' || left.kind === 'mixed') && !left.glyph)) throw new Ambiguous();
          left = { type: 'bin', op: '*', left: left, right: power(), implicit: true };
        } else {
          return left;
        }
      }
    }

    function sum() {
      var left = product();
      for (;;) {
        var tok = peek();
        if (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
          next();
          left = { type: 'bin', op: tok.v, left: left, right: product() };
        } else {
          return left;
        }
      }
    }

    var tree = sum();
    if (pos !== tokens.length) throw new Error('trailing');
    return tree;
  }

  function evaluate(node) {
    var v;
    switch (node.type) {
      case 'num': v = node.value; break;
      case 'group': v = evaluate(node.arg); break;
      case 'neg': v = neg(evaluate(node.arg)); break;
      case 'bin': {
        var l = evaluate(node.left), r = evaluate(node.right);
        if (node.op === '+') v = add(l, r);
        else if (node.op === '-') v = sub(l, r);
        else if (node.op === '*') v = mul(l, r);
        else if (node.op === '/') v = div(l, r);
        else {
          if (!isWhole(r)) throw new RangeError('exponent not whole');
          v = pow(l, r.n);
        }
        break;
      }
      default: throw new Error('unknown node');
    }
    if (tooBig(v)) throw new RangeError('too large');
    return v;
  }

  function usesDecimal(node) {
    if (node.type === 'num') return node.decimal;
    if (node.type === 'bin') return usesDecimal(node.left) || usesDecimal(node.right);
    return usesDecimal(node.arg);
  }

  // -> {ok: true, tree, value, answer, decimal} or {ok: false, reason}.
  function compute(text) {
    var s = clean(text);
    if (!s) return { ok: false, reason: 'empty' };
    if (s.length > MAX_CHARS) return { ok: false, reason: 'too long' };
    var tokens = tokenize(s);
    if (!tokens) return { ok: false, reason: 'not arithmetic' };
    if (slashRun(tokens)) return { ok: false, reason: 'ambiguous' };
    tokens = joinFractions(tokens, s);
    if (!tokens) return { ok: false, reason: 'division by zero' };
    var tree;
    try {
      tree = parseTokens(tokens);
    } catch (err) {
      return { ok: false, reason: err instanceof Ambiguous ? 'ambiguous' : 'not arithmetic' };
    }
    // A single number is not a question to compute.
    if (tree.type === 'num' || (tree.type === 'group' && tree.arg.type === 'num')) return { ok: false, reason: 'no operation' };
    var value;
    try {
      value = evaluate(tree);
    } catch (err) {
      return { ok: false, reason: err instanceof RangeError ? err.message : 'not arithmetic' };
    }
    var decimal = usesDecimal(tree);
    return { ok: true, tree: tree, value: value, decimal: decimal, answer: canonical(value, { decimal: decimal }) };
  }

  // A choice's printed text as an exact number, or null: "1,288", "-3",
  // "7/8", "1 1/2", "2.5", "$4.50", "25%" (as 1/4).
  function numberOf(text) {
    var s = clean(text).replace(/^\$\s*/, '');
    var percent = /%$/.test(s);
    if (percent) s = s.slice(0, -1).trim();
    var tokens = tokenize(s);
    if (!tokens) return null;
    var sign = ONE;
    if (tokens[0] && tokens[0].t === 'op' && tokens[0].v === '-') { sign = -ONE; tokens = tokens.slice(1); }
    tokens = joinFractions(tokens, s);
    if (!tokens || tokens.length !== 1 || tokens[0].t !== 'num') return null;
    var v = mul(tokens[0].value, frac(sign));
    return percent ? div(v, frac(100)) : v;
  }

  // ---------------------------------------------------------------- a student's answer

  var REMAINDER_RE = /^(-?\d{1,3}(?:,\d{3})+|-?\d+)\s*(?:r|rem|remainder)\.?\s*(\d+)$/i;

  // A student's answer as one exact number, or null: what numberOf reads,
  // after a leading "=" or "x =" and a trailing period; places is how many
  // digits the student wrote after a decimal point. "13 R 1" (also r, rem,
  // remainder) is a quotient and remainder.
  function answerValue(text) {
    var s = String(text === undefined || text === null ? '' : text).trim()
      .replace(/^(?:[a-z]\s*)?=\s*/i, '').replace(/\.$/, '').trim();
    if (!s) return null;
    var m = REMAINDER_RE.exec(s);
    if (m) return { remainder: { q: BigInt(m[1].replace(/,/g, '')), r: BigInt(m[2]) } };
    var v = numberOf(s);
    if (!v) return null;
    var dec = /\.(\d+)\s*%?$/.exec(s.replace(/,/g, ''));
    return { value: v, places: dec ? dec[1].length : 0 };
  }

  // The value rounded half away from zero, or cut off, to places decimals.
  function toPlaces(v, places, cut) {
    var scale = TEN ** BigInt(places);
    var n = v.n * scale, q = n / v.d, r = n % v.d;
    if (!cut && abs(r) * TWO >= v.d) q += n < ZERO ? -ONE : ONE;
    return frac(q, scale);
  }

  // A whole number divided by a whole number with the division sign (or a
  // bar between two whole numbers): {n, d}, else null.
  function wholeDivision(tree) {
    if (!tree || tree.type !== 'bin' || tree.op !== '/') return null;
    var l = tree.left, r = tree.right;
    if (l.type !== 'num' || r.type !== 'num' || l.kind !== 'whole' || r.kind !== 'whole') return null;
    return { n: l.value.n, d: r.value.n };
  }

  // Whether a student's answer is the value code computed for a question
  // (result of compute): {match, nearMiss}, or null when the answer is not
  // one number (the caller compares it another way). A quotient and
  // remainder matches a whole-number division when q x d + r = n and
  // 0 <= r < d. nearMiss: a decimal answer that is the value rounded or cut
  // off to the places the student wrote; it is not a match, and the cell is
  // flagged so the teacher can say whether rounding was asked for.
  function accepts(answer, computed) {
    var a = answerValue(answer);
    if (!a) return null;
    if (a.remainder) {
      var div = wholeDivision(computed.tree);
      var ok = !!div && div.d > ZERO && a.remainder.r < div.d &&
        a.remainder.q * div.d + a.remainder.r === div.n;
      return { match: ok, nearMiss: false };
    }
    if (equal(a.value, computed.value)) return { match: true, nearMiss: false };
    var near = a.places > 0 && (equal(a.value, toPlaces(computed.value, a.places)) ||
      equal(a.value, toPlaces(computed.value, a.places, true)));
    return { match: false, nearMiss: near };
  }

  // ---------------------------------------------------------------- multiple choice

  // A choice label as printed, compared without brackets, points or case:
  // "(b)", "B.", "b)" -> "B".
  function normLabel(label) {
    return String(label === undefined || label === null ? '' : label)
      .replace(/[\s().:\[\]]/g, '').toUpperCase();
  }

  // A choice's printed text as an exact value: one number, or arithmetic
  // solve.compute works out ("23 x 47"). null for anything else.
  function choiceValue(text) {
    var v = numberOf(text);
    if (v) return v;
    var r = compute(text);
    return r.ok ? r.value : null;
  }

  function normText(text) {
    return String(text === undefined || text === null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function labeled(choices) {
    return choices.length > 0 && choices.every(function (c) { return normLabel(c.label) !== ''; });
  }

  // Labels that are digits could be read as a choice's value, so they are
  // never compared by value.
  function digitLabels(choices) {
    return choices.some(function (c) { return /^\d+$/.test(normLabel(c.label)); });
  }

  // The one choice that is target: {label}, {value} (an exact value) or
  // {text}. -> its index, or -1 when none or more than one is.
  function findChoice(choices, target) {
    var hits = [];
    choices.forEach(function (c, i) {
      var hit = false;
      if (target.label !== undefined) hit = normLabel(target.label) !== '' && normLabel(c.label) === normLabel(target.label);
      else if (target.value) { var v = choiceValue(c.text); hit = !!v && equal(v, target.value); }
      else if (target.text !== undefined) hit = normText(target.text) !== '' && normText(c.text) === normText(target.text);
      if (hit) hits.push(i);
    });
    return hits.length === 1 ? hits[0] : -1;
  }

  // What a student marked on a multiple-choice question, from the answer as
  // read and the paper's choices:
  //   {index}        one choice
  //   {two: true}    more than one choice marked
  //   {none: true}   nothing marked (a blank answer)
  //   {unknown: true} a mark that names no choice on the paper
  // With labeled choices the answer must name a label; with unlabeled ones
  // it must be one choice's text, or its value when that is unique.
  function resolveMark(answer, choices) {
    var text = String(answer === undefined || answer === null ? '' : answer).trim();
    if (!text) return { none: true };
    if (labeled(choices)) {
      var one = findChoice(choices, { label: text });
      if (one >= 0) return { index: one };
      // An answer written as a choice's whole text ("3/4", "1,388"), before
      // it is split into marks, so a fraction or a comma is never two marks.
      var byText = findChoice(choices, { text: text });
      if (byText >= 0) return { index: byText };
      var parts = text.split(/\s*(?:,|;|&|\/|\band\b)\s*/i).filter(Boolean);
      var found = [];
      var allLabels = parts.length > 1 && parts.every(function (part) {
        var i = findChoice(choices, { label: part });
        if (i >= 0 && found.indexOf(i) < 0) found.push(i);
        return i >= 0;
      });
      if (allLabels) return found.length > 1 ? { two: true } : { index: found[0] };
      if (!digitLabels(choices)) {
        var v = choiceValue(text);
        var byValue = v ? findChoice(choices, { value: v }) : -1;
        if (byValue >= 0) return { index: byValue };
      }
      return { unknown: true };
    }
    var t = findChoice(choices, { text: text });
    if (t >= 0) return { index: t };
    var value = choiceValue(text);
    var iv = value ? findChoice(choices, { value: value }) : -1;
    return iv >= 0 ? { index: iv } : { unknown: true };
  }

  // The choice an AI answer names: a label ("B", "(b)", "B) 42"), for
  // unlabeled choices the bracketed number the solver was shown ("(2)"), the
  // choice's text or its value, and only then a bare number as a position,
  // when no choice's text or value is that number. -> index, or -1.
  function choiceNamed(answer, choices) {
    var t = String(answer === undefined || answer === null ? '' : answer).trim();
    if (!t || !choices || !choices.length) return -1;
    var unlabeled = !labeled(choices);
    var bracket = /^\(?(\d+)\)$/.exec(t);
    if (unlabeled && bracket) {
      var b = Number(bracket[1]) - 1;
      return b >= 0 && b < choices.length ? b : -1;
    }
    var lead = /^\(?([A-Za-z]|\d{1,2})\s*[).:]\s+(.+)$/.exec(t);
    if (lead && !unlabeled) {
      var li = findChoice(choices, { label: lead[1] });
      if (li >= 0) return li;
    }
    var mark = resolveMark(t, choices);
    if (unlabeled && /^\d+$/.test(t)) {
      // A bare number on unlabeled choices is a position or a value; when
      // the two name different choices it names neither.
      var k = Number(t) - 1;
      var pos = k >= 0 && k < choices.length ? k : -1;
      if (mark.index !== undefined && pos >= 0 && mark.index !== pos) return -1;
      return mark.index !== undefined ? mark.index : pos;
    }
    if (mark.index !== undefined) return mark.index;
    return -1;
  }

  // ---------------------------------------------------------------- the gate

  // Words a question may carry around its arithmetic and still ask for
  // nothing but the value. Any other word (round, estimate, nearest,
  // simplify, lowest, compare, greater, less, closest, digit, place, factor,
  // remainder, of, and anything unknown) means the question asks for more
  // than the value, so it is not computed. Unknown words fail closed.
  var ALLOWED_WORDS = ('multiply divide add subtract solve find compute calculate evaluate work out ' +
    'what is the a value product sum difference quotient total answer show your all work ' +
    'use using standard algorithm method write each problem question below following these ' +
    'partial products area model lattice long division column ' +
    'box space blank line here in on to your final circle circled ' +
    'which choose select pick mark correct one option options letter').split(' ');
  var ALLOWED = {};
  ALLOWED_WORDS.forEach(function (w) { ALLOWED[w] = true; });

  // Text as a key for comparing printed math: signs mapped, thousands
  // commas dropped, and spaces dropped around operators and brackets (so
  // "347 x 26" and "347*26" match), kept elsewhere as one space (so
  // "Multiply. 347" keeps its sentence apart from the number, while in
  // "Find .5" the point still touches it).
  function mathKey(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/[\u2212\u2012\u2013\u2014\ufe63\uff0d]/g, '-')
      .replace(/[\u00d7\u2715\u2716\u22c5\u00b7\u2219]/g, '*')
      .replace(/\u2215/g, '/')
      .replace(/[\[{]/g, '(').replace(/[\]}]/g, ')')
      .replace(/(\d)\s*[xX]\s*(?=[\d(])/g, '$1*')
      .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
      .replace(/\s+/g, ' ')
      .replace(/\s*([*\/\u00f7+\-^=()])\s*/g, '$1')
      .trim();
  }

  // Whether a printed question asks for exactly the value of the
  // expression read from it: the expression appears in the question as
  // printed (spacing, thousands commas and the look of the signs aside; the
  // division sign is never the same as a slash), and every word left around
  // it is on the allowed list. Any other symbol left over (a minus sign, %,
  // |, !, $, a root or a power) fails closed, the same as an unknown word. A
  // question number or letter at the start ("3.", "Q3)", "b)") is set aside
  // first, never the whole part of a decimal ("12.5 - 3").
  function asksForValue(question, expression) {
    var q = String(question === undefined || question === null ? '' : question)
      .replace(/^\s*(?:q(?:uestion)?\s*)?(?:\d{1,3}|[a-h])\s*[.):](?!\d)\s*/i, '');
    var e = mathKey(expression);
    if (!e) return false;
    var k = mathKey(q);
    var at = k.indexOf(e);
    if (at < 0) return false;
    // The expression must not be part of a longer number: no digit or point
    // right before it (".5 x 4" read as "5 x 4"), and no digit, or point and
    // digit, right after it.
    var before = k.charAt(at - 1), after = k.slice(at + e.length, at + e.length + 2);
    if (/[\d.]/.test(before) || /^\d|^\.\d/.test(after)) return false;
    // what is left once the expression is cut out: plain punctuation, then
    // words from the allowed list and nothing else
    var rest = k.slice(0, at) + ' ' + k.slice(at + e.length);
    if (/[^A-Za-z0-9\s=?_.:,;()"'\u2026]/.test(rest)) return false;
    if (/\d/.test(rest)) return false;
    rest = rest.replace(/[=?_.:,;()"'\u2026]+/g, ' ');
    var words = rest.toLowerCase().match(/[a-z]+/g) || [];
    return words.every(function (w) { return ALLOWED[w] === true; });
  }

  return {
    frac: frac,
    add: add,
    sub: sub,
    mul: mul,
    div: div,
    pow: pow,
    neg: neg,
    equal: equal,
    compare: compare,
    isWhole: isWhole,
    isZero: isZero,
    terminates: terminates,
    canonical: canonical,
    decimalText: decimalText,
    fractionText: fractionText,
    withCommas: withCommas,
    clean: clean,
    compute: compute,
    evaluate: evaluate,
    asksForValue: asksForValue,
    normLabel: normLabel,
    choiceValue: choiceValue,
    findChoice: findChoice,
    resolveMark: resolveMark,
    choiceNamed: choiceNamed,
    answerValue: answerValue,
    accepts: accepts,
    wholeDivision: wholeDivision,
    mathKey: mathKey,
    numberOf: numberOf
  };
});
