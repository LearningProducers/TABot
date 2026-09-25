// TABot.enhance: the enhanced copy of a slip crop that the second read sees
// when only one provider key is saved. Grayscale, a contrast stretch between
// the 2nd and 98th luminance percentiles, then a 3x3 unsharp mask. Pure: the
// input raster is never changed.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.enhance = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = { lowPercent: 2, highPercent: 98, amount: 0.6 };

  function option(opts, name) {
    return opts && typeof opts[name] === 'number' && isFinite(opts[name]) ? opts[name] : DEFAULTS[name];
  }

  // Integer luma, the same weights segment.js uses. A gray raster passes through.
  function luminance(raster) {
    var n = raster.width * raster.height, src = raster.data, out = new Uint8Array(n);
    if (src.length === n) {
      out.set(src);
      return out;
    }
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      out[i] = (77 * src[j] + 150 * src[j + 1] + 29 * src[j + 2] + 128) >> 8;
    }
    return out;
  }

  // The smallest values whose cumulative share reaches each percentile.
  function percentileRange(gray, lowPercent, highPercent) {
    var hist = new Uint32Array(256), n = gray.length, i;
    for (i = 0; i < n; i++) hist[gray[i]]++;
    var lowCount = n * lowPercent / 100, highCount = n * highPercent / 100;
    var lo = -1, hi = 255, cum = 0;
    for (i = 0; i < 256; i++) {
      cum += hist[i];
      if (lo < 0 && cum >= lowCount) lo = i;
      if (cum >= highCount) { hi = i; break; }
    }
    return { lo: Math.max(0, lo), hi: hi };
  }

  function stretch(gray, lo, hi) {
    var span = hi - lo, lut = new Uint8Array(256), out = new Uint8Array(gray.length), v;
    for (v = 0; v < 256; v++) {
      lut[v] = span > 0 ? Math.max(0, Math.min(255, Math.round((v - lo) * 255 / span))) : v;
    }
    for (var i = 0; i < gray.length; i++) out[i] = lut[gray[i]];
    return out;
  }

  // 3x3 Gaussian (1 2 1 / 2 4 2 / 1 2 1, over 16), separable, edges clamped.
  function blur3(src, W, H) {
    var tmp = new Uint16Array(W * H), out = new Float32Array(W * H), x, y, row;
    for (y = 0; y < H; y++) {
      row = y * W;
      for (x = 0; x < W; x++) {
        var l = x > 0 ? x - 1 : x, r = x < W - 1 ? x + 1 : x;
        tmp[row + x] = src[row + l] + 2 * src[row + x] + src[row + r];
      }
    }
    for (y = 0; y < H; y++) {
      var up = (y > 0 ? y - 1 : y) * W, down = (y < H - 1 ? y + 1 : y) * W;
      row = y * W;
      for (x = 0; x < W; x++) out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[down + x]) / 16;
    }
    return out;
  }

  function enhance(raster, opts) {
    var W = raster.width, H = raster.height, n = W * H;
    var out = new Uint8ClampedArray(n * 4);
    if (!n) return { width: W, height: H, data: out };

    var gray = luminance(raster);
    var range = percentileRange(gray, option(opts, 'lowPercent'), option(opts, 'highPercent'));
    var flat = stretch(gray, range.lo, range.hi);
    var blurred = blur3(flat, W, H), amount = option(opts, 'amount');

    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var v = flat[i] + amount * (flat[i] - blurred[i]);
      out[j] = out[j + 1] = out[j + 2] = v;
      out[j + 3] = 255;
    }
    return { width: W, height: H, data: out };
  }

  return { enhance: enhance };
});
