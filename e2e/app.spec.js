const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startGitServer } = require('./gitServer');

const appDir = path.resolve(__dirname, '..');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

let app, page, tmp, project, gitRoot, server;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-workbench-'));
  project = path.join(tmp, 'project');
  gitRoot = path.join(tmp, 'git');
  fs.mkdirSync(project);
  fs.mkdirSync(gitRoot);
  sh(gitRoot, 'init', '--bare', '-b', 'main', 'remote.git');
  sh(path.join(gitRoot, 'remote.git'), 'config', 'http.receivepack', 'true');
  server = await startGitServer(gitRoot);

  // PW_WORKBENCH_EXE lets the same suite run against a packaged build.
  const exe = process.env.PW_WORKBENCH_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [appDir] }),
    env: {
      ...process.env,
      PW_WORKBENCH_USER_DATA: path.join(tmp, 'userdata'),
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'),
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.waitForFunction(() => window.__workbenchReady === true);
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, project);
});

test.afterAll(async () => {
  // Skip the "unsaved changes" dialog, which would block closing after a failed test.
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app?.close();
  server?.close();
});

const setEditor = (code) => page.evaluate((c) => window.monaco.editor.getEditors()[0].getModel().setValue(c), code);
const outputText = () => page.locator('#output').textContent();

test('neues Projekt wird angelegt und Beispieltest geöffnet', async () => {
  await page.getByRole('button', { name: 'Neues Projekt anlegen' }).click();
  await expect(page.locator('.tab.active')).toHaveText(/example\.spec\.ts/);
  await expect(page.locator('#tree')).toContainText('playwright.config.ts');
  expect(fs.existsSync(path.join(project, 'tests', 'example.spec.ts'))).toBe(true);
});

test('Editor kennt die Playwright-Typen', async () => {
  await setEditor(`import { test } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.gotoo('/');\n});\n`);
  await expect
    .poll(() => page.evaluate(() => window.monaco.editor.getModelMarkers({}).map((m) => m.message).join('\n')), { timeout: 30_000 })
    .toMatch(/Property 'gotoo' does not exist on type 'Page'/);
  const markers = await page.evaluate(() => window.monaco.editor.getModelMarkers({}).map((m) => m.message));
  expect(markers.filter((m) => /Cannot find module/.test(m))).toEqual([]);
});

test('Datei speichern und Test ausführen (grün)', async () => {
  await setEditor(`import { test, expect } from '@playwright/test';

test('Überschrift sichtbar', async ({ page }) => {
  await page.setContent('<h1>Hallo Workbench</h1>');
  await expect(page.getByRole('heading')).toHaveText('Hallo Workbench');
});
`);
  await expect(page.locator('.tab.active')).toHaveClass(/dirty/);
  await page.getByRole('button', { name: '▶ Datei' }).click();
  await expect(page.locator('#status-text')).toHaveText('Alle Tests bestanden ✔', { timeout: 90_000 });
  expect(await outputText()).toContain('1 passed');
  await expect(page.locator('.tab.active')).not.toHaveClass(/dirty/);
  expect(fs.readFileSync(path.join(project, 'tests', 'example.spec.ts'), 'utf8')).toContain('Hallo Workbench');
});

test('fehlschlagender Test unter Cursor wird als rot gemeldet', async () => {
  await setEditor(`import { test, expect } from '@playwright/test';

test('grün', async ({ page }) => {
  await page.setContent('<p>ok</p>');
});

test('rot', async ({ page }) => {
  await page.setContent('<p>ok</p>');
  expect(1).toBe(2);
});
`);
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setPosition({ lineNumber: 9, column: 3 }));
  await page.getByRole('button', { name: '▶ Test unter Cursor' }).click();
  await expect(page.locator('#status-text')).toHaveText('Tests fehlgeschlagen ✘', { timeout: 90_000 });
  const text = await outputText();
  expect(text).toContain('1 failed');
  expect(text).not.toContain('passed');
});

test('Git: init, commit, push und pull', async () => {
  const remote = `http://127.0.0.1:${server.address().port}/remote.git`;

  await page.locator('#btn-git-settings').click();
  await page.getByLabel('Name (für Commits)').fill('Test User');
  await page.getByLabel('E-Mail (für Commits)').fill('test@example.com');
  await page.getByRole('button', { name: 'Speichern' }).click();

  await page.getByRole('button', { name: 'Git initialisieren' }).click();
  await page.getByLabel('Remote-URL (optional)').fill(remote);
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('#git-body')).toContainText('Branch: main');
  await expect(page.locator('#git-body')).toContainText('tests/example.spec.ts');
  await expect(page.locator('#git-body')).not.toContainText('test-results');

  await page.getByPlaceholder('Commit-Nachricht').fill('Erste Tests');
  await page.getByRole('button', { name: 'Commit' }).click();
  await expect(page.locator('#git-body')).toContainText('Keine Änderungen');
  await page.getByRole('button', { name: '⬆ Push' }).click();
  await expect(page.locator('#status-text')).toHaveText('Push erfolgreich ✔');
  expect(sh(path.join(gitRoot, 'remote.git'), 'log', '--format=%s', 'main')).toContain('Erste Tests');

  const other = path.join(tmp, 'other');
  sh(tmp, 'clone', '-q', path.join(gitRoot, 'remote.git'), other);
  fs.writeFileSync(path.join(other, 'tests', 'von-kollege.spec.ts'), "import { test } from '@playwright/test';\n");
  sh(other, 'add', '.');
  sh(other, '-c', 'user.name=Kollege', '-c', 'user.email=k@example.com', 'commit', '-qm', 'Kollege');
  sh(other, 'push', '-q', 'origin', 'main');

  await page.getByRole('button', { name: '⬇ Pull' }).click();
  await expect(page.locator('#status-text')).toHaveText('Pull erfolgreich ✔');
  await expect(page.locator('#tree')).toContainText('von-kollege.spec.ts');
});
