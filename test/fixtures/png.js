// A minimal PNG encoder for test fixtures: 8-bit RGBA (or gray), no
// interlace, filter 0 on every row, one IDAT chunk. Node only (zlib). The e2e
// test uses it to turn a synth.js raster into a photo the browser can decode.
'use strict';

var zlib = require('zlib');

var SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
var COLOR_GRAY = 0;
var COLOR_RGBA = 6;

var CRC_TABLE = (function () {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  var c = 0xffffffff;
  buffers.forEach(function (buf) {
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  });
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var typeBuf = Buffer.from(type, 'ascii');
  var length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([typeBuf, data]), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// raster = {width, height, data}; data is RGBA (4 bytes a pixel) or gray (1).
// -> Buffer holding a complete PNG file.
function encodePng(raster) {
  var width = raster.width, height = raster.height, src = raster.data;
  if (!(width > 0 && height > 0)) throw new RangeError('encodePng needs a non-empty raster');
  var channels = src.length / (width * height);
  if (channels !== 4 && channels !== 1) throw new TypeError('encodePng takes RGBA or gray data');

  var header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? COLOR_RGBA : COLOR_GRAY;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  var stride = width * channels;
  var raw = Buffer.alloc((stride + 1) * height);
  for (var y = 0; y < height; y++) {
    var out = y * (stride + 1);
    raw[out] = 0;
    for (var i = 0; i < stride; i++) raw[out + 1 + i] = src[y * stride + i];
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { encodePng: encodePng, crc32: crc32 };
