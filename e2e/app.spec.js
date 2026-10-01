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

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
    console.log(`--- App-Ausgabe (${testInfo.title}) ---\n${await page.locator('#output').textContent()}`);
  }
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

const activeEditorText = () => page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValue());
const runFile = async (expected) => {
  await page.getByRole('button', { name: '▶ Datei' }).click();
  await expect(page.locator('#status-text')).toHaveText(expected, { timeout: 120_000 });
};

test('neue Datei anlegen, alle Tests ausführen, Report öffnen', async () => {
  await page.locator('#btn-new-file').click();
  await expect(page.getByLabel('Pfad (relativ zum Projekt)')).toHaveValue('tests/neu.spec.ts');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.locator('.tab.active')).toHaveText(/neu\.spec\.ts/);
  expect(await activeEditorText()).toContain("from '@playwright/test'");
  await setEditor(`import { test, expect } from '@playwright/test';

test('neu', async ({ page }) => {
  await page.setContent('<button>OK</button>');
  await expect(page.getByRole('button', { name: 'OK' })).toBeVisible();
});
`);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await expect(page.locator('.tab.active')).not.toHaveClass(/dirty/);

  await page.getByRole('button', { name: '▶ Alle Tests' }).click();
  await expect(page.locator('#status-text')).toHaveText('Tests fehlgeschlagen ✘', { timeout: 120_000 });
  const text = await outputText();
  expect(text).toContain('1 failed');
  expect(text).toContain('2 passed');

  await app.evaluate(({ shell }) => {
    shell.openPath = async (p) => {
      globalThis.__openedPath = p;
      return '';
    };
  });
  await page.getByRole('button', { name: 'Report öffnen' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.__openedPath)).toBe(path.join(project, 'playwright-report', 'index.html'));
  expect(fs.readFileSync(path.join(project, 'playwright-report', 'index.html'), 'utf8')).toContain('Playwright Test Report');
});

test('Checkbox "Browser sichtbar" startet den Browser mit Fenster', async () => {
  await setEditor(`import { test, expect } from '@playwright/test';

test('läuft mit sichtbarem Browser', async ({ page, headless }) => {
  await page.setContent('<p>sichtbar</p>');
  expect(headless).toBe(false);
});
`);
  await runFile('Tests fehlgeschlagen ✘');
  await page.getByLabel('Browser sichtbar').check();
  await runFile('Alle Tests bestanden ✔');
  await page.getByLabel('Browser sichtbar').uncheck();
});

test('Aufnahme (Codegen) erzeugt einen lauffähigen Test', async () => {
  const url = 'data:text/html,<h1>Aufnahme</h1>';
  await page.getByRole('button', { name: '● Aufnehmen' }).click();
  await page.getByLabel('Start-URL').fill(url);
  await page.getByRole('button', { name: 'Aufnahme starten' }).click();
  await expect(page.locator('#btn-stop')).toBeEnabled();

  const recorded = () => fs.readdirSync(path.join(project, 'tests')).filter((f) => f.startsWith('aufnahme-'));
  await expect.poll(() => recorded().length, { timeout: 60_000 }).toBe(1);
  await expect
    .poll(() => fs.readFileSync(path.join(project, 'tests', recorded()[0]), 'utf8'), { timeout: 60_000 })
    .toContain(`page.goto('${url}')`);

  // Stands in for the user closing the recorder window.
  await page.locator('#btn-stop').click();
  await expect(page.locator('.tab.active')).toHaveText(new RegExp(recorded()[0].replace(/\./g, '\\.')), { timeout: 30_000 });
  expect(await activeEditorText()).toContain(`page.goto('${url}')`);
  await runFile('Alle Tests bestanden ✔');
});

