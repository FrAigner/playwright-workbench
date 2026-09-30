const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  if (raw.gitTokenEnc && safeStorage.isEncryptionAvailable()) {
    try {
      raw.gitToken = safeStorage.decryptString(Buffer.from(raw.gitTokenEnc, 'base64'));
    } catch {}
  }
  delete raw.gitTokenEnc;
  return raw;
}

function save(settings) {
  const out = { ...settings };
  if (out.gitToken && safeStorage.isEncryptionAvailable()) {
    out.gitTokenEnc = safeStorage.encryptString(out.gitToken).toString('base64');
    delete out.gitToken;
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2));
}

function update(patch) {
  const next = { ...load(), ...patch };
  save(next);
  return next;
}

module.exports = { load, update };
