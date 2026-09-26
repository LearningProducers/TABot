/*
 * TABot sheet: the downloaded workbook (Roster, Summary and Exemplars) and
 * its file name.
 *
 * Rows are graded papers (grade.gradeSlip output) plus {readBy, reviewedBy,
 * reviewMode} and the AI analysis fields from the app; reviewMode
 * 'single-model' marks a row whose second read ran on an enhanced copy with
 * the same model. The summary is grade.summarize output; its mean, median,
 * passRate and hitRate are percents (0 to 100). Percents are written rounded
 * to one decimal. settled (settle.js) says where each question's expected
 * answer came from, and exemplars (exemplar.forClass) are the worked
 * examples. Everything a model wrote is labeled as AI: the Analysis (AI)
 * column, the AI-solved cells and the error patterns.
 *
 * A cell is the answer as read, then a tick or a cross, then an asterisk
 * when the teacher should check it: the reads disagreed, the reader was
 * unsure, or the expected answer was solved by AI. An ungraded question
 * reads "(not graded)" with no tick or cross.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.sheet = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var CHECK = ' ✓';
  var CROSS = ' ✗';
  var FLAG = ' *';
  var DEFAULT_PASS = 70;

  // In the browser SheetJS is the global XLSX; in node the vendored build
  // fills module.exports. Looked up on first use so script order does not matter.
  // grade.analysisCurrent says whether an analysis is still current; looked
  // up on first use like SheetJS.
  var grade = null;
  function G() {
    if (grade) return grade;
    grade = root && root.TABot && root.TABot.grade;
    if (!grade && typeof module === 'object' && module.exports && typeof require === 'function') grade = require('./grade.js');
    return grade;
  }

  var xlsxLib = null;
  function X() {
    if (xlsxLib) return xlsxLib;
    var lib = root && root.XLSX;
    if (!lib && typeof module === 'object' && module.exports && typeof require === 'function') {
      var loaded = require('../vendor/xlsx.mini.min.js');
      lib = loaded && loaded.utils ? loaded : loaded && loaded.XLSX;
    }
    if (!lib && typeof XLSX !== 'undefined') lib = XLSX;
    if (!lib || !lib.utils) throw new Error('SheetJS (XLSX) is not loaded');
    xlsxLib = lib;
    return lib;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function round1(v) {
    return Math.round(num(v) * 10) / 10;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // A 'YYYY-MM-DD' string is taken as written; anything else is read as a
  // date in the teacher's local time zone. No date means today.
  function ymd(date) {
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
    var d = date instanceof Date ? date : date !== undefined && date !== null ? new Date(date) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fileName(assignment, date) {
    var name = String(assignment === undefined || assignment === null ? '' : assignment)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_-]/g, '');
    return 'TABot_' + (name || 'assignment') + '_' + ymd(date) + '.xlsx';
  }

  function questionCount(key, rows) {
    if (key && Array.isArray(key.questions)) return key.questions.length;
    return rows.reduce(function (n, row) {
      return Math.max(n, Array.isArray(row.answers) ? row.answers.length : 0);
    }, 0);
  }

  function answerFor(row, q) {
    var list = Array.isArray(row.answers) ? row.answers : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].q) === q) return list[i];
    }
    return null;
  }

  function answerCell(a) {
    var read = a && a.read !== undefined && a.read !== null ? String(a.read).trim() : '';
    var text = read === '' ? '(blank)' : read;
    if (a && a.graded === false) return text + ' (not graded)' + (a.flagged ? FLAG : '');
    text += a && a.correct ? CHECK : CROSS;
    if (a && (a.flagged || a.aiSolved)) text += FLAG;
    return text;
  }

  function rowHasFlag(row) {
    return G().rowFlagged(row);
  }

  function qList(list) {
    var names = list.map(function (q) { return 'Q' + q; });
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // The Analysis (AI) cell: the AI's sentences when there are any, marked
  // when they were written against expected answers that have changed since;
  // otherwise a line code can stand behind, derived now from the grades.
  function analysisCell(row) {
    var answers = Array.isArray(row.answers) ? row.answers : [];
    var graded = answers.filter(function (a) { return a && a.graded !== false; });
    if (!graded.length) return 'No question on this paper could be graded.';
    if (row.analysis) {
      var changed = G().analysisChanged(row);
      if (!changed.length) return String(row.analysis);
      return String(row.analysis) + ' (the expected answer to ' + qList(changed) + (changed.length === 1 ? ' has' : ' have') +
        ' changed since this was written)';
    }
    var wrong = graded.filter(function (a) { return !a.correct; });
    var blankWrong = wrong.filter(function (a) { return String(a.read || '').trim() === ''; });
    var extra = '';
    var ai = graded.filter(function (a) { return a.aiSolved; }).map(function (a) { return a.q; });
    var ungraded = answers.filter(function (a) { return a && a.graded === false; }).map(function (a) { return a.q; });
    if (ai.length) extra += ' ' + qList(ai) + (ai.length === 1 ? ' was' : ' were') + ' checked against an AI-solved answer.';
    if (ungraded.length) extra += ' ' + qList(ungraded) + ' not graded.';
    if (!wrong.length) return 'Every graded answer matches the expected answer.' + extra;
    if (wrong.length === blankWrong.length) return 'Left ' + qList(blankWrong.map(function (a) { return a.q; })) + ' blank.' + extra;
    var state = row.analysisState;
    if (state === 'stopped') return 'Analysis not written: reading was stopped.';
    if (state === 'failed') return 'Analysis not written: ' + (row.analysisReason || 'Groq did not answer') + '.';
    if (state === 'pending') return 'Analysis not written: the page closed before it was done.';
    // An analysis is written only while a photo is read; a key changed since
    // can make a paper wrong that had nothing to analyse then.
    if (state === 'checked') return 'No AI analysis: this paper had no wrong answer when it was read.';
    return '';
  }

  function notesText(notes, row) {
    var text = Array.isArray(notes) ? notes.filter(Boolean).join('\n')
      : notes === undefined || notes === null ? '' : String(notes);
    var current = row && G().analysisCurrent(row);
    var concerns = current && Array.isArray(row.analysisReadConcerns) ? row.analysisReadConcerns : [];
    if (concerns.length) {
      text += (text ? '\n' : '') + 'The AI analysis reads ' + qList(concerns) + ' differently from the reader; check the answer on the paper.';
    }
    var right = current && Array.isArray(row.analysisExpectedConcerns) ? row.analysisExpectedConcerns : [];
    if (right.length) {
      text += (text ? '\n' : '') + 'The AI analysis says the answer to ' + qList(right) + ' looks right; check the expected answer.';
    }
    return text;
  }

  // A paper with nothing graded has no percent: the cell is left empty.
  function percentOf(row) {
    var max = num(row.maxScore);
    return max > 0 ? round1(num(row.score) / max * 100) : null;
  }

  function rosterRow(row, n) {
    var name = row.studentName ? String(row.studentName).trim() : '';
    if (name === '') name = '(no name)';
    if (row.nameFlag) name += FLAG;
    var out = [name, num(row.score), num(row.maxScore), percentOf(row)];
    for (var q = 1; q <= n; q++) out.push(answerCell(answerFor(row, q)));
    out.push(rowHasFlag(row) ? '*' : '');
    out.push(analysisCell(row));
    out.push(notesText(row.notes, row));
    out.push(row.readBy ? String(row.readBy) : '');
    out.push(row.reviewedBy ? String(row.reviewedBy) : '');
    out.push(reviewLabel(row.reviewMode));
    return out;
  }

  // 'none' is a row whose second read failed on every model: saying
  // 'two-model' there would claim a cross-check that never happened.
  function reviewLabel(mode) {
    if (mode === 'single-model') return 'single-model review';
    if (mode === 'none') return 'no second read';
    return 'two-model';
  }

  // Column width = longest text in the column plus a little, within [min, max].
  function columnWidths(aoa, limits) {
    return limits.map(function (lim, c) {
      var longest = 0;
      aoa.forEach(function (r) {
        var v = r[c];
        if (v === undefined || v === null) return;
        String(v).split('\n').forEach(function (line) { longest = Math.max(longest, line.length); });
      });
      return { wch: Math.max(lim[0], Math.min(lim[1], longest + 2)) };
    });
  }

  function rosterSheet(rows, n) {
    var header = ['Student', 'Score', 'Max', 'Percent'];
    for (var q = 1; q <= n; q++) header.push('Q' + q);
    header.push('Flags', 'Analysis (AI)', 'Notes', 'Read by', 'Reviewed by', 'Review');
    var aoa = [header].concat(rows.map(function (row) { return rosterRow(row, n); }));

    var limits = [[10, 30], [7, 8], [6, 8], [9, 10]];
    for (var i = 0; i < n; i++) limits.push([8, 24]);
    limits.push([6, 6], [24, 60], [20, 60], [10, 32], [12, 32], [12, 22]);

    var ws = X().utils.aoa_to_sheet(aoa);
    ws['!cols'] = columnWidths(aoa, limits);
    return ws;
  }

  // How question q is graded, as the key says: 'exact' is exact form; anything
  // else, including a key saved before the setting existed, is value.
  function matchLabel(key, q) {
    var list = key && Array.isArray(key.questions) ? key.questions : [];
    var question = list[Number(q) - 1];
    return question && question.match === 'exact' ? 'exact form' : 'value';
  }

  var SOURCE_LABEL = { key: 'answer key', computed: 'worked out by code', ai: 'AI-solved, check' };

  function settledQuestion(settled, q) {
    return settled && Array.isArray(settled.questions) ? settled.questions[q - 1] || null : null;
  }

  // The class's expected answer to a question as the rows were graded on
  // it: the answer most rows show.
  function expectedFor(rows, q) {
    var counts = {}, best = '', most = 0;
    rows.forEach(function (row) {
      var a = Array.isArray(row.answers) ? row.answers[q - 1] : null;
      var e = a && a.graded !== false && a.expected ? String(a.expected) : '';
      if (!e) return;
      counts[e] = (counts[e] || 0) + 1;
      if (counts[e] > most) { most = counts[e]; best = e; }
    });
    return best;
  }

  function printedFor(sq) {
    if (!sq) return '';
    if (sq.computed) {
      var sup = sq.computed.support;
      return sq.computed.expression + ' (read this way on ' + sup.agree + ' of ' + sup.of + (sup.of === 1 ? ' paper)' : ' papers)');
    }
    return sq.text || '';
  }

  // How a question was compared, from where its expected answer came: the
  // key's own setting, exact form for an AI answer to a question that asks
  // for a form, value otherwise; nothing for a question not graded.
  function gradedMatch(key, sq, q) {
    if (!sq) return matchLabel(key, q);
    if (sq.source === 'key') return sq.match === 'exact' ? 'exact form' : 'value';
    if (sq.source === 'ai') return sq.ai && sq.ai.exact ? 'exact form' : 'value';
    if (sq.source === 'computed') return 'value';
    return null;
  }

  function summarySheet(summary, passPercent, key, rows, settled) {
    var none = num(summary.students) > 0 && num(summary.notGraded) === num(summary.students);
    var aoa = [
      ['Students', num(summary.students)],
      ['Mean %', none ? null : round1(summary.mean)],
      ['Median %', none ? null : round1(summary.median)],
      ['Pass rate % (pass at ' + passPercent + '%)', none ? null : round1(summary.passRate)],
      ['Rows with flags', num(summary.flaggedRows)],
      ['Single-model review rows', num(summary.singleModelRows)]
    ];
    if (num(summary.notGraded)) {
      aoa.push(['Papers with nothing graded', num(summary.notGraded)]);
      aoa.push(['These have no percent and are left out of the mean, median, pass rate and bands.']);
    }
    aoa.push([], ['Question', 'Hit rate %', 'Match', 'Expected answer', 'Answer from', 'Printed question as read']);
    var aiQs = [], notes = [], ungraded = [];
    (summary.perQuestion || []).forEach(function (p) {
      var sq = settledQuestion(settled, p.q);
      var source = sq ? sq.source : 'key';
      var from = source === 'none' ? 'not graded' : SOURCE_LABEL[source] || 'answer key';
      if (source === 'ai') aiQs.push(p.q);
      if (source === 'none') ungraded.push('Q' + p.q + ': ' + (sq.reason || 'no expected answer.'));
      aoa.push(['Q' + p.q, p.hitRate === null || p.hitRate === undefined ? 'not graded' : round1(p.hitRate),
        gradedMatch(key, sq, p.q), expectedFor(rows, p.q) || null, from, printedFor(sq) || null]);
      if (sq && sq.keyConflict) notes.push(sq.keyConflict);
    });
    if (ungraded.length) {
      aoa.push([], ['Not graded']);
      ungraded.forEach(function (line) { aoa.push([line]); });
    }
    if (aiQs.length) {
      aoa.push([], ['AI-solved, check: ' + aiQs.map(function (q) { return 'Q' + q; }).join(', ') +
        '. No answer key was given for ' + (aiQs.length === 1 ? 'it' : 'them') + ' and code could not work ' +
        (aiQs.length === 1 ? 'it' : 'them') + ' out, so an AI solved ' + (aiQs.length === 1 ? 'it' : 'each') +
        ' twice and the answers agreed. Type the answer in step 2 to grade on your own.']);
    }
    if (notes.length) {
      aoa.push([], ['The key and the printed question disagree']);
      notes.forEach(function (n) { aoa.push([n]); });
    }
    aoa.push([], ['Score band', 'Students']);
    (summary.distribution || []).forEach(function (d) {
      aoa.push([String(d.bucket), num(d.count)]);
    });
    var patterns = summary.errorPatterns || [];
    aoa.push([], ['Common error patterns (AI observations)', 'Students', 'Questions']);
    if (!patterns.length) {
      aoa.push([num(summary.analyses) ? 'None named.' : num(summary.staleAnalyses) ? 'No current AI analysis.' : 'No AI analysis was written.']);
    }
    patterns.forEach(function (p) {
      aoa.push([p.pattern, num(p.students), p.questions.map(function (q) { return 'Q' + q; }).join(', ')]);
    });
    if (num(summary.staleAnalyses)) {
      aoa.push([num(summary.staleAnalyses) + (num(summary.staleAnalyses) === 1 ? ' analysis was' : ' analyses were') +
        ' written before an expected answer it covers changed, and ' + (num(summary.staleAnalyses) === 1 ? 'is' : 'are') +
        ' left out of these counts.']);
    }

    var ws = X().utils.aoa_to_sheet(aoa);
    ws['!cols'] = columnWidths(aoa, [[12, 40], [10, 12], [7, 12], [10, 24], [12, 40], [16, 60]]);
    return ws;
  }

  // The Exemplars tab: a heading, then per question its worked example or
  // the reason it has none. Rows that open with Question, Method or Answer
  // keep that label in column A; every other row moves right one column, so
  // a digit grid starts in column B with its sign and runs one digit to a
  // narrow column. A table (an area model) starts to the right of the
  // widest digit grid, so its wide cells never spread a digit grid apart.
  function exemplarSheet(exemplars) {
    var digitWidth = 0;
    (exemplars || []).forEach(function (e) {
      (e.ok ? e.rows : []).forEach(function (row) {
        if (row.table || row[0] === 'Question' || row[0] === 'Method' || row[0] === 'Answer' || row.length <= 2) return;
        var last = row.length;
        while (last > 0 && !(typeof row[last - 1] === 'string' && row[last - 1].length === 1)) last--;
        digitWidth = Math.max(digitWidth, last);
      });
    });
    var tableAt = 1 + digitWidth + 1;
    var aoa = [
      ['Worked examples, computed and checked by TABot\'s code, not by AI. Each one is worked out in exact ' +
        'arithmetic and checked a second way before it is shown.'],
      []
    ];
    var gridRows = [], tableRows = [];
    (exemplars || []).forEach(function (e) {
      if (!e.ok) {
        aoa.push(['Q' + e.q, 'No worked example: ' + e.reason]);
        aoa.push([]);
        return;
      }
      aoa.push(['Q' + e.q]);
      e.rows.forEach(function (row) {
        if (!row.length) { aoa.push([]); return; }
        if (row[0] === 'Question' || row[0] === 'Method' || row[0] === 'Answer') {
          aoa.push(row.slice(0, 1).concat([row.slice(1).filter(function (c) { return c !== null && c !== undefined; }).join('  ')]));
          return;
        }
        if (row.table) {
          var placed = [];
          for (var i = 0; i < tableAt; i++) placed.push(null);
          placed = placed.concat(row);
          tableRows.push(placed);
          aoa.push(placed);
          return;
        }
        var shifted = [null].concat(row);
        if (row.length > 2) gridRows.push(shifted);
        aoa.push(shifted);
      });
      aoa.push([]);
    });
    if (!(exemplars || []).length) aoa.push(['No questions.']);

    var ws = X().utils.aoa_to_sheet(aoa);
    // Column A holds labels. A digit-grid column is 3 wide, so digits sit
    // close like a printed grid; a table column is as wide as its widest
    // cell. Text rows are left out of the widths: their text runs on over
    // empty cells.
    var widths = [{ wch: 10 }], most = 0;
    gridRows.concat(tableRows).forEach(function (r) { most = Math.max(most, r.length); });
    for (var c = 1; c < most; c++) {
      var w = 3;
      tableRows.forEach(function (r) {
        var v = r[c];
        if (typeof v === 'string') w = Math.max(w, v.length + 1);
      });
      widths.push({ wch: Math.min(w, 16) });
    }
    ws['!cols'] = widths;
    return ws;
  }

  // The label names the pass mark the summary was computed with.
  function passPercentOf(key, summary) {
    var candidates = [key && key.passPercent, summary.passPercent];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (v !== undefined && v !== null && v !== '' && isFinite(Number(v))) return Number(v);
    }
    return DEFAULT_PASS;
  }

  function buildWorkbook(opts) {
    opts = opts || {};
    var rows = Array.isArray(opts.rows) ? opts.rows : [];
    var key = opts.key || null;
    if (!opts.summary || typeof opts.summary !== 'object') {
      throw new TypeError('buildWorkbook needs the summary from grade.summarize');
    }
    var pass = passPercentOf(key, opts.summary);

    var utils = X().utils;
    var wb = utils.book_new();
    utils.book_append_sheet(wb, rosterSheet(rows, questionCount(key, rows)), 'Roster');
    utils.book_append_sheet(wb, summarySheet(opts.summary, pass, key, rows, opts.settled || null), 'Summary');
    utils.book_append_sheet(wb, exemplarSheet(opts.exemplars || []), 'Exemplars');
    wb.Props = { Title: 'TABot ' + (String(opts.assignment || '').trim() || 'assignment') + ' ' + ymd(opts.date) };
    return wb;
  }

  function toArrayBuffer(workbook) {
    return X().write(workbook, { bookType: 'xlsx', type: 'array' });
  }

  return {
    fileName: fileName,
    buildWorkbook: buildWorkbook,
    toArrayBuffer: toArrayBuffer
  };
});
