// TABot.segment: finds the exit slips in a photo of slips laid on a dark or
// colored surface. Pure functions on plain rasters ({width, height, data}),
// no canvas, so node tests run the same code the page runs.
//
// Coordinates are continuous pixel coordinates: pixel (x, y) covers the square
// [x, x+1) x [y, y+1), so a rect scales exactly with the image.
// A slip is a rotated rectangle {cx, cy, w, h, angle}. angle (radians) is the
// direction of the w side in image coordinates (x right, y down), so a positive
// angle turns clockwise on screen. findSlips keeps angle in [-pi/4, pi/4), the
// smallest turn that makes the slip upright, and swaps w and h to match.
// The upright crop maps crop point (u, v), measured from the crop center, to
// source point (cx + u cos(angle) - v sin(angle), cy + u sin(angle) + v cos(angle)).
// On a canvas of size w x h: ctx.translate(w / 2, h / 2); ctx.rotate(-angle);
// ctx.translate(-cx, -cy); ctx.drawImage(source, 0, 0).
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.segment = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var QUARTER_TURN = Math.PI / 2;
  var EIGHTH_TURN = Math.PI / 4;

  var DEFAULTS = {
    minAreaFrac: 0.004,
    maxAreaFrac: 0.6,
    // When the bright and dark halves of the histogram sit closer than this,
    // the photo is one surface with lighting on it, not paper on a surface.
    minContrast: 40,
    // A lone slip fills nearly all of its rectangle; two slips meeting at an
    // angle leave empty corners, even when their combined area is small.
    minFill: 0.8,
    // Two slips end to end make a blob twice as long for its width as one
    // slip. With 3 or more blobs, a blob whose aspect (long side over short)
    // is more than this many times the median aspect of the others is a pair.
    stretchRatio: 1.6,
    // With fewer than 3 blobs there are no others to measure against, so the
    // aspect of a usual slip stands in: over this, the blob is a pair.
    maxAspect: 2.4,
    // A blob of slip shape this many times the median blob area is 'large':
    // a bigger slip, or two slips long edge to long edge. Only the teacher
    // can say which.
    largeRatio: 1.8,
    // Diagnostic switch for tests; the app always fills holes.
    fillHoles: true
  };

  function options(opts) {
    var out = {};
    for (var k in DEFAULTS) {
      out[k] = opts && opts[k] !== undefined && opts[k] !== null ? opts[k] : DEFAULTS[k];
    }
    return out;
  }

  // ---- rasters ---------------------------------------------------------

  // Integer luma, weights 77/150/29 of 256 (Rec. 601).
  function toGray(rgba) {
    var w = rgba.width, h = rgba.height, n = w * h, src = rgba.data;
    var out = new Uint8Array(n);
    if (src.length === n) {
      out.set(src);
      return { width: w, height: h, data: out };
    }
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      out[i] = (77 * src[j] + 150 * src[j + 1] + 29 * src[j + 2] + 128) >> 8;
    }
    return { width: w, height: h, data: out };
  }

  function asGray(raster) {
    return raster.data.length === raster.width * raster.height ? raster : toGray(raster);
  }

  // Otsu's method on the 256-bin histogram. Paper is every value above the
  // threshold. When a run of thresholds ties (empty bins between the two
  // modes), the middle of the run is taken so the cut sits between them.
  function otsu(gray) {
    var data = gray.data, n = data.length, hist = new Uint32Array(256), i;
    for (i = 0; i < n; i++) hist[data[i]]++;
    var sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];

    var wB = 0, sumB = 0, best = -1, first = 0, last = 0;
    for (var t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      var wF = n - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      var diff = sumB / wB - (sum - sumB) / wF;
      var between = wB * wF * diff * diff;
      if (between > best) { best = between; first = last = t; }
      else if (between === best && last === t - 1) last = t;
    }
    var threshold = (first + last) >> 1;

    var darkN = 0, darkSum = 0;
    for (i = 0; i <= threshold; i++) { darkN += hist[i]; darkSum += i * hist[i]; }
    var lightN = n - darkN;
    return {
      threshold: threshold,
      darkMean: darkN ? darkSum / darkN : NaN,
      lightMean: lightN ? (sum - darkSum) / lightN : NaN
    };
  }

  function otsuThreshold(gray) {
    return otsu(asGray(gray)).threshold;
  }

  // Background is whatever non-paper pixel the image border reaches
  // (4-connected, the complement of 8-connected paper). Every other non-paper
  // pixel is enclosed by paper, so it becomes paper: handwriting, printed bars
  // and a box drawn round an answer stay part of their slip instead of cutting
  // an island of paper loose as a second "slip".
  function fillHoles(mask, W, H, queue) {
    var N = W * H, head = 0, tail = 0, p, x;
    function seed(q) {
      if (mask[q] === 0) { mask[q] = 2; queue[tail++] = q; }
    }
    for (x = 0; x < W; x++) { seed(x); seed(N - W + x); }
    for (var y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }

    while (head < tail) {
      p = queue[head++];
      x = p % W;
      if (x > 0 && mask[p - 1] === 0) { mask[p - 1] = 2; queue[tail++] = p - 1; }
      if (x < W - 1 && mask[p + 1] === 0) { mask[p + 1] = 2; queue[tail++] = p + 1; }
      if (p >= W && mask[p - W] === 0) { mask[p - W] = 2; queue[tail++] = p - W; }
      if (p < N - W && mask[p + W] === 0) { mask[p + W] = 2; queue[tail++] = p + W; }
    }
    for (p = 0; p < N; p++) mask[p] = mask[p] === 2 ? 0 : 1;
  }

  // 8-connected components by breadth-first search over a typed queue (no
  // recursion, so a big slip cannot overflow the stack). For each component
  // in the area range it keeps only the leftmost and rightmost pixel of every
  // row: the convex hull of a pixel set is the hull of those row ends.
  function collectBlobs(mask, W, H, queue, minArea, maxArea) {
    var N = W * H, blobs = [];
    var rowMin = new Int32Array(H).fill(W), rowMax = new Int32Array(H).fill(-1);

    for (var s = 0; s < N; s++) {
      if (mask[s] !== 1) continue;
      mask[s] = 2;
      var head = 0, tail = 0, area = 0, y0 = H, y1 = -1;
      queue[tail++] = s;

      while (head < tail) {
        var p = queue[head++], x = p % W, y = (p - x) / W, q;
        area++;
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        var hasL = x > 0, hasR = x < W - 1;
        if (y > 0) {
          q = p - W;
          if (mask[q] === 1) { mask[q] = 2; queue[tail++] = q; }
          if (hasL && mask[q - 1] === 1) { mask[q - 1] = 2; queue[tail++] = q - 1; }
          if (hasR && mask[q + 1] === 1) { mask[q + 1] = 2; queue[tail++] = q + 1; }
        }
        if (hasL && mask[p - 1] === 1) { mask[p - 1] = 2; queue[tail++] = p - 1; }
        if (hasR && mask[p + 1] === 1) { mask[p + 1] = 2; queue[tail++] = p + 1; }
        if (y < H - 1) {
          q = p + W;
          if (mask[q] === 1) { mask[q] = 2; queue[tail++] = q; }
          if (hasL && mask[q - 1] === 1) { mask[q - 1] = 2; queue[tail++] = q - 1; }
          if (hasR && mask[q + 1] === 1) { mask[q + 1] = 2; queue[tail++] = q + 1; }
        }
      }

      if (area >= minArea && area <= maxArea) {
        blobs.push({ area: area, points: rowEndCorners(rowMin, rowMax, y0, y1) });
      }
      for (var r = y0; r <= y1; r++) { rowMin[r] = W; rowMax[r] = -1; }
    }
    return blobs;
  }

  // The outer corners of each row's end pixels, so the hull wraps whole pixels.
  function rowEndCorners(rowMin, rowMax, y0, y1) {
    var pts = [];
    for (var y = y0; y <= y1; y++) {
      if (rowMax[y] < 0) continue;
      var left = rowMin[y], right = rowMax[y] + 1;
      pts.push([left, y], [right, y], [left, y + 1], [right, y + 1]);
    }
    return pts;
  }

  // ---- geometry --------------------------------------------------------

  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  // Andrew's monotone chain. Returns the hull with no repeated or collinear
  // points, ordered so the inside lies on the positive side of cross().
  function convexHull(points) {
    var pts = points.slice().sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
    if (pts.length < 3) return pts;
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function boundingRect(points) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(function (p) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    });
    if (!points.length) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, angle: 0 };
  }

  // Turns a rect into the equivalent one with angle in [-pi/4, pi/4).
  function upright(rect) {
    var angle = rect.angle, w = rect.w, h = rect.h, t;
    while (angle >= EIGHTH_TURN) { angle -= QUARTER_TURN; t = w; w = h; h = t; }
    while (angle < -EIGHTH_TURN) { angle += QUARTER_TURN; t = w; w = h; h = t; }
    return { cx: rect.cx, cy: rect.cy, w: w, h: h, angle: angle };
  }

  // Minimum-area enclosing rectangle by rotating calipers. The best rectangle
  // has a side on a hull edge, so each edge is tried once while three calipers
  // (farthest along the edge, farthest from it, farthest back along it) only
  // ever move forward around the hull: O(hull size) in total.
  function minAreaRect(hull) {
    var m = hull.length;
    if (m < 3) return boundingRect(hull);
    var best = null, j = 1, k = 0, l = 0;

    for (var i = 0; i < m; i++) {
      var a = hull[i], b = hull[(i + 1) % m];
      var ex = b[0] - a[0], ey = b[1] - a[1], len = Math.sqrt(ex * ex + ey * ey);
      if (len === 0) continue;
      ex /= len;
      ey /= len;
      var along = function (p) { return (p[0] - a[0]) * ex + (p[1] - a[1]) * ey; };
      var away = function (p) { return ex * (p[1] - a[1]) - ey * (p[0] - a[0]); };
      var guard;

      for (guard = 0; guard < m && along(hull[(j + 1) % m]) > along(hull[j]); guard++) j = (j + 1) % m;
      if (i === 0) k = j;
      for (guard = 0; guard < m && away(hull[(k + 1) % m]) > away(hull[k]); guard++) k = (k + 1) % m;
      if (i === 0) l = k;
      for (guard = 0; guard < m && along(hull[(l + 1) % m]) < along(hull[l]); guard++) l = (l + 1) % m;

      var maxU = along(hull[j]), minU = along(hull[l]), height = away(hull[k]);
      var area = (maxU - minU) * height;
      if (best === null || area < best.area) {
        var mid = (maxU + minU) / 2;
        best = {
          area: area,
          cx: a[0] + ex * mid - ey * height / 2,
          cy: a[1] + ey * mid + ex * height / 2,
          w: maxU - minU,
          h: height,
          angle: Math.atan2(ey, ex)
        };
      }
    }
    if (best === null) return boundingRect(hull);
    return upright(best);
  }

  // The four corners of a rect, clockwise on screen from the top-left.
  function corners(rect) {
    var c = Math.cos(rect.angle), s = Math.sin(rect.angle);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (k) {
      var u = k[0] * rect.w / 2, v = k[1] * rect.h / 2;
      return [rect.cx + u * c - v * s, rect.cy + u * s + v * c];
    });
  }

  // ---- ordering and cropping -------------------------------------------

  function median(values) {
    if (!values.length) return 0;
    var v = values.slice().sort(function (a, b) { return a - b; }), mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // The median, taking the lower of the two middle values when the count is
  // even.
  function lowerMedian(values) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    return v[(v.length - 1) >> 1];
  }

  function aspectOf(rect) {
    var longSide = Math.max(rect.w, rect.h), shortSide = Math.min(rect.w, rect.h);
    return shortSide > 0 ? longSide / shortSide : Infinity;
  }

  // Why one blob might not be one slip.
  // 'touching': not the shape of a slip. It leaves empty corners in its
  // rectangle (slips meeting at an angle), or it is far longer for its width
  // than the slips beside it (slips end to end), so it is two or more slips
  // and the photo has to be retaken.
  // 'large': the shape of a slip at well over the median area. It may be a
  // half-sheet or two slips long edge to long edge, and the app asks the
  // teacher which.
  // Touching pairs only ever make a blob longer, so the others' aspect is
  // taken at the lower middle: with two pairs and one lone slip, each pair is
  // measured against the lone slip, not against the average of it and the
  // other pair.
  // Residual limits, by construction:
  // - A pair of quarter-sheets side by side along the long edge has the
  //   aspect of a half-sheet, so it reads as 'large' at best, never proven.
  //   In a photo of one or two blobs the median area is the pair's own, so it
  //   may not read as 'large' either.
  // - When pairs are at least half the blobs in a photo of 3 or more, the
  //   others' median aspect is itself a pair's, and only the fill and area
  //   rules can still catch them.
  // - One or two slips longer than maxAspect for their width (a strip cut
  //   from a sheet) read as 'touching'. Three or more strips to a photo are
  //   judged against each other and pass.
  function suspicion(found, i, medianArea, o) {
    var f = found[i];
    if (f.fill < o.minFill) return 'touching';
    if (found.length >= 3) {
      var others = [];
      for (var j = 0; j < found.length; j++) if (j !== i) others.push(found[j].aspect);
      if (f.aspect > o.stretchRatio * lowerMedian(others)) return 'touching';
    } else if (f.aspect > o.maxAspect) {
      return 'touching';
    }
    if (f.area > o.largeRatio * medianArea) return 'large';
    return null;
  }

  // The side of the rect that runs closest to vertical.
  function verticalSize(r) {
    var a = r.angle || 0;
    return Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)) ? r.h : r.w;
  }

  // Rows top to bottom, then left to right. A rect joins the current row when
  // its center is within half the median slip height of the row's mean
  // center; the running mean keeps a slightly tilted row together.
  function readingOrder(rects) {
    var list = rects.slice();
    if (list.length < 2) return list;
    var tolerance = 0.5 * median(list.map(verticalSize));
    list.sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx; });

    var rows = [], row = null, rowSum = 0;
    list.forEach(function (r) {
      if (row && Math.abs(r.cy - rowSum / row.length) <= tolerance) {
        row.push(r);
        rowSum += r.cy;
      } else {
        row = [r];
        rowSum = r.cy;
        rows.push(row);
      }
    });
    var out = [];
    rows.forEach(function (rw) {
      rw.sort(function (a, b) { return a.cx - b.cx || a.cy - b.cy; });
      out.push.apply(out, rw);
    });
    return out;
  }

  // Scales a rect found on the analysis raster to the source image. opts.pad
  // (analysis pixels, default 0) widens every side so a crop that is a pixel
  // off never trims writing at the edge.
  function cropPlan(slip, scale, opts) {
    var pad = opts && opts.pad ? opts.pad : 0;
    return {
      cx: slip.cx * scale,
      cy: slip.cy * scale,
      w: (slip.w + 2 * pad) * scale,
      h: (slip.h + 2 * pad) * scale,
      angle: slip.angle
    };
  }

  // ---- the pipeline ----------------------------------------------------

  function findSlipsDetailed(raster, opts) {
    var o = options(opts);
    var gray = asGray(raster), W = gray.width, H = gray.height, N = W * H;
    if (!N) return { slips: [], warnings: ['none'] };

    var split = otsu(gray);
    if (!(split.lightMean - split.darkMean >= o.minContrast)) return { slips: [], warnings: ['none'] };

    var data = gray.data, t = split.threshold, mask = new Uint8Array(N);
    for (var i = 0; i < N; i++) mask[i] = data[i] > t ? 1 : 0;

    var queue = new Int32Array(N);
    if (o.fillHoles) fillHoles(mask, W, H, queue);
    var blobs = collectBlobs(mask, W, H, queue, o.minAreaFrac * N, o.maxAreaFrac * N);
    if (!blobs.length) return { slips: [], warnings: ['none'] };

    var found = blobs.map(function (b) {
      var rect = minAreaRect(convexHull(b.points)), rectArea = rect.w * rect.h;
      return { rect: rect, area: b.area, fill: rectArea > 0 ? b.area / rectArea : 1, aspect: aspectOf(rect) };
    });
    var medianArea = median(found.map(function (f) { return f.area; }));

    var slips = readingOrder(found.map(function (f, i) {
      var r = f.rect;
      return { cx: r.cx, cy: r.cy, w: r.w, h: r.h, angle: r.angle, suspect: suspicion(found, i, medianArea, o) };
    }));
    var warnings = [];
    ['touching', 'large'].forEach(function (kind) {
      if (slips.some(function (s) { return s.suspect === kind; })) warnings.push(kind);
    });
    return { slips: slips, warnings: warnings };
  }

  function findSlips(raster, opts) {
    return findSlipsDetailed(raster, opts).slips;
  }

  return {
    toGray: toGray,
    otsuThreshold: otsuThreshold,
    findSlips: findSlips,
    findSlipsDetailed: findSlipsDetailed,
    cropPlan: cropPlan,
    readingOrder: readingOrder,
    convexHull: convexHull,
    minAreaRect: minAreaRect,
    corners: corners
  };
});
