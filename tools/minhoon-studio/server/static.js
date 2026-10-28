'use strict';
// The mirror: serves the product front-end straight from the studio sandbox (the git checkout the chat edits), the
// pinned OHIF build, and the studio's own UI. Paths match the product's nginx so the screens run unchanged.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { mimeOf, safeJoin, send } = require('./util');

// The same cross-origin isolation the product's /worklist/ and the Orthanc OHIF plugin send: named popup handles
// survive navigation only inside one browsing context group, and OHIF's workers want SharedArrayBuffer.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// What the Orthanc OHIF plugin appends to the configured app-config (captured from the synthetic stack, 24.12.0).
const OHIF_DATASOURCE_SUFFIX = `
window.config.routerBasename = '/ohif/';
window.config.dataSources = [
  {
    friendlyName: 'Orthanc DICOMweb',
    namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
    sourceName: 'dicomweb',
    configuration: {
      name: 'orthanc',
      wadoUriRoot: '../dicom-web',
      qidoRoot: '../dicom-web',
      wadoRoot: '../dicom-web',
      qidoSupportsIncludeField: false,
      supportsReject: false,
      imageRendering: 'wadors',
      thumbnailRendering: 'wadors',
      enableStudyLazyLoad: true,
      supportsFuzzyMatching: false,
      supportsWildcard: true,
      staticWado: true,
      singlepart: 'bulkdata,pdf,video',
      acceptHeader: [ 'multipart/related; type=application/octet-stream; transfer-syntax=*']
    }
  }
];
window.config.defaultDataSourceName = 'dicomweb';
`;

// nginx's sub_filter on the OHIF index (proxy/nginx.conf.template): KIN title and icons instead of OHIF's.
const OHIF_INDEX_REWRITES = [
  ['<meta name="application-name" content="OHIF Viewer"/>', '<meta name="application-name" content="KIN 판독 뷰어"/>'],
  ['<meta name="apple-mobile-web-app-title" content="@ohif/app"/>', '<meta name="apple-mobile-web-app-title" content="KIN 판독 뷰어"/>'],
  ['<link rel="shortcut icon" href="./assets/favicon.ico"/>', ''],
  ['<link rel="icon" type="image/png" sizes="16x16" href="./assets/favicon-16x16.png"/>', ''],
  ['<link rel="icon" type="image/png" sizes="32x32" href="./assets/favicon-32x32.png"/>',
    '<link rel="icon" type="image/svg+xml" href="/kin-brand/kin-emblem-j1.svg"/><link rel="icon" type="image/png" sizes="32x32" href="/kin-brand/kin-favicon-32.png"/>'],
  ['<title>OHIF Viewer</title>', '<title>판독 뷰어 — KOREA IMAGING NETWORK (Studio)</title>'],
];

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|wasm|manifest\+json|xml)|image\/svg)/;

class StaticServer {
  // previewRoot(req): the folder to serve the product front-end from for this request (a suggestion's preview copy
  // while this browser previews it), or null for the sandbox.
  constructor({ sandbox, ohifDist, uiDir, previewRoot = () => null }) {
    this.sandbox = sandbox;
    this.previewRoot = previewRoot;
    this.ohifDist = ohifDist;
    this.uiDir = uiDir;
    this.gzipCache = new Map(); // file -> {key, data}
    this.gzipBytes = 0;
  }

  // Returns true when the request was handled.
  handle(req, res, url) {
    const p = url.pathname;
    const product = () => this.previewRoot(req) || this.sandbox;
    if (p.startsWith('/worklist/')) return this.file(req, res, safeJoin(path.join(product(), 'worklist-v0'), p.slice('/worklist/'.length)), { fresh: true });
    if (p.startsWith('/kin-brand/')) return this.file(req, res, safeJoin(path.join(product(), 'proxy/branding'), p.slice('/kin-brand/'.length)), { fresh: true });
    if (p === '/ohif/manifest.json') return this.file(req, res, path.join(product(), 'proxy/branding/viewer-manifest.json'), { fresh: true, type: 'application/manifest+json' });
    if (p === '/ohif/app-config.js') return this.appConfig(req, res, product());
    if (p === '/ohif' || p.startsWith('/ohif/')) return this.ohif(req, res, p);
    if (p.startsWith('/studio/')) return this.file(req, res, safeJoin(this.uiDir, p.slice('/studio/'.length)), { fresh: true });
    return false;
  }

  appConfig(req, res, root) {
    const file = path.join(root, 'config/ohif.js');
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { send(res, 404, 'config/ohif.js missing in sandbox', ISOLATION); return true; }
    this.respond(req, res, Buffer.from(body + '\n' + OHIF_DATASOURCE_SUFFIX), 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
    return true;
  }

  ohif(req, res, p) {
    const sub = p.replace(/^\/ohif\/?/, '');
    let file = sub ? safeJoin(this.ohifDist, sub) : null;
    const exists = file && fs.existsSync(file) && fs.statSync(file).isFile();
    // OHIF is a single-page app: /ohif/viewer?StudyInstanceUIDs=... is a client route served by index.html.
    if (!exists && (!sub || !path.extname(sub))) file = path.join(this.ohifDist, 'index.html');
    else if (!exists) { send(res, 404, 'not found', ISOLATION); return true; }
    if (path.basename(file) === 'index.html') {
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch { send(res, 503, 'Viewer — Prototype pending: OHIF build is not installed in this studio', ISOLATION); return true; }
      for (const [from, to] of OHIF_INDEX_REWRITES) html = html.split(from).join(to);
      this.respond(req, res, Buffer.from(html), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
      return true;
    }
    return this.file(req, res, file, { immutable: /\.[0-9a-f]{16,}\./.test(file) });
  }

  file(req, res, file, { fresh = false, immutable = false, type } = {}) {
    if (!file) { send(res, 400, 'bad path', ISOLATION); return true; }
    let stat;
    try { stat = fs.statSync(file); } catch { send(res, 404, 'not found', { ...ISOLATION, 'Content-Type': 'text/plain; charset=utf-8' }); return true; }
    if (stat.isDirectory()) { send(res, 404, 'not found', ISOLATION); return true; }
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    // Edited files must show on the next reload: revalidate every time (ETag makes that a cheap 304).
    const cache = fresh ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...ISOLATION, ETag: etag, 'Cache-Control': cache }); res.end(); return true; }
    const data = fs.readFileSync(file);
    this.respond(req, res, data, type || mimeOf(file), { ETag: etag, 'Cache-Control': cache }, `${file}|${etag}`);
    return true;
  }

  respond(req, res, data, type, headers, cacheKey) {
    const head = { ...ISOLATION, 'Content-Type': type, ...headers };
    if (req.method === 'HEAD') { res.writeHead(200, { ...head, 'Content-Length': data.length }); res.end(); return; }
    const gzip = data.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (!gzip) { send(res, 200, data, head); return; }
    let packed = cacheKey && this.gzipCache.get(cacheKey);
    if (!packed) {
      packed = zlib.gzipSync(data, { level: 6 });
      if (cacheKey) {
        this.gzipCache.set(cacheKey, packed); this.gzipBytes += packed.length;
        // Keep the cache bounded: drop oldest entries once it grows past ~96 MB.
        for (const [key, value] of this.gzipCache) {
          if (this.gzipBytes <= 96 * 1024 * 1024) break;
          this.gzipCache.delete(key); this.gzipBytes -= value.length;
        }
      }
    }
    send(res, 200, packed, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  }
}

module.exports = { StaticServer, ISOLATION, OHIF_DATASOURCE_SUFFIX };
