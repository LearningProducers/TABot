// Synthetic exit-slip photos for tests. Pure JS, no canvas, deterministic per
// seed, so node unit tests and the e2e PNG fixture come from one generator.
// Nothing here is real student work: the "handwriting" is random polylines.
//
// Coordinates follow js/segment.js: pixel (x, y) covers [x, x+1) x [y, y+1)
// and is sampled at its center; angle is the direction of the w side in image
// coordinates (y down), so a positive angle turns clockwise on screen.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TABotSynth = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SURFACES = [
    [50, 64, 92],  // slate blue
    [76, 52, 40],  // walnut
    [38, 76, 58],  // green felt
    [48, 48, 54]   // charcoal
  ];
  var PAPER = [243, 239, 229];
  var HEADER_FILL = [206, 207, 212];
  var PRINT = [44, 44, 50];
  var INKS = [[32, 40, 84], [30, 30, 34], [72, 72, 78]]; // blue pen, black pen, pencil
  var MAX_LAYOUT_DEG = 12;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(rnd, list) {
    return list[Math.floor(rnd() * list.length)];
  }

  // A blank opaque black RGBA raster.
  function makeRaster(width, height) {
    var data = new Uint8ClampedArray(width * height * 4);
    for (var i = 3; i < data.length; i += 4) data[i] = 255;
    return { width: width, height: height, data: data };
  }

  // Area-average downscale so the long side is longSide, the way the app's
  // analysis canvas shrinks a photo. Works on RGBA or gray rasters.
  function downscale(raster, longSide) {
    var W = raster.width, H = raster.height, ch = raster.data.length / (W * H);
    var f = Math.max(W, H) / longSide;
    var w = f > 1 ? Math.max(1, Math.round(W / f)) : W;
    var h = f > 1 ? Math.max(1, Math.round(H / f)) : H;
    var fx = W / w, fy = H / h, src = raster.data;
    var out = new raster.data.constructor(w * h * ch), sums = new Float64Array(ch);

    for (var oy = 0; oy < h; oy++) {
      var sy0 = Math.floor(oy * fy), sy1 = Math.max(sy0 + 1, Math.min(H, Math.floor((oy + 1) * fy)));
      for (var ox = 0; ox < w; ox++) {
        var sx0 = Math.floor(ox * fx), sx1 = Math.max(sx0 + 1, Math.min(W, Math.floor((ox + 1) * fx)));
        var c, count = (sy1 - sy0) * (sx1 - sx0);
        for (c = 0; c < ch; c++) sums[c] = 0;
        for (var sy = sy0; sy < sy1; sy++) {
          for (var sx = sx0; sx < sx1; sx++) {
            var s = (sy * W + sx) * ch;
            for (c = 0; c < ch; c++) sums[c] += src[s + c];
          }
        }
        var o = (oy * w + ox) * ch;
        for (c = 0; c < ch; c++) out[o + c] = Math.round(sums[c] / count);
      }
    }
    return { width: w, height: h, data: out };
  }

  // A gentle linear lighting falloff across the photo, at most +/-25% at a corner.
  function lighting(rnd, width, height) {
    var gx = (rnd() * 2 - 1) * 0.25, gy = (rnd() * 2 - 1) * 0.25;
    return function (x, y) { return 1 + gx * (x / width - 0.5) + gy * (y / height - 0.5); };
  }

  function paintSurface(raster, rnd, light, color) {
    var W = raster.width, H = raster.height, d = raster.data;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var L = light(x + 0.5, y + 0.5), n = (rnd() + rnd() - 1) * 8, i = (y * W + x) * 4;
        d[i] = color[0] * L + n;
        d[i + 1] = color[1] * L + n;
        d[i + 2] = color[2] * L + n;
      }
    }
  }

  function blend(d, i, color, cover) {
    d[i] = d[i] + (color[0] - d[i]) * cover;
    d[i + 1] = d[i + 1] + (color[1] - d[i + 1]) * cover;
    d[i + 2] = d[i + 2] + (color[2] - d[i + 2]) * cover;
  }

  // An anti-aliased round-capped line segment in image coordinates.
  function drawSegment(raster, ax, ay, bx, by, half, ink) {
    var W = raster.width, H = raster.height, d = raster.data, reach = half + 1;
    var x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + reach));
    var y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + reach));
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var px = x + 0.5 - ax, py = y + 0.5 - ay;
        var t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        var qx = px - t * dx, qy = py - t * dy;
        var cover = half + 0.5 - Math.sqrt(qx * qx + qy * qy);
        if (cover > 0) blend(d, (y * W + x) * 4, ink, Math.min(1, cover));
      }
    }
  }

  // The printed header: a light gray bar inset from the slip edge, with dark
  // word-shaped blocks in it. Local coordinates, origin at the slip center.
  function printedLayout(rnd, slip) {
    var m = 0.07 * slip.h, barH = 0.15 * slip.h;
    var bar = { left: -slip.w / 2 + m, right: slip.w / 2 - m, top: -slip.h / 2 + m, bottom: -slip.h / 2 + m + barH };
    var words = [], u = bar.left + 0.04 * slip.w, stop = bar.left + 0.75 * (bar.right - bar.left);
    while (u < stop) {
      var len = (0.05 + rnd() * 0.1) * slip.w;
      words.push([u, Math.min(u + len, bar.right - 0.02 * slip.w)]);
      u += len + 0.025 * slip.w;
    }
    return { bar: bar, words: words, textTop: bar.top + 0.3 * barH, textBottom: bar.top + 0.7 * barH };
  }

  function printedColor(layout, u, v) {
    var bar = layout.bar;
    if (u < bar.left || u > bar.right || v < bar.top || v > bar.bottom) return null;
    if (v >= layout.textTop && v <= layout.textBottom) {
      for (var k = 0; k < layout.words.length; k++) {
        if (u >= layout.words[k][0] && u <= layout.words[k][1]) return PRINT;
      }
    }
    return HEADER_FILL;
  }

  function wobblyBox(rnd, left, top, right, bottom, jitter) {
    var pts = [[left, top], [(left + right) / 2, top], [right, top], [right, (top + bottom) / 2],
      [right, bottom], [(left + right) / 2, bottom], [left, bottom], [left, (top + bottom) / 2]];
    return pts.map(function (p) { return [p[0] + (rnd() * 2 - 1) * jitter, p[1] + (rnd() * 2 - 1) * jitter]; });
  }

  function loop(rnd, cx, cy, rx, ry) {
    var pts = [];
    for (var k = 0; k < 40; k++) {
      var a = k / 40 * 2 * Math.PI, r = 1 + (rnd() * 2 - 1) * 0.03;
      pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
    }
    return pts;
  }

  // A wavy pen line from u0 to u1 around baseline v, amplitude amp.
  function scrawl(rnd, u0, u1, v, amp, step) {
    var pts = [];
    for (var u = u0; u <= u1; u += step * (0.6 + rnd() * 0.8)) pts.push([u, v + (rnd() * 2 - 1) * amp]);
    return { points: pts, closed: false };
  }

  // Answer lines in the slip body, in local coordinates. Heavy handwriting is
  // thick ink with a box drawn round one answer, a loop circling another and a
  // crossed-out patch. Each closed shape encloses a big island of paper that
  // would read as a slip of its own if segmentation did not fill holes. Ink
  // stays off the paper edge, as it does on a real slip with a margin.
  function handwriting(rnd, slip, heavy) {
    var w = slip.w, h = slip.h, m = 0.07 * h;
    var half = heavy ? Math.max(2, 0.02 * h) : Math.max(1, 0.006 * h);
    var left = -w / 2 + m + half, right = w / 2 - m - half;
    var top = -h / 2 + m + 0.15 * h + 0.6 * m + half, bottom = h / 2 - m - half;
    var bodyW = right - left, bodyH = bottom - top, paths = [];
    function U(f) { return left + f * bodyW; }
    function V(f) { return top + f * bodyH; }

    if (!heavy) {
      var lineH = bodyH / 3;
      for (var i = 0; i < 3; i++) {
        var start = left + rnd() * 0.06 * w, end = left + (0.35 + rnd() * 0.6) * bodyW;
        paths.push(scrawl(rnd, start, end, top + (i + 0.5) * lineH, 0.35 * lineH, 0.03 * w));
      }
      return { paths: paths, half: half, ink: pick(rnd, INKS) };
    }

    var j = 0.006 * w;
    paths.push({ points: wobblyBox(rnd, U(0) + j, V(0) + j, U(0.46), V(0.6), j), closed: true });
    paths.push(scrawl(rnd, U(0.12), U(0.3), V(0.3), 0.06 * bodyH, 0.025 * w));
    paths.push({ points: loop(rnd, U(0.76), V(0.33), 0.2 * bodyW, 0.3 * bodyH), closed: true });
    paths.push(scrawl(rnd, U(0.68), U(0.82), V(0.33), 0.05 * bodyH, 0.025 * w));
    paths.push(scrawl(rnd, U(0), U(0.3 + rnd() * 0.2), V(0.8), 0.06 * bodyH, 0.03 * w));
    paths.push(scrawl(rnd, U(0), U(0.3 + rnd() * 0.2), V(0.96), 0.03 * bodyH, 0.03 * w));
    var zig = [];
    for (var z = 0, zu = U(0.6); zu <= U(0.95); z++, zu += 0.012 * w) zig.push([zu, z % 2 ? V(1) : V(0.74)]);
    paths.push({ points: zig, closed: false });
    return { paths: paths, half: half, ink: pick(rnd, INKS) };
  }

  // A full-page quiz in local coordinates: a printed question line over each
  // of three blocks; a multiple choice with four printed options and one
  // circled in ink; two multiplications, each a printed grid with digit-like
  // ink marks in its cells. Printed parts are returned as segments to draw in
  // PRINT, handwritten parts in ink.
  function quizPage(rnd, slip) {
    var w = slip.w, h = slip.h, m = 0.07 * Math.min(w, h);
    var left = -w / 2 + m, right = w / 2 - m, top = -h / 2 + m + 0.15 * h, bottom = h / 2 - m;
    var blockH = (bottom - top) / 3, printed = [], inked = [];
    var printHalf = Math.max(0.6, 0.0015 * h), inkHalf = Math.max(1, 0.003 * h);

    for (var b = 0; b < 3; b++) {
      var y0 = top + b * blockH, textV = y0 + 0.08 * blockH;
      var u = left, stop = left + (0.5 + rnd() * 0.3) * (right - left);
      while (u < stop) {
        var len = (0.04 + rnd() * 0.08) * w;
        printed.push([[u, textV], [Math.min(u + len, stop), textV]]);
        u += len + 0.02 * w;
      }
      if (b === 0) {
        var chosen = Math.floor(rnd() * 4);
        for (var k = 0; k < 4; k++) {
          var ou = left + 0.05 * w, ov = y0 + (0.25 + 0.17 * k) * blockH;
          printed.push([[ou, ov], [ou + 0.12 * w, ov]]);
          if (k === chosen) {
            var ring = loop(rnd, ou + 0.06 * w, ov, 0.09 * w, 0.06 * blockH);
            for (var r = 0; r < ring.length; r++) inked.push([ring[r], ring[(r + 1) % ring.length]]);
          }
        }
        continue;
      }
      var cols = 5, rows = 5, cell = Math.min(0.06 * w, 0.75 * blockH / rows);
      var gu = left + 0.1 * w, gv = y0 + 0.2 * blockH;
      for (var c = 0; c <= cols; c++) printed.push([[gu + c * cell, gv], [gu + c * cell, gv + rows * cell]]);
      for (var rr = 0; rr <= rows; rr++) printed.push([[gu, gv + rr * cell], [gu + cols * cell, gv + rr * cell]]);
      for (var ry = 0; ry < rows; ry++) {
        for (var cx = 0; cx < cols; cx++) {
          if (rnd() < 0.3) continue;
          var mu = gu + (cx + 0.5) * cell, mv = gv + (ry + 0.5) * cell, a = 0.3 * cell;
          inked.push([[mu - a * 0.6, mv - a], [mu + a * 0.6, mv - a * 0.2]]);
          inked.push([[mu + a * 0.6, mv - a * 0.2], [mu - a * 0.4, mv + a]]);
        }
      }
    }
    return { printed: printed, printHalf: printHalf, inked: inked, inkHalf: inkHalf };
  }

  // Darkens the surface in a band outside a rect, the soft shadow a top page
  // casts on the pages under it: strength at the edge, fading to nothing at
  // width px.
  function paintShadow(raster, slip, width, strength) {
    var W = raster.width, H = raster.height, d = raster.data;
    var cos = Math.cos(slip.angle), sin = Math.sin(slip.angle);
    var halfW = slip.w / 2, halfH = slip.h / 2;
    var ex = halfW * Math.abs(cos) + halfH * Math.abs(sin) + width + 2;
    var ey = halfW * Math.abs(sin) + halfH * Math.abs(cos) + width + 2;
    var x0 = Math.max(0, Math.floor(slip.cx - ex)), x1 = Math.min(W - 1, Math.ceil(slip.cx + ex));
    var y0 = Math.max(0, Math.floor(slip.cy - ey)), y1 = Math.min(H - 1, Math.ceil(slip.cy + ey));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - slip.cx, dy = y + 0.5 - slip.cy;
        var u = Math.abs(dx * cos + dy * sin) - halfW, v = Math.abs(-dx * sin + dy * cos) - halfH;
        var out = Math.sqrt(Math.max(0, u) * Math.max(0, u) + Math.max(0, v) * Math.max(0, v));
        if (out <= 0 || out >= width) continue;
        var k = 1 - strength * (1 - out / width), i = (y * W + x) * 4;
        d[i] *= k;
        d[i + 1] *= k;
        d[i + 2] *= k;
      }
    }
  }

  function paintSlip(raster, rnd, light, slip, heavy, kind) {
    var W = raster.width, H = raster.height, d = raster.data;
    var cos = Math.cos(slip.angle), sin = Math.sin(slip.angle);
    var halfW = slip.w / 2, halfH = slip.h / 2;
    var ex = halfW * Math.abs(cos) + halfH * Math.abs(sin) + 2;
    var ey = halfW * Math.abs(sin) + halfH * Math.abs(cos) + 2;
    var x0 = Math.max(0, Math.floor(slip.cx - ex)), x1 = Math.min(W - 1, Math.ceil(slip.cx + ex));
    var y0 = Math.max(0, Math.floor(slip.cy - ey)), y1 = Math.min(H - 1, Math.ceil(slip.cy + ey));
    var shadeU = (rnd() * 2 - 1) * 0.05, shadeV = (rnd() * 2 - 1) * 0.05, warm = rnd() * 6;
    var layout = printedLayout(rnd, slip), color = [0, 0, 0];

    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - slip.cx, dy = y + 0.5 - slip.cy;
        var u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
        var cover = Math.min(halfW - Math.abs(u), halfH - Math.abs(v)) + 0.5;
        if (cover <= 0) continue;
        var base = printedColor(layout, u, v) || PAPER;
        var f = light(x + 0.5, y + 0.5) * (1 + shadeU * u / slip.w + shadeV * v / slip.h);
        var n = (rnd() + rnd() - 1) * 5;
        color[0] = base[0] * f + n;
        color[1] = base[1] * f + n;
        color[2] = base[2] * f - warm + n;
        blend(d, (y * W + x) * 4, color, Math.min(1, cover));
      }
    }

    function toImage(p) {
      return [slip.cx + p[0] * cos - p[1] * sin, slip.cy + p[0] * sin + p[1] * cos];
    }
    if (kind === 'blank') return;
    if (kind === 'quiz') {
      var quiz = quizPage(rnd, slip), pen = pick(rnd, INKS);
      quiz.printed.forEach(function (sg) {
        var a = toImage(sg[0]), b = toImage(sg[1]);
        drawSegment(raster, a[0], a[1], b[0], b[1], quiz.printHalf, PRINT);
      });
      quiz.inked.forEach(function (sg) {
        var a = toImage(sg[0]), b = toImage(sg[1]);
        drawSegment(raster, a[0], a[1], b[0], b[1], quiz.inkHalf, pen);
      });
      return;
    }
    var ink = handwriting(rnd, slip, heavy);
    ink.paths.forEach(function (path) {
      var pts = path.points.map(toImage);
      var last = path.closed ? pts.length : pts.length - 1;
      for (var k = 0; k < last; k++) {
        var a = pts[k], b = pts[(k + 1) % pts.length];
        drawSegment(raster, a[0], a[1], b[0], b[1], ink.half, ink.ink);
      }
    });
  }

  // slips: [{cx, cy, w, h, angleDeg, heavy, kind, shadow}] in pixels; heavy
  // (optional) draws heavy handwriting on that slip; kind 'quiz' draws a
  // full-page quiz instead (see quizPage), kind 'blank' paper with no handwriting; shadow
  // (px, optional) casts a soft shadow round it on whatever lies below.
  // Later slips paint over earlier ones.
  // under: [{cx, cy, w, h, angleDeg}] blank pages painted first, with no
  // shadow and no ink: a stack of white pages the slips rest on. They are not
  // in truth.
  // truth keeps the input order of slips, angle in radians.
  function makePhoto(opts) {
    opts = opts || {};
    var seed = opts.seed === undefined ? 1 : opts.seed;
    var width = opts.width || 2000, height = opts.height || 1500;
    var rnd = mulberry32(seed);
    var raster = makeRaster(width, height);
    var light = lighting(rnd, width, height);
    paintSurface(raster, rnd, light, pick(rnd, SURFACES));

    function rect(s) {
      return { cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: (s.angleDeg || 0) * Math.PI / 180 };
    }
    (opts.under || []).forEach(function (s) {
      paintSlip(raster, rnd, light, rect(s), false, 'blank');
    });
    var truth = (opts.slips || []).map(function (s) {
      var slip = rect(s);
      if (s.shadow) paintShadow(raster, slip, s.shadow, 0.3);
      paintSlip(raster, rnd, light, slip, !!s.heavy, s.kind);
      return slip;
    });
    return { raster: raster, truth: truth };
  }

  // Two slips pressed together: slip, then a twin of the same size and angle
  // placed past one of its sides so the two cover each other by overlap px
  // (default 3) and read as one blob. along 'w' (the default) puts the twin
  // past the end of the w side, end to end, so the pair is twice as long for
  // its width as one slip. along 'h' puts it past the h side, the two w edges
  // meeting, so the pair has the outline of one bigger slip.
  function touchingPair(slip, opts) {
    opts = opts || {};
    var overlap = opts.overlap === undefined ? 3 : opts.overlap;
    var a = (slip.angleDeg || 0) * Math.PI / 180;
    var alongH = opts.along === 'h';
    var step = (alongH ? slip.h : slip.w) - overlap;
    var dx = alongH ? -Math.sin(a) : Math.cos(a), dy = alongH ? Math.cos(a) : Math.sin(a);
    var twin = {};
    for (var k in slip) twin[k] = slip[k];
    twin.cx = slip.cx + step * dx;
    twin.cy = slip.cy + step * dy;
    return [slip, twin];
  }

  // n slips (1 to 10) on a grid, in reading order, rotations within +/-12
  // degrees. Every slip's bounding box at the full 12 degrees fits inside its
  // cell with a margin, so slips never overlap or touch. Rows stay far apart
  // and each slip drifts vertically by at most a tenth of its height, so
  // reading order is never ambiguous.
  function layoutGrid(n, opts) {
    opts = opts || {};
    if (!(n >= 1 && n <= 10 && n === Math.floor(n))) throw new RangeError('layoutGrid takes 1 to 10 slips');
    var width = opts.width || 2000, height = opts.height || 1500;
    var rnd = mulberry32(opts.seed === undefined ? 1 : opts.seed);
    var cols = Math.min(n, Math.ceil(Math.sqrt(n * width / height))), rows = Math.ceil(n / cols);
    var cellW = width / cols, cellH = height / rows;
    var maxA = MAX_LAYOUT_DEG * Math.PI / 180, c = Math.cos(maxA), s = Math.sin(maxA);
    var specs = [];

    for (var i = 0; i < n; i++) {
      var col = i % cols, row = Math.floor(i / cols);
      var aspect = 1.35 + rnd() * 0.4, fill = 0.66 + rnd() * 0.1;
      var w = Math.min(fill * cellW / (c + s / aspect), fill * cellH / (s + c / aspect), 0.42 * width);
      var h = w / aspect;
      var boxW = w * c + h * s, boxH = w * s + h * c;
      var slackX = 0.8 * (cellW - boxW) / 2, slackY = Math.min(0.8 * (cellH - boxH) / 2, 0.1 * h);
      specs.push({
        cx: (col + 0.5) * cellW + (rnd() * 2 - 1) * slackX,
        cy: (row + 0.5) * cellH + (rnd() * 2 - 1) * slackY,
        w: w,
        h: h,
        angleDeg: (rnd() * 2 - 1) * MAX_LAYOUT_DEG
      });
    }
    return specs;
  }

  return {
    mulberry32: mulberry32,
    makeRaster: makeRaster,
    makePhoto: makePhoto,
    touchingPair: touchingPair,
    layoutGrid: layoutGrid,
    downscale: downscale
  };
});
