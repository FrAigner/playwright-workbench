// electron-builder strips *.d.ts from node_modules, so Playwright's typings are
// bundled into one JSON file that the editor loads for autocomplete.
const fs = require('fs');
const path = require('path');

const nm = path.resolve(__dirname, '..', 'node_modules');
const out = {};

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory() && e.name === 'types') walk(abs);
    else if (e.isFile() && (e.name.endsWith('.d.ts') || e.name === 'package.json')) {
      out[`file:///node_modules/${path.relative(nm, abs).split(path.sep).join('/')}`] = fs.readFileSync(abs, 'utf8');
    }
  }
}

['@playwright/test', 'playwright', 'playwright-core'].forEach((p) => walk(path.join(nm, p)));
const target = path.resolve(__dirname, '..', 'src', 'playwright-types.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log(`${Object.keys(out).length} Typdateien -> ${path.relative(process.cwd(), target)}`);
