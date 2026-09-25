# Vendored libraries

The page loads these from this folder, never from a CDN, so it makes no network
call except to the teacher's chosen provider. Each file is byte-identical to its
upstream release; re-check with `shasum -a 256`.

| File | Library | Upstream source | sha256 |
|---|---|---|---|
| `math.js` | mathjs 15.2.0 (`lib/browser/math.js`), Apache-2.0 | https://registry.npmjs.org/mathjs/-/mathjs-15.2.0.tgz (tarball sha512 `UAQzSVob9rNLdGpqcFMYmSu9dkuLYy7Lr2hBEQS5SHQdknA9VppJz3cy2KkpMzTODunad6V6cNv+5kOLsePLow==`, matching the npm registry's published integrity) | `b4de1e31da7797c3daaf7b8dae3b1d8bb0a7296c9cc8590f9359ac0250f8ddd6` |
| `xlsx.mini.min.js` | SheetJS Community Edition 0.20.3, Apache-2.0 | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js (SheetJS publishes current builds on its own CDN; the npm registry's `xlsx` stops at 0.18.5) | `0cb353f830d7288385492c83d277b058ddeac664ca51cf1393aa1fd3e2b70939` |

Licenses: `LICENSE-mathjs.txt` and `NOTICE-mathjs.txt` (math.js ships a NOTICE
file, which the Apache License requires every redistribution to carry),
`math.js.LICENSE.txt` (licenses of code bundled inside math.js),
`LICENSE-sheetjs.txt` (SheetJS ships no NOTICE file). These files keep their
own licenses; TABot's MIT license (`LICENSE` at the repo root) covers
TABot's own code only. `math.js` ends with a
`sourceMappingURL` comment; the map is not shipped, and the comment is left in
place so the file stays byte-identical to upstream.

Neither file contains `eval(` or `Function(` (checked 2026-09-24), so the
page's Content-Security-Policy (`script-src 'self'`) holds.
