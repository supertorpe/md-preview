import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(new URL('..', import.meta.url).pathname);
const mainRs = await readFile(resolve(root, 'src/main.rs'), 'utf8');
const marker = 'var ICON_EDIT';
const markerIndex = mainRs.indexOf(marker);
if (markerIndex < 0) throw new Error('desktop script marker not found');
const scriptStart = mainRs.lastIndexOf('<script>', markerIndex);
const scriptEnd = mainRs.indexOf('</script>', markerIndex);
if (scriptStart < 0 || scriptEnd < 0) throw new Error('desktop script block not found');

const desktopScript = mainRs
  .slice(scriptStart + '<script>'.length, scriptEnd)
  .replaceAll('{{', '{')
  .replaceAll('}}', '}')
  // The real page formats these at build time; the harness must too, or the
  // assertions below would see literal '{btn_theme_dark}' placeholders.
  .replaceAll('{btn_theme_dark}', 'Switch to dark theme')
  .replaceAll('{btn_theme_light}', 'Switch to light theme')
  .replaceAll('{btn_theme_system}', 'Follow system');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

const harness = `<!doctype html>
<html>
  <head><meta charset="utf-8"><style>
    body { margin: 0; font: 15px/1.6 system-ui, sans-serif; }
  </style></head>
  <body>
    <div class="tabbar">
      <div id="tabs"></div>
      <div id="doc-stats"></div>
      <button id="tab-open"></button>
    </div>
    <div class="toolbar">
      <button id="btn-open"></button>
      <button id="btn-search"></button>
      <button id="btn-toggle"></button>
      <button id="btn-print"></button>
      <div id="theme-control">
        <button id="btn-theme"></button>
        <div id="theme-menu" hidden><button id="theme-system"></button></div>
      </div>
      <div id="zoom-control">
        <button id="btn-zoom"></button>
        <button id="btn-zoom-out"></button>
        <button id="btn-zoom-reset"></button>
        <button id="btn-zoom-in"></button>
      </div>
      <button id="btn-update" hidden></button>
    </div>
    <div class="findbar">
      <input id="find-input" type="search">
      <span id="find-state"></span>
      <button id="find-prev"></button>
      <button id="find-next"></button>
      <button id="find-close"></button>
    </div>
    <div id="app">
      <div id="preview"><p>Theme probe</p></div>
      <textarea id="editor"></textarea>
    </div>
    <script>
      window.__messages = [];
      window.ipc = { postMessage(message) { window.__messages.push(message); } };
    </script>
    <script>${desktopScript}</script>
  </body>
</html>`;

// Scenario 1: light scheme -> sun icon, dark tooltip, click emits theme:dark
await page.emulateMedia({ colorScheme: 'light' });
await page.setContent(harness);
let state = await page.evaluate(() => ({
  icon: document.getElementById('btn-theme').innerHTML,
  title: document.getElementById('btn-theme').title,
  aria: document.getElementById('btn-theme').getAttribute('aria-label'),
  menuHidden: document.getElementById('theme-menu').hidden,
}));
if (!state.icon.includes('M12 2v2') ||
    state.title !== 'Switch to dark theme' ||
    state.aria !== 'Switch to dark theme' ||
    !state.menuHidden) {
  throw new Error(`light icon state failed: ${JSON.stringify(state)}`);
}
await page.locator('#btn-theme').click();
state = await page.evaluate(() =>
  window.__messages.filter((m) => m.startsWith('theme:')),
);
if (state.length !== 1 || state[0] !== 'theme:dark') {
  throw new Error(`light click failed: ${JSON.stringify(state)}`);
}

// Scenario 2: dark scheme -> moon icon, light tooltip, click emits theme:light
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForFunction(
  () => document.getElementById('btn-theme').title === 'Switch to light theme',
);
state = await page.evaluate(() => ({
  icon: document.getElementById('btn-theme').innerHTML,
  title: document.getElementById('btn-theme').title,
}));
if (!state.icon.includes('M21 12.79A9')) {
  throw new Error(`dark icon state failed: ${JSON.stringify(state)}`);
}
await page.locator('#btn-theme').click();
state = await page.evaluate(() =>
  window.__messages.filter((m) => m.startsWith('theme:')),
);
if (state.length !== 2 || state[1] !== 'theme:light') {
  throw new Error(`dark click failed: ${JSON.stringify(state)}`);
}

// Scenario 3: right-click opens the menu; outside click closes it silently
await page.locator('#btn-theme').click({ button: 'right' });
state = await page.evaluate(() => document.getElementById('theme-menu').hidden);
if (state) throw new Error('right-click did not open the theme menu');
await page.locator('#preview p').click();
state = await page.evaluate(() => ({
  hidden: document.getElementById('theme-menu').hidden,
  messages: window.__messages.filter((m) => m.startsWith('theme:')),
}));
if (!state.hidden || state.messages.length !== 2) {
  throw new Error(`outside click must close without emitting: ${JSON.stringify(state)}`);
}

// Scenario 4: menu item emits theme:system and closes the menu
await page.locator('#btn-theme').click({ button: 'right' });
await page.locator('#theme-system').click();
state = await page.evaluate(() => ({
  hidden: document.getElementById('theme-menu').hidden,
  messages: window.__messages.filter((m) => m.startsWith('theme:')),
}));
if (!state.hidden ||
    state.messages.length !== 3 ||
    state.messages[2] !== 'theme:system') {
  throw new Error(`follow-system failed: ${JSON.stringify(state)}`);
}

await browser.close();
console.log('[desktop-theme-verify] OK');
