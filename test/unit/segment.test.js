'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const seg = require(path.join(__dirname, '..', '..', 'js', 'segment.js'));
const synth = require(path.join(__dirname, '..', 'fixtures', 'synth.js'));

const DEG = Math.PI / 180;

// Signed difference of two angles folded into [-45, 45) degrees: a rectangle
// turned a quarter turn is the same rectangle.
function angleDiffDeg(a, b) {
  const d = (a - b) / DEG;
  return ((((d % 90) + 135) % 90) + 90) % 90 - 45;
}

function photo(n, seed, tweak) {
  const specs = synth.layoutGrid(n, { seed });
  if (tweak) tweak(specs);
  return synth.makePhoto({ seed, slips: specs });
}

function scaleRect(r, k) {
  return { cx: r.cx * k, cy: r.cy * k, w: r.w * k, h: r.h * k, angle: r.angle };
}

// Detected slips must match truth one for one in reading order: center within
// 3% of the long side, angle within 3 degrees (mod 90), and, unless skipped,
// each side within 3% (+2 px for the pixel edge).
function assertMatches(found, truth, longSide, opts) {
  opts = opts || {};
  const ordered = seg.readingOrder(truth);
  assert.equal(found.length, ordered.length, 'slip count');
  ordered.forEach((t, i) => {
    const d = found[i];
    const dist = Math.hypot(d.cx - t.cx, d.cy - t.cy);
    assert.ok(dist <= 0.03 * longSide, `slip ${i}: center off by ${dist.toFixed(1)} px`);
    const da = angleDiffDeg(d.angle, t.angle);
    assert.ok(Math.abs(da) <= 3, `slip ${i}: angle off by ${da.toFixed(2)} deg`);
    if (opts.skipDims && opts.skipDims.includes(i)) return;
    assert.ok(Math.abs(d.w - t.w) <= 0.03 * t.w + 2, `slip ${i}: w ${d.w.toFixed(1)} vs ${t.w.toFixed(1)}`);
    assert.ok(Math.abs(d.h - t.h) <= 0.03 * t.h + 2, `slip ${i}: h ${d.h.toFixed(1)} vs ${t.h.toFixed(1)}`);
  });
}

// A photo of well-spaced slips: no photo warning and no slip under suspicion.
function assertClean(out, label) {
  assert.deepEqual(out.warnings, [], label);
  assert.deepEqual(out.slips.map((s) => s.suspect), out.slips.map(() => null), label);
}

// The full photo and the 1000 px copy the app analyzes.
function bothSizes(raster) {
  return [{ gray: seg.toGray(raster), label: '2000 px' },
    { gray: seg.toGray(synth.downscale(raster, 1000)), label: '1000 px' }];
}

const SLIP = { w: 420, h: 280 };

test('toGray uses integer Rec. 601 luma and passes gray through', () => {
  const rgba = { width: 4, height: 1, data: new Uint8ClampedArray([
    255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255
  ]) };
  const g = seg.toGray(rgba);
  assert.equal(g.width, 4);
  assert.equal(g.height, 1);
  assert.deepEqual(Array.from(g.data), [255, 0, 77, 149]);

  const gray = { width: 2, height: 1, data: new Uint8Array([10, 200]) };
  const again = seg.toGray(gray);
  assert.deepEqual(Array.from(again.data), [10, 200]);
  assert.notEqual(again.data, gray.data, 'returns a copy');
});

test('otsuThreshold splits a bimodal histogram between the modes', () => {
  const n = 1000, data = new Uint8Array(n), rnd = synth.mulberry32(3);
  for (let i = 0; i < n; i++) data[i] = i % 3 ? 40 + Math.floor(rnd() * 20) : 190 + Math.floor(rnd() * 20);
  const t = seg.otsuThreshold({ width: n, height: 1, data });
  assert.ok(t >= 59 && t < 190, `threshold ${t}`);

  const exact = new Uint8Array([40, 40, 200, 200]);
  assert.equal(seg.otsuThreshold({ width: 4, height: 1, data: exact }), 119, 'middle of the tie run');
});

test('finds 1 slip, rotated 12 degrees', () => {
  const { raster, truth } = photo(1, 11, (s) => { s[0].angleDeg = 12; });
  const out = seg.findSlipsDetailed(seg.toGray(raster));
  assertClean(out);
  assertMatches(out.slips, truth, 2000);
});

