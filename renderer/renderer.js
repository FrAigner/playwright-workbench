/* global require, monaco, api */
const $ = (sel) => document.querySelector(sel);

const state = {
  root: null,
  tabs: [], // { path, model, savedVersion, viewState }
  active: null,
  busy: false,
  expanded: new Set(['tests']),
};
let editor;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

// ---------- Output & status ----------
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function out(text) {
  const pre = $('#output');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.append(text.replace(ANSI, ''));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
function status(text) {
  $('#status-text').textContent = text;
}
function setBusy(busy, text) {
  state.busy = busy;
  $('#statusbar').classList.toggle('busy', busy);
  for (const id of ['#btn-run-all', '#btn-run-file', '#btn-run-test', '#btn-codegen']) $(id).disabled = busy;
  $('#btn-stop').disabled = !busy;
  if (text) status(text);
}
async function busy(label, fn) {
  if (state.busy) return;
  setBusy(true, label);
  try {
    return await fn();
  } catch (e) {
    out(`\nFehler: ${e.message}\n`);
    status(`Fehler: ${e.message}`);
  } finally {
    setBusy(false, $('#status-text').textContent === label ? 'Bereit' : null);
  }
}

// ---------- Modal ----------
function modal(title, fields, okLabel = 'OK') {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-ok').textContent = okLabel;
  const box = $('#modal-fields');
  box.replaceChildren();
  const inputs = {};
  for (const f of fields) {
    const input = el('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '', required: !!f.required });
    inputs[f.name] = input;
    box.append(el('label', {}, f.label, input));
  }
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const res = {};
      for (const [k, i] of Object.entries(inputs)) res[k] = i.value.trim();
      resolve(res);
    };
    dlg.returnValue = '';
    dlg.showModal();
    Object.values(inputs)[0]?.focus();
  });
}

// ---------- Editor ----------
const LANG = { ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', html: 'html', css: 'css', yml: 'yaml', yaml: 'yaml' };
const langOf = (p) => LANG[p.split('.').pop().toLowerCase()] || 'plaintext';
const uriOf = (p) => monaco.Uri.parse(`file:///workspace/${p.split('/').map(encodeURIComponent).join('/')}`);

async function setupTypes() {
  const ts = monaco.languages.typescript;
  const opts = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    esModuleInterop: true,
    noEmit: true,
    strict: false,
    lib: ['esnext', 'dom'],
  };
  ts.typescriptDefaults.setCompilerOptions(opts);
  ts.javascriptDefaults.setCompilerOptions(opts);
  const libs = await api.call('pw:types');
  // Loose stubs for Node built-ins and zod, which Playwright's typings reference.
  libs['file:///node_modules/@types/stubs/index.d.ts'] = [
    'fs', 'path', 'os', 'url', 'stream', 'child_process', 'crypto', 'util', 'http', 'https', 'zod', 'zod/v3',
  ].map((m) => `declare module '${m}';`).join('\n') +
    '\ndeclare var process: any;\ndeclare var require: any;\ndeclare var __dirname: string;\ndeclare var __filename: string;\n';
  const extra = Object.entries(libs).map(([filePath, content]) => ({ filePath, content }));
  ts.typescriptDefaults.setExtraLibs(extra);
  ts.javascriptDefaults.setExtraLibs(extra);
}

function initEditor() {
  editor = monaco.editor.create($('#editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    tabSize: 2,
    scrollBeyondLastLine: false,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  editor.onDidChangeModelContent(() => renderTabs());
}

function activeTab() {
  return state.tabs.find((t) => t.path === state.active);
}
const isDirty = (t) => t.model.getAlternativeVersionId() !== t.savedVersion;

async function openFile(p) {
  let tab = state.tabs.find((t) => t.path === p);
  if (!tab) {
    const content = await api.call('fs:read', p);
    const uri = uriOf(p);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, langOf(p), uri);
    model.setValue(content);
    tab = { path: p, model, savedVersion: model.getAlternativeVersionId() };
    state.tabs.push(tab);
  }
  activate(p);
}

function activate(p) {
  const prev = activeTab();
  if (prev) prev.viewState = editor.saveViewState();
  state.active = p;
  const tab = activeTab();
  editor.setModel(tab ? tab.model : null);
  if (tab?.viewState) editor.restoreViewState(tab.viewState);
  if (tab) editor.focus();
  renderTabs();
  renderTree();
}

function closeTab(p) {
  const tab = state.tabs.find((t) => t.path === p);
  if (!tab) return;
  if (isDirty(tab) && !confirm(`${p} hat ungespeicherte Änderungen. Trotzdem schließen?`)) return;
  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);
  tab.model.dispose();
  if (state.active === p) activate(state.tabs[Math.max(0, idx - 1)]?.path || null);
  else renderTabs();
}

