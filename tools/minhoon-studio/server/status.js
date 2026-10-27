'use strict';
// 물어보기's grounding (decision D8): one status.json the commander publishes on a schedule. The studio only reads it.
// Everything in it is shown to Minhoon (owner 22:3x); only live secrets are masked on the way out.
const fs = require('fs');
const path = require('path');
const { maskSecrets, readJsonFile } = require('./util');

class StatusFeed {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'status.json');
  }

  read() { return readJsonFile(this.file, null); }

  view() {
    const status = this.read();
    if (!status) return { present: false, message: '현황 자료(status.json)가 아직 발행되지 않았습니다.' };
    const published = Date.parse(status.published_at || '');
    const next = Date.parse(status.next_publication || '');
    const now = Date.now();
    return {
      present: true,
      publishedAt: status.published_at || null,
      ageHours: Number.isFinite(published) ? Math.round((now - published) / 360e3) / 10 : null,
      overdue: Number.isFinite(next) ? now > next : null,
      status: JSON.parse(maskSecrets(JSON.stringify(status))),
    };
  }

  // Compact text for the 물어보기 prompt. The full file stays readable through the Read tool (--add-dir).
  summary() {
    const v = this.view();
    if (!v.present) return v.message;
    const head = `published_at=${v.publishedAt} (${v.ageHours ?? '?'}시간 전)` + (v.overdue ? ' — 다음 예정 발행 시각이 지났음(갱신 지연)' : '');
    let body = JSON.stringify(v.status);
    if (body.length > 24000) body = body.slice(0, 24000) + ` …(잘림: 전체는 ${path.basename(this.file)}를 Read로 읽을 것)`;
    return `${head}\n${body}`;
  }
}

module.exports = { StatusFeed };