test('finds 5 slips, rotations -12 and +12 included', () => {
  const { raster, truth } = photo(5, 25, (s) => { s[0].angleDeg = 12; s[4].angleDeg = -12; });
  const out = seg.findSlipsDetailed(seg.toGray(raster));
  assertClean(out);
  assertMatches(out.slips, truth, 2000);
});

test('finds 8 slips across a sweep of rotations from -12 to +12 degrees', () => {
  const sweep = [-12, -9, -6, -3, 0, 4, 8, 12];
  const { raster, truth } = photo(8, 38, (s) => s.forEach((x, i) => { x.angleDeg = sweep[i]; }));
  const out = seg.findSlipsDetailed(seg.toGray(raster));
  assertClean(out);
  assertMatches(out.slips, truth, 2000);
});

test('finds 10 slips at random rotations within 12 degrees', () => {
  for (const seed of [410, 411, 412]) {
    const { raster, truth } = photo(10, seed);
    truth.forEach((t) => assert.ok(Math.abs(t.angle) <= 12 * DEG));
    const out = seg.findSlipsDetailed(seg.toGray(raster));
    assertClean(out, `seed ${seed}`);
    assertMatches(out.slips, truth, 2000);
  }
});

test('findSlips returns the slips array: rects in reading order, each with its suspicion', () => {
  const { raster, truth } = photo(5, 26);
  const slips = seg.findSlips(seg.toGray(raster));
  assert.deepEqual(slips, seg.findSlipsDetailed(seg.toGray(raster)).slips);
  assert.equal(slips.length, truth.length);
  slips.forEach((s) => assert.deepEqual(Object.keys(s).sort(), ['angle', 'cx', 'cy', 'h', 'suspect', 'w']));
  slips.forEach((s) => assert.equal(s.suspect, null));
  assert.deepEqual(seg.readingOrder(slips), slips, 'already in reading order');
  slips.forEach((s) => assert.ok(s.angle >= -Math.PI / 4 && s.angle < Math.PI / 4, 'upright angle range'));
});

test('findSlips accepts an RGBA raster and matches the gray result', () => {
  const { raster } = photo(5, 27);
  assert.deepEqual(seg.findSlips(raster), seg.findSlips(seg.toGray(raster)));
});

test('works on a copy downscaled to 1000 px, the size the app analyzes', () => {
  for (const n of [1, 5, 8, 10]) {
    const { raster, truth } = photo(n, 500 + n);
    const small = synth.downscale(raster, 1000);
    assert.equal(small.width, 1000);
    assert.equal(small.height, 750);
    const out = seg.findSlipsDetailed(seg.toGray(small));
    assertClean(out, `n=${n}`);
    assertMatches(out.slips, truth.map((t) => scaleRect(t, 0.5)), 1000);
  }
});

test('cropPlan maps a 1000 px detection back onto the full photo', () => {
  const { raster, truth } = photo(8, 520);
  const found = seg.findSlips(seg.toGray(synth.downscale(raster, 1000)));
  const scale = raster.width / 1000;
  assertMatches(found.map((s) => seg.cropPlan(s, scale)), truth, 2000);
});

