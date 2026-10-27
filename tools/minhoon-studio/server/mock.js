'use strict';
// The studio's mock PACS API. Synthetic data only (studio-mock/dataset.json in the sandbox) plus a persisted
// mock state (drafts, reports, versions, prefs) so a reload or a restart returns the same screen (decision D6).
// The reading workflow (worklist -> select -> draft/autosave -> Save/Approve/Prelim/Defer/Reset/Addendum ->
// Related Exam/Related Report -> history) follows the real API contract closely; other screens get enough to
// render and navigate. Every route without a mock answers 501 STUDIO_NOT_SUPPORTED — never a catch-all 200.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { send, sendJson, readJson, readJsonFile, writeJsonAtomic, today } = require('./util');

const ISO = () => new Date().toISOString();
const REVISION = /^([^:\s]+):(\d+)$/;
const ROLE_SETS = {
  radiologist: ['radiologist'],
  technician: ['technician'],
  clinician: ['clinician'],
  admin: ['admin'],
};

function uidFor(n) { return `2.25.20261027${String(n).padStart(4, '0')}`; }
function ymd(date) { return date.toISOString().slice(0, 10).replace(/-/g, ''); }
function kstDaysAgo(days) { return new Date(Date.parse(today() + 'T00:00:00Z') - days * 86400e3); }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function err(status, message, extra = {}) { return { status, body: { message, ...extra } }; }

class Mock {
  constructor({ dataDir, sandboxDir, dicomweb, onMissing }) {
    this.stateFile = path.join(dataDir, 'mock-state.json');
    this.datasetFile = path.join(sandboxDir, 'studio-mock/dataset.json');
    this.routesFile = path.join(sandboxDir, 'studio-mock/routes.json');
    this.dicomweb = dicomweb;
    this.onMissing = onMissing || (() => {});
    this.state = readJsonFile(this.stateFile, null);
    this.datasetStamp = null;
    this.load();
  }

  // ── dataset ─────────────────────────────────────────────────────────────────────────────────────────────
  load() {
    let stat = null;
    try { stat = fs.statSync(this.datasetFile); } catch { /* no dataset: empty worklist */ }
    const stamp = stat ? `${stat.size}-${stat.mtimeMs}` : 'none';
    if (stamp === this.datasetStamp) return;
    this.datasetStamp = stamp;
    const seed = readJsonFile(this.datasetFile, { institutions: [], colleagues: [], patients: [], studies: [], templates: [], orders: [] });
    this.seed = seed;
    const images = this.dicomweb ? this.dicomweb.studyList() : [];
    const imageFor = key => {
      if (!key) return null;
      const found = images.find(s => s.source && s.source.folder && s.source.folder.includes(key));
      return found || null;
    };
    const institutions = new Map((seed.institutions || []).map(i => [i.id, i]));
    const patients = new Map((seed.patients || []).map(p => [p.key, p]));
    this.studies = [];
    for (const s of seed.studies || []) {
      const p = patients.get(s.patient);
      if (!p) continue;
      const image = imageFor(s.image);
      const inst = institutions.get(s.institution || 'kin-center') || { id: s.institution || 'kin-center', name: s.institution || 'KIN 판독센터' };
      const date = kstDaysAgo(s.daysAgo || 0);
      this.studies.push({
        n: s.n, uid: uidFor(s.n), seed: s, imageUid: image ? image.studyUid : null, image,
        patient: { ...p, dicomName: p.name.replace(' ', '^') },
        date: ymd(date), acc: s.acc || '', modality: s.modality, desc: s.desc,
        institutionId: inst.id, institutionName: inst.name, tele: !!s.tele,
        count: image ? image.instanceCount : null, series: image ? image.seriesCount : null,
      });
    }
    this.studies.sort((a, b) => (a.uid < b.uid ? -1 : 1));
    this.byUid = new Map(this.studies.map(s => [s.uid, s]));
    if (!this.state || this.state.datasetStamp !== stamp) this.reset(stamp);
  }

