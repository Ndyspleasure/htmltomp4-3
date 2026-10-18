#!/usr/bin/env node
/**
 * Minimal static server for the production build that applies the headers from vercel.json, so E2E
 * tests exercise the same CSP/sandbox headers that Vercel serves. Only the header features used in
 * this repository's vercel.json are supported (regex-style `source` patterns).
 *
 * Usage: node scripts/serve-dist.mjs [port]
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('dist');
const port = Number(process.argv[2] ?? process.env.PORT ?? 4321);
const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
const rules = (config.headers ?? []).map((rule) => ({
  pattern: new RegExp(`^${rule.source}$`),
  headers: rule.headers,
}));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(pathname) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = [join(root, safe), join(root, safe, 'index.html'), join(root, `${safe}.html`)];
  for (const candidate of candidates) {
    if (candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  for (const rule of rules) {
    if (rule.pattern.test(url.pathname)) {
      for (const { key, value } of rule.headers) res.setHeader(key, value);
    }
  }
  const file = resolveFile(url.pathname);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', MIME['.html']);
    const notFound = join(root, '404.html');
    if (existsSync(notFound)) createReadStream(notFound).pipe(res);
    else res.end('Not found');
    return;
  }
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`Serving ${root} with vercel.json headers on http://localhost:${port}`);
});
