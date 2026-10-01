// Writes release notes listing the exact bundled component versions.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkgVersion = (name) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { browsers } = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
const browser = (name) => browsers.find((b) => b.name === name).browserVersion;

const runtime = JSON.parse(
  execFileSync(require('electron'), ['-p', 'JSON.stringify(process.versions)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
);

const notes = `## Playwright Workbench ${app.version}

### Enthaltene Versionen

| Komponente | Version |
| --- | --- |
| Playwright (\`@playwright/test\`) | **${pkgVersion('@playwright/test')}** |
| Chromium (für Tests) | ${browser('chromium')} |
| Firefox (für Tests) | ${browser('firefox')} |
| WebKit (für Tests) | ${browser('webkit')} |
| Node.js (führt die Tests aus) | ${runtime.node} |
| Electron (App-Rahmen) | ${runtime.electron} (Chromium ${runtime.chrome}) |
| Monaco-Editor | ${pkgVersion('monaco-editor')} |
| isomorphic-git | ${pkgVersion('isomorphic-git')} |

Die Test-Browser werden nicht mitgeliefert: Chromium lädt die App beim ersten
Start herunter, Firefox und WebKit per Klick in der Statusleiste.

### Installation

- **macOS (Homebrew):** \`brew install --cask fraigner/tap/playwright-workbench\`
- **macOS (manuell):** \`playwright-workbench-${app.version}-arm64.dmg\` (Apple Silicon) bzw. \`-x64.dmg\` (Intel)
- **Windows:** \`playwright-workbench-${app.version}-x64.exe\`
`;

const out = process.argv[2] || path.join(root, 'dist', 'RELEASE_NOTES.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, notes);
console.log(notes);