  // Fresh mock state from the dataset. Called on first start, when the dataset file changes, or from 합성 자료 초기화.
  reset(stamp = this.datasetStamp) {
    const studies = {};
    for (const s of this.studies) {
      const seed = s.seed;
      const st = {
        rs: seed.rs || 'W', ss: seed.ss || 'Verified', em: seed.em || 'N', ts: 'none', matched: 'U', ward: seed.ward || '',
        reqHosp: s.institutionId === 'kin-center' ? 'KIN' : s.institutionId.toUpperCase(),
        institutionId: s.institutionId, teleInstitutionId: s.tele ? 'kin-center' : null,
        preDoc: seed.preDoc || null, preReviewer: seed.preReviewer || null, prelimHidden: false,
        repDoc: null, confirm: null, ov: null, orig: null, oid: null,
        holder: seed.holder || null, holdReason: seed.holdReason || null,
        version: 0, findings: '', conclusion: '', recommendation: '',
        draftEpoch: crypto.randomUUID(), versions: [], drafts: {}, techNotes: [],
      };
      if (seed.report && ['A', 'T', 'P'].includes(st.rs)) {
        const author = seed.report.author === 'SELF' ? 'minhoon@studio.invalid' : seed.report.author;
        const action = st.rs === 'A' ? 'approve' : st.rs === 'P' ? 'preliminary' : 'save';
        const at = new Date(kstDaysAgo(seed.daysAgo || 0).getTime() + 10 * 3600e3).toISOString();
        st.versions.push({ id: String(s.n * 100 + 1), uid: s.uid, version: 1, action, findings: seed.report.findings || '',
          conclusion: seed.report.conclusion || '', recommendation: seed.report.recommendation || '', reason: null, author, at, accessRef: `studio-${s.n}-1` });
        st.version = 1;
        st.findings = seed.report.findings || ''; st.conclusion = seed.report.conclusion || ''; st.recommendation = seed.report.recommendation || '';
        if (st.rs === 'A') { st.repDoc = author.split('@')[0]; st.confirm = at.slice(0, 10); }
      }
      studies[s.uid] = st;
    }
    const templates = (this.seed.templates || []).map((t, i) => ({ id: i + 1, owner: 'shared', ord: i + 1, createdAt: ISO(), recommendation: '', ...t }));
    this.state = { datasetStamp: stamp, createdAt: ISO(), studies, templates, nextTemplateId: templates.length + 1,
      filters: [], nextFilterId: 1, prefs: {}, roles: {}, sessions: {}, holds: {} };
    this.save();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => writeJsonAtomic(this.stateFile, this.state), 200);
  }

  flush() { clearTimeout(this.saveTimer); writeJsonAtomic(this.stateFile, this.state); }

  // ── identity: one synthetic member per studio person; the role is a studio switch ─────────────────────────
  role(user) { return this.state.roles[user] || 'radiologist'; }
  setRole(user, role) { if (!ROLE_SETS[role]) return false; this.state.roles[user] = role; this.save(); return true; }

  me(user, displayName, origin) {
    const counter = this.state.sessions[user] || 1;
    const actor = `${user}@studio.invalid`;
    return {
      sub: `studio-${user}`, actor, roles: ROLE_SETS[this.role(user)], institution: 'kin-center', kind: 'member', user: actor,
      displayName: `${String(displayName || user).toUpperCase()} (Studio)`, sessionId: `studio-${user}-${counter}`, issuer: `${origin}/auth/realms/kin`,
    };
  }

  owner(me) { return { institution: me.institution, sub: me.sub, author: me.actor }; }

  // ── worklist rows and the study state the client sees ────────────────────────────────────────────────────
  draftRow(st, me) { return st.drafts[me.sub] || { n: 0, present: false, snapshot: null, updatedAt: null }; }

  toClient(uid, me) {
    const st = this.state.studies[uid];
    const row = this.draftRow(st, me);
    const hold = this.state.holds[uid];
    const holder = hold && hold.until > Date.now() ? hold.holder : st.holder;
    return {
      rs: st.rs, ss: st.ss, em: st.em, ts: st.ts, matched: st.matched, ward: st.ward, reqHosp: st.reqHosp,
      // The seed's "REVIEWER" means "whoever is using the studio", so either person can try the P -> Approve path.
      institutionId: st.institutionId, teleInstitutionId: st.teleInstitutionId, preDoc: st.preDoc,
      preReviewer: st.preReviewer === 'REVIEWER' ? me.sub : st.preReviewer,
      prelimHidden: st.prelimHidden, repDoc: st.repDoc, confirm: st.confirm, ov: st.ov, orig: st.orig, oid: st.oid,
      holder: holder || null, holdReason: st.holdReason, version: st.version,
      findings: st.findings, conclusion: st.conclusion, recommendation: st.recommendation,
      draft: row.present && row.snapshot ? { findings: row.snapshot.findings, conclusion: row.snapshot.conclusion,
        recommendation: row.snapshot.recommendation, baseVersion: row.snapshot.baseVersion, at: row.updatedAt } : null,
      draftRevision: `${st.draftEpoch}:${row.n}`, draftEpoch: st.draftEpoch,
    };
  }

  row(s, me) {
    const st = this.state.studies[s.uid];
    const note = st.techNotes[st.techNotes.length - 1];
    return {
      uid: s.uid, techNote: { version: note ? note.version : 0, present: !!(note && note.text) },
      readerAssignment: { revision: 0, reader: null }, gatewayReceipt: null, orderIdentity: null,
      count: s.count, series: s.series, acc: s.acc, id: s.patient.id, sourcePatientKey: `${s.institutionId}|${s.patient.id}`,
      name: s.patient.name, birth: s.patient.birth.replace(/-/g, ''), date: s.date, sex: s.patient.sex, modality: s.modality,
      desc: s.desc, institutionName: s.institutionName, tele: s.tele, state: this.toClient(s.uid, me),
    };
  }

  envelope(uid, me, extra = {}) {
    const st = this.state.studies[uid];
    const row = this.draftRow(st, me);
    return { uid, owner: this.owner(me), revision: `${st.draftEpoch}:${row.n}`, present: !!row.present,
      snapshot: row.present ? row.snapshot : null, updatedAt: row.present ? row.updatedAt : null, ...extra };
  }

  // ── dispatcher ───────────────────────────────────────────────────────────────────────────────────────────
  async handle(req, res, url, ctx) {
    this.load();
    const method = req.method;
    const p = url.pathname;
    const me = this.me(ctx.user, ctx.displayName, ctx.origin);
    // Routes the chat added for new-feature prototypes come first (studio-mock/routes.json in the sandbox).
    const custom = this.customRoute(method, p);
    if (custom) {
      const body = substitute(custom.route.body, custom.params);
      sendJson(res, custom.route.status || 200, body === undefined ? {} : body, { 'X-Studio-Mock': 'prototype' });
      return;
    }
    let body = {};
    if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' || (method === 'DELETE' && Number(req.headers['content-length'] || 0) > 0)) {
      const type = req.headers['content-type'] || '';
      if (type.includes('json') || !type) { try { body = await readJson(req, 8 * 1024 * 1024); } catch (error) { sendJson(res, error.status || 400, { message: error.message }); return; } }
    }
    let out;
    try {
      out = this.route(method, p, url.searchParams, body, me, ctx);
    } catch (error) {
      out = err(500, `studio mock error: ${error.message}`);
    }
    if (!out) {
      this.onMissing({ method, path: p });
      sendJson(res, 501, { code: 'STUDIO_NOT_SUPPORTED', message: '스튜디오에는 이 요청의 가짜 응답이 아직 없습니다. 바꾸기에서 말하면 추가합니다.', method, path: p },
        { 'X-Studio-Mock': 'not-supported' });
      return;
    }
    if (out.redirect) { res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store' }); res.end(); return; }
    if (out.status === 204) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; }
    if (out.raw) { send(res, out.status || 200, out.raw, { 'Content-Type': out.type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return; }
    sendJson(res, out.status || 200, out.body, out.headers || {});
  }

  customRoute(method, p) {
    const routes = readJsonFile(this.routesFile, { routes: [] });
    for (const route of Array.isArray(routes.routes) ? routes.routes : []) {
      if (!route || (route.method || 'GET').toUpperCase() !== method || typeof route.path !== 'string') continue;
      const names = [];
      const re = new RegExp('^' + route.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
      const m = p.match(re);
      if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  // Returns {status, body} | {redirect} | null (null = not supported in studio).
  route(method, p, q, body, me, ctx) {
    const ok = value => ({ status: 200, body: value });
    const ownerPair = [me.institution, me.sub];
    let m;

    // ── identity / auth ──
    if (p === '/api/me' && method === 'GET') return ok(me);
    if (p === '/api/health') return ok({ status: 'ok', studio: true });
    if (p === '/api/auth/login' && method === 'GET') return { redirect: '/worklist/hpacs-lite/index.html' };
    if (p === '/api/auth/login' && method === 'POST') { this.state.sessions[ctx.user] = (this.state.sessions[ctx.user] || 1) + 1; this.save(); return ok({ location: '/worklist/hpacs-lite/index.html' }); }
    if (p === '/api/auth/logout' && method === 'POST') { this.state.sessions[ctx.user] = (this.state.sessions[ctx.user] || 1) + 1; this.save(); return { status: 204 }; }
    if (p === '/auth/realms/kin/.well-known/openid-configuration') {
      const base = `${ctx.origin}/auth/realms/kin`;
      return ok({ issuer: base, authorization_endpoint: `${base}/protocol/openid-connect/auth`, token_endpoint: `${base}/protocol/openid-connect/token`, studio: true });
    }

    // ── boot ──
    if (p === '/api/bootstrap' && method === 'GET') {
      const omit = q.get('states') === 'omit';
      const states = {};
      if (!omit) for (const s of this.visible(me)) states[s.uid] = this.toClient(s.uid, me);
      return ok({
        ...(omit ? { statesOmitted: true } : {}),
        dictation: { available: false, maxBytes: 1048576, timeoutMs: 120000, languagePin: 'auto', enginePin: 'studio', modelPin: 'studio' },
        me: { actor: me.actor, roles: me.roles, institution: me.institution, institutionName: 'KIN 판독센터' },
        filters: this.state.filters.filter(f => f.owner === me.actor),
        templates: this.state.templates,
        institutions: this.seed.institutions || [],
        states,
        orders: (this.seed.orders || []).map(o => ({ ...o, sched: String(o.sched || '').replace('TODAY', today()) })),
        serverTime: ISO(),
      });
    }
    if (p === '/api/colleagues') return ok((this.seed.colleagues || []).filter(c => c.id !== me.sub));
    if (p === '/api/studies' && method === 'GET') return ok(this.list(me, q));
    if (p === '/statistics') {
      const instances = this.studies.reduce((n, s) => n + (s.count || 0), 0);
      return ok({ CountInstances: instances, CountPatients: new Set(this.studies.map(s => s.patient.id)).size, CountSeries: this.studies.reduce((n, s) => n + (s.series || 0), 0),
        CountStudies: this.studies.length, TotalDiskSize: '330000000', TotalDiskSizeMB: 315, TotalUncompressedSize: '330000000', TotalUncompressedSizeMB: 315 });
    }
    if (p === '/system') return ok({ Name: 'KIN-Lab (Studio mock)', Version: '1.12.5', ApiVersion: 24, DicomAet: 'STUDIO', PluginsEnabled: true });
    if (p === '/api/study-access') return ok({ owner: ownerPair, revision: 0, restricted: false, startsAt: null, endsAt: null, windowOpen: true, denied: false, needsInstitutionReview: false });
    for (const [route, defaults] of Object.entries(PREFS)) {
      if (p !== route) continue;
      return this.pref(route, defaults, method, body, me, ownerPair);
    }
    if (p === '/api/hanging-protocols/site') {
      return this.pref(p, { value: null, canManageSite: false, updatedAt: null }, method, body, me, { institution: me.institution, subject: '' });
    }
    if (p === '/api/prefs' && method === 'GET') return ok({ filters: this.state.filters.filter(f => f.owner === me.actor), templates: this.state.templates });
    if (p === '/api/filter-folders' && method === 'GET') return ok({ owner: ownerPair, revision: 0, folders: [], shortcuts: [], filters: [] });
    if (p === '/api/shared-filters' && method === 'GET') return ok({ owner: ownerPair, revision: 0, canManage: false, updatedBy: '', updatedAt: null, folders: [], filters: [] });
    if (p === '/api/filters' && method === 'POST') {
      const filter = { ...body, id: this.state.nextFilterId++, owner: me.actor, createdAt: ISO() };
      this.state.filters.push(filter); this.save(); return ok(filter);
    }
    if ((m = p.match(/^\/api\/filters\/(\d+)$/)) && method === 'DELETE') {
      this.state.filters = this.state.filters.filter(f => !(f.id === Number(m[1]) && f.owner === me.actor)); this.save(); return ok({ ok: true });
    }
    if (p === '/api/templates' && method === 'POST') return this.saveTemplate(body, me);
    if ((m = p.match(/^\/api\/templates\/(\d+)$/)) && method === 'DELETE') {
      const before = this.state.templates.length;
      this.state.templates = this.state.templates.filter(t => t.id !== Number(m[1]));
      if (this.state.templates.length === before) return err(404, '상용구를 찾을 수 없습니다');
      this.save(); return ok({ ok: true });
    }
    if (p === '/api/critical-results' && method === 'GET') {
      return ok({ owner: ownerPair, view: q.get('view') || 'received', items: [], nextCursor: null, pending: 0 });
    }
    if (p === '/api/unassigned' && method === 'GET') return ok([]);
    if (p === '/api/questions' && method === 'GET') return ok({ owner: ownerPair, view: q.get('view') || 'inbox', items: [], nextCursor: null });
    if (p === '/api/image-requests' && method === 'GET') return ok({ owner: ownerPair, view: q.get('view') || 'queue', items: [], nextCursor: null });
    if (p === '/api/dicom/lookup' && method === 'POST') {
      const s = this.byUid.get(body.studyUid);
      const id = s && s.image && s.image.sopToOrthanc ? s.image.sopToOrthanc[body.sopUid] : null;
      return id ? ok({ id }) : err(404, '영상을 찾을 수 없습니다');
    }

    // ── clinician ──
    if (p === '/api/clinician/studies' && method === 'GET') return ok(this.clinicianList(me, q));
    if ((m = p.match(/^\/api\/clinician\/studies\/([0-9.]+)\/report$/)) && method === 'GET') {
      const s = this.study(m[1], me); if (!s) return err(404, '검사를 찾을 수 없습니다');
      const report = this.clinicianReport(s.uid, true);
      return ok({ uid: s.uid, report, keys: report.final ? [] : null });
    }
    if ((m = p.match(/^\/api\/clinician\/studies\/([0-9.]+)\/timeline$/)) && method === 'GET') return this.timeline(m[1], me, q);

    // ── admin ──
    if (p === '/api/admin/users' && method === 'GET') {
      const users = [
        { id: 'studio-minhoon', username: 'minhoon@studio.invalid', name: 'MINHOON', email: 'minhoon@studio.invalid', institution: 'kin-center', roles: ['radiologist'], approvalState: 'approved', enabled: true, version: 1, rosterUnconfirmed: false },
        ...(this.seed.colleagues || []).map((c, i) => ({ id: c.id, username: c.username, name: c.name, email: c.username, institution: 'kin-center', roles: ['radiologist'], approvalState: 'approved', enabled: true, version: 1, rosterUnconfirmed: false })),
        { id: 'studio-tech', username: 'tech.choi@studio.invalid', name: 'CHOI TECH', email: 'tech.choi@studio.invalid', institution: 'hallym', roles: ['technician'], approvalState: 'approved', enabled: true, version: 1, rosterUnconfirmed: false },
        { id: 'studio-pending', username: 'new.doctor@studio.invalid', name: 'NEW DOCTOR', email: 'new.doctor@studio.invalid', institution: 'hallym', roles: [], approvalState: 'pending', enabled: true, version: 1, rosterUnconfirmed: true },
      ];
      return ok({ page: Number(q.get('page') || 1), pageSize: 50, total: users.length, pendingCount: 1, users });
    }

    // ── per study ──
    if ((m = p.match(/^\/api\/studies\/([0-9.]+)(\/.*)?$/))) return this.studyRoute(method, m[1], m[2] || '', q, body, me);
    return null;
  }

  visible(me) {
    // A clinician sees approved/finished studies of the reading center too in the product; the studio keeps all rows.
    return this.studies;
  }

  study(uid, me) { return this.byUid.get(uid) || null; }

  list(me, q) {
    const rows = this.visible(me);
    const uids = q.get('uids');
    if (uids) {
      const wanted = new Set(uids.split(','));
      return { studies: rows.filter(s => wanted.has(s.uid)).map(s => this.row(s, me)), serverTime: ISO(), observedAt: ISO() };
    }
    const limit = Number(q.get('limit') || 0);
    const all = rows.map(s => this.row(s, me));
    if (!limit) return { studies: all, serverTime: ISO(), observedAt: ISO(), notObserved: [], identityIssues: [] };
    const offset = Number(q.get('after') || 0);
    const page = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    return {
      studies: page, serverTime: ISO(), observedAt: ISO(), notObserved: [],
      orderReconciliation: { source: 'engineering_only', orders: (this.seed.orders || []).map(o => ({ oid: o.oid, link: 'unlinked', accession: 'absent', candidates: [] })) },
      identityIssues: [],
      pagination: { owner: [me.institution, me.sub], next, total: all.length, offset, limit },
    };
  }

  clinicianReport(uid, withBody) {
    const st = this.state.studies[uid];
    const head = st.versions.find(v => v.version === st.version);
    const final = st.rs === 'A' && head && ['approve', 'addendum'].includes(head.action);
    if (!final) return { final: false, rs: ['W', 'T', 'P', 'H'].includes(st.rs) ? st.rs : null };
    const status = { final: true, rs: 'A', action: head.action, version: head.version, repDoc: st.repDoc, confirm: st.confirm };
    return withBody ? { ...status, findings: head.findings, conclusion: head.conclusion, recommendation: head.recommendation } : status;
  }

  clinicianRow(s, me) {
    const r = this.row(s, me);
    return { uid: r.uid, id: r.id, name: r.name, birth: r.birth, sex: r.sex, date: r.date, acc: r.acc, desc: r.desc, modality: r.modality,
      count: r.count, series: r.series, sourcePatientKey: r.sourcePatientKey, institutionName: r.institutionName, tele: r.tele,
      report: this.clinicianReport(s.uid, false) };
  }

  clinicianList(me, q) {
    const all = this.visible(me);
    const uids = q.get('uids');
    if (uids) { const wanted = new Set(uids.split(',')); return { studies: all.filter(s => wanted.has(s.uid)).map(s => this.clinicianRow(s, me)), serverTime: ISO() }; }
    const limit = Number(q.get('limit') || 100), offset = Number(q.get('after') || 0);
    const page = all.slice(offset, offset + limit).map(s => this.clinicianRow(s, me));
    return { studies: page, serverTime: ISO(), identityIssues: [],
      pagination: { next: offset + limit < all.length ? String(offset + limit) : null, total: all.length, offset, limit } };
  }

  timeline(uid, me, q) {
    const anchor = this.study(uid, me);
    if (!anchor) return err(404, '검사를 찾을 수 없습니다');
    const key = `${anchor.institutionId}|${anchor.patient.id}`;
    const members = this.visible(me).filter(s => `${s.institutionId}|${s.patient.id}` === key);
    const limit = Number(q.get('limit') || 0);
    if (!limit) return err(400, '타임라인은 limit(1~100)으로 쪽을 나눠 읽습니다');
    const offset = Number(q.get('after') || 0);
    const rows = members.slice(offset, offset + limit);
    const rel = (a, b) => (a && b ? (a === b ? 'match' : 'mismatch') : 'not_comparable');
    const allSame = members.length > 1 ? 'match' : 'not_comparable';
    return { status: 200, body: {
      uid, patientKey: key, identity: { conflict: false, birth: allSame, sex: allSame },
      studies: rows.map(s => ({ ...this.clinicianRow(s, me), identity: { birth: rel(anchor.patient.birth, s.patient.birth), sex: rel(anchor.patient.sex, s.patient.sex) } })),
      serverTime: ISO(), pagination: { next: offset + limit < members.length ? String(offset + limit) : null, total: members.length, offset, limit },
    } };
  }

  pref(route, defaults, method, body, me, owner) {
    const key = `${me.sub}|${route}`;
    const stored = this.state.prefs[key] || { revision: 0, value: {} };
    if (method === 'GET') return { status: 200, body: { owner, revision: stored.revision, ...defaults, ...stored.value } };
    if (method === 'PUT' || method === 'POST') {
      const value = { ...body }; delete value.revision; delete value.expectedRevision; delete value.owner;
      this.state.prefs[key] = { revision: stored.revision + 1, value: { ...stored.value, ...value, updatedAt: ISO() } };
      this.save();
      return { status: 200, body: { owner, revision: stored.revision + 1, ...defaults, ...this.state.prefs[key].value } };
    }
    if (method === 'DELETE') {
      delete this.state.prefs[key]; this.save();
      return { status: 200, body: { owner, revision: stored.revision + 1, ...defaults } };
    }
    return null;
  }

  saveTemplate(body, me) {
    if (!String(body.title || '').trim()) return err(400, '상용구 제목이 필요합니다');
    const fields = ['title', 'shortcut', 'modality', 'bodypart', 'findings', 'conclusion', 'recommendation', 'ord'];
    if (body.id) {
      const t = this.state.templates.find(x => x.id === Number(body.id));
      if (!t) return err(404, '상용구를 찾을 수 없습니다');
      for (const f of fields) if (body[f] !== undefined) t[f] = body[f];
      this.save(); return { status: 200, body: t };
    }
    const t = { id: this.state.nextTemplateId++, owner: me.actor, createdAt: ISO(), title: '', shortcut: '', modality: '', bodypart: '', findings: '', conclusion: '', recommendation: '', ord: this.state.templates.length + 1 };
    for (const f of fields) if (body[f] !== undefined) t[f] = body[f];
    this.state.templates.push(t); this.save();
    return { status: 200, body: t };
  }

  // ── per-study routes ─────────────────────────────────────────────────────────────────────────────────────
  studyRoute(method, uid, sub, q, body, me) {
    const s = this.study(uid, me);
    if (!s) return err(404, '검사를 찾을 수 없습니다');
    const st = this.state.studies[uid];
    const ok = value => ({ status: 200, body: value });
    const ownerPair = [me.institution, me.sub];
    let m;
    if (sub === '' && method === 'PATCH') {
      if (body.em === 'E' || body.em === 'N') st.em = body.em;
      this.save();
      return ok({ uid, state: this.toClient(uid, me) });
    }
    if (sub === '/draft' && method === 'GET') {
      const env = this.envelope(uid, me);
      const id = q.get('insertRequestId');
      if (id) {
        const receipt = (st.receipts || {})[id];
        env.relatedInsert = receipt ? { ...receipt, currentMatches: receipt.state === 'applied' && receipt.appliedRevision === env.revision }
          : { insertRequestId: id, result: 'unknown', state: null, requestHash: null, proposalHash: null, expectedRevision: null, appliedRevision: null, receiptRevision: null, currentMatches: false, discardable: false, reason: 'RECEIPT_ABSENT' };
      }
      return ok(env);
    }
    if (sub === '/report' && method === 'PUT') return this.saveDraft(uid, body, me);
    if (sub === '/draft' && method === 'DELETE') {
      const pre = this.precondition(uid, body, me); if (pre) return pre;
      const row = this.draftRow(st, me);
      st.drafts[me.sub] = { n: row.n + 1, present: false, snapshot: null, updatedAt: null };
      this.save();
      return ok(this.envelope(uid, me, { state: this.toClient(uid, me) }));
    }
    if (sub === '/report/commit' && method === 'POST') return this.commit(uid, body, me);
    if (sub === '/hold' && method === 'POST') {
      const hold = this.state.holds[uid];
      const other = (hold && hold.until > Date.now() && hold.holder !== me.actor) ? hold.holder : (st.holder && st.holder !== me.actor ? st.holder : null);
      if (other) return ok({ holder: other, mine: false, conflict: true });
      this.state.holds[uid] = { holder: me.actor, until: Date.now() + 5 * 60e3 };
      return ok({ holder: me.actor, mine: true, conflict: false });
    }
    if ((sub === '/release' || sub === '/release/force') && method === 'POST') {
      const hold = this.state.holds[uid];
      if (hold && (hold.holder === me.actor || sub === '/release/force')) delete this.state.holds[uid];
      if (sub === '/release/force') st.holder = null;
      this.save();
      return ok({ ok: true });
    }
    if (sub === '/report/versions' && method === 'GET') return ok([...st.versions].sort((a, b) => b.version - a.version));
    if ((m = sub.match(/^\/report\/versions\/(\d+)\/citations$/)) && method === 'GET') {
      const v = st.versions.find(x => x.version === Number(m[1]));
      if (!v) return err(404, '그 판이 없습니다');
      return ok({ version: v.version, actor: v.author, entries: [], accessRef: v.accessRef });
    }
    if (sub === '/report/citations' && method === 'GET') return ok({ version: st.version, head: [], draft: [], draftRevision: this.toClient(uid, me).draftRevision });
    if (sub === '/report/structure' && method === 'GET') return ok({ version: st.version, unknown: false, head: [], draft: [], draftRevision: this.toClient(uid, me).draftRevision });
    if (sub === '/clinical-context' && method === 'GET') return ok(this.clinicalContext(s, me));
    if (sub === '/questions' && method === 'GET') return ok({ owner: ownerPair, items: [] });
    if (sub === '/image-requests' && method === 'GET') return ok({ owner: ownerPair, items: [] });
    if (sub === '/critical-result-recipients' && method === 'GET') {
      return ok({ owner: ownerPair, uid, sendable: false, reason: 'NO_PINNABLE_SOURCE', source: null, recipients: [] });
    }
    if (sub === '/findings' && method === 'GET') return { status: 200, body: { items: [], nextCursor: null }, headers: { 'X-KIN-Finding-Schema': '2' } };
    if (sub === '/viewer-items' && method === 'GET') return ok({ items: [], nextCursor: null });
    if (sub === '/viewer-jobs' && method === 'GET') return ok({ jobs: [] });
    if (sub === '/viewer-context-events' && method === 'POST') return ok({ ok: true });
    if (sub === '/reader-assignment' && method === 'GET') return ok({ uid, revision: 0, reader: null });
    if (sub === '/tech-note' && method === 'GET') {
      const note = st.techNotes[st.techNotes.length - 1] || null;
      return ok({ uid, writable: true, note });
    }
    if (sub === '/tech-note' && method === 'POST') {
      const latest = st.techNotes[st.techNotes.length - 1];
      const version = latest ? latest.version : 0;
      if (Number(body.baseVersion) !== version) return err(409, '다른 저장이 먼저 있었습니다', { code: 'TECH_NOTE_CONFLICT', latestNote: latest || null });
      const note = { studyUid: uid, version: version + 1, text: String(body.text || ''), reason: String(body.reason || '').trim(), author: me.actor,
        createdAt: ISO(), attemptId: body.attemptId || null, isOwnAttempt: true };
      st.techNotes.push(note); this.save();
      return ok({ uid, writable: true, note, latestNote: note });
    }
    if (sub === '/tech-note/history' && method === 'GET') {
      const before = Number(q.get('before') || Infinity);
      return ok({ uid, items: st.techNotes.filter(n => n.version < before).sort((a, b) => b.version - a.version), nextCursor: null });
    }
    if (sub === '/report-preview' && method === 'GET') {
      const head = st.versions.find(v => v.version === st.version) || null;
      return ok({
        study: { uid, id: s.patient.id, name: s.patient.name, birth: s.patient.birth.replace(/-/g, ''), sex: s.patient.sex, date: s.date, acc: s.acc, desc: s.desc, modality: s.modality },
        actor: me.actor, canPreviewEditor: true,
        report: { version: st.version, rs: st.rs, action: head ? head.action : null, author: head ? head.author : null, repDoc: st.repDoc, confirm: st.confirm,
          findings: st.findings, conclusion: st.conclusion, recommendation: st.recommendation },
        keys: [],
      });
    }
    return null;
  }

  precondition(uid, body, me) {
    const st = this.state.studies[uid];
    const expected = REVISION.exec(String(body.expectedRevision || ''));
    if (!body.expectedOwner || !expected) return err(400, '초안 조건이 없습니다', { code: 'REPORT_DRAFT_PRECONDITION_REQUIRED' });
    const owner = body.expectedOwner;
    if (owner.sub !== me.sub || owner.author !== me.actor) return err(409, '초안 주인이 바뀌었습니다', { code: 'REPORT_DRAFT_OWNER_CHANGED' });
    const row = this.draftRow(st, me);
    if (expected[1] !== st.draftEpoch || Number(expected[2]) !== row.n) {
      return err(409, '다른 곳에서 이 초안이 먼저 저장되었습니다', { code: 'REPORT_DRAFT_CONFLICT', ...this.envelope(uid, me) });
    }
    return null;
  }

  heldByOther(uid, me) {
    const st = this.state.studies[uid];
    const hold = this.state.holds[uid];
    if (hold && hold.until > Date.now() && hold.holder !== me.actor) return hold.holder;
    if (st.holder && st.holder !== me.actor) return st.holder;
    return null;
  }

  saveDraft(uid, body, me) {
    const st = this.state.studies[uid];
    for (const key of ['findings', 'conclusion', 'recommendation']) if (typeof body[key] !== 'string') return err(400, `${key}가 없습니다`, { code: 'REPORT_DRAFT_PRECONDITION_REQUIRED' });
    if (!Number.isSafeInteger(body.baseVersion) || !Array.isArray(body.citationIds) || !Array.isArray(body.structureIds)) {
      return err(400, '초안 형식이 맞지 않습니다', { code: 'REPORT_DRAFT_PRECONDITION_INVALID' });
    }
    const ri = body.relatedInsert;
    if (ri && ri.intent === 'discard') return this.discardInsert(uid, body, me);
    const pre = this.precondition(uid, body, me);
    if (pre) return ri ? this.refuseInsert(uid, body, me, 'DRAFT_CONFLICT') : pre;
    const holder = this.heldByOther(uid, me);
    if (holder) return ri ? this.refuseInsert(uid, body, me, 'TARGET_HELD') : err(409, `${holder}님이 판독 중입니다`, { code: 'REPORT_HELD', holder });
    if (st.ss === 'Unverified' && st.em !== 'E') return ri ? this.refuseInsert(uid, body, me, 'TARGET_UNVERIFIED') : err(409, '검증 전(Unverified) 검사는 판독문을 쓸 수 없습니다');
    if (body.baseVersion > st.version) return err(400, '기준 판이 현재 판보다 큽니다');
    const row = this.draftRow(st, me);
    const empty = !body.findings && !body.conclusion && !body.recommendation;
    const snapshot = empty ? null : { findings: body.findings, conclusion: body.conclusion, recommendation: body.recommendation,
      baseVersion: body.baseVersion, citations: [...body.citationIds], structured: [...body.structureIds] };
    st.drafts[me.sub] = { n: row.n + 1, present: !empty, snapshot, updatedAt: empty ? null : ISO() };
    const env = this.envelope(uid, me);
    if (ri) {
      const hashes = insertHashes(body);
      const receipt = { insertRequestId: ri.insertRequestId, result: 'applied', state: 'applied', ...hashes,
        expectedRevision: body.expectedRevision, appliedRevision: env.revision, receiptRevision: 1, currentMatches: true, discardable: false, reason: null };
      st.receipts = st.receipts || {}; st.receipts[ri.insertRequestId] = receipt;
      env.relatedInsert = receipt;
    }
    if (body.insert) env.inserted = { cid: `studio-${Date.now()}` };
    if (body.structure) env.applied = { sid: `studio-${Date.now()}` };
    this.save();
    return { status: 200, body: env };
  }

  refuseInsert(uid, body, me, reason) {
    const st = this.state.studies[uid];
    const ri = body.relatedInsert;
    const receipt = { insertRequestId: ri.insertRequestId, result: 'refused', state: 'refused', ...insertHashes(body),
      expectedRevision: body.expectedRevision, appliedRevision: null, receiptRevision: 1, currentMatches: false, discardable: true, reason };
    st.receipts = st.receipts || {}; st.receipts[ri.insertRequestId] = receipt; this.save();
    return { status: 409, body: { code: 'RELATED_INSERT_REFUSED', message: `삽입하지 않았습니다 (${reason})`, ...this.envelope(uid, me), relatedInsert: receipt } };
  }

  discardInsert(uid, body, me) {
    const st = this.state.studies[uid];
    const ri = body.relatedInsert;
    const receipt = (st.receipts || {})[ri.insertRequestId];
    if (!receipt || receipt.state !== 'refused') return { status: 409, body: { code: 'RELATED_INSERT_NOT_DISCARDABLE', message: '버릴 수 있는 삽입이 아닙니다', ...this.envelope(uid, me) } };
    const done = { ...receipt, state: 'discarded', result: 'refused', discardable: false, currentMatches: false, reason: 'INSERT_DISCARDED', receiptRevision: receipt.receiptRevision + 1 };
    st.receipts[ri.insertRequestId] = done; this.save();
    return { status: 200, body: { ...this.envelope(uid, me), relatedInsert: done } };
  }

  commit(uid, body, me) {
    const st = this.state.studies[uid];
    const action = body.action;
    const actions = ['save', 'approve', 'addendum', 'reset', 'preliminary', 'defer'];
    if (!actions.includes(action)) return err(400, '알 수 없는 동작입니다');
    if (!Number.isSafeInteger(body.baseVersion)) return err(400, 'baseVersion이 필요합니다');
    const pre = this.precondition(uid, body, me); if (pre) return pre;
    const holder = this.heldByOther(uid, me);
    if (holder) return err(409, `${holder}님이 판독 중입니다`, { code: 'REPORT_HELD', holder });
    if (st.ss === 'Unverified' && st.em !== 'E') return err(409, '검증 전(Unverified) 검사는 판독할 수 없습니다');
    if (body.baseVersion !== st.version) {
      const head = st.versions.find(v => v.version === st.version);
      if (action === 'addendum' && head) {
        return err(409, '승인된 판독문이 바뀌었습니다', { code: 'REPORT_DRAFT_STALE', head: { version: head.version, updatedBy: head.author, findings: head.findings, conclusion: head.conclusion, recommendation: head.recommendation }, draftBaseVersion: body.baseVersion });
      }
      return err(409, `그 사이 ${head ? head.author : '다른 사용자'}가 v${st.version}을 저장했습니다. 내 글은 클립보드로 복사해 두고 새 판을 불러오세요.`);
    }
    const prev = st.rs;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const text = { findings: String(body.findings || ''), conclusion: String(body.conclusion || ''), recommendation: String(body.recommendation || '') };
    let next = prev;
    if (action === 'save') { if (prev === 'A') return err(400, '승인된 판독문은 Addendum으로만 고칠 수 있습니다'); next = prev === 'P' ? 'P' : 'T'; }
    if (action === 'approve') {
      if (prev === 'A') return err(400, '이미 승인되었습니다');
      if (prev === 'P' && st.preReviewer && st.preReviewer !== 'REVIEWER' && st.preReviewer !== me.sub) return err(403, '지정된 상급 판독의만 승인할 수 있습니다');
      if (prev === 'P' && st.preDoc === me.actor) return err(403, '작성자 자신은 예비 판독을 승인할 수 없습니다');
      next = 'A';
    }
    if (action === 'addendum') { if (prev !== 'A') return err(400, 'Addendum은 승인된 판독문에만 쓸 수 있습니다'); next = 'A'; }
    if (action === 'preliminary') {
      if (prev === 'A' || prev === 'P') return err(400, '이 상태에서는 Prelim을 할 수 없습니다');
      const reviewer = (this.seed.colleagues || []).find(c => c.id === body.reviewer);
      if (!reviewer || reviewer.id === me.sub) return err(400, '검토할 상급 판독의를 골라 주세요');
      next = 'P';
    }
    if (action === 'reset') { if (!reason) return err(400, '취소 사유가 필요합니다'); next = 'W'; }
    if (action === 'defer') {
      if (!reason) return err(400, '보류 사유가 필요합니다');
      if (!['W', 'T', 'H'].includes(prev)) return err(400, '이 상태에서는 Defer 할 수 없습니다');
      next = 'H';
    }
    let version = st.versions.reduce((max, v) => Math.max(max, v.version), 0);
    const at = ISO();
    const push = (act, t, why) => {
      version += 1;
      st.versions.push({ id: String(Date.now()) + version, uid, version, action: act, ...t, reason: why || null, author: me.actor, at, accessRef: `studio-${uid}-${version}` });
    };
    if (action === 'reset') {
      if (st.findings || st.conclusion || st.recommendation) push('discarded', { findings: st.findings, conclusion: st.conclusion, recommendation: st.recommendation }, reason);
      push('reset', { findings: '', conclusion: '', recommendation: '' }, reason);
      Object.assign(st, { findings: '', conclusion: '', recommendation: '', repDoc: null, confirm: null, preDoc: null, preReviewer: null });
    } else {
      push(action, text, reason || null);
      Object.assign(st, text);
    }
    st.version = version;
    st.rs = next;
    st.holder = null;
    st.holdReason = action === 'defer' ? reason : null;
    if (action === 'approve' || action === 'addendum') { st.repDoc = me.actor.split('@')[0]; st.confirm = today(); }
    if (action === 'preliminary') { st.preDoc = me.actor; st.preReviewer = body.reviewer; }
    delete this.state.holds[uid];
    const row = this.draftRow(st, me);
    st.drafts[me.sub] = { n: row.n + 1, present: false, snapshot: null, updatedAt: null };
    this.save();
    return { status: 200, body: { ...this.envelope(uid, me), state: this.toClient(uid, me), signature: null } };
  }

  clinicalContext(s, me) {
    const now = ISO();
    const st = this.state.studies[s.uid];
    const key = `${s.institutionId}|${s.patient.id}`;
    const others = this.visible(me).filter(o => o.uid !== s.uid && `${o.institutionId}|${o.patient.id}` === key);
    const access = s.tele ? 'tele' : 'owner';
    const priors = [];
    for (const o of others) {
      const ost = this.state.studies[o.uid];
      const head = ost.versions.find(v => v.version === ost.version);
      if (ost.rs === 'A' && head && ['approve', 'addendum'].includes(head.action)) {
        priors.push({ studyUid: o.uid, access, study: { date: o.date, modalities: o.modality, description: o.desc },
          identity: { birth: 'match', sex: 'match' },
          report: { version: head.version, action: head.action, findings: head.findings, conclusion: head.conclusion, recommendation: head.recommendation },
          provenance: { kind: 'kin.report-version', recordId: /^\d+$/.test(head.id) ? head.id : String(head.version), version: head.version, author: head.author, recordedAt: head.at, observedAt: now } });
      }
    }
    const history = others.map(o => {
      const ost = this.state.studies[o.uid];
      return { studyUid: o.uid, access, institutionName: s.institutionName, study: { date: o.date, modalities: o.modality, description: o.desc, accession: o.acc },
        reading: { rs: ost.rs, signed: ost.rs === 'A' && ost.version > 0, reportVersion: ost.version },
        identity: { birth: 'match', sex: 'match' },
        provenance: { kind: 'dicom.study+kin.study-state', recordId: o.uid, version: null, author: null, recordedAt: now, observedAt: now } };
    });
    const clinical = s.seed.clinical || {};
    const sop = s.image && s.image.sopToOrthanc ? Object.keys(s.image.sopToOrthanc)[0] : null;
    const tagValues = { '00321030': clinical.reason, '001021B0': clinical.history };
    const tagDefs = [['00321030', 'ReasonForStudy', 'LO'], ['00401002', 'ReasonForTheRequestedProcedure', 'LO'], ['001021B0', 'AdditionalPatientHistory', 'LT'],
      ['00081080', 'AdmittingDiagnosesDescription', 'LO'], ['00324000', 'StudyComments', 'LT']];
    const tags = sop ? tagDefs.filter(([tag]) => tagValues[tag]).map(([tag, keyword, vr]) => ({ tag, keyword, vr, value: tagValues[tag], note: null,
      provenance: { kind: 'dicom.instance-header', recordId: sop, version: null, author: null, recordedAt: null, observedAt: now } })) : [];
    const note = st.techNotes[st.techNotes.length - 1];
    const section = (state, items, label, extra = {}) => ({ state, reason: null, sourceLabel: label, observedAt: now, truncated: false, items, ...extra });
    return {
      schema: 'kin.clinical-context/1', uid: s.uid, observedAt: now, patientKey: key,
      anchor: { access, institutionName: s.institutionName, techNoteVersion: note ? note.version : 0 },
      identity: { conflict: false, birth: others.length ? 'match' : 'not_comparable', sex: others.length ? 'match' : 'not_comparable' },
      sections: {
        priorReports: section(priors.length ? 'present' : 'absent', priors.slice(0, 10), 'KIN signed report (head version)'),
        history: section(history.length ? 'present' : 'absent', history, 'DICOM study + KIN study state'),
        requestTags: sop ? section(tags.length ? 'present' : 'absent', tags, 'DICOM header (one original instance)', { checked: tagDefs.map(t => t[0]) })
          : { state: 'not_configured', reason: 'no_original_instance', sourceLabel: 'DICOM header (one original instance)', observedAt: now, truncated: false, items: [], checked: [] },
        techNote: note ? section('present', [{ version: note.version, hasText: !!note.text, provenance: { kind: 'kin.tech-note', recordId: `${s.uid}#${note.version}`, version: note.version, author: note.author, recordedAt: note.createdAt, observedAt: now } }], 'KIN Tech Note')
          : section('absent', [], 'KIN Tech Note'),
      },
    };
  }

  // Studio panel: a short description of the synthetic data for the chat and the status bar.
  describe() {
    return { studies: this.studies.length, patients: new Set(this.studies.map(s => s.patient.id)).size,
      withImages: this.studies.filter(s => s.imageUid).length, createdAt: this.state.createdAt };
  }

  // The revision lets the image server drop metadata it rewrote for an earlier version of the synthetic identities.
  dataset() {
    this.load();
    return { revision: this.datasetStamp, byAlias: uid => this.byUid.get(uid) || null, all: () => this.studies };
  }
}

// Owner-scoped preference documents: GET returns the stored value over these defaults; PUT stores and bumps the revision.
const PREFS = {
  '/api/workspace-layout': { layout: null, updatedAt: null },
  '/api/reading-appearance': { sizes: null },
  '/api/reading-preferences': { autoNote: null },
  '/api/workspace-shortcuts': { bindings: null, invalid: false, viewerSettings: null },
  '/api/worklist-columns': { columns: null, updatedAt: null },
  '/api/hanging-protocols': { value: null, updatedAt: null },
};

// The client's canonical related-insert hashes (report-draft-client.js insertHashes): same tuples, same JSON.
function insertHashes(request) {
  const r = request.relatedInsert, owner = request.expectedOwner, expected = REVISION.exec(request.expectedRevision) || [];
  const proposal = ['related-insert-proposal-v1', request.findings, request.conclusion, request.recommendation,
    request.baseVersion, [...request.citationIds].sort(), [...request.structureIds].sort()];
  const tuple = ['related-insert-v1', r.insertRequestId, owner.institution, owner.sub, owner.author, r.targetUid,
    expected[1], Number(expected[2]), r.source.uid, r.source.version, r.source.action,
    r.source.parts.map(p => [p.field, p.start, p.end]), r.targetBaseVersion, r.seedKind, r.section, r.position,
    r.offset, r.text, r.selectionSeq, r.contentRevision, r.sourceGeneration, proposal];
  return { requestHash: hash(tuple), proposalHash: hash(proposal) };
}

// ":param" placeholders in a prototype route body are replaced with the matched path values.
function substitute(value, params) {
  if (typeof value === 'string') return value.replace(/:(\w+)/g, (all, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : all));
  if (Array.isArray(value)) return value.map(v => substitute(v, params));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, params)]));
  return value;
}

module.exports = { Mock, insertHashes, uidFor };
