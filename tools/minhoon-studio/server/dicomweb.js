'use strict';
// Static DICOMweb for the studio viewer (decision D7, option 1): a handful of public CC BY TCIA studies, crawled once
// from a throwaway Orthanc (dev/build_dicomweb_store.py) and served from files. Each synthetic worklist study points
// at one stored image study through an alias UID; patient and study tags are rewritten to the synthetic identity so
// the viewer never shows a different patient from the worklist row (a mismatch there would itself be a safety bug).
const fs = require('fs');
const path = require('path');
const { send, readJsonFile } = require('./util');
const { ISOLATION } = require('./static');

class DicomWeb {
  constructor(storeDir) {
    this.dir = storeDir;
    this.routes = readJsonFile(path.join(storeDir, 'routes.json'), {});
    const studies = readJsonFile(path.join(storeDir, 'studies.json'), []);
    this.studies = new Map(studies.map(s => [s.studyUid, s]));
    this.cache = new Map();
  }

  available() { return this.studies.size > 0; }
  studyList() { return [...this.studies.values()]; }

  // dataset: { byAlias(uid) -> mock study | null, all() -> [mock studies] }
  handle(req, res, url, dataset, origin) {
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') { notSupported(res, req, p); return true; }
    if (p === '/dicom-web/studies' || p === '/dicom-web/studies/') return this.qido(res, url, dataset, origin), true;
    const m = p.match(/^\/dicom-web\/studies\/([0-9.]+)(\/.*)?$/);
    if (m) {
      const study = dataset.byAlias(m[1]);
      if (!study || !study.imageUid || !this.studies.has(study.imageUid)) { send(res, 404, '[]', { ...ISOLATION, 'Content-Type': 'application/dicom+json' }); return true; }
      return this.serve(req, res, `/dicom-web/studies/${study.imageUid}${m[2] || ''}`, study, origin);
    }
    const preview = p.match(/^\/instances\/([0-9a-f-]+)\/preview$/);
    if (preview) return this.serve(req, res, p, null, origin);
    notSupported(res, req, p);
    return true;
  }

  qido(res, url, dataset, origin) {
    const q = url.searchParams;
    const wanted = (q.get('StudyInstanceUID') || q.get('0020000D') || '').split(/[,\\]/).filter(Boolean);
    const patientId = q.get('PatientID') || q.get('00100020');
    const accession = q.get('AccessionNumber') || q.get('00080050');
    let list = dataset.all().filter(s => s.imageUid && this.studies.has(s.imageUid));
    if (wanted.length) list = list.filter(s => wanted.includes(s.uid));
    if (patientId) list = list.filter(s => wildcard(patientId, s.patient.id));
    if (accession) list = list.filter(s => wildcard(accession, s.acc));
    const offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 1000);
    const body = list.slice(offset, offset + limit).map(s => patch(JSON.parse(
      JSON.stringify(this.studies.get(s.imageUid).qido).split(s.imageUid).join(s.uid).split('{{ORIGIN}}').join(origin)), s));
    send(res, 200, JSON.stringify(body), { ...ISOLATION, 'Content-Type': 'application/dicom+json', 'Cache-Control': 'no-store' });
  }

  serve(req, res, realPath, study, origin) {
    const route = this.routes[realPath];
    if (!route) { send(res, 404, 'not in the studio image samples', { ...ISOLATION, 'Content-Type': 'text/plain; charset=utf-8' }); return true; }
    const file = path.join(this.dir, route.file);
    const json = /json/.test(route.type);
    if (!json) {
      const data = fs.readFileSync(file);
      res.writeHead(200, { ...ISOLATION, 'Content-Type': route.type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : data);
      return true;
    }
    const key = `${study ? study.uid : ''}|${realPath}|${origin}`;
    let body = this.cache.get(key);
    if (!body) {
      let text = fs.readFileSync(file, 'utf8').split('{{ORIGIN}}').join(origin);
      if (study) text = text.split(study.imageUid).join(study.uid);
      let value = JSON.parse(text);
      if (study) value = Array.isArray(value) ? value.map(item => patch(item, study)) : patch(value, study);
      body = Buffer.from(JSON.stringify(value));
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(key, body);
    }
    send(res, 200, body, { ...ISOLATION, 'Content-Type': route.type, 'Cache-Control': 'no-store' });
    return true;
  }
}

function wildcard(pattern, value) {
  const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(String(value || ''));
}

// Overwrite the identity tags with the synthetic study's values (only tags the object already carries, plus the
// patient name/id which every level must agree on).
function patch(item, study) {
  if (!item || typeof item !== 'object') return item;
  const set = (tag, vr, value, always = false) => {
    if (!always && !item[tag]) return;
    item[tag] = value === '' || value == null ? { vr } : { vr, Value: [value] };
  };
  set('00100010', 'PN', { Alphabetic: study.patient.dicomName }, true);
  set('00100020', 'LO', study.patient.id, true);
  set('00100030', 'DA', study.patient.birth.replace(/-/g, ''));
  set('00100040', 'CS', study.patient.sex);
  set('00101010', 'AS', ageAt(study.patient.birth, study.date));
  set('00080020', 'DA', study.date);
  set('00080050', 'SH', study.acc);
  set('00081030', 'LO', study.desc);
  set('00080080', 'LO', study.institutionName);
  return item;
}

// PatientAge (AS, e.g. "054Y") at the study date, so the overlay agrees with the synthetic birth date.
function ageAt(birth, studyDate) {
  const b = String(birth || '').replace(/-/g, ''), d = String(studyDate || '');
  if (!/^\d{8}$/.test(b) || !/^\d{8}$/.test(d)) return '';
  let years = Number(d.slice(0, 4)) - Number(b.slice(0, 4));
  if (d.slice(4) < b.slice(4)) years -= 1;
  return String(Math.max(0, years)).padStart(3, '0') + 'Y';
}

function notSupported(res, req, p) {
  send(res, 501, JSON.stringify({ error: 'STUDIO_NOT_SUPPORTED', message: '스튜디오에는 이 영상 요청의 가짜 응답이 없습니다.', method: req.method, path: p }),
    { ...ISOLATION, 'Content-Type': 'application/json; charset=utf-8', 'X-Studio-Mock': 'not-supported' });
}

module.exports = { DicomWeb };