function renderTabs() {
  document.body.classList.toggle('has-tabs', state.tabs.length > 0);
  $('#tabs').replaceChildren(
    ...state.tabs.map((t) =>
      el('div', { class: `tab${t.path === state.active ? ' active' : ''}${isDirty(t) ? ' dirty' : ''}`, title: t.path, onclick: () => activate(t.path) },
        t.path.split('/').pop(),
        el('span', { class: 'close', textContent: '×', onclick: (e) => { e.stopPropagation(); closeTab(t.path); } }))
    )
  );
}

async function saveTab(tab) {
  await api.call('fs:write', tab.path, tab.model.getValue());
  tab.savedVersion = tab.model.getAlternativeVersionId();
}
async function saveActive() {
  const tab = activeTab();
  if (!tab) return;
  try {
    await saveTab(tab);
    status(`Gespeichert: ${tab.path}`);
  } catch (e) {
    status(`Speichern fehlgeschlagen: ${e.message}`);
  }
  renderTabs();
}
async function saveAll() {
  for (const t of state.tabs) if (isDirty(t)) await saveTab(t);
  renderTabs();
}

// Re-read files from disk that changed externally (e.g. after git pull), unless edited locally.
async function reloadCleanTabs() {
  for (const t of [...state.tabs]) {
    if (isDirty(t)) continue;
    try {
      const content = await api.call('fs:read', t.path);
      if (content !== t.model.getValue()) {
        t.model.setValue(content);
        t.savedVersion = t.model.getAlternativeVersionId();
      }
    } catch {
      closeTab(t.path);
    }
  }
  renderTabs();
}

// ---------- Explorer ----------
let treeData = [];
async function refreshTree() {
  treeData = await api.call('fs:tree');
  renderTree();
}
function renderTree() {
  const rows = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const open = state.expanded.has(n.path);
      const label = n.dir ? `${open ? '▾' : '▸'} ${n.name}` : n.name;
      const row = el('div', {
        class: `node${n.path === state.active ? ' active' : ''}`,
        title: n.path,
        onclick: () => {
          if (n.dir) {
            open ? state.expanded.delete(n.path) : state.expanded.add(n.path);
            renderTree();
          } else openFile(n.path).catch((e) => status(e.message));
        },
      }, label);
      row.style.paddingLeft = `${10 + depth * 12}px`;
      if (!n.dir) row.append(el('span', { class: 'del', textContent: '🗑', title: 'In den Papierkorb', onclick: (e) => { e.stopPropagation(); deleteFile(n.path); } }));
      rows.push(row);
      if (n.dir && open) walk(n.children, depth + 1);
    }
  };
  walk(treeData, 0);
  $('#tree').replaceChildren(...rows);
}

async function newFile() {
  const res = await modal('Neue Datei', [{ name: 'path', label: 'Pfad (relativ zum Projekt)', value: 'tests/neu.spec.ts', required: true }], 'Anlegen');
  if (!res?.path) return;
  try {
    await api.call('fs:create', res.path);
    const parts = res.path.split('/');
    for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join('/'));
    await refreshTree();
    await openFile(res.path);
  } catch (e) {
    status(e.message);
  }
}

async function deleteFile(p) {
  if (!confirm(`${p} in den Papierkorb verschieben?`)) return;
  try {
    await api.call('fs:delete', p);
  } catch (e) {
    if (e.message !== 'TRASH_UNAVAILABLE') return status(`Löschen fehlgeschlagen: ${e.message}`);
    if (!confirm('Papierkorb ist nicht verfügbar. Datei endgültig löschen?')) return;
    try {
      await api.call('fs:delete', p, true);
    } catch (e2) {
      return status(`Löschen fehlgeschlagen: ${e2.message}`);
    }
  }
  const tab = state.tabs.find((t) => t.path === p);
  if (tab) {
    tab.savedVersion = tab.model.getAlternativeVersionId();
    closeTab(p);
  }
  await refreshTree();
  refreshGit();
}

