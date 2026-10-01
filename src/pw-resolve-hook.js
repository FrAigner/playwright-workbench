// Preloaded into every Playwright process (via NODE_OPTIONS). Resolves Playwright
// imports to the bundled copy for both require() and ESM import:
// - a node_modules folder in the project or a parent directory with another copy
//   would make Playwright fail with "did not expect test() to be called here";
// - ESM projects ("type": "module") ignore NODE_PATH and would not find it at all.
const Module = require('module');
const path = require('path');
const { pathToFileURL } = require('url');

const bundled = process.env.PW_WORKBENCH_NODE_MODULES;
const PLAYWRIGHT = /^(@playwright\/test|playwright|playwright-core)(\/.*)?$/;

if (bundled) {
  // Resolving relative to a file next to the bundled node_modules finds the bundled copy first.
  const parentURL = pathToFileURL(path.join(path.dirname(bundled), 'pw-workbench-resolver.js')).href;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (PLAYWRIGHT.test(specifier)) return nextResolve(specifier, { ...context, parentURL });
      return nextResolve(specifier, context);
    },
  });

  // Playwright's own CommonJS transform resolves through _resolveFilename, bypassing the hook above.
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (PLAYWRIGHT.test(request)) return original.call(this, request, parent, isMain, { ...options, paths: [bundled] });
    return original.call(this, request, parent, isMain, options);
  };
}
