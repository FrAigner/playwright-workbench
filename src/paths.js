const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Packaged builds keep Playwright outside app.asar (asarUnpack), because the
// child Node process cannot execute code from inside the archive.
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function playwrightCli() {
  return unpacked(require.resolve('@playwright/test/cli'));
}

function nodeModulesDir() {
  const pkg = unpacked(require.resolve('@playwright/test/package.json'));
  return path.resolve(path.dirname(pkg), '..', '..');
}

function browsersDir() {
  return process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(app.getPath('userData'), 'ms-playwright');
}

// Headless runs need chromium-headless-shell in addition to chromium, and only
// the exact revisions pinned by the bundled Playwright version are usable.
const REQUIRED = {
  chromium: ['chromium', 'chromium-headless-shell'],
  firefox: ['firefox'],
  webkit: ['webkit'],
};

function installedBrowsers() {
  const dir = browsersDir();
  const coreDir = path.dirname(unpacked(require.resolve('playwright-core/package.json')));
  const { browsers } = JSON.parse(fs.readFileSync(path.join(coreDir, 'browsers.json'), 'utf8'));
  const isInstalled = (name) => {
    const b = browsers.find((x) => x.name === name);
    const revisions = [b.revision, ...Object.values(b.revisionOverrides || {})];
    return revisions.some((r) => fs.existsSync(path.join(dir, `${name.replace(/-/g, '_')}-${r}`, 'INSTALLATION_COMPLETE')));
  };
  return Object.keys(REQUIRED).filter((b) => REQUIRED[b].every(isInstalled));
}

module.exports = { playwrightCli, nodeModulesDir, browsersDir, installedBrowsers, unpacked };
