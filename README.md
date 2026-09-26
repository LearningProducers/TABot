# TABot (Teacher's Assistant)

TABot is one static web page for math teachers. It turns photographed student
work (exit slips, homework, quizzes and tests) into one spreadsheet.

TABot is free and open source under the MIT license (see `LICENSE`).

**Status:** the core loop runs on Groq (photo to spreadsheet). Claude, the
optional second provider, and video capture are not built yet. The page has
been tested in WebKit with an iPhone profile and in desktop Chromium.

## What the teacher does

1. **Setup.** Paste your own Groq API key and press Check key. The key stays in
   this browser's localStorage, goes only to Groq, and never appears in a URL.
   The page lists Groq's models, tests each one once with a small image to see
   which read images, and remembers the answers. Pick the model that reads the
   papers. Model names are never hardcoded.
2. **Answer key.** Assignment name, pass mark, number of questions, and for
   each question the points and, if you want, the answer and how to match it:
   **Value** (the default: `1/2`, `0.5` and `2/4` all count) or **Exact form**
   (the answer must be written the way the key is: `6/8` does not count for
   `3/4`). **Answers are optional.** A question left blank is graded against
   what TABot works out from the printed question (see below); once papers are
   read, the blank shows that answer, marked "worked out" or "AI, check".
   Exact form needs a typed answer. Saved in this browser for reuse.
3. **Photos.** One to ten papers per photo. Lay several flat on a dark or
   colored surface, well lit, not overlapping, with a gap between them, every
   paper fully in frame, and shoot straight down. One full page can fill most
   of the frame, and can rest on other white pages. On a phone, Take photo
   opens the camera directly (no permission prompt); Upload photo takes a file
   on any device. The page finds each paper and shows the count; when a mostly
   bright photo shows no paper edges, it reads the whole photo as one paper and
   says so. When a paper looks like two papers touching, or is much larger
   than the rest, it asks before reading (Read anyway or Retake). Each paper is
   read twice and graded in code, and saved the moment its two reads finish, so
   a refresh loses nothing already read, and an interrupted photo is named on
   the next load. When the reads end, the page works out any answers it still
   needs, grades the whole class again, and writes the AI analyses (see
   below). Stop reading ends a photo early and keeps what was already graded.
   The photo and its crops are released once the photo is done. While a photo
   is being read, the page keeps the screen awake, and lets it sleep again when
   it is done.
4. **Done.** The page builds `TABot_<assignment>_<date>.xlsx` (Roster, Summary
   and Exemplars tabs), hands it to the browser's downloads, and asks "Did the
   file save?". **Yes** deletes every result from this browser; **No**
   downloads it again and asks again. Results nobody confirmed are deleted
   automatically 24 hours after the last photo. Only the key, the model
   choice, the answer key and the list of which models read images remain.

No backend, no server, no browser extension, nothing to install, no analytics.
Student work leaves the teacher's device only to Groq, in these calls:

- every paper, twice (the crop and an enhanced copy), to be read;
- a paper with a wrong answer that is not blank, once more (the same crop), for
  its AI analysis;
- a question with no key answer that code cannot work out: its printed text,
  with no image, twice for each way the class reads it (and again after a
  failed solve), never once per paper, to be solved.

## How a paper is graded

- **Reading.** Groq's vision model transcribes the name and every answer
  exactly as written, as JSON, with a confidence per answer, and then, after
  the answers, each question as printed: its text, its arithmetic when it is a
  bare calculation, its choices when it is multiple choice, whether it needs a
  figure, and the method the student's work shows. The answers come first so
  that writing out a problem cannot lean on how an answer is read. With one key
  the second read uses the same model on an enhanced copy of the crop
  (grayscale, contrast stretched, sharpened), and the row is marked
  `single-model review`.
- **Where each expected answer comes from.** In this order, settled once for
  the whole class:
  1. **The answer key**, when you typed one. It always wins. When the class's
     printed question works out to something else, the Summary says so.
  2. **Worked out by code**, from the printed arithmetic, in exact fractions
     (no rounding error). Only when the arithmetic appears in the printed
     question word for word, the words around it only ask for the value
     (Multiply, Find, What is, Show your work...), the page's printed
     instructions ask for nothing more (no rounding, no form), two separate
     parsers agree on its value, and the paper's second read agrees (a paper
     whose second read failed does not count). A division sign is never read
     as a slash: `12 ÷ 3/4` is 16, and a read that turns it into `12 / 3/4`
     is refused. Anything
     else (round, estimate, simplify, of, a remainder asked for, a word
     problem, notation read two ways such as `-3^2`) is not worked out by
     code. The class value is the one most papers read; a paper that read the
     question differently is graded on the class value and flagged, and a
     second version of the test on enough papers is graded on its own version,
     flagged (a paper whose version cannot be read is not graded). Multiple
     choice is worked out to the one choice that matches.
     A division accepts `13 R 1` as well as `13 1/12`; a decimal that is the
     answer rounded is flagged, never silently marked wrong.
  3. **Solved by AI**, when code cannot work it out: the printed question, as
     most papers read it, is solved twice by two differently worded prompts,
     and used only when the two answers agree. Page instructions go with it
     only when more than half the papers show them, and a question copied by
     hand needs two papers to agree. Every cell graded on it carries `*` with
     the note "AI-solved, check". A question that needs a picture, or has no
     single answer, is not solved.
  4. **Not graded**, when none of these gives an answer. The cell reads "(not
     graded)", and the question counts toward no score; a paper with nothing
     graded has no percent and is left out of the class figures.
