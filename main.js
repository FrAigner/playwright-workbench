const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const runner = require('./src/runner');
const gitOps = require('./src/git');
const settings = require('./src/settings');
const { createProject, isPlaywrightProject } = require('./src/template');
const { installedBrowsers } = require('./src/paths');

if (process.env.PW_WORKBENCH_USER_DATA) app.setPath('userData', process.env.PW_WORKBENCH_USER_DATA);

const HIDDEN =new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'blob-report', '.DS_Store']);

let win;
let root = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function resolveInRoot(rel) {
  if (!root) throw new Error('Kein Projektordner geöffnet.');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Pfad liegt außerhalb des Projekts.');
  return abs;
}

function tree(dir, rel = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .map((e) => {
      const p = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? { name: e.name, path: p, dir: true, children: tree(path.join(dir, e.name), p) } : { name: e.name, path: p };
    });
}

function setRoot(dir) {
  root = path.resolve(dir);
  settings.update({ lastWorkspace: root });
  win.setTitle(`Playwright Workbench – ${path.basename(root)}`);
  return { root, name: path.basename(root), isPlaywright: isPlaywrightProject(root) };
}

let chromiumInstall = null;
function ensureChromium() {
  if (installedBrowsers().includes('chromium')) return Promise.resolve();
  chromiumInstall ??= (async () => {
    send('browsers:installing', 'chromium');
    send('output', 'Chromium wird einmalig heruntergeladen (ca. 150 MB) …\n');
    const code = await runner.runCli(['install', 'chromium'], app.getPath('userData'), (t) => send('output', t));
    send('output', code === 0 ? 'Chromium ist installiert.\n' : `Installation fehlgeschlagen (Code ${code}).\n`);
    send('browsers:changed', installedBrowsers());
  })().finally(() => (chromiumInstall = null));
  return chromiumInstall;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('workspace:restore', () => {
    const last = settings.load().lastWorkspace;
    return last && fs.existsSync(last) ? setRoot(last) : null;
  });
  handle('workspace:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Projektordner öffnen', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : setRoot(r.filePaths[0]);
  });
  handle('workspace:new', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Ordner für neues Playwright-Projekt wählen',
      buttonLabel: 'Projekt hier anlegen',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled) return null;
    createProject(r.filePaths[0]);
    return setRoot(r.filePaths[0]);
  });
  handle('workspace:addTemplate', () => {
    createProject(resolveInRoot('.'));
    return setRoot(root);
  });

  handle('fs:tree', () => (root ? tree(root) : []));
  handle('fs:read', (rel) => fs.readFileSync(resolveInRoot(rel), 'utf8'));
  handle('fs:write', (rel, content) => {
    const abs = resolveInRoot(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  });
  handle('fs:create', (rel) => {
    const abs = resolveInRoot(rel);
    if (fs.existsSync(abs)) throw new Error('Datei existiert bereits.');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = /\.spec\.[cm]?[tj]s$/.test(rel)
      ? `import { test, expect } from '@playwright/test';\n\ntest('mein Test', async ({ page }) => {\n  await page.goto('https://example.com/');\n  await expect(page).toHaveTitle(/Example/);\n});\n`
      : '';
    fs.writeFileSync(abs, content);
  });
  handle('fs:delete', async (rel) => {
    const abs = resolveInRoot(rel);
    if (abs === root) throw new Error('Projektordner kann nicht gelöscht werden.');
    await shell.trashItem(abs);
  });

  handle('pw:types', () => JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'playwright-types.json'), 'utf8')));
  handle('pw:browsers', installedBrowsers);
  handle('pw:install', async (browser) => {
    const code = await runner.runCli(['install', browser], app.getPath('userData'), (t) => send('output', t));
    send('browsers:changed', installedBrowsers());
    return code;
  });
  handle('pw:run', async ({ file, headed, grep }) => {
    await ensureChromium();
    const args = ['test'];
    if (file) args.push(file);
    if (headed) args.push('--headed');
    if (grep) args.push('--grep', grep);
    send('output', `$ playwright ${args.join(' ')}\n`);
    const code = await runner.runCli(args, resolveInRoot('.'), (t) => send('output', t));
    send('output', `\n${code === 0 ? '✔ Alle Tests bestanden' : `✘ Beendet mit Code ${code}`}\n`);
    return code;
  });
  handle('pw:codegen', async (url) => {
    await ensureChromium();
    const rel = `tests/aufnahme-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.spec.ts`;
    fs.mkdirSync(resolveInRoot('tests'), { recursive: true });
    const args = ['codegen', '--target', 'playwright-test', '--output', resolveInRoot(rel)];
    if (url) args.push(url);
    send('output', 'Aufnahme läuft – im geöffneten Browser klicken, danach Fenster schließen.\n');
    await runner.runCli(args, resolveInRoot('.'), (t) => send('output', t));
    return fs.existsSync(resolveInRoot(rel)) ? rel : null;
  });
  handle('pw:stop', () => runner.stop());
  handle('pw:report', async () => {
    const report = resolveInRoot('playwright-report/index.html');
    if (!fs.existsSync(report)) throw new Error('Noch kein Report vorhanden – zuerst Tests ausführen.');
    const err = await shell.openPath(report);
    if (err) throw new Error(err);
  });

  handle('settings:get', () => {
    const s = settings.load();
    return { gitName: s.gitName || '', gitEmail: s.gitEmail || '', gitUsername: s.gitUsername || '', hasToken: !!s.gitToken };
  });
  handle('settings:set', (patch) => {
    const clean = {};
    for (const k of ['gitName', 'gitEmail', 'gitUsername', 'gitToken']) if (typeof patch[k] === 'string') clean[k] = patch[k];
    if (clean.gitToken === '') delete clean.gitToken;
    settings.update(clean);
  });

  handle('git:status', () => (root ? gitOps.status(root) : { repo: false }));
  handle('git:init', (remoteUrl) => gitOps.init(resolveInRoot('.'), remoteUrl));
  handle('git:setRemote', (remoteUrl) => gitOps.setRemote(resolveInRoot('.'), remoteUrl));
  handle('git:commit', (message) => gitOps.commitAll(resolveInRoot('.'), message, settings.load()));
  handle('git:pull', () => gitOps.pull(resolveInRoot('.'), settings.load()));
  handle('git:push', () => gitOps.push(resolveInRoot('.'), settings.load()));
  handle('git:clone', async (url) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Leeren Zielordner für das Repository wählen',
      buttonLabel: 'Hierhin klonen',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled) return null;
    const dir = r.filePaths[0];
    if (fs.readdirSync(dir).length) throw new Error('Der Zielordner muss leer sein.');
    await gitOps.clone(url, dir, settings.load(), (t) => send('output', `${t}\n`));
    return setRoot(dir);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Playwright Workbench',
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Ohne Speichern schließen', 'Abbrechen'],
      defaultId: 1,
      message: 'Es gibt ungespeicherte Änderungen.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  if (!process.env.PW_WORKBENCH_SKIP_BROWSER_INSTALL) {
    win.webContents.once('did-finish-load', () => ensureChromium().catch((e) => send('output', `${e.message}\n`)));
  }
});

app.on('window-all-closed', () => {
  runner.stop();
  app.quit();
});
