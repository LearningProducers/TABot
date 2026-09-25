/*
 * TABot sheet: the downloaded workbook (Roster + Summary) and its file name.
 *
 * Rows are graded slips (grade.gradeSlip output) plus {readBy, reviewedBy,
 * reviewMode} from the app; reviewMode 'single-model' marks a row whose second
 * read ran on an enhanced copy with the same model. The summary is
 * grade.summarize output; its mean, median, passRate and hitRate are percents
 * (0 to 100). Percents are written rounded to one decimal. The Summary's
 * per-question table also names each question's match setting from the key
 * ('value' or 'exact form').
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
    text += a && a.correct ? CHECK : CROSS;
    if (a && a.flagged) text += FLAG;
    return text;
  }

  function rowHasFlag(row) {
    if (row.flagged || row.nameFlag) return true;
    return (row.answers || []).some(function (a) { return a && a.flagged; });
  }

  function notesText(notes) {
    if (Array.isArray(notes)) return notes.filter(Boolean).join('\n');
    return notes === undefined || notes === null ? '' : String(notes);
  }

  function percentOf(row) {
    var max = num(row.maxScore);
    return max > 0 ? round1(num(row.score) / max * 100) : 0;
  }

  function rosterRow(row, n) {
    var name = row.studentName ? String(row.studentName).trim() : '';
    if (name === '') name = '(no name)';
    if (row.nameFlag) name += FLAG;
    var out = [name, num(row.score), num(row.maxScore), percentOf(row)];
    for (var q = 1; q <= n; q++) out.push(answerCell(answerFor(row, q)));
    out.push(rowHasFlag(row) ? '*' : '');
    out.push(notesText(row.notes));
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
    header.push('Flags', 'Notes', 'Read by', 'Reviewed by', 'Review');
    var aoa = [header].concat(rows.map(function (row) { return rosterRow(row, n); }));

    var limits = [[10, 30], [7, 8], [6, 8], [9, 10]];
    for (var i = 0; i < n; i++) limits.push([8, 24]);
    limits.push([6, 6], [20, 60], [10, 32], [12, 32], [12, 22]);

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

  function summarySheet(summary, passPercent, key) {
    var aoa = [
      ['Students', num(summary.students)],
      ['Mean %', round1(summary.mean)],
      ['Median %', round1(summary.median)],
      ['Pass rate % (pass at ' + passPercent + '%)', round1(summary.passRate)],
      ['Rows with flags', num(summary.flaggedRows)],
      ['Single-model review rows', num(summary.singleModelRows)],
      [],
      ['Question', 'Hit rate %', 'Match']
    ];
    (summary.perQuestion || []).forEach(function (p) {
      aoa.push(['Q' + p.q, round1(p.hitRate), matchLabel(key, p.q)]);
    });
    aoa.push([], ['Score band', 'Students']);
    (summary.distribution || []).forEach(function (d) {
      aoa.push([String(d.bucket), num(d.count)]);
    });

    var ws = X().utils.aoa_to_sheet(aoa);
    ws['!cols'] = columnWidths(aoa, [[12, 34], [10, 12], [7, 12]]);
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
    utils.book_append_sheet(wb, summarySheet(opts.summary, pass, key), 'Summary');
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
