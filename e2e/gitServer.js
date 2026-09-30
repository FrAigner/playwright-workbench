// Minimal smart-HTTP git server (wraps `git http-backend`) so push/pull can be tested offline.
const http = require('http');
const { spawn } = require('child_process');

function startGitServer(projectRoot) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'tester',
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] || '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
      },
    });
    req.pipe(cgi.stdin);
    let buf = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', (chunk) => {
      if (headersDone) return res.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      headersDone = true;
      let statusCode = 200;
      for (const line of buf.slice(0, idx).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k.toLowerCase() === 'status') statusCode = parseInt(v.join(':'), 10);
        else res.setHeader(k, v.join(':').trim());
      }
      res.writeHead(statusCode);
      res.write(buf.slice(idx + 4));
    });
    cgi.on('close', () => res.end());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

module.exports = { startGitServer };
