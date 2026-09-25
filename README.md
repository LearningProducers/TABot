# TABot (Teacher's Assistant)

TABot is one static web page for math teachers. It turns a stack of exit slips
into one spreadsheet.

TABot is free and open source under the MIT license (see `LICENSE`).

**Status:** the core loop runs on Groq (photo to spreadsheet). Claude, the
optional second provider, and video capture are not built yet. The page has
been tested in WebKit with an iPhone profile and in desktop Chromium.

## What the teacher does

1. **Setup.** Paste your own Groq API key and press Check key. The key stays in
   this browser's localStorage, goes only to Groq, and never appears in a URL.
   The page lists Groq's models, tests each one once with a small image to see
   which read images, and remembers the answers. Pick the model that reads the
   slips. Model names are never hardcoded.
2. **Answer key.** Assignment name, pass mark, number of questions, and for
   each question the answer, the points, and how to match it: **Value** (the
   default: `1/2`, `0.5` and `2/4` all count) or **Exact form** (the answer must
   be written the way the key is: `6/8` does not count for `3/4`). Saved in this
   browser for reuse.
3. **Photos.** Lay 5 to 10 slips flat on a dark or colored surface, well lit,
   not overlapping, with a gap between them, every slip fully in frame, and
   shoot straight down. On a phone, Take photo opens the camera directly (no
   permission prompt); Upload photo takes a file on any device. One full page
   (homework, a quiz, a test) can fill most of the frame, and can rest on other
   white pages. The page finds each slip and shows the count; when a mostly
   bright photo shows no paper edges, it reads the whole photo as one paper and
   says so. When a slip looks like two slips touching, or is much larger than
   the rest, it asks before reading (Read anyway or Retake). Each slip is read
   twice and graded in code. Each result is saved the moment its two reads
   finish, so a refresh loses nothing already read, and an interrupted photo is
   named on the next load. Stop reading ends a photo early and keeps what was
   already graded. The photo and its crops are released once read. While slips
   are being read, the page keeps the screen awake, and lets it sleep again
   when reading ends.
4. **Done.** The page builds `TABot_<assignment>_<date>.xlsx` (a Roster tab and
   a Summary tab), hands it to the browser's downloads, and asks "Did the file
   save?". **Yes** deletes every result from this browser; **No** downloads it
   again and asks again. Results nobody confirmed are deleted automatically 24
   hours after the last photo. Only the key, the model choice, the answer key
   and the list of which models read images remain.

No backend, no server, no browser extension, nothing to install, no analytics.
Student work leaves the teacher's device only to Groq.

## How a slip is graded

- **Reading.** Groq's vision model transcribes the name and every answer
  exactly as written, as JSON, with a confidence per answer. With one key the
  second read uses the same model on an enhanced copy of the crop (grayscale,
  contrast stretched, sharpened), and the row is marked `single-model review`.
- **Grading happens in code, never in the model.** On a Value question,
  `1/2`, `0.5`, `.5`, `2/4` and `50%` match; `2x+6` matches `2(x+3)`; `x = 4`
  matches `4`; `3 x 10^4` matches `30000`; `12 m` matches `12` and `12 meters`.
  Where a rule could be read two ways, the page picks the reading that cannot
  mark a wrong answer right: `5m` is algebra (it never matches `5`), and
  `3 x 4` is compared as written (it never matches `12` or `2 x 6`). On an
  Exact form question the answer must also be written the way the key is; only
  spacing, letter case, look-alike symbols, a missing leading zero (`.75` for
  `0.75`) and a sentence-ending period are forgiven.
- **Asterisks.** A cell gets `*` when the reader was unsure (confidence under
  0.7), when the reader's note names that question, or when the two reads
  disagree. On a Value question, two reads disagree when they differ in value
  or would score differently; on an Exact form question, when they are written
  differently. A name gets `*` when the two reads of it differ. Scores use the
  first read; the Notes column says what the second read saw.
- **Summary tab.** Students, mean and median percent, pass rate at the pass
  mark, hit rate and match setting per question, and the score distribution in
  10-point bands.