// ---------- Workspace ----------
async function applyWorkspace(ws) {
  if (!ws) return;
  for (const t of [...state.tabs]) t.model.dispose();
  state.tabs = [];
  state.active = null;
  editor.setModel(null);
  state.root = ws.root;
  document.body.classList.remove('no-root');
  $('#project-name').textContent = ws.name.toUpperCase();
  $('#not-pw-hint').hidden = ws.isPlaywright;
  renderTabs();
  await refreshTree();
  refreshGit();
  const first = findFirstSpec(treeData);
  if (first) {
    first.split('/').slice(0, -1).reduce((acc, part) => { const p = acc ? `${acc}/${part}` : part; state.expanded.add(p); return p; }, '');
    await openFile(first);
  }
}
function findFirstSpec(nodes) {
  for (const n of nodes) {
    if (!n.dir && /\.(spec|test)\.[cm]?[jt]s$/.test(n.name)) return n.path;
    if (n.dir) {
      const hit = findFirstSpec(n.children);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------- Running tests ----------
function currentTestLine() {
  const tab = activeTab();
  if (!tab) return null;
  const pos = editor.getPosition();
  for (let line = pos.lineNumber; line >= 1; line--) {
    if (/^\s*test(\.(only|skip|fixme|fail|describe(\.\w+)?))?\s*\(/.test(tab.model.getLineContent(line))) return line;
  }
  return null;
}

async function runTests(target) {
  await saveAll();
  $('#output').replaceChildren();
  await busy('Tests laufen …', async () => {
    const code = await api.call('pw:run', { file: target, headed: $('#chk-headed').checked });
    status(code === 0 ? 'Alle Tests bestanden ✔' : 'Tests fehlgeschlagen ✘');
  });
  refreshTree();
}

// ---------- Git ----------
async function refreshGit() {
  const body = $('#git-body');
  let st;
  try {
    st = await api.call('git:status');
  } catch (e) {
    body.replaceChildren(el('div', { class: 'muted', textContent: e.message }));
    return;
  }
  if (!st.repo) {
    body.replaceChildren(
      el('div', { class: 'muted', textContent: 'Kein Git-Repository.' }),
      el('button', { textContent: 'Git initialisieren', onclick: gitInit })
    );
    return;
  }
  const msg = el('textarea', { rows: 2, placeholder: 'Commit-Nachricht', id: 'commit-msg' });
  const changes = st.changes.length
    ? st.changes.map((c) => el('div', { class: 'change' }, el('span', { textContent: c.file }), el('span', { class: 'kind', textContent: c.kind })))
    : [el('div', { class: 'muted', textContent: 'Keine Änderungen' })];
  body.replaceChildren(
    el('div', {}, 'Branch: ', el('b', { textContent: st.branch })),
    el('div', { class: 'muted', textContent: st.remote ? `origin: ${st.remote}` : 'Kein Remote konfiguriert' }),
    ...changes,
    msg,
    el('div', { class: 'row' },
      el('button', { textContent: 'Commit', onclick: () => gitCommit(msg.value) }),
      el('button', { textContent: '⬇ Pull', disabled: !st.remote, onclick: gitPull }),
      el('button', { textContent: '⬆ Push', disabled: !st.remote, onclick: gitPush })),
    el('button', { textContent: st.remote ? 'Remote ändern' : 'Remote hinzufügen', onclick: () => gitSetRemote(st.remote) })
  );
}

async function gitInit() {
  const res = await modal('Git initialisieren', [{ name: 'remote', label: 'Remote-URL (optional)', placeholder: 'https://github.com/user/repo.git' }]);
  if (!res) return;
  await busy('Git init …', () => api.call('git:init', res.remote || null));
  refreshGit();
}
async function gitSetRemote(current) {
  const res = await modal('Remote „origin“', [{ name: 'remote', label: 'Remote-URL', value: current || '', required: true }]);
  if (!res?.remote) return;
  await busy('Remote setzen …', () => api.call('git:setRemote', res.remote));
  refreshGit();
}
async function gitCommit(message) {
  if (!message.trim()) return status('Bitte eine Commit-Nachricht eingeben.');
  await saveAll();
  await busy('Commit …', async () => {
    await api.call('git:commit', message.trim());
    status('Commit erstellt ✔');
  });
  refreshGit();
}
async function gitPull() {
  await busy('Pull …', async () => {
    await api.call('git:pull');
    status('Pull erfolgreich ✔');
  });
  await refreshTree();
  await reloadCleanTabs();
  refreshGit();
}
async function gitPush() {
  await busy('Push …', async () => {
    await api.call('git:push');
    status('Push erfolgreich ✔');
  });
  refreshGit();
}
async function gitSettings() {
  const s = await api.call('settings:get');
  const res = await modal('Git-Einstellungen', [
    { name: 'gitName', label: 'Name (für Commits)', value: s.gitName },
    { name: 'gitEmail', label: 'E-Mail (für Commits)', value: s.gitEmail, type: 'email' },
    { name: 'gitUsername', label: 'Benutzername (GitHub/GitLab …)', value: s.gitUsername },
    { name: 'gitToken', label: s.hasToken ? 'Access-Token (gespeichert – leer lassen zum Beibehalten)' : 'Access-Token / Passwort', type: 'password' },
  ], 'Speichern');
  if (!res) return;
  await api.call('settings:set', res);
  status('Git-Einstellungen gespeichert');
}
async function gitClone() {
  const res = await modal('Repository klonen', [{ name: 'url', label: 'Repository-URL (HTTPS)', placeholder: 'https://github.com/user/repo.git', required: true }], 'Klonen');
  if (!res?.url) return;
  const ws = await busy('Klone Repository …', () => api.call('git:clone', res.url));
  await applyWorkspace(ws);
}

// ---------- Browsers ----------
function renderBrowsers(installed) {
  const box = $('#browser-status');
  const items = ['chromium', 'firefox', 'webkit'].map((b) =>
    installed.includes(b)
      ? el('span', { textContent: `${b} ✓ ` })
      : el('button', { textContent: `${b} installieren`, onclick: () => busy(`Installiere ${b} …`, () => api.call('pw:install', b)) })
  );
  box.replaceChildren('Browser: ', ...items);
}

// ---------- Wiring ----------
function wire() {
  const open = (fn) => async () => {
    try {
      await applyWorkspace(await api.call(fn));
    } catch (e) {
      status(e.message);
    }
  };
  $('#btn-new-project').onclick = $('#w-new').onclick = open('workspace:new');
  $('#btn-open').onclick = $('#w-open').onclick = open('workspace:open');
  $('#w-template').onclick = open('workspace:addTemplate');
  $('#w-clone').onclick = gitClone;
  $('#btn-new-file').onclick = newFile;
  $('#btn-refresh').onclick = () => { refreshTree(); refreshGit(); };
  $('#btn-run-all').onclick = () => runTests(null);
  $('#btn-run-file').onclick = () => {
    if (!state.active) return status('Keine Datei geöffnet.');
    runTests(state.active);
  };
  $('#btn-run-test').onclick = () => {
    const line = currentTestLine();
    if (!line) return status('Cursor steht in keinem test(…)-Block.');
    runTests(`${state.active}:${line}`);
  };
  $('#btn-stop').onclick = () => api.call('pw:stop');
  $('#btn-codegen').onclick = async () => {
    const res = await modal('Test aufnehmen', [{ name: 'url', label: 'Start-URL', value: 'https://', required: true }], 'Aufnahme starten');
    if (!res) return;
    const rel = await busy('Aufnahme läuft …', () => api.call('pw:codegen', res.url === 'https://' ? '' : res.url));
    if (rel) {
      state.expanded.add('tests');
      await refreshTree();
      await openFile(rel);
    }
  };
  $('#btn-report').onclick = () => api.call('pw:report').catch((e) => status(e.message));
  $('#btn-clear').onclick = () => $('#output').replaceChildren();
  $('#btn-git-refresh').onclick = refreshGit;
  $('#btn-git-settings').onclick = gitSettings;

  api.on('output', out);
  api.on('browsers:changed', renderBrowsers);
  api.on('browsers:installing', (b) => status(`Installiere ${b} …`));

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveActive();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.tabs.some(isDirty)) e.returnValue = false;
  });
}

document.body.classList.add('no-root');
require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], async () => {
  initEditor();
  wire();
  await setupTypes().catch((e) => out(`Typen konnten nicht geladen werden: ${e.message}\n`));
  try {
    renderBrowsers(await api.call('pw:browsers'));
    await applyWorkspace(await api.call('workspace:restore'));
  } catch (e) {
    out(`Fehler beim Start: ${e.message}\n`);
  }
  window.__workbenchReady = true;
});