test('findSlips on a 1000x750 gray raster runs well under 300 ms', (t) => {
  const { raster } = photo(10, 530);
  const gray = seg.toGray(synth.downscale(raster, 1000));
  assert.equal(gray.width * gray.height, 1000 * 750);

  let start = performance.now();
  const first = seg.findSlips(gray);
  const cold = performance.now() - start;
  const times = [];
  for (let i = 0; i < 7; i++) {
    start = performance.now();
    seg.findSlips(gray);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  t.diagnostic(`findSlips 1000x750, 10 slips: first run ${cold.toFixed(1)} ms, median of 7 ${median.toFixed(1)} ms`);
  assert.equal(first.length, 10);
  assert.ok(cold < 300, `first run ${cold.toFixed(1)} ms`);
  assert.ok(median < 300, `median ${median.toFixed(1)} ms`);
});

test('a slip with heavy handwriting is not split into pieces', () => {
  for (const seed of [600, 601]) {
    const { raster, truth } = photo(5, seed, (s) => { s[1].heavy = true; s[3].heavy = true; });
    for (const size of [2000, 1000]) {
      const gray = seg.toGray(size === 2000 ? raster : synth.downscale(raster, size));
      const k = size / 2000;
      const out = seg.findSlipsDetailed(gray);
      assertClean(out, `seed ${seed} at ${size}`);
      assertMatches(out.slips, truth.map((t) => scaleRect(t, k)), size);

      // The fixture must be able to fail: with holes left open, the paper
      // inside the drawn box and loop reads as extra slips.
      const open = seg.findSlips(gray, { fillHoles: false });
      assert.ok(open.length > truth.length, `seed ${seed} at ${size}: unfilled found ${open.length}`);
    }
  }
});

test('two touching slips produce the touching warning', () => {
  const size = { w: 420, h: 280 };
  const a = 4 * DEG;
  const pair = [
    { cx: 700, cy: 1050, angleDeg: 4, ...size },
    // Next along the first slip's own long axis, overlapping by 3 px.
    { cx: 700 + (size.w - 3) * Math.cos(a), cy: 1050 + (size.w - 3) * Math.sin(a), angleDeg: 4, ...size }
  ];
  const slips = [
    { cx: 350, cy: 350, angleDeg: 5, ...size },
    { cx: 1000, cy: 350, angleDeg: -7, ...size },
    { cx: 1650, cy: 350, angleDeg: 10, ...size }
  ].concat(pair);
  const { raster } = synth.makePhoto({ seed: 700, slips });
  for (const small of [false, true]) {
    const gray = seg.toGray(small ? synth.downscale(raster, 1000) : raster);
    const out = seg.findSlipsDetailed(gray);
    assert.equal(out.slips.length, 4, 'the pair reads as one blob');
    assert.deepEqual(out.warnings, ['touching']);
    assert.deepEqual(out.slips.map((s) => s.suspect), [null, null, null, 'touching'], 'the pair, and only the pair');
  }
});

test('a small slip touching a big one at a corner is flagged by its empty corners', () => {
  const slips = [
    { cx: 400, cy: 400, w: 420, h: 280, angleDeg: 3 },
    { cx: 1100, cy: 400, w: 420, h: 280, angleDeg: -4 },
    { cx: 1700, cy: 400, w: 420, h: 280, angleDeg: 6 },
    { cx: 700, cy: 1050, w: 420, h: 280, angleDeg: 0 },
    // Overlaps the big slip's lower-right corner; together about 1.4 slips of
    // area, under the 1.8x area rule, so only the fill rule can catch it.
    { cx: 700 + 210 + 80, cy: 1050 + 140 + 40, w: 260, h: 170, angleDeg: 20 }
  ];
  const { raster } = synth.makePhoto({ seed: 710, slips });
  for (const { gray, label } of bothSizes(raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.equal(out.slips.length, 4, label);
    assert.deepEqual(out.warnings, ['touching'], label);
    assert.deepEqual(out.slips.map((s) => s.suspect), [null, null, null, 'touching'], label);
  }
});

// An older rule compared each blob's area with the median blob, so a photo
// whose median blob was itself a pair (one blob, two blobs, or pairs next to a
// lone slip) passed as clean and one crop carried two students.
test('a lone touching pair, the only blob in the photo, is suspect', () => {
  for (const [seed, angleDeg] of [[720, 5], [721, -10], [722, 0]]) {
    const slips = synth.touchingPair({ cx: 650, cy: 700, angleDeg, ...SLIP });
    const { raster, truth } = synth.makePhoto({ seed, slips });
    assert.equal(truth.length, 2);
    for (const { gray, label } of bothSizes(raster)) {
      const out = seg.findSlipsDetailed(gray);
      assert.equal(out.slips.length, 1, `${angleDeg} deg, ${label}: one blob`);
      assert.equal(out.slips[0].suspect, 'touching', `${angleDeg} deg, ${label}`);
      assert.deepEqual(out.warnings, ['touching'], `${angleDeg} deg, ${label}`);
    }
  }
});

test('two touching pairs and nothing else are both suspect', () => {
  const slips = synth.touchingPair({ cx: 300, cy: 400, angleDeg: 3, ...SLIP })
    .concat(synth.touchingPair({ cx: 500, cy: 1050, angleDeg: -6, ...SLIP }));
  const { raster, truth } = synth.makePhoto({ seed: 730, slips });
  assert.equal(truth.length, 4);
  for (const { gray, label } of bothSizes(raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.deepEqual(out.slips.map((s) => s.suspect), ['touching', 'touching'], label);
    assert.deepEqual(out.warnings, ['touching'], label);
  }
});

test('two touching pairs beside one lone slip are both suspect, the lone slip is not', () => {
  // Three blobs, two of them pairs: the median area is a pair's, and the
  // other blobs of each pair are a lone slip and the other pair.
  const slips = synth.touchingPair({ cx: 250, cy: 350, angleDeg: 3, ...SLIP })
    .concat([{ cx: 1600, cy: 720, angleDeg: 4, ...SLIP }])
    .concat(synth.touchingPair({ cx: 250, cy: 1100, angleDeg: -6, ...SLIP }));
  const { raster, truth } = synth.makePhoto({ seed: 740, slips });
  assert.equal(truth.length, 5);
  for (const { gray, label } of bothSizes(raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.deepEqual(out.slips.map((s) => s.suspect), ['touching', null, 'touching'], label);
    assert.deepEqual(out.warnings, ['touching'], label);
  }
});

test('3 slips, one touching pair: the pair is suspect, the lone slip is not', () => {
  const slips = [{ cx: 1500, cy: 400, angleDeg: -5, ...SLIP }]
    .concat(synth.touchingPair({ cx: 400, cy: 1000, angleDeg: 7, ...SLIP }));
  const { raster, truth } = synth.makePhoto({ seed: 750, slips });
  assert.equal(truth.length, 3);
  for (const { gray, label } of bothSizes(raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.deepEqual(out.slips.map((s) => s.suspect), [null, 'touching'], label);
    assert.deepEqual(out.warnings, ['touching'], label);
  }
});

// A slip well over the median area with a slip's shape is not proof of a
// pair, so it is 'large' for the app to ask about, never 'touching'.
test('a genuinely larger slip among 5 is large, not touching', () => {
  const slips = [
    { cx: 350, cy: 350, angleDeg: 5, ...SLIP },
    { cx: 1000, cy: 350, angleDeg: -7, ...SLIP },
    { cx: 1650, cy: 350, angleDeg: 10, ...SLIP },
    { cx: 450, cy: 1050, angleDeg: 0, ...SLIP },
    // A half-sheet: the same shape, about 2x the area.
    { cx: 1300, cy: 1050, w: 600, h: 400, angleDeg: 6 }
  ];
  const { raster, truth } = synth.makePhoto({ seed: 760, slips });
  for (const { gray, label } of bothSizes(raster)) {
    const out = seg.findSlipsDetailed(gray);
    assertMatches(out.slips, truth.map((t) => scaleRect(t, gray.width / 2000)), gray.width);
    assert.deepEqual(out.slips.map((s) => s.suspect), [null, null, null, null, 'large'], label);
    assert.deepEqual(out.warnings, ['large'], label);
  }
});

test('a pair meeting long edge to long edge reads as large at best, beside a pair that is touching', () => {
  const slips = [
    { cx: 350, cy: 350, angleDeg: 5, ...SLIP },
    { cx: 1000, cy: 350, angleDeg: -7, ...SLIP },
    { cx: 1650, cy: 350, angleDeg: 10, ...SLIP }
  ].concat(synth.touchingPair({ cx: 450, cy: 900, angleDeg: 3, ...SLIP }, { along: 'h' }))
    .concat(synth.touchingPair({ cx: 1150, cy: 1050, angleDeg: -4, ...SLIP }));
  const { raster, truth } = synth.makePhoto({ seed: 770, slips });
  assert.equal(truth.length, 7);
  for (const { gray, label } of bothSizes(raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.deepEqual(out.slips.map((s) => s.suspect), [null, null, null, 'large', 'touching'], label);
    assert.deepEqual(out.warnings, ['touching', 'large'], label);
  }
});

test('long strips, three or more to a photo, are judged against each other and pass', () => {
  const STRIP = { w: 600, h: 200 };
  const strips = [
    { cx: 450, cy: 300, angleDeg: 4, ...STRIP },
    { cx: 1400, cy: 300, angleDeg: -6, ...STRIP },
    { cx: 450, cy: 800, angleDeg: 8, ...STRIP },
    { cx: 1400, cy: 800, angleDeg: -3, ...STRIP }
  ];
  const clean = synth.makePhoto({ seed: 780, slips: strips });
  for (const { gray, label } of bothSizes(clean.raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.equal(out.slips.length, 4, label);
    assertClean(out, label);
  }

  // Two of the same strips end to end are still twice as long for their width.
  const paired = synth.makePhoto({ seed: 781, slips: strips.slice(0, 3)
    .concat(synth.touchingPair({ cx: 400, cy: 1200, angleDeg: 2, ...STRIP })) });
  for (const { gray, label } of bothSizes(paired.raster)) {
    const out = seg.findSlipsDetailed(gray);
    assert.deepEqual(out.slips.map((s) => s.suspect), [null, null, null, 'touching'], label);
  }
});

test('synth touchingPair places a same-size twin past the w or h side, overlapping', () => {
  const slip = { cx: 500, cy: 400, w: 300, h: 200, angleDeg: 30, heavy: true };
  const [a, b] = synth.touchingPair(slip);
  assert.equal(a, slip);
  assert.deepEqual([b.w, b.h, b.angleDeg, b.heavy], [300, 200, 30, true]);
  assert.ok(Math.abs(Math.hypot(b.cx - 500, b.cy - 400) - 297) < 1e-9, 'w - 3 px apart');
  assert.ok(Math.abs(Math.atan2(b.cy - 400, b.cx - 500) - 30 * DEG) < 1e-9, 'along the w side');

  const [, c] = synth.touchingPair(slip, { along: 'h', overlap: 5 });
  assert.ok(Math.abs(Math.hypot(c.cx - 500, c.cy - 400) - 195) < 1e-9, 'h - 5 px apart');
  assert.ok(Math.abs(Math.atan2(c.cy - 400, c.cx - 500) - 120 * DEG) < 1e-9, 'along the h side');
  assert.equal(slip.cx, 500, 'input untouched');
});

test('an empty surface returns zero slips with the none warning', () => {
  const { raster } = synth.makePhoto({ seed: 800, slips: [] });
  for (const r of [raster, synth.downscale(raster, 1000)]) {
    const out = seg.findSlipsDetailed(seg.toGray(r));
    assert.deepEqual(out, { slips: [], warnings: ['none'] });
    assert.deepEqual(seg.findSlips(seg.toGray(r)), []);
  }
  const flat = { width: 64, height: 48, data: new Uint8Array(64 * 48).fill(120) };
  assert.deepEqual(seg.findSlipsDetailed(flat), { slips: [], warnings: ['none'] });
  const empty = { width: 0, height: 0, data: new Uint8Array(0) };
  assert.deepEqual(seg.findSlipsDetailed(empty), { slips: [], warnings: ['none'] });
});

test('specks too small to be slips are dropped', () => {
  const W = 400, H = 300, data = new Uint8Array(W * H).fill(40);
  // A 100x60 slip and a 10x10 fleck of lint.
  for (let y = 100; y < 160; y++) for (let x = 50; x < 150; x++) data[y * W + x] = 230;
  for (let y = 20; y < 30; y++) for (let x = 300; x < 310; x++) data[y * W + x] = 230;
  const out = seg.findSlipsDetailed({ width: W, height: H, data });
  assert.equal(out.slips.length, 1);
  const s = out.slips[0];
  assert.deepEqual([s.cx, s.cy, s.w, s.h, s.angle], [100, 130, 100, 60, 0]);
});

test('minAreaRect finds the exact rotated rectangle and keeps it upright', () => {
  for (const deg of [0, 7, -12, 30, 60, -75, 90]) {
    const rect = { cx: 50, cy: 40, w: 30, h: 12, angle: deg * DEG };
    const hull = seg.convexHull(seg.corners(rect));
    const r = seg.minAreaRect(hull);
    assert.ok(Math.abs(r.cx - 50) < 1e-9 && Math.abs(r.cy - 40) < 1e-9, `${deg}: center`);
    assert.ok(r.angle >= -Math.PI / 4 && r.angle < Math.PI / 4, `${deg}: upright`);
    assert.ok(Math.abs(angleDiffDeg(r.angle, rect.angle)) < 1e-6, `${deg}: angle`);
    // A quarter turn to upright swaps the sides.
    const turned = Math.round((rect.angle - r.angle) / (Math.PI / 2)) % 2 !== 0;
    const [w, h] = turned ? [12, 30] : [30, 12];
    assert.ok(Math.abs(r.w - w) < 1e-9 && Math.abs(r.h - h) < 1e-9, `${deg}: ${r.w} x ${r.h}`);
  }
});

test('minAreaRect on many hull points beats the axis-aligned box', () => {
  const rnd = synth.mulberry32(9), pts = [];
  const a = 20 * DEG, c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 500; i++) {
    const u = (rnd() - 0.5) * 80, v = (rnd() - 0.5) * 20;
    pts.push([u * c - v * s, u * s + v * c]);
  }
  const r = seg.minAreaRect(seg.convexHull(pts));
  assert.ok(Math.abs(r.angle / DEG - 20) < 1.5, `angle ${r.angle / DEG}`);
  assert.ok(r.w * r.h < 80 * 20 * 1.01);
});

test('readingOrder: rows top to bottom, then left to right', () => {
  const r = (cx, cy, name) => ({ cx, cy, w: 100, h: 60, angle: 0, name });
  const input = [r(500, 320, 'F'), r(120, 90, 'A'), r(300, 105, 'B'), r(480, 70, 'C'),
    r(110, 300, 'D'), r(290, 330, 'E')];
  const out = seg.readingOrder(input);
  assert.deepEqual(out.map((x) => x.name), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.notEqual(out, input, 'a new array');
  assert.equal(input[0].name, 'F', 'input untouched');

  // A row that drifts downward still reads as one row while each center stays
  // within half the median height of the row's running mean ('d' is 36 px
  // below 'a', past the 30 px tolerance, but 24 px below the mean).
  const drift = [r(100, 100, 'a'), r(250, 112, 'b'), r(400, 124, 'c'), r(550, 136, 'd')];
  assert.deepEqual(seg.readingOrder(drift.slice().reverse()).map((x) => x.name), ['a', 'b', 'c', 'd']);

  // A slip turned a quarter turn contributes its vertical side, w.
  const tall = { cx: 100, cy: 100, w: 60, h: 100, angle: Math.PI / 2 };
  assert.equal(seg.readingOrder([tall]).length, 1);
  assert.deepEqual(seg.readingOrder([]), []);
});

test('cropPlan scales every length and keeps the angle; pad widens each side', () => {
  const slip = { cx: 100, cy: 50, w: 80, h: 40, angle: 0.1 };
  assert.deepEqual(seg.cropPlan(slip, 2.4), { cx: 240, cy: 120, w: 192, h: 96, angle: 0.1 });
  assert.deepEqual(seg.cropPlan(slip, 2, { pad: 2 }), { cx: 200, cy: 100, w: 168, h: 88, angle: 0.1 });
});

test('synth is deterministic per seed and layoutGrid keeps slips apart', () => {
  const a = photo(5, 900), b = photo(5, 900), c = photo(5, 901);
  assert.deepEqual(a.truth, b.truth);
  assert.ok(Buffer.from(a.raster.data.buffer).equals(Buffer.from(b.raster.data.buffer)));
  assert.ok(!Buffer.from(a.raster.data.buffer).equals(Buffer.from(c.raster.data.buffer)));

  for (let n = 1; n <= 10; n++) {
    const specs = synth.layoutGrid(n, { seed: n });
    assert.equal(specs.length, n);
    const boxes = specs.map((s) => {
      assert.ok(Math.abs(s.angleDeg) <= 12);
      const corners = seg.corners({ cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angleDeg * DEG });
      const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    boxes.forEach((p, i) => {
      assert.ok(p[0] >= 0 && p[1] >= 0 && p[2] <= 2000 && p[3] <= 1500, `n=${n} slip ${i} in frame`);
      boxes.slice(i + 1).forEach((q) => {
        const apart = p[2] < q[0] || q[2] < p[0] || p[3] < q[1] || q[3] < p[1];
        assert.ok(apart, `n=${n}: bounding boxes overlap`);
      });
    });
  }
  assert.throws(() => synth.layoutGrid(0), RangeError);
  assert.throws(() => synth.layoutGrid(11), RangeError);
});