- **Grading happens in code.** On a Value question, `1/2`, `0.5`, `.5`, `2/4`
  and `50%` match; `2x+6` matches `2(x+3)`; `x = 4` matches `4`; `3 x 10^4`
  matches `30000`; `12 m` matches `12` and `12 meters`. Where a rule could be
  read two ways, the page picks the reading that cannot mark a wrong answer
  right: `5m` is algebra (it never matches `5`), and `3 x 4` is compared as
  written (it never matches `12` or `2 x 6`). On an Exact form question the
  answer must also be written the way the key is; only spacing, letter case,
  look-alike symbols, a missing leading zero (`.75` for `0.75`) and a
  sentence-ending period are forgiven. A multiple-choice answer is the label
  marked; two marks score nothing and are flagged.
- **Asterisks.** A cell gets `*` when the reader was unsure (confidence under
  0.7), when the reader's note names that question, when the two reads
  disagree, when the paper's own read of the question differs from the class,
  or when the expected answer was solved by AI. A name gets `*` when the two
  reads of it differ. Scores use the first read; the Notes column says what the
  second read saw.
- **Analysis (AI).** A paper with a wrong answer that is not blank is sent once
  more with, for each such answer, the printed question, the expected answer
  and where it came from, and the steps code worked out. The model writes one
  or two sentences on how the student worked and where the work broke, and
  names an error pattern from a fixed list for each question. The Roster's
  Analysis (AI) column holds them. Papers with nothing to analyse get a line
  from code instead ("Every graded answer matches the expected answer.", "Left
  Q2 blank."). An analysis written before the expected answer to one of its
  questions changed is marked so, and left out of the Summary's counts. When
  the analysis says an answer read looks different on the paper, or that a
  student's answer looks right, the Notes say which to check.
- **Summary tab.** Students, mean and median percent, pass rate at the pass
  mark; per question the hit rate, the match setting, the expected answer,
  where it came from and the printed question as read; the questions solved by
  AI; any key that disagrees with its printed question; the score
  distribution in 10-point bands; and the class's most common error patterns
  with counts, labeled as AI observations.
- **Exemplars tab.** For each question whose printed arithmetic code worked
  out, a worked solution, computed and checked by code, never by AI:
  multiplication in the standard algorithm, partial products or an area model
  (whichever most papers' work shows; lattice is not laid out), one digit to a
  cell like a printed grid; addition and subtraction by columns with each carry
  or borrow named; long division; fraction steps; order of operations one step
  at a time; and the matching choice of a multiple-choice question. Each is
  read back from its finished cells and checked a second way, and a key that
  disagrees with it means no exemplar. Every other question is listed with the
  reason it has none.

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

The page must be served over https from an origin of its own. Opened from a
file on the device, it runs but saves nothing (no key, no results), because
every local file shares one storage area with every other local file, and it
says so on screen.

## Known limits

- The camera opening from Take photo, memory on a 48 MP photo, the screen
  wake lock and the iOS download sheet are measured only in emulation. The
  `<img>` fallback that decodes a photo in browsers without
  `createImageBitmap` options is not reached by either test browser.
- Groq's free-tier limits for the vision model were not measured with the
  extra calls (the analysis and the solves). A 429 that names a daily limit
  moves on to the next vision model at once; the photo stops, and says so,
  only when every model this key can use has reached its daily limit.
- Two papers laid side by side along their long edges look like one larger
  paper; the page asks about it (Read anyway or Retake) but cannot prove it. A
  strip-shaped paper gets the same question.
- A download made just before the 24-hour mark can be deleted with the other
  results at that mark, even while "Did the file save?" is on screen.
- Papers must be lighter than the surface they lie on. Several papers on a
  white or pale surface, or on a white stack, merge into one bright region and
  are read as one paper: one paper per photo on white. A page on a white stack
  is cut with the stack edges round it.
- Questions are counted by their position on the paper, whatever number is
  printed beside them.
- A Value question compares values, not form: on "simplify 6/8" a student who
  copies `6/8` gets the point against a typed key of `3/4`, and `4^2` matches
  `2^4`. Set such a question to Exact form. (With no key, a question that says
  simplify is never worked out by code, and its AI answer is compared in exact
  form.)
- A unit written on only one side is ignored (`12cm` matches `12`), so `2mg`
  in a physics formula also matches `2`. `1/2x` reads as (1/2)x. Against an
  AI-solved answer a trailing word is set aside (`15 apples` matches `15`);
  against a typed key it is not.
- An AI-solved answer can be wrong in the same way on both solves; its cells
  always carry `*` to be checked. An AI analysis is written only while a photo
  is read, so a key changed later cannot get a fresh one.
- Two versions of a test are told apart only by the arithmetic of their
  questions; they are flagged, never merged silently.

## Tests

No real student data is in this repo; every test paper is synthetic and every
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
`segment.js`, `enhance.js`, `solve.js` (exact arithmetic), `grade.js`,
`settle.js` (each question's expected answer for the class), `exemplar.js`
(worked solutions), `sheet.js`, `store.js`, `app.js`),
`vendor/` (math.js and SheetJS, byte-identical to upstream; see
`vendor/VENDOR.md`), `test/`.

## License

TABot's own code is MIT (`LICENSE`). The files in `vendor/` keep their upstream
licenses: math.js is Apache-2.0 (`vendor/LICENSE-mathjs.txt`, with its notice in
`vendor/NOTICE-mathjs.txt` and the licenses of code bundled inside it in
`vendor/math.js.LICENSE.txt`), and SheetJS Community Edition is Apache-2.0
(`vendor/LICENSE-sheetjs.txt`).