for (const browser of ['firefox', 'webkit']) {
  test(`${browser} installieren und Test darin ausführen`, async () => {
    test.skip(browser === 'webkit' && process.platform === 'linux', 'WebKit braucht unter Linux Systempakete');
    test.setTimeout(900_000);
    const status = page.locator('#browser-status');
    if (!(await status.textContent()).includes(`${browser} ✓`)) {
      await page.getByRole('button', { name: `${browser} installieren` }).click();
      await expect(status).toContainText(`${browser} ✓`, { timeout: 840_000 });
    }

    const rel = `tests/${browser}.spec.ts`;
    fs.writeFileSync(path.join(project, rel), `import { test, expect } from '@playwright/test';

test.use({ browserName: '${browser}' });

test('läuft in ${browser}', async ({ page, browserName }) => {
  expect(browserName).toBe('${browser}');
  await page.setContent('<p>Hallo</p>');
  await expect(page.getByText('Hallo')).toBeVisible();
});
`);
    await page.locator('#btn-refresh').click();
    await page.locator('#tree .node', { hasText: `${browser}.spec.ts` }).click();
    await expect(page.locator('.tab.active')).toHaveText(new RegExp(`${browser}\\.spec\\.ts`));
    await runFile('Alle Tests bestanden ✔');
  });
}

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

test('Ordner ohne Konfiguration öffnen, Vorlage hinzufügen, Datei löschen', async () => {
  const empty = path.join(tmp, 'leer');
  fs.mkdirSync(empty);
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, empty);
  await page.getByRole('button', { name: 'Ordner öffnen' }).first().click();
  await expect(page.getByText('Dieser Ordner enthält noch keine')).toBeVisible();
  await page.getByRole('button', { name: 'Playwright-Vorlage hinzufügen' }).click();
  await expect(page.locator('.tab.active')).toHaveText(/example\.spec\.ts/);
  expect(fs.existsSync(path.join(empty, 'playwright.config.ts'))).toBe(true);

  // Accepts "in den Papierkorb?" and, where no trash exists, "endgültig löschen?".
  const dialogs = [];
  const accept = (d) => {
    dialogs.push(d.message());
    d.accept();
  };
  page.on('dialog', accept);
  const row = page.locator('#tree .node', { hasText: 'example.spec.ts' });
  await row.hover();
  await row.locator('.del').click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('#tabs .tab')).toHaveCount(0);
  page.off('dialog', accept);
  expect(fs.existsSync(path.join(empty, 'tests', 'example.spec.ts'))).toBe(false);
  if (process.platform !== 'linux') expect(dialogs).toHaveLength(1);
});

const greenSpec = `import { test, expect } from '@playwright/test';

test('grün', async ({ page }) => {
  await page.setContent('<p>ok</p>');
  await expect(page.getByText('ok')).toBeVisible();
});
`;

async function openFolder(dir) {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
  }, dir);
  await page.getByRole('button', { name: 'Ordner öffnen' }).first().click();
}

test('fremde Playwright-Kopie in übergeordnetem node_modules stört nicht', async () => {
  const parent = path.join(tmp, 'mit-node-modules');
  const proj = path.join(parent, 'projekt');
  for (const pkg of ['@playwright/test', 'playwright', 'playwright-core']) {
    fs.cpSync(path.join(appDir, 'node_modules', pkg), path.join(parent, 'node_modules', pkg), { recursive: true });
  }
  fs.mkdirSync(proj, { recursive: true });
  await openFolder(proj);
  await page.getByRole('button', { name: 'Playwright-Vorlage hinzufügen' }).click();
  await expect(page.locator('.tab.active')).toHaveText(/example\.spec\.ts/);
  await setEditor(greenSpec);
  await runFile('Alle Tests bestanden ✔');
});

test('ES-Modul-Projekt ("type": "module") läuft', async () => {
  const proj = path.join(tmp, 'esm');
  fs.mkdirSync(path.join(proj, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{ "type": "module" }\n');
  fs.writeFileSync(path.join(proj, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
  fs.writeFileSync(path.join(proj, 'tests', 'esm.spec.ts'), greenSpec);
  await openFolder(proj);
  await expect(page.locator('.tab.active')).toHaveText(/esm\.spec\.ts/);
  await runFile('Alle Tests bestanden ✔');
});