## Providers

| Provider | Role | Measured |
|---|---|---|
| Groq | Free default, built | Browser calls allowed (CORS open), 2026-09-24. The page cannot read Groq's rate-limit headers (none are exposed to browsers), so on a 429 it waits blind: exponential backoff with full jitter, up to 8 tries. A read that gets no answer in 60 seconds is retried once. Groq's models list does not say which models read images; the page probes each one. Groq's docs list one vision model today, `qwen/qwen3.8-27b`, marked Preview. Groq's free-tier limits for that model are not published in its docs and were not measured. |
| Claude | Optional, on the teacher's own key; not built yet | Browser calls allowed with the `anthropic-dangerous-direct-browser-access` header, 2026-09-24. The models list says which models accept images. Anthropic's Commercial Terms bar Anthropic from training models on customer content. |

**Ollama Cloud is out** until Ollama allows direct browser calls. Measured
2026-09-24: every browser preflight to `ollama.com` gets a 405 with no CORS
headers.

**Provider terms.** A provider a teacher can pick must have terms saying inputs
are not used for training and not human-reviewed for product improvement.
Groq's Services Agreement (read 2026-09-24) bars training on inputs and outputs
and limits Groq's access to them to providing the service, following the
customer's instructions, complying with law, keeping the service reliable, and
checking acceptable-use compliance; product improvement is not on that list.
Anthropic's Commercial Terms bar Anthropic from training models on customer
content from its services.

## Where the page runs

The page must be served over https from an origin of its own. Opened from a file on the device, it runs but saves nothing (no key,
no results), because every local file shares one storage area with every other
local file, and it says so on screen.

## Known limits

- The camera opening from Take photo, memory on a 48 MP photo, the screen
  wake lock and the iOS download sheet are measured only in emulation. The
  `<img>` fallback that decodes a photo in browsers without
  `createImageBitmap` options is not reached by either test browser.
- Two slips laid side by side along their long edges look like one half-sheet;
  the page asks about it (Read anyway or Retake) but cannot prove it. A
  strip-shaped slip gets the same question.
- A download made just before the 24-hour mark can be deleted with the other
  results at that mark, even while "Did the file save?" is on screen.
- Slips must be lighter than the surface they lie on. Several papers on a
  white or pale surface, or on a white stack, merge into one bright region and
  are read as one paper: one paper per photo on white. A page on a white stack
  is cut with the stack edges round it.
- A Value question compares values, not form: on "simplify 6/8" a student who
  copies `6/8` gets the point, and `4^2` matches `2^4`. Set such a question to
  Exact form.
- A unit written on only one side is ignored (`12cm` matches `12`), so `2mg`
  in a physics formula also matches `2`. `1/2x` reads as (1/2)x.

## Tests

No real student data is in this repo; every test slip is synthetic and every
call to Groq is mocked. From the repo root:

```
npm install
node --test 'test/unit/*.test.js'
npx playwright test --config test/e2e/playwright.config.js
```

The end-to-end suite runs the whole loop in WebKit (iPhone 13 profile) and
desktop Chromium, fails on any request to a host other than the page and
`api.groq.com`, and fails on any console error.

## Files

`index.html` (the page), `css/app.css`, `js/` (one classic script per concern:
`queue.js`, `providers/groq.js`, `providers/index.js`, `prompt.js`,
`segment.js`, `enhance.js`, `grade.js`, `sheet.js`, `store.js`, `app.js`),
`vendor/` (math.js and SheetJS, byte-identical to upstream; see
`vendor/VENDOR.md`), `test/`.

## License

TABot's own code is MIT (`LICENSE`). The files in `vendor/` keep their upstream
licenses: math.js is Apache-2.0 (`vendor/LICENSE-mathjs.txt`, with its notice in
`vendor/NOTICE-mathjs.txt` and the licenses of code bundled inside it in
`vendor/math.js.LICENSE.txt`), and SheetJS Community Edition is Apache-2.0
(`vendor/LICENSE-sheetjs.txt`).
