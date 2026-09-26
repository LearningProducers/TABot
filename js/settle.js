/*
 * TABot.settle: the expected answer to every question, settled once for the
 * whole class from the answer key and from every stored paper's reads.
 *
 * settle({key, rows}) -> {questions: [...]} with one entry per key question:
 *   {q, source, keyAnswer, match, computed, support, versions, text, choices,
 *    figure, ai, needsSolve, solve, reason, keyConflict, method}
 * and expectation(settled, row, q) says what one paper's answer to q is
 * graded against (see gradeSlip in grade.js).
 *
 * Where a question's expected answer comes from, in order:
 *   1. key: the teacher typed an answer. The key always wins. When the
 *      class's reads also compute a value for the question and the key does
 *      not match it, keyConflict says so for the Summary (never a cell).
 *   2. computed: code worked out the printed arithmetic. A paper counts
 *      toward it only when (a) its reader read the question as printed text,
 *      not a figure, with arithmetic that appears in the question word for
 *      word and nothing else but plain instructions around it
 *      (solve.asksForValue), (b) any instructions printed for the whole page
 *      are plain too, (c) solve.compute and grade.exactValue, two separate
 *      parsers, agree on its value, and (d) the reviewer's read of the
 *      question computes to the same value. The class value is the one most
 *      such papers share, with more papers than any other value; a question
 *      the student copied by hand needs two papers to agree. A tie means the
 *      reads of the printed question disagree, and the question is not
 *      computed. A second value on at least two papers and a quarter of them
 *      is another version of the test: those papers are graded on their own
 *      version, flagged. A paper whose own confirmed read gives yet another
 *      value is graded on the class value, flagged.
 *   3. ai: the question's printed text, as most papers read it, was solved by
 *      a model (twice, independently, and kept only when the two agree). Every
 *      such cell carries the AI-solved mark. The app fetches these: a
 *      question in needsSolve has no answer stored yet.
 *   4. none: no key, nothing computed, no AI answer (a figure, no single
 *      answer, the reads disagree, or no question read at that number). The
 *      question is not graded on any paper and counts toward no score.
 *
 * AI answers live on the rows, row.solved[q] = {key, answer, exact, gradable,
 * reason, model}, copied onto every row once solved, so they are cleared with
 * the results and survive a reload. The class map is rebuilt from all rows.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.settle = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var inNode = typeof module === 'object' && module.exports && typeof require === 'function';
  var S = inNode ? require('./solve.js') : root.TABot && root.TABot.solve;
  var G = inNode ? require('./grade.js') : root.TABot && root.TABot.grade;
  if (!S || !G) throw new Error('TABot.settle needs js/solve.js and js/grade.js loaded first');

  // A question's printed text asks for a form, not only a value.
  var FORM_WORDS = /\b(?:simplif\w*|simplest|lowest\s+terms|mixed\s+number|improper|as\s+a\s+(?:fraction|decimal|percent)|expanded\s+form|scientific\s+notation)\b/i;
  var FRACTION_FORM = /\b(?:simplif\w*|simplest|lowest\s+terms|mixed\s+number|improper|as\s+a\s+fraction)/i;
  var DECIMAL_FORM = /\bas\s+a\s+decimal\b|\bdecimals?\b/i;
  var PERCENT_FORM = /\bas\s+a\s+percent\b|\bpercents?\b/i;

  // The kind of answer the page's instructions ask a form for: 'fraction',
  // 'decimal', 'percent', 'other' (a form TABot has no rule for, such as
  // scientific notation) or ''.
  function formKind(t) {
    if (FRACTION_FORM.test(t)) return 'fraction';
    if (!FORM_WORDS.test(t)) return '';
    if (DECIMAL_FORM.test(t)) return 'decimal';
    if (PERCENT_FORM.test(t)) return 'percent';
    return 'other';
  }

  function text(v) {
    return v === undefined || v === null ? '' : String(v).trim();
  }

  function entryFor(list, q) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].q) === q) return list[i];
    }
    return null;
  }

  function questionOf(reading, q) {
    return reading ? entryFor(reading.questions, q) : null;
  }

  function valueKey(v) {
    return v.n.toString() + '/' + v.d.toString();
  }

  // The text of a question as a key for comparing papers: case, spacing and
  // punctuation set aside.
  function textKey(t) {
    return text(t).toLowerCase()
      .replace(/[\u2212\u2012\u2013\u2014\ufe63\uff0d]/g, '-')
      .replace(/[\u00d7]/g, 'x')
      .replace(/[^a-z0-9+\-*/^=%$.\u00f7]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // Page instructions that ask for nothing but values. Anything else (round,
  // simplest form, as a decimal...) turns computing off for the paper.
  function plainInstructions(t) {
    t = text(t);
    return !t || S.asksForValue(t + ' 1+1', '1+1');
  }

  // One paper's computed read of question q: {value, key, compute, handwritten}
  // when it passes every gate, {differs} for a reader read the reviewer does
  // not confirm, or null.
  // A multiple-choice question's text without its printed choices, when the
  // reader copied them into the text as well: "Which is 6 x 7? A) 36 B) 42"
  // -> "Which is 6 x 7?".
  function stem(rq) {
    var t = text(rq.text);
    var choices = Array.isArray(rq.choices) ? rq.choices : [];
    choices.forEach(function (c) {
      var label = text(c.label).replace(/[().:\s]/g, '');
      var body = text(c.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!body) return;
      var re = new RegExp('(?:^|\\s)\\(?' + (label ? label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[).:]?' : '') + '\\s*' + body + '(?=\\s|$|[,;.])', 'i');
      t = t.replace(re, ' ');
    });
    return t.replace(/\s+/g, ' ').trim();
  }

  function candidate(row, q) {
    var rq = questionOf(row.reading, q);
    if (!rq || rq.figure || !text(rq.expression)) return null;
    if (!plainInstructions(row.reading.instructions)) return null;
    if (!S.asksForValue(stem(rq), rq.expression)) return null;
    var c = S.compute(rq.expression);
    if (!c.ok) return null;
    var cross = G.exactValue(rq.expression);
    if (!cross || cross.n !== c.value.n.toString() || cross.d !== c.value.d.toString()) return null;
    var out = { value: c.value, key: valueKey(c.value), compute: c, expression: text(rq.expression), handwritten: rq.printed === false };
    // Only a second read that works out the same value confirms it; a paper
    // whose second read failed counts on nothing.
    var vq = row.review ? questionOf(row.review, q) : null;
    var vc = vq && text(vq.expression) ? S.compute(vq.expression) : null;
    if (!vc || !vc.ok || valueKey(vc.value) !== out.key) out.unconfirmed = true;
    return out;
  }

  function tally(items, keyOf) {
    var groups = {}, order = [];
    items.forEach(function (item) {
      var k = keyOf(item);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(item);
    });
    return order.map(function (k) { return { key: k, items: groups[k] }; })
      .sort(function (a, b) { return b.items.length - a.items.length; });
  }

  // The class value for q from the papers' confirmed reads.
  function settleComputed(rows, q) {
    var confirmed = [], all = {};
    rows.forEach(function (row) {
      var c = row.reading ? candidate(row, q) : null;
      if (!c) return;
      all[row.id] = c;
      if (!c.unconfirmed) confirmed.push({ row: row, c: c });
    });
    if (!confirmed.length) {
      return { byRow: all, settled: null, why: Object.keys(all).length ? 'unconfirmed' : '' };
    }
    var groups = tally(confirmed, function (x) { return x.c.key; });
    var top = groups[0], second = groups[1];
    var t = top.items.length, s = second ? second.items.length : 0;
    var handwrittenOnly = top.items.every(function (x) { return x.c.handwritten; });
    var support = { agree: t, of: confirmed.length };
    if (t === s) return { byRow: all, settled: null, tie: true, support: support, why: 'tie' };
    if (handwrittenOnly && t < 2) return { byRow: all, settled: null, support: support, why: 'handwritten' };
    var versions = groups.slice(1).filter(function (g) {
      return g.items.length >= 2 && g.items.length * 4 >= confirmed.length;
    }).map(function (g) {
      return { key: g.key, value: g.items[0].c.value, compute: g.items[0].c.compute, expression: g.items[0].c.expression, count: g.items.length };
    });
    // The most common way the class value was written, to show the teacher.
    var byText = tally(top.items, function (x) { return S.mathKey(x.c.expression); });
    return {
      byRow: all,
      settled: {
        key: top.key,
        value: top.items[0].c.value,
        compute: byText[0].items[0].c.compute,
        expression: byText[0].items[0].c.expression,
        support: support,
        versions: versions
      }
    };
  }

  // The class's printed question text for q, as most papers read it.
  // A text read only from handwriting (a copied question) counts when two
  // papers agree on it, the same as for computing.
  function settleText(rows, q) {
    var reads = [];
    rows.forEach(function (row) {
      var rq = questionOf(row.reading, q);
      if (rq && textKey(rq.text)) reads.push({ row: row, rq: rq, key: textKey(rq.text) });
    });
    if (!reads.length) return null;
    var groups = tally(reads, function (x) { return x.key; });
    var t = groups[0].items.length, s = groups[1] ? groups[1].items.length : 0;
    if (t === s) return { tie: true, of: reads.length };
    var handwritten = groups[0].items.every(function (x) { return x.rq.printed === false; });
    if (handwritten && t < 2) return { handwritten: true, of: reads.length };
    var first = groups[0].items[0].rq;
    var figure = groups[0].items.filter(function (x) { return x.rq.figure; }).length * 2 > t;
    return {
      text: text(first.text),
      key: groups[0].key,
      choices: Array.isArray(first.choices) ? first.choices : [],
      figure: figure,
      support: { agree: t, of: reads.length }
    };
  }

  // The page instructions most papers read, for the solver: a paper with no
  // instructions votes for none, and a text needs more than half of all the
  // papers, so one paper's reading (or a student's writing read as one)
  // never speaks for the class.
  function settleInstructions(rows) {
    var reads = rows.map(function (r) { return r.reading ? text(r.reading.instructions) : ''; });
    if (!reads.length) return '';
    var top = tally(reads, textKey)[0];
    return top.key && top.items.length * 2 > reads.length ? top.items[0] : '';
  }

  // The method most papers' work shows for q, with counts.
  function settleMethod(rows, q) {
    var reads = [];
    rows.forEach(function (row) {
      var rq = questionOf(row.reading, q);
      if (rq && text(rq.method)) reads.push(text(rq.method).toLowerCase());
    });
    if (!reads.length) return null;
    var groups = tally(reads, function (m) { return m; });
    return { method: groups[0].key, count: groups[0].items.length, of: rows.length, tie: !!groups[1] && groups[1].items.length === groups[0].items.length };
  }

  function solveKey(q, settledText, instructions) {
    return q + '|' + settledText.key + '|' + settledText.choices.map(function (c) {
      return S.normLabel(c.label) + ':' + textKey(c.text);
    }).join(';') + '|' + textKey(instructions);
  }

  // Every AI answer stored on any row, by solve key. Two different answers
  // stored under one key are a conflict, named.
  function solvedMap(rows) {
    var map = {};
    rows.forEach(function (row) {
      var solved = row && row.solved;
      if (!solved || typeof solved !== 'object') return;
      Object.keys(solved).forEach(function (q) {
        var e = solved[q];
        if (!e || !e.key) return;
        if (!map[e.key]) map[e.key] = e;
        else if (text(map[e.key].answer) !== text(e.answer) || map[e.key].gradable !== e.gradable) map[e.key].conflict = true;
      });
    });
    return map;
  }

  function matchOf(question) {
    return question && question.match === 'exact' ? 'exact' : 'value';
  }

  function commas(t) { return S.withCommas(t); }

  function showExpr(e) {
    var r = S.compute(e);
    return r.ok ? e.replace(/\s+/g, ' ').trim() : e;
  }

  // Whether a key answer is the value code computed, for keyConflict.
  // Multiple choice keys (a label) are checked against the choice with that
  // label on the class's printed question.
  function keyMatchesValue(keyAnswer, computed, choices) {
    if (choices && choices.length) {
      var byLabel = S.findChoice(choices, { label: keyAnswer });
      if (byLabel >= 0) {
        var v = S.choiceValue(choices[byLabel].text);
        return v ? S.equal(v, computed.value) : null;
      }
    }
    var a = S.accepts(keyAnswer, computed.compute);
    if (a) return a.match;
    return G.equivalent(keyAnswer, S.canonical(computed.value, { decimal: computed.compute.decimal }));
  }

  function settle(opts) {
    opts = opts || {};
    var key = opts.key || { questions: [] };
    var rows = (Array.isArray(opts.rows) ? opts.rows : []).filter(function (r) { return r && r.reading; });
    var questions = Array.isArray(key.questions) ? key.questions : [];
    var solved = solvedMap(rows);
    var instructions = settleInstructions(rows);

    return {
      instructions: instructions,
      questions: questions.map(function (question, i) {
        var q = i + 1;
        var keyAnswer = text(question && question.answer);
        var comp = settleComputed(rows, q);
        var st = settleText(rows, q);
        var method = settleMethod(rows, q);
        var out = {
          q: q,
          keyAnswer: keyAnswer,
          match: keyAnswer ? matchOf(question) : 'value',
          computed: comp.settled,
          byRow: comp.byRow,
          text: st && !st.tie ? st.text : '',
          choices: st && !st.tie ? st.choices : [],
          figure: !!(st && st.figure),
          method: method,
          source: 'none',
          ai: null,
          needsSolve: false,
          solve: null,
          reason: '',
          keyConflict: '',
          readsDisagree: !!comp.tie || !!(st && st.tie),
          anyExpression: Object.keys(comp.byRow).length > 0,
          computedWhy: comp.why || ''
        };

        if (keyAnswer) {
          out.source = 'key';
          if (comp.settled) {
            var agrees = keyMatchesValue(keyAnswer, comp.settled, out.choices);
            if (agrees === false) {
              var worked = commas(S.canonical(comp.settled.value, { decimal: comp.settled.compute.decimal }));
              out.keyConflict = 'Q' + q + ': the key says ' + keyAnswer + '; the printed question as read (' +
                showExpr(comp.settled.expression) + ', on ' + comp.settled.support.agree + ' of ' +
                comp.settled.support.of + ' papers) works out to ' + worked + '. One of them is off.';
            }
          }
          return out;
        }

        if (comp.settled) {
          out.source = 'computed';
          return out;
        }
        if (comp.tie) {
          out.reason = 'The papers\' reads of the printed question disagree, so it was not graded. Type the answer in step 2 to grade it.';
          return out;
        }
        if (!st) {
          out.reason = 'No question was read at this number on any paper, and it has no key answer.';
          return out;
        }
        if (st.tie) {
          out.reason = 'The papers\' reads of the printed question disagree, so it was not graded. Type the answer in step 2 to grade it.';
          return out;
        }
        if (st.handwritten) {
          out.reason = 'The question was copied by hand on only one paper, so it was not solved. Type the answer in step 2 to grade it.';
          return out;
        }
        if (st.figure) {
          out.reason = 'The question depends on a picture, graph or table, so it was not solved. Type the answer in step 2 to grade it.';
          return out;
        }
        var sk = solveKey(q, st, instructions);
        var entry = solved[sk];
        if (!entry) {
          out.needsSolve = true;
          // The question's own words decide exact form; page instructions
          // about form apply only to an answer that is a number (see ai).
          out.solve = { key: sk, q: q, text: st.text, choices: st.choices, instructions: instructions,
            exact: FORM_WORDS.test(st.text), formKind: formKind(instructions) };
          out.reason = 'No AI answer yet. Type the answer in step 2, or take another photo to have it solved.';
          return out;
        }
        if (entry.conflict) {
          out.reason = 'Two different AI answers were stored for this question, so it was not graded. Type the answer in step 2.';
          return out;
        }
        if (!entry.gradable || !text(entry.answer)) {
          out.reason = text(entry.reason) || 'The AI found no single answer to check, so it was not graded. Grade it by hand, or type the answer in step 2.';
          out.solvedEntry = entry;
          return out;
        }
        out.source = 'ai';
        var aiAnswer = text(entry.answer);
        // Page instructions about form apply to an answer of the kind they
        // name: a fraction instruction to a fraction answer (exact form), a
        // decimal instruction to a decimal answer (its value, written as a
        // decimal).
        var form = '';
        if (entry.formKind === 'fraction' && /\//.test(aiAnswer) && !/[a-z]/i.test(aiAnswer)) form = 'fraction';
        if (entry.formKind === 'decimal' && /\.\d/.test(aiAnswer) && !/[a-z]/i.test(aiAnswer)) form = 'decimal';
        if (entry.formKind === 'percent' && /%/.test(aiAnswer)) form = 'percent';
        if (entry.formKind === 'other') form = 'other';
        out.ai = { answer: aiAnswer, exact: !!entry.exact, form: form, model: entry.model || '' };
        out.solvedEntry = entry;
        return out;
      })
    };
  }

  // What one paper's answer to q is graded against: the settled question
  // plus what is particular to this paper (its version, its choices, and
  // whether its own read of the question differs from the class).
  //   {source, keyAnswer, match, computed (a compute result), ai, choices,
  //    correctIndex, flags: [text], reason}
  function expectation(settled, row, q) {
    var sq = settled.questions[q - 1];
    if (!sq) return { source: 'none', flags: [], reason: 'No such question.' };
    var rq = questionOf(row.reading, q);
    var choices = rq && Array.isArray(rq.choices) && rq.choices.length ? rq.choices : [];
    var out = {
      source: sq.source,
      keyAnswer: sq.keyAnswer,
      match: sq.match,
      computed: null,
      ai: sq.ai,
      choices: choices,
      correctIndex: -1,
      flags: [],
      reason: sq.reason
    };
    var own = sq.byRow ? sq.byRow[row.id] : null;
    var cls = sq.computed;

    if (sq.source === 'computed') {
      var target = cls;
      if (!own && cls.versions.length) {
        // Two versions in the class, and this paper's own read cannot say
        // which it is: graded by the teacher, never guessed.
        out.source = 'none';
        out.reason = 'This question has two versions in the class, and this paper\'s version could not be read.';
        out.flags.push('Q' + q + ' has two versions in this class, and this paper\'s could not be read; grade it by hand');
        return out;
      }
      if (own && own.key !== cls.key) {
        var version = cls.versions.filter(function (v) { return v.key === own.key && !own.unconfirmed; })[0];
        if (version) {
          target = { compute: version.compute, value: version.value, expression: version.expression };
          out.flags.push('Q' + q + ' has two versions in this class; graded on this paper\'s version (' + showExpr(version.expression) + ')');
        } else {
          out.flags.push('this paper\'s Q' + q + ' reads ' + showExpr(own.expression) + '; graded on the class\'s ' + showExpr(cls.expression));
        }
      }
      out.computed = target.compute;
      out.expression = target.expression;
      if (choices.length) {
        out.correctIndex = S.findChoice(choices, { value: target.value });
        if (out.correctIndex < 0) {
          out.source = 'none';
          out.reason = 'No single choice on this paper matches the worked answer, so it was not graded.';
          out.flags.push('Q' + q + ': no single choice on this paper matches ' + commas(S.canonical(target.value, { decimal: target.compute.decimal })));
        }
      }
      return out;
    }

    if (sq.source === 'key' && choices.length) {
      var byLabel = S.findChoice(choices, { label: sq.keyAnswer });
      if (byLabel >= 0) out.correctIndex = byLabel;
      else {
        var kv = S.choiceValue(sq.keyAnswer);
        var byValue = kv ? S.findChoice(choices, { value: kv }) : -1;
        if (byValue < 0) byValue = S.findChoice(choices, { text: sq.keyAnswer });
        out.correctIndex = byValue;
      }
      return out;
    }

    if (sq.source === 'ai' && choices.length) {
      // The AI names a label on the class's printed choices; this paper's
      // choices may be in another order, so the choice is found by its text.
      // The AI named a choice on the class's printed choices; this paper's
      // may be in another order, so the choice is found here by its text,
      // or its value. An answer that names no one choice grades nothing.
      var cls2 = sq.choices || [];
      var ci = S.choiceNamed(sq.ai.answer, cls2);
      var idx = -1;
      if (ci >= 0) {
        idx = S.findChoice(choices, { text: cls2[ci].text });
        if (idx < 0) {
          var tv = S.choiceValue(cls2[ci].text);
          idx = tv ? S.findChoice(choices, { value: tv }) : -1;
        }
      } else if (!cls2.length) {
        idx = S.choiceNamed(sq.ai.answer, choices);
      }
      out.correctIndex = idx;
      if (idx < 0) {
        out.source = 'none';
        out.reason = 'No choice on this paper matches the AI answer, so it was not graded.';
      }
      return out;
    }
    return out;
  }

  // The questions the app still has to have solved, one entry per question.
  function toSolve(settled) {
    return settled.questions.filter(function (sq) { return sq.needsSolve; }).map(function (sq) { return sq.solve; });
  }

  return {
    settle: settle,
    expectation: expectation,
    toSolve: toSolve,
    textKey: textKey,
    FORM_WORDS: FORM_WORDS
  };
});
