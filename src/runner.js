const { spawn } = require('child_process');
const { playwrightCli, nodeModulesDir, browsersDir } = require('./paths');

let current = null;

function playwrightEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: nodeModulesDir(),
    PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
    FORCE_COLOR: '0',
  };
}

// Runs the bundled Playwright CLI with Electron's embedded Node runtime,
// so users need neither Node.js nor npm installed.
function runCli(args, cwd, onOutput) {
  if (current) throw new Error('Es läuft bereits ein Vorgang.');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [playwrightCli(), ...args], { cwd, env: playwrightEnv() });
    current = child;
    child.stdout.on('data', (d) => onOutput(d.toString()));
    child.stderr.on('data', (d) => onOutput(d.toString()));
    child.on('error', (e) => onOutput(`\n${e.message}\n`));
    child.on('close', (code) => {
      current = null;
      resolve(code);
    });
  });
}

function stop() {
  if (current) current.kill();
}

function isRunning() {
  return current !== null;
}

module.exports = { runCli, stop, isRunning };
