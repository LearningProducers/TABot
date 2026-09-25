// Playwright config for TABot's end-to-end test. Two engines: WebKit with
// the iPhone 13 profile (the Safari engine a phone-first page has to pass)
// and desktop Chromium. The page is served as plain static files, the way a
// teacher's browser gets it; Groq is mocked inside the test.
'use strict';

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 8791;
// Fixed so the downloaded file's date is predictable.
const TIMEZONE = 'America/Chicago';

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js$/,
  outputDir: path.join(REPO, 'test-results'),
  timeout: 120000,
  expect: { timeout: 20000 },
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:' + PORT,
    timezoneId: TIMEZONE,
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: 'block',
    trace: 'off'
  },
  projects: [
    { name: 'webkit-iphone-13', use: { ...devices['iPhone 13'] } },
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'python3 -m http.server ' + PORT + ' --bind 127.0.0.1 --directory ' + JSON.stringify(REPO),
    url: 'http://127.0.0.1:' + PORT + '/index.html',
    reuseExistingServer: false,
    timeout: 20000,
    // http.server logs every request to stderr; the test's own request log is the record.
    stdout: 'ignore',
    stderr: 'ignore'
  }
});
