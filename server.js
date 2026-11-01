'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ROOT = __dirname;
const INDEX = path.join(ROOT, 'Index.html');
const DATA = path.join(ROOT, 'journal-data.json');
const CODE_FILE = path.join(ROOT, '.access-code.txt');
const PORT = Number(process.env.PORT || 8765);
let writeQueue = Promise.resolve();
let accessCode;
try {
  accessCode = fs.readFileSync(CODE_FILE, 'utf8').trim();
} catch (_) {
  accessCode = crypto.randomBytes(9).toString('hex');
  fs.writeFileSync(CODE_FILE, accessCode + '\n', { mode: 0o600 });
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    if (!value || !Array.isArray(value.data?.students) || !Array.isArray(value.data?.lessons)) throw new Error('invalid');
    return value;
  } catch (err) {
    if (err.code === 'ENOENT') return { revision: 0, data: { students: [], lessons: [] } };
    throw err;
  }
}
function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const pair = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const split = pair.indexOf(':');
    return pair.slice(0, split) === 'journal' && pair.slice(split + 1) === accessCode;
  } catch (_) { return false; }
}
function challenge(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="STEM journal on local Wi-Fi", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Введіть код доступу з вікна сервера.');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 3000000) { reject(new Error('Завеликий запит')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { reject(new Error('Некоректний JSON')); } });
    req.on('error', reject);
  });
}
function localAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) if (item.family === 'IPv4' && !item.internal) result.push(item.address);
  }
  return result;
}
const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return challenge(res);
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/Index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    try { return sendJson(res, 200, readState()); }
    catch (_) { return sendJson(res, 500, { error: 'Не вдалося прочитати файл журналу.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/save') {
    let input;
    try { input = await readBody(req); } catch (_) { return sendJson(res, 400, { error: 'Некоректні дані.' }); }
    const operation = writeQueue.then(() => {
      const current = readState();
      if (Number(input.expectedRevision) !== Number(current.revision)) return { status: 409, body: { ok: false, conflict: true, revision: current.revision } };
      if (!input.data || !Array.isArray(input.data.students) || !Array.isArray(input.data.lessons)) return { status: 400, body: { ok: false, error: 'Невірний формат журналу.' } };
      const next = { revision: current.revision + 1, data: input.data };
      const temp = DATA + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temp, DATA);
      return { status: 200, body: { ok: true, revision: next.revision } };
    });
    writeQueue = operation.then(() => undefined, () => undefined);
    try { const result = await operation; return sendJson(res, result.status, result.body); }
    catch (_) { return sendJson(res, 500, { error: 'Не вдалося зберегти журнал.' }); }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не знайдено.');
});
server.on('error', err => { console.error('Не вдалося запустити сервер:', err.message); process.exitCode = 1; });
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nЛокальний STEM-журнал працює. Залиште це вікно відкритим.');
  console.log('На цьому ноутбуці: http://localhost:' + PORT);
  for (const address of localAddresses()) console.log('На інших пристроях у цій Wi-Fi мережі: http://' + address + ':' + PORT);
  console.log('Ім’я користувача: journal');
  console.log('Код доступу: ' + accessCode);
  console.log('Дані зберігаються локально у journal-data.json. Зупинити сервер: Ctrl+C.\n');
});
