/*
 * TABot.exemplar: worked solutions for the Exemplars tab, built and checked
 * by code, never by a model.
 *
 * build({expression, method, choices, keyAnswer}) takes a question's printed
 * arithmetic (see solve.js for what parses) and returns either
 *   {ok: true, method, question, rows, answer}
 * where rows is an array of rows for the sheet (each an array of cell
 * strings), or
 *   {ok: false, reason}
 * with a plain sentence saying why there is no exemplar.
 *
 * Every number shown is computed with exact BigInt fractions, and every
 * exemplar passes check() before it is returned: each step is recomputed a
 * second way (a partial product by one multiplication, a running sum by one
 * addition, a rewritten expression by evaluating it again) and the final
 * answer must equal solve.evaluate of the whole question. With a key, the
 * key must match that value, or there is no exemplar. A failed check means
 * no exemplar, with the reason "TABot's check of the worked steps failed",
 * never a wrong one.
 *
 * Layouts, chosen by the shape of the question and the method most of the
 * class used:
 *   - two whole numbers or decimals multiplied: the standard algorithm, one
 *     digit to a cell like a printed grid, a partial product per nonzero
 *     digit of the lower number, then their sum; or partial products (every
 *     place-value part times every part), or an area model (the same parts
 *     in a grid). Lattice is not laid out: without cell borders its boxes
 *     would read as fractions. Decimals are multiplied as whole numbers and
 *     the decimal point is placed after.
 *   - whole numbers or decimals added or subtracted, two to six of them, all
 *     positive and every running total positive: the column method, one digit
 *     to a cell, with the carries or borrows named.
 *   - a whole number divided by a whole number with the division sign: long
 *     division, one step per digit brought down, then the quotient and
 *     remainder and the exact value.
 *   - two fractions or mixed numbers added, subtracted, multiplied or
 *     divided: the fraction steps (common denominator, multiply across, or
 *     multiply by the reciprocal), then lowest terms and a mixed number.
 *   - anything else solve.js computes: order of operations, one operation per
 *     step.
 * Multiple choice: the stem worked as above, then the one choice whose value
 * matches.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.exemplar = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var S = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./solve.js')
    : root.TABot && root.TABot.solve;
  if (!S) throw new Error('TABot.exemplar needs js/solve.js loaded first');

  var ZERO = BigInt(0);
  var ONE = BigInt(1);
  var TEN = BigInt(10);
  var TIMES = '\u00d7';
  var DIVIDE = '\u00f7';
  // A grid wider than this many digits is not laid out one digit to a cell.
  var MAX_GRID_DIGITS = 16;

  function big(v) { return BigInt(v); }
  function abs(v) { return v < ZERO ? -v : v; }
  function pow10(k) { return TEN ** big(k); }
  function commas(text) { return S.withCommas(String(text)); }

  function fail(reason) { return { ok: false, reason: reason }; }

  var CHECK_FAILED = 'TABot\'s check of the worked steps failed, so no exemplar is shown.';

  // A failed invariant throws this, and build turns it into CHECK_FAILED.
  function CheckError() {}
  function must(ok) { if (!ok) throw new CheckError(); }

  // ---------------------------------------------------------------- numbers as digits

  // A non-negative whole number or decimal node -> {int: BigInt of all its
  // digits, places: digits after the point}. 3.47 -> {347n, 2}.
  function scaled(node) {
    if (node.type !== 'num' || (node.kind !== 'whole' && node.kind !== 'decimal')) return null;
    var text = node.text;
    var dot = text.indexOf('.');
    var places = dot < 0 ? 0 : text.length - dot - 1;
    var digits = text.replace('.', '').replace(/^0+(?=\d)/, '');
    return { int: big(digits), places: places };
  }

  // Exact decimal text of int / 10^places, keeping every place: (9022, 3) -> 9.022.
  function placeText(int, places) {
    var t = abs(int).toString();
    if (!places) return (int < ZERO ? '-' : '') + t;
    while (t.length <= places) t = '0' + t;
    return (int < ZERO ? '-' : '') + t.slice(0, t.length - places) + '.' + t.slice(t.length - places);
  }

  // A value as a reader writes it: 9,022; 9.022; 7/8.
  function show(value, decimal) {
    return commas(S.canonical(value, { decimal: decimal }));
  }

  // Cells for a digit string right-aligned in width columns, after a sign
  // cell at the left. Every digit is a one-character string and every blank
  // is null, so no cell turns into a number and no empty text cell stops a
  // note from showing.
  function digitRow(text, width, sign) {
    var cells = [sign || null];
    var chars = String(text).split('');
    for (var i = 0; i < width - chars.length; i++) cells.push(null);
    return cells.concat(chars);
  }

  function withNote(cells, note) {
    return note ? cells.concat([null, note]) : cells;
  }

  // The number a grid row holds, read back from its cells (columns 1 to
  // width), as {int, places}: the check reads what the sheet will show,
  // never the numbers that built it.
  function readRow(cells, width) {
    var text = '';
    for (var i = 1; i <= width; i++) {
      var c = cells[i];
      if (c === null || c === undefined) { if (text) return null; continue; }
      if (!/^[0-9.]$/.test(c)) return null;
      text += c;
    }
    if (!text || (text.match(/\./g) || []).length > 1) return null;
    var dot = text.indexOf('.');
    return { int: big(text.replace('.', '')), places: dot < 0 ? 0 : text.length - dot - 1 };
  }

  // ---------------------------------------------------------------- multiplication

  function multiplication(tree, method, decimal) {
    var a = scaled(tree.left), b = scaled(tree.right);
    if (!a || !b) return null;
    if (method === 'lattice') return fail('Most papers used the lattice method, which TABot does not lay out yet.');
    var product = a.int * b.int;
    var places = a.places + b.places;
    var aText = a.int.toString(), bText = b.int.toString();
    if (aText.length > 6 || bText.length > 4) return fail('The numbers are too long to lay out one digit to a cell.');
    must(S.equal(S.frac(product, pow10(places)), S.evaluate(tree)));

    var rows;
    var chosen = method;
    var lead = places ? [[null, 'Multiply ' + tree.left.text + ' ' + TIMES + ' ' + tree.right.text + ' as whole numbers: ' +
      commas(a.int.toString()) + ' ' + TIMES + ' ' + commas(b.int.toString()) + '.'], []] : [];
    if (method === 'partial products') rows = partialProducts(a.int, b.int, false);
    else if (method === 'area model') rows = partialProducts(a.int, b.int, true);
    else { chosen = 'standard algorithm'; rows = standardMultiplication(a.int, b.int); }

    rows = lead.concat(rows);
    if (places) {
      rows.push([]);
      rows.push([null, 'Place the decimal point: ' + a.places + ' + ' + b.places + ' = ' + places +
        (places === 1 ? ' decimal place' : ' decimal places') + ', so ' + commas(product.toString()) + ' becomes ' +
        commas(placeText(product, places)) + '.']);
    }
    return { method: chosen, rows: rows, value: S.frac(product, pow10(places)), decimal: decimal };
  }

  // 347 x 26, the longer number on top: 2082 (347 x 6), 6940 (347 x 20,
  // the placeholder zero written), then their sum. A 0 digit in the lower
  // number adds a row of zeros, so it gets no row and a line says so. The
  // grid is then read back from its cells and checked.
  function standardMultiplication(x, y) {
    var top = x.toString().length >= y.toString().length ? x : y;
    var bottom = top === x ? y : x;
    var aText = top.toString(), bText = bottom.toString();
    var product = top * bottom;
    var partials = [], skipped = [];
    for (var k = 0; k < bText.length; k++) {
      var digit = big(bText[bText.length - 1 - k]);
      if (digit === ZERO) { if (bText.length > 1) skipped.push(k); continue; }
      var place = pow10(k);
      partials.push({ value: top * digit * place, k: k, digit: digit,
        note: commas(aText) + ' ' + TIMES + ' ' + commas((digit * place).toString()) + ' = ' + commas((top * digit * place).toString()) });
    }
    var width = Math.max(aText.length, bText.length, product.toString().length);
    var rows = [digitRow(aText, width), digitRow(bText, width, TIMES)];
    var partialAt = [];
    if (partials.length <= 1) {
      partialAt.push(rows.length);
      rows.push(withNote(digitRow(product.toString(), width, '='), partials.length ? partials[0].note : commas(aText) + ' ' + TIMES + ' 0 = 0'));
    } else {
      partials.forEach(function (p) {
        partialAt.push(rows.length);
        rows.push(withNote(digitRow(p.value.toString(), width), p.note));
      });
      rows.push(withNote(digitRow(product.toString(), width, '='), 'Add: ' +
        partials.map(function (p) { return commas(p.value.toString()); }).join(' + ') + ' = ' + commas(product.toString())));
    }
    var notes = skipped.map(function (k) {
      return 'The 0 in the ' + columnName(k, 0) + ' place of ' + commas(bText) + ' gives a row of zeros, so it has no row.';
    });

    // read back
    var rTop = readRow(rows[0], width), rBottom = readRow(rows[1], width);
    must(rTop && rTop.int === top && rBottom && rBottom.int === bottom);
    if (partials.length > 1) {
      var sum = ZERO;
      partials.forEach(function (p, i) {
        var got = readRow(rows[partialAt[i]], width);
        must(got && got.int === top * p.digit * pow10(p.k));
        sum += got.int;
      });
      var total = readRow(rows[rows.length - 1], width);
      must(total && total.int === sum && sum === product);
    } else {
      var only = readRow(rows[partialAt[0]], width);
      must(only && only.int === product);
    }
    if (notes.length) {
      rows.push([]);
      notes.forEach(function (n) { rows.push([null, n]); });
    }
    return rows;
  }

  // Place-value parts of a whole number: 347 -> [300, 40, 7] (zeros skipped).
  function parts(n) {
    var text = n.toString(), out = [];
    for (var i = 0; i < text.length; i++) {
      var d = big(text[i]);
      if (d !== ZERO) out.push(d * pow10(text.length - 1 - i));
    }
    return out.length ? out : [ZERO];
  }

  function partialProducts(a, b, grid) {
    var pa = parts(a), pb = parts(b), product = a * b;
    must(pa.reduce(function (s, v) { return s + v; }, ZERO) === a);
    must(pb.reduce(function (s, v) { return s + v; }, ZERO) === b);
    var rows = [], all = [];
    if (grid) {
      var head = [TIMES].concat(pa.map(function (v) { return commas(v.toString()); }));
      head.table = true;
      rows.push(head);
      pb.forEach(function (y) {
        var r = [commas(y.toString())].concat(pa.map(function (x) {
          all.push(x * y);
          return commas((x * y).toString());
        }));
        r.table = true;
        rows.push(r);
      });
    } else {
      pa.forEach(function (x) {
        pb.forEach(function (y) {
          all.push(x * y);
          rows.push([null, commas(x.toString()) + ' ' + TIMES + ' ' + commas(y.toString()) + ' = ' + commas((x * y).toString())]);
        });
      });
    }
    var sum = all.reduce(function (s, v) { return s + v; }, ZERO);
    must(sum === product);
    rows.push([]);
    rows.push([null, 'Add the parts: ' + all.map(function (v) { return commas(v.toString()); }).join(' + ') + ' = ' + commas(product.toString())]);
    return rows;
  }

  // ---------------------------------------------------------------- addition and subtraction

  // A chain of + and - of positive whole numbers or decimals -> [{sign, node}] or null.
  function terms(tree, out) {
    out = out || [];
    if (tree.type === 'bin' && (tree.op === '+' || tree.op === '-')) {
      if (!terms(tree.left, out)) return null;
      if (!scaled(tree.right)) return null;
      out.push({ sign: tree.op, node: tree.right });
      return out;
    }
    if (!scaled(tree)) return null;
    out.push({ sign: '+', node: tree });
    return out;
  }

  function columnMethod(tree, decimal) {
    var list = terms(tree);
    if (!list || list.length < 2 || list.length > 6) return null;
    var places = Math.max.apply(null, list.map(function (t) { return scaled(t.node).places; }));
    var values = list.map(function (t) {
      var s = scaled(t.node);
      return s.int * pow10(places - s.places);
    });
    // every running total stays positive, so it is column arithmetic, not signed numbers
    var running = values[0];
    for (var i = 1; i < list.length; i++) {
      running = list[i].sign === '+' ? running + values[i] : running - values[i];
      if (running < ZERO) return null;
    }
    must(S.equal(S.frac(running, pow10(places)), S.evaluate(tree)));
    var mixed = list.some(function (t) { return t.sign === '-'; }) && list.some(function (t, k) { return k > 0 && t.sign === '+'; });
    if (mixed) return null; // left to order of operations
    var subtract = list[1].sign === '-';
    if (subtract && list.length !== 2) return null;

    var texts = values.map(function (v) { return placeText(v, places); });
    var answerText = placeText(running, places);
    var width = Math.max.apply(null, texts.concat([answerText]).map(function (t) { return t.length; }));
    if (width > MAX_GRID_DIGITS) return fail('The numbers are too long to lay out one digit to a cell.');

    var rows = [];
    var notes = subtract ? borrows(values[0], values[1], places) : carries(values, places);
    texts.forEach(function (t, k) {
      rows.push(digitRow(t, width, k === texts.length - 1 ? (subtract ? '-' : '+') : null));
    });
    rows.push(digitRow(answerText, width, '='));

    // read back: every number, and the answer, from the cells; the points
    // line up because every row has the same number of places.
    var back = rows.map(function (r) { return readRow(r, width); });
    must(back.every(function (b) { return b && b.places === places; }));
    for (var k = 0; k < values.length; k++) must(back[k].int === values[k]);
    var total = back[0].int;
    for (var m = 1; m < values.length; m++) total = subtract ? total - back[m].int : total + back[m].int;
    must(back[values.length].int === total && total === running);

    if (notes.length) {
      rows.push([]);
      notes.forEach(function (n) { rows.push([null, n]); });
    }
    return { method: 'standard algorithm', rows: rows, value: S.frac(running, pow10(places)), decimal: decimal };
  }

  var PLACE_NAMES = ['ones', 'tens', 'hundreds', 'thousands', 'ten thousands', 'hundred thousands', 'millions'];
  var DECIMAL_NAMES = ['tenths', 'hundredths', 'thousandths', 'ten thousandths'];

  // The name of column k counted from the right, with places digits after the point.
  function columnName(k, places) {
    if (k < places) return DECIMAL_NAMES[places - 1 - k] || ('10^-' + (places - k) + ' place');
    return PLACE_NAMES[k - places] || ('10^' + (k - places) + ' place');
  }

  function carries(values, places) {
    var notes = [], carry = ZERO, k = 0;
    var longest = Math.max.apply(null, values.map(function (v) { return v.toString().length; }));
    for (k = 0; k < longest; k++) {
      var total = carry;
      var digitsHere = values.map(function (v) { return (v / pow10(k)) % TEN; });
      digitsHere.forEach(function (d) { total += d; });
      var next = total / TEN;
      if (next > ZERO) {
        notes.push(columnName(k, places) + ': ' + digitsHere.join(' + ') + (carry ? ' + ' + carry + ' carried' : '') +
          ' = ' + total + '; write ' + (total % TEN) + ', carry ' + next + '.');
      }
      carry = next;
    }
    return notes;
  }

  // One line per column that lends or borrows, as plain arithmetic:
  // "tens: 0 - 1 lent + 10 borrowed - 7 = 2".
  function borrows(top, bottom, places) {
    var notes = [], lent = ZERO;
    var longest = top.toString().length;
    for (var k = 0; k < longest; k++) {
      var d = (top / pow10(k)) % TEN, b = (bottom / pow10(k)) % TEN;
      var borrowed = d - lent < b ? TEN : ZERO;
      var result = d - lent + borrowed - b;
      must(result >= ZERO && result < TEN);
      if (lent || borrowed) {
        notes.push(columnName(k, places) + ': ' + d + (lent ? ' - 1 lent' : '') + (borrowed ? ' + 10 borrowed' : '') +
          ' - ' + b + ' = ' + result + '.');
      }
      lent = borrowed ? ONE : ZERO;
    }
    return notes;
  }

  // ---------------------------------------------------------------- long division

  function longDivision(tree) {
    var a = tree.left, b = tree.right;
    if (!(tree.sign && a.type === 'num' && a.kind === 'whole' && b.type === 'num' && b.kind === 'whole')) return null;
    var dividend = a.value.n, divisor = b.value.n;
    if (divisor === ZERO) return null;
    var text = dividend.toString();
    if (text.length > MAX_GRID_DIGITS) return fail('The numbers are too long to lay out one digit to a cell.');
    var rows = [[null, commas(text) + ' ' + DIVIDE + ' ' + commas(divisor.toString())]];
    var current = ZERO, quotient = '', started = false;
    for (var i = 0; i < text.length; i++) {
      current = current * TEN + big(text[i]);
      var q = current / divisor;
      var taken = q * divisor;
      if (started || q > ZERO) {
        // Each step in exact words: how many times the divisor goes in, and
        // what is left.
        var lead = !started
          ? (i === 0 ? 'Start with ' + current + ': ' : divisor + ' does not go into ' + text.slice(0, i) + ', so start with ' + current + ': ')
          : 'Bring down ' + text[i] + ': ';
        rows.push([null, lead + divisor + ' goes into ' + current + (q === ONE ? ' once' : ' ' + q + ' times') + '; ' +
          q + ' ' + TIMES + ' ' + divisor + ' = ' + taken + '; ' + current + ' - ' + taken + ' = ' + (current - taken) + '.']);
        started = true;
      }
      quotient += q.toString();
      current -= taken;
    }
    quotient = quotient.replace(/^0+(?=\d)/, '');
    var qBig = big(quotient);
    must(qBig * divisor + current === dividend && current < divisor);
    var value = S.frac(dividend, divisor);
    must(S.equal(value, S.evaluate(tree)));
    rows.push([]);
    var line = 'Quotient ' + commas(quotient) + (current > ZERO ? ', remainder ' + current : ', no remainder') + '.';
    if (current > ZERO) {
      line += ' As a number: ' + mixedText(value) + (S.terminates(value) ? ' = ' + commas(S.decimalText(value)) : '') + '.';
    }
    rows.push([null, line]);
    var shown = commas(quotient) + (current > ZERO ? ' R ' + current + ' (' + mixedText(value) + ')' : '');
    return { method: 'long division', rows: rows, value: value, decimal: false, shown: shown };
  }

  // ---------------------------------------------------------------- fractions

  function fractionPart(node) {
    if (node.type !== 'num') return null;
    if (node.kind === 'fraction' || node.kind === 'mixed' || node.kind === 'whole') return node;
    return null;
  }

  function fracText(v) { return S.fractionText(v); }

  function mixedText(v) {
    if (S.isWhole(v) || abs(v.n) < v.d) return fracText(v);
    var sign = v.n < ZERO ? '-' : '';
    var n = abs(v.n), whole = n / v.d, rest = n % v.d;
    return sign + whole + ' ' + rest + '/' + v.d;
  }

  function gcd(a, b) { a = abs(a); b = abs(b); while (b) { var t = a % b; a = b; b = t; } return a; }

  function fractionSteps(tree) {
    if (tree.type !== 'bin' || tree.sign && tree.op !== '/') { /* division sign allowed */ }
    var l = fractionPart(tree.left), r = fractionPart(tree.right);
    if (!l || !r) return null;
    if (l.kind === 'whole' && r.kind === 'whole') return null;
    var op = tree.op;
    if (op === '/' && !tree.sign) return null;
    // The operands as printed, not yet in lowest terms: 6/8 stays 6/8, and a
    // mixed number becomes its improper fraction, 1 1/2 = 3/2.
    function printed(n) {
      if (n.kind === 'fraction') return { n: big(n.num), d: big(n.den) };
      if (n.kind === 'mixed') return { n: big(n.whole) * big(n.den) + big(n.num), d: big(n.den) };
      return { n: n.value.n, d: ONE };
    }
    function pt(v) { return v.d === ONE ? v.n.toString() : v.n + '/' + v.d; }
    var x = printed(l), y = printed(r), rows = [], result;
    must(S.equal(S.frac(x.n, x.d), l.value) && S.equal(S.frac(y.n, y.d), r.value));
    function row(text) { rows.push([null, text]); }
    [l, r].forEach(function (n) {
      if (n.kind === 'mixed') row('Write ' + n.text + ' as a fraction: ' + pt(printed(n)) + '.');
    });
    if (op === '+' || op === '-') {
      var L = x.d * y.d / gcd(x.d, y.d);
      var xn = x.n * (L / x.d), yn = y.n * (L / y.d);
      if (x.d !== y.d) {
        row('Common denominator ' + L + ': ' + pt(x) + ' = ' + xn + '/' + L + ', ' + pt(y) + ' = ' + yn + '/' + L + '.');
      }
      var top = op === '+' ? xn + yn : xn - yn;
      row((op === '+' ? 'Add' : 'Subtract') + ' the numerators: ' + xn + ' ' + op + ' ' + (yn < ZERO ? '(' + yn + ')' : yn) + ' = ' + top + ', so ' + top + '/' + L + '.');
      result = S.frac(top, L);
      must(S.equal(result, op === '+' ? S.add(l.value, r.value) : S.sub(l.value, r.value)));
      if (!(result.n === top && result.d === L)) row('Lowest terms: ' + top + '/' + L + ' = ' + fracText(result) + '.');
    } else if (op === '*') {
      var pn = x.n * y.n, pd = x.d * y.d;
      row('Multiply across: (' + x.n + ' ' + TIMES + ' ' + y.n + ')/(' + x.d + ' ' + TIMES + ' ' + y.d + ') = ' + pn + '/' + pd + '.');
      result = S.frac(pn, pd);
      must(S.equal(result, S.mul(l.value, r.value)));
      if (!(result.n === pn && result.d === pd)) row('Lowest terms: ' + pn + '/' + pd + ' = ' + fracText(result) + '.');
    } else if (op === '/') {
      if (y.n === ZERO) return null;
      var recip = y.n < ZERO ? { n: -y.d, d: -y.n } : { n: y.d, d: y.n };
      row('Multiply by the reciprocal of ' + pt(y) + ', which is ' + pt(recip) + '.');
      var qn = x.n * recip.n, qd = x.d * recip.d;
      row('Multiply across: (' + x.n + ' ' + TIMES + ' ' + recip.n + ')/(' + x.d + ' ' + TIMES + ' ' + recip.d + ') = ' + qn + '/' + qd + '.');
      result = S.frac(qn, qd);
      must(S.equal(result, S.div(l.value, r.value)));
      if (!(result.n === qn && result.d === qd)) row('Lowest terms: ' + qn + '/' + qd + ' = ' + fracText(result) + '.');
    } else {
      return null;
    }
    if (!S.isWhole(result) && abs(result.n) > result.d) row('As a mixed number: ' + mixedText(result) + '.');
    must(S.equal(result, S.evaluate(tree)));
    var shownFrac = !S.isWhole(result) && abs(result.n) > result.d ? fracText(result) + ' (' + mixedText(result) + ')' : fracText(result);
    return { method: 'fraction steps', rows: rows, value: result, decimal: false, shown: shownFrac };
  }

  // ---------------------------------------------------------------- order of operations

  function isNum(node) { return node.type === 'num'; }

  function numNode(value, decimal) {
    return { type: 'num', value: value, text: S.canonical(value, { decimal: decimal }), decimal: decimal, kind: 'value' };
  }

  var PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };

  // A number that is a fraction, a mixed number or negative keeps brackets
  // wherever it is an operand, so "(3/4)^2" never prints as "3/4^2" (which
  // is 3/(4^2)), and "6 / (1/2)" never as "6 / 1/2".
  function render(node, parentPrec, right) {
    if (node.type === 'num') {
      var t = commas(node.text);
      var compound = node.value.n < ZERO || /[\/ ]/.test(node.text);
      return compound && parentPrec > 0 ? '(' + t + ')' : t;
    }
    if (node.type === 'group') return '(' + render(node.arg, 0) + ')';
    if (node.type === 'neg') return '-' + render(node.arg, 4);
    var p = PREC[node.op];
    var sym = node.op === '*' ? ' ' + TIMES + ' ' : node.op === '/' ? (node.sign ? ' ' + DIVIDE + ' ' : ' / ') : node.op === '^' ? '^' : ' ' + node.op + ' ';
    var text = render(node.left, p, false) + sym + render(node.right, p, true);
    var wrap = p < parentPrec || (p === parentPrec && right && node.op !== '^');
    return wrap ? '(' + text + ')' : text;
  }

  // Reduces the leftmost operation whose operands are both numbers; a group
  // around a lone number opens. -> the new tree, or null when nothing reduces.
  function reduceOnce(node, decimal) {
    if (node.type === 'num') return null;
    if (node.type === 'group') {
      if (isNum(node.arg)) return node.arg;
      var inner = reduceOnce(node.arg, decimal);
      if (!inner) return null;
      return isNum(inner) ? inner : { type: 'group', arg: inner };
    }
    if (node.type === 'neg') {
      if (isNum(node.arg)) return numNode(S.neg(node.arg.value), decimal);
      var a = reduceOnce(node.arg, decimal);
      return a ? { type: 'neg', arg: a } : null;
    }
    if (isNum(node.left) && isNum(node.right)) return numNode(S.evaluate(node), decimal);
    var left = reduceOnce(node.left, decimal);
    if (left) return Object.assign({}, node, { left: left });
    var right = reduceOnce(node.right, decimal);
    if (right) return Object.assign({}, node, { right: right });
    return null;
  }

  // A printed step read back the way a teacher (and solve.compute) reads it.
  function readBack(textLine) {
    var t = textLine.replace(/^= /, '').replace(/(\d),(?=\d{3})/g, '$1');
    var r = S.compute(t);
    if (r.ok) return r.value;
    return S.numberOf(t);
  }

  function orderOfOperations(tree, decimal) {
    var target = S.evaluate(tree);
    var rows = [[null, render(tree, 0)]];
    var current = tree, guard = 0;
    while (!isNum(current) && guard++ < 60) {
      var next = reduceOnce(current, decimal);
      if (!next) return null;
      must(S.equal(S.evaluate(next), target));
      var shown = render(next, 0);
      if (shown !== rows[rows.length - 1][1].replace(/^= /, '')) rows.push([null, '= ' + shown]);
      current = next;
    }
    if (!isNum(current)) return null;
    must(S.equal(current.value, target));
    rows.forEach(function (r) {
      var back = readBack(r[1]);
      must(!!back && S.equal(back, target));
    });
    return { method: 'order of operations', rows: rows, value: target, decimal: decimal };
  }

  // ---------------------------------------------------------------- build

  var METHODS_BY_SHAPE = {
    multiplication: ['standard algorithm', 'partial products', 'area model']
  };

  function shapeOf(tree) {
    if (tree.type === 'bin' && tree.op === '*' && scaled(tree.left) && scaled(tree.right)) return 'multiplication';
    return 'other';
  }

  // The methods TABot can lay out for this question, first the default.
  function methodsFor(expression) {
    var r = S.compute(expression);
    if (!r.ok) return [];
    return METHODS_BY_SHAPE[shapeOf(r.tree)] || [];
  }

  function worked(tree, method, decimal) {
    if (shapeOf(tree) === 'multiplication') return multiplication(tree, method, decimal);
    return longDivisionOrNull(tree) || fractionSteps(tree) || columnMethod(tree, decimal) || orderOfOperations(tree, decimal);
  }

  function longDivisionOrNull(tree) {
    return tree.type === 'bin' && tree.op === '/' ? longDivision(tree) : null;
  }

  // opts: {expression, method, choices, keyAnswer, equivalent, exactValue}.
  // equivalent is grade.equivalent and exactValue grade.exactValue, passed in
  // so this module needs no math.js; exactValue is a second parse of the
  // question, and the exemplar is refused when it disagrees.
  function build(opts) {
    opts = opts || {};
    var r = S.compute(opts.expression);
    if (!r.ok) {
      if (r.reason === 'empty') return fail('No printed arithmetic was read for this question.');
      if (r.reason === 'too long' || r.reason === 'too large' || r.reason === 'exponent out of range') {
        return fail('The numbers are too large for TABot to work out.');
      }
      if (r.reason === 'division by zero') return fail('The question as read divides by zero.');
      if (r.reason === 'ambiguous') return fail('The question as read can be worked two ways (for example -3^2, or 8 \u00f7 2(2+2)).');
      return fail('The question is not arithmetic TABot\'s code can work out (for example a word problem, a rounding or an estimate).');
    }
    if (opts.exactValue) {
      var second = opts.exactValue(opts.expression);
      if (!second || second.n !== r.value.n.toString() || second.d !== r.value.d.toString()) return fail(CHECK_FAILED);
    }
    var out;
    try {
      out = worked(r.tree, opts.method, r.decimal);
      if (!out) return fail('The question is not arithmetic TABot\'s code can work out.');
      if (out.ok === false) return out;
      must(S.equal(out.value, r.value));
    } catch (err) {
      if (err instanceof CheckError) return fail(CHECK_FAILED);
      if (err instanceof RangeError) return fail('The numbers are too large for TABot to work out.');
      throw err;
    }
    var answer = S.canonical(r.value, { decimal: r.decimal });
    var question = render(r.tree, 0);
    var shown = out.shown || commas(answer);
    var choice = null;
    var tail = [];
    if (Array.isArray(opts.choices) && opts.choices.length) {
      var at = S.findChoice(opts.choices, { value: r.value });
      if (at < 0) {
        var any = opts.choices.some(function (c) { var v = S.choiceValue(c.text); return v && S.equal(v, r.value); });
        return fail(any ? 'More than one choice matches the worked answer.' : 'No choice matches the worked answer ' + shown + '.');
      }
      choice = opts.choices[at];
      tail.push([]);
      tail.push([null, 'The choice that matches is ' + (choice.label ? S.normLabel(choice.label) + ' (' + choice.text + ')' : choice.text) + '.']);
    }
    var key = opts.keyAnswer ? String(opts.keyAnswer).trim() : '';
    if (key) {
      var keyOk;
      var named = choice ? S.findChoice(opts.choices, { label: key }) : -1;
      if (named >= 0) {
        keyOk = opts.choices[named] === choice;
      } else {
        var acc = S.accepts(key, r);
        keyOk = acc ? acc.match : !!(opts.equivalent && opts.equivalent(key, answer));
      }
      if (!keyOk) {
        return fail('The printed question works out to ' + (choice ? S.normLabel(choice.label) + ' (' + choice.text + ')' : shown) +
          ', but the answer key says ' + key + '. Check the key, or the question as read.');
      }
    }
    var rows = [['Question', question], ['Method', out.method], []].concat(out.rows).concat(tail);
    rows.push([]);
    rows.push(['Answer', choice ? (choice.label ? S.normLabel(choice.label) + ' (' + choice.text + ')' : choice.text) : shown]);
    return { ok: true, method: out.method, question: question, rows: rows, answer: answer, choice: choice };
  }

  // The method an exemplar uses for a question, from the method most papers'
  // work shows (settle.js) -> {method, line} or {reason}.
  function methodFor(expression, majority) {
    var methods = methodsFor(expression);
    if (!methods.length) return { method: '', line: '' };
    if (!majority || majority.tie || !majority.method) {
      return { method: methods[0], line: methods[0] + ' (no one method was read on most papers)' };
    }
    if (methods.indexOf(majority.method) < 0) {
      if (majority.method === 'lattice') return { reason: 'Most papers used the lattice method, which TABot does not lay out yet.' };
      return { reason: 'Most papers used a method TABot does not lay out yet (' + majority.method + ').' };
    }
    return { method: majority.method, line: majority.method + ' (as read by AI on ' + majority.count + ' of ' + majority.of + ' papers)' };
  }

  function whyNone(sq) {
    if (sq.readsDisagree) return 'The papers\' reads of the printed question disagree, so there is no worked example.';
    if (sq.computedWhy === 'unconfirmed') {
      return 'No paper\'s second read agreed with its first read of the printed question, so there is no worked example.';
    }
    if (sq.computedWhy === 'handwritten') return 'The question was copied by hand on only one paper, so there is no worked example.';
    if (sq.figure) return 'The question depends on a picture, graph or table.';
    if (!sq.text && !sq.anyExpression) return 'No printed question was read at this number.';
    return 'The question is not arithmetic TABot\'s code can work out and check (for example a word problem, ' +
      'a rounding, an estimate, or a question that asks for a form), so there is no worked example.';
  }

  // One entry per question of settle.settle's result:
  // {q, ok, rows} or {q, ok: false, reason}. A question whose layout throws is
  // listed with a reason; it never costs the rest of the workbook.
  function forClass(settled, opts) {
    opts = opts || {};
    return (settled && settled.questions || []).map(function (sq) {
      try {
        if (!sq.computed) return { q: sq.q, ok: false, reason: whyNone(sq) };
        var c = sq.computed;
        var m = methodFor(c.expression, sq.method);
        if (m.reason) return { q: sq.q, ok: false, reason: m.reason };
        var r = build({
          expression: c.expression,
          method: m.method,
          choices: sq.choices,
          keyAnswer: sq.keyAnswer,
          equivalent: opts.equivalent,
          exactValue: opts.exactValue
        });
        if (!r.ok) return { q: sq.q, ok: false, reason: r.reason };
        var support = 'read this way on ' + c.support.agree + ' of ' + c.support.of + (c.support.of === 1 ? ' paper' : ' papers');
        r.rows[0] = ['Question', r.question, support];
        if (m.line) r.rows[1] = ['Method', m.line];
        if (c.versions && c.versions.length) {
          r.rows.push([null, 'Another version of this question was read on ' +
            c.versions.map(function (v) { return v.count + ' papers (' + v.expression + ')'; }).join(' and ') +
            '; only the most common is worked here.']);
        }
        return { q: sq.q, ok: true, rows: r.rows, method: r.method, answer: r.answer };
      } catch (err) {
        return { q: sq.q, ok: false, reason: 'TABot could not lay this one out.' };
      }
    });
  }

  // The worked steps as one line of text, for the AI analysis prompt: every
  // note and step line of the standard layout, in order. '' when there is
  // no exemplar.
  function stepsText(expression) {
    var r;
    try {
      r = build({ expression: expression });
    } catch (err) {
      return '';
    }
    if (!r.ok) return '';
    var lines = [];
    r.rows.forEach(function (row) {
      if (!row.length || row[0] === 'Question' || row[0] === 'Method' || row[0] === 'Answer') return;
      var last = row[row.length - 1];
      if (typeof last === 'string' && last.length > 1) lines.push(last.replace(/\.$/, ''));
    });
    // The last line (the result) always stays; when the steps do not fit,
    // the middle is left out and the text says so.
    var all = lines.join('; ');
    if (all.length <= 600 || !lines.length) return all;
    var last = lines[lines.length - 1], out = '';
    for (var i = 0; i < lines.length - 1; i++) {
      var next = out ? out + '; ' + lines[i] : lines[i];
      if (next.length + last.length + 40 > 600) break;
      out = next;
    }
    return (out ? out + '; ' : '') + '(some steps left out); ' + last;
  }

  return {
    build: build,
    forClass: forClass,
    stepsText: stepsText,
    methodsFor: methodsFor,
    CHECK_FAILED: CHECK_FAILED
  };
});
