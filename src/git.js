const fs = require('fs');
const path = require('path');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');

function authFor(settings) {
  return () => ({ username: settings.gitUsername || 'git', password: settings.gitToken || '' });
}

function author(settings) {
  if (!settings.gitName || !settings.gitEmail) {
    throw new Error('Bitte zuerst Name und E-Mail in den Git-Einstellungen eintragen.');
  }
  return { name: settings.gitName, email: settings.gitEmail };
}

async function status(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { repo: false };
  const branch = (await git.currentBranch({ fs, dir, fullname: false })) || '(detached)';
  const remotes = await git.listRemotes({ fs, dir });
  const matrix = await git.statusMatrix({ fs, dir });
  const changes = [];
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue;
    let kind = 'geändert';
    if (head === 0) kind = 'neu';
    else if (workdir === 0) kind = 'gelöscht';
    changes.push({ file, kind });
  }
  return { repo: true, branch, remote: remotes.find((r) => r.remote === 'origin')?.url || null, changes };
}

async function init(dir, remoteUrl) {
  await git.init({ fs, dir, defaultBranch: 'main' });
  if (remoteUrl) await git.addRemote({ fs, dir, remote: 'origin', url: remoteUrl, force: true });
}

async function setRemote(dir, remoteUrl) {
  await git.addRemote({ fs, dir, remote: 'origin', url: remoteUrl, force: true });
}

async function clone(url, dir, settings, onProgress) {
  await git.clone({
    fs, http, dir, url, singleBranch: true, depth: 50,
    onAuth: authFor(settings),
    onProgress: (p) => onProgress?.(`${p.phase} ${p.loaded}${p.total ? '/' + p.total : ''}`),
  });
}

async function commitAll(dir, message, settings) {
  const matrix = await git.statusMatrix({ fs, dir });
  let staged = 0;
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue;
    if (workdir === 0) await git.remove({ fs, dir, filepath: file });
    else await git.add({ fs, dir, filepath: file });
    staged++;
  }
  if (!staged) throw new Error('Keine Änderungen zum Committen.');
  return git.commit({ fs, dir, message, author: author(settings) });
}

async function pull(dir, settings) {
  const ref = await git.currentBranch({ fs, dir });
  await git.pull({
    fs, http, dir, ref, remote: 'origin', singleBranch: true,
    author: author(settings), onAuth: authFor(settings),
  });
}

async function push(dir, settings) {
  const ref = await git.currentBranch({ fs, dir });
  const res = await git.push({ fs, http, dir, remote: 'origin', ref, onAuth: authFor(settings) });
  if (!res.ok) throw new Error(`Push fehlgeschlagen: ${JSON.stringify(res.refs)}`);
}

module.exports = { status, init, setRemote, clone, commitAll, pull, push };
