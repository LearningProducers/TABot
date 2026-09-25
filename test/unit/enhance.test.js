'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { enhance } = require(path.join(__dirname, '..', '..', 'js', 'enhance.js'));
const synth = require(path.join(__dirname, '..', 'fixtures', 'synth.js'));

function luma(raster) {
  const n = raster.width * raster.height, d = raster.data, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (77 * d[i * 4] + 150 * d[i * 4 + 1] + 29 * d[i * 4 + 2] + 128) >> 8;
  return out;
}

function percentile(values, p) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
}

function spread(raster) {
  const l = luma(raster);
  return percentile(l, 98) - percentile(l, 2);
}

// A dim, washed-out slip crop: a synthetic slip photo squeezed into a narrow
// band of gray, the way a slip shot in poor light looks.
function dullCrop() {
  const { raster } = synth.makePhoto({ seed: 42, width: 320, height: 200, slips: [
    { cx: 160, cy: 100, w: 300, h: 180, angleDeg: 0 }
  ] });
  const d = raster.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = 110 + d[i + c] * 40 / 255;
  }
  return raster;
}

test('keeps the dimensions and returns an opaque gray RGBA raster', () => {
  const src = dullCrop();
  const out = enhance(src);
  assert.equal(out.width, src.width);
  assert.equal(out.height, src.height);
  assert.ok(out.data instanceof Uint8ClampedArray);
  assert.equal(out.data.length, src.width * src.height * 4);
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i], out.data[i + 1]);
    assert.equal(out.data[i], out.data[i + 2]);
    assert.equal(out.data[i + 3], 255);
  }
});

test('widens the contrast range of a dull crop', () => {
  const src = dullCrop();
  const before = spread(src), after = spread(enhance(src));
  assert.ok(before <= 45, `input spread ${before}`);
  assert.ok(after >= 200, `output spread ${after}`);
});

test('keeps ink darker than paper', () => {
  const src = dullCrop();
  const inL = luma(src), outL = luma(enhance(src));
  let darkest = 0;
  for (let i = 1; i < inL.length; i++) if (inL[i] < inL[darkest]) darkest = i;
  const paper = percentile(outL, 75);
  assert.ok(outL[darkest] < paper - 100, `ink ${outL[darkest]} vs paper ${paper}`);
});

test('does not change its input', () => {
  const src = dullCrop();
  const copy = Uint8ClampedArray.from(src.data);
  enhance(src);
  assert.deepEqual(src.data, copy);
});

test('applies a 3x3 unsharp mask with amount 0.6', () => {
  // Columns: 0 on the left, a 128 stripe, 255 on the right. The 2nd and 98th
  // percentiles are 0 and 255, so the stretch is the identity and only the
  // unsharp mask moves pixels.
  const W = 10, H = 5, data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) data[y * W + x] = x < 4 ? 0 : x < 6 ? 128 : 255;
  }
  const out = enhance({ width: W, height: H, data });
  const at = (x, y) => out.data[(y * W + x) * 4];
  // Left edge of the stripe: blur = (0 + 2*128 + 128) / 4 = 96,
  // so 128 + 0.6 * (128 - 96) = 147.2.
  assert.equal(at(4, 2), 147);
  // Right edge of the stripe: blur = (128 + 2*128 + 255) / 4 = 159.75,
  // so 128 + 0.6 * (128 - 159.75) = 108.95.
  assert.equal(at(5, 2), 109);
  // Flat areas stay put.
  assert.equal(at(1, 2), 0);
  assert.equal(at(8, 2), 255);
});

test('handles flat, tiny and gray inputs without NaN', () => {
  const flat = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4).fill(90) };
  const outFlat = enhance(flat);
  for (let i = 0; i < outFlat.data.length; i += 4) {
    assert.equal(outFlat.data[i], 90);
    assert.equal(outFlat.data[i + 3], 255);
  }

  const one = enhance({ width: 1, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255]) });
  assert.equal(one.data.length, 4);
  assert.ok(Number.isInteger(one.data[0]));

  const empty = enhance({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
  assert.equal(empty.data.length, 0);

  const gray = { width: 4, height: 1, data: new Uint8Array([100, 110, 120, 130]) };
  const outGray = enhance(gray);
  assert.equal(outGray.data.length, 16);
  assert.ok(outGray.data[0] < outGray.data[12], 'order kept');
});

test('is deterministic', () => {
  const a = enhance(dullCrop()), b = enhance(dullCrop());
  assert.deepEqual(a.data, b.data);
});
