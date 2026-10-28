'use strict';
// The daily digest for the commander ("오늘 끝" or ~60 minutes idle): Minhoon's requests in his words, what changed
// (commits + patch), disagreements and forwarded questions, 501s the screens hit, timings and model usage.
// Written to data/public/digests/ — Minhoon can open the same file; nothing in it is hidden from him.
const fs = require('fs');
const path = require('path');
const { readJsonl, maskSecrets, today, writeJsonAtomic } = require('./util');

function pct(values, p) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

const sec = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}초` : '—');
const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

// A digest covers everything since the previous one (not a calendar day): a session that runs past midnight stays in
// one handoff with its commits. The file is named by the KST day it is written; a second one that day gets "-2", ...
// Digests are written one at a time (the "오늘 끝" button of both people and the idle timer share the same files).
const chains = new Map();
function writeDigest(options) {
  const key = path.resolve(options.dataDir);
  const run = (chains.get(key) || Promise.resolve()).then(() => writeDigestNow(options));
  chains.set(key, run.catch(() => {}));
  return run;
}

// activeJobs(): ids of chat jobs still queued or running. A request without an answer yet is "pending" and carried
// into the next digest, where it appears with its answer; one that is neither answered nor running was cut off
// (for example by a restart) and is reported as "interrupted".
async function writeDigestNow({ dataDir, sandbox, reason = 'manual', by = null, activeJobs = () => [] }) {
  const stateFile = path.join(dataDir, 'digest-state.json');
  const prev = readJsonFileSafe(stateFile);
  const since = prev.lastAt || '1970-01-01T00:00:00.000Z';
  const carried = new Set(prev.pending || []);
  const snapshotAt = new Date().toISOString();
  const active = new Set(activeJobs());
  const writtenAt = new Date().toISOString();
  // One revision for the log, patch, statistics and the next boundary, taken after writtenAt: an edit commits before it
  // logs its answer, so every answer up to writtenAt names a commit this revision contains. Edits and undos go on
  // meanwhile; reading HEAD again later could describe a newer (or a half-done undo's) revision than the patch.
  const head = await sandbox.publishedHead();
  const dir = path.join(dataDir, 'public', 'digests');
  fs.mkdirSync(dir, { recursive: true });
  let day = today();
  for (let n = 2; fs.existsSync(path.join(dir, `${day}.md`)); n++) day = `${today()}-${n}`;
  const upTo = e => e && e.t && e.t <= writtenAt;
  const inDay = e => upTo(e) && e.t > since;
  const chatAll = readJsonl(path.join(dataDir, 'chat.jsonl')).filter(upTo);
  const metricsAll = readJsonl(path.join(dataDir, 'metrics.jsonl')).filter(upTo);
  const usage = readJsonl(path.join(dataDir, 'usage.jsonl')).filter(inDay);
  const records = readJsonl(path.join(dataDir, 'public', 'records.jsonl')).filter(inDay);
  const missing = readJsonl(path.join(dataDir, 'missing.jsonl')).filter(inDay);
  const history = await sandbox.log(head);
  let log = history.filter(c => new Date(c.time).toISOString() > since);
  let sinceLast = null;
  if (prev.lastHead) {
    const fresh = await sandbox.git(['rev-list', `${prev.lastHead}..${head}`]);
    if (!fresh.code) {
      const shas = new Set(fresh.stdout.split('\n').map(s => s.trim()).filter(Boolean));
      log = history.filter(c => shas.has(c.sha));
      sinceLast = await sandbox.git(['diff', '--stat', `${prev.lastHead}..${head}`]).then(r => r.stdout);
    }
  }
  const reloadMetrics = metricsAll.filter(m => m.kind === 'reload-ready');
  const reloads = new Map(reloadMetrics.map(m => [m.jobId, m]));
  const edits = metricsAll.filter(m => m.kind !== 'reload-ready');
  const answersOf = new Map();
  for (const e of chatAll) if (e.jobId && e.role !== 'user') answersOf.set(e.jobId, [...(answersOf.get(e.jobId) || []), e]);

  // An applied edit leaves the active jobs before the mirror reports ready, so a handoff can be written in between.
  // A screen outcome that arrives after that handoff brings its request back once, marked reloadOnly: already counted
  // there, so only the reload result (a timeout, or a ready time for the statistics) is new.
  const readyBefore = new Set(reloadMetrics.filter(m => m.t <= since).map(m => m.jobId));
  const lateReady = new Set(reloadMetrics.filter(m => m.t > since && !readyBefore.has(m.jobId)).map(m => m.jobId));
  const asked = chatAll.filter(e => e.role === 'user' && (e.t > since || carried.has(e.jobId) || lateReady.has(e.jobId)));
  const requests = asked.map(u => {
    const answers = answersOf.get(u.jobId) || [];
    const last = answers[answers.length - 1] || {};
    const meta = last.meta || {};
    const metric = edits.find(m => m.jobId === u.jobId);
    const reload = reloads.get(u.jobId);
    const t = metric ? metric.timings : {};
    // A reload that never showed the screen is a failure to report, not a latency sample.
    const reloadTimedOut = !!reload && reload.readyKind === 'timeout';
    const reloadOk = reload && !reloadTimedOut && Number.isFinite(reload.reloadMs);
    const outcome = !answers.length ? (active.has(u.jobId) || u.t >= snapshotAt ? 'pending' : 'interrupted')
      : meta.loginRequired ? 'login-required' : meta.failed ? 'failed'
        : meta.changed ? 'applied' : u.mode === 'ask' ? 'answered' : 'no-change';
    return {
      t: u.t, user: u.user, mode: u.mode, request: u.text, answer: last.text || '', jobId: u.jobId, outcome,
      carriedFromPrevious: u.t <= since, reloadOnly: u.t <= since && !carried.has(u.jobId),
      sha: meta.sha, files: meta.files,
      totalToReloadSentMs: t.totalToReloadSentMs, claudeMs: t.claudeMs, buildMs: t.buildMs,
      lastEditToReloadSentMs: t.lastEditToReloadSentMs, reloadMs: reloadOk ? reload.reloadMs : null, reloadTimedOut,
      editToReadyMs: Number.isFinite(t.lastEditToReloadSentMs) && reloadOk ? t.lastEditToReloadSentMs + reload.reloadMs : null,
    };
  });
  const pending = requests.filter(r => r.outcome === 'pending').map(r => r.jobId);
  const counted = requests.filter(r => !r.reloadOnly);
  const lateReloads = requests.filter(r => r.reloadOnly);
  const applied = requests.filter(r => r.outcome === 'applied');
  const tokens = usage.reduce((acc, u) => {
    const x = u.usage || {};
    acc.input += x.input_tokens || 0; acc.output += x.output_tokens || 0;
    acc.cacheRead += x.cache_read_input_tokens || 0; acc.cacheWrite += x.cache_creation_input_tokens || 0;
    acc.cost += u.costUsdReported || 0; if (u.model) acc.models.add(u.model);
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set() });
  const suggestions = suggestionRows(readJsonl(path.join(dataDir, 'public', 'suggestions.jsonl')).filter(upTo), since);
  const missingCount = new Map();
  for (const m of missing) { const k = `${m.method} ${m.path.replace(/\/[0-9.]{8,}(?=\/|$)/g, '/:uid')}`; missingCount.set(k, (missingCount.get(k) || 0) + 1); }
  const patch = await sandbox.diffSinceBase(head);
  const stat = await sandbox.diffStatSinceBase(head);
  const base = await sandbox.base();
  const branch = await sandbox.branch();
  if (sinceLast === null) sinceLast = stat;

  const summary = {
    day, reason, by, since, writtenAt, branch, base, head, previousHead: prev.lastHead || null,
    counts: { requests: counted.length, edits: counted.filter(r => r.mode === 'edit').length, applied: counted.filter(r => r.outcome === 'applied').length,
      questions: counted.filter(r => r.mode === 'ask').length, pending: pending.length,
      failed: counted.filter(r => ['failed', 'interrupted', 'login-required'].includes(r.outcome)).length,
      reloadTimeouts: requests.filter(r => r.reloadTimedOut).length, lateReloads: lateReloads.length,
      reverts: log.filter(c => c.trailers['Studio-Kind'] === 'revert').length,
      disagreements: records.filter(r => r.kind === 'disagreement').length, forwarded: records.filter(r => r.kind === 'question').length,
      suggestions: suggestions.filter(s => s.prepared).length, suggestionsApplied: suggestions.filter(s => s.answer === 'applied').length },
    suggestionTiming: {
      prepareP50Ms: pct(suggestions.map(s => s.prepareMs), 50),
      previewClickToReadyP50Ms: pct(suggestions.flatMap(s => s.previewMs), 50), previewClickToReadyP90Ms: pct(suggestions.flatMap(s => s.previewMs), 90),
    },
    suggestions,
    timing: {
      editToReadyP50Ms: pct(applied.map(r => r.editToReadyMs), 50), editToReadyP90Ms: pct(applied.map(r => r.editToReadyMs), 90),
      totalP50Ms: pct(applied.map(r => r.totalToReloadSentMs), 50), totalP90Ms: pct(applied.map(r => r.totalToReloadSentMs), 90),
    },
    usage: { models: [...tokens.models], inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite, costUsdReportedByCli: Math.round(tokens.cost * 10000) / 10000,
      costNote: 'CLI가 보고한 API 단가 환산값이다. 구독(sdij) 계정 사용이라 실제 청구액이 아니다.' },
    requests, records, commits: log, missing: [...missingCount].map(([k, n]) => ({ request: k, count: n })),
  };

  const lines = [];
  lines.push(`# 민훈 스튜디오 하루 인계 — ${day}`, '');
  lines.push(`- 작성: ${summary.writtenAt} (${reason}${by ? `, ${by}` : ''}) · 범위: 지난 인계(${since === '1970-01-01T00:00:00.000Z' ? '처음' : since}) 이후`);
  lines.push(`- 샌드박스: \`${branch}\` · base \`${base.slice(0, 12)}\` · head \`${head.slice(0, 12)}\``);
  lines.push(`- 요청 ${summary.counts.requests}건 (바꾸기 ${summary.counts.edits}, 적용 ${summary.counts.applied}, 물어보기 ${summary.counts.questions}, 실패·중단 ${summary.counts.failed}, 진행 중 ${summary.counts.pending}) · 되돌림 ${summary.counts.reverts} · 이견 ${summary.counts.disagreements} · 넘긴 질문 ${summary.counts.forwarded}`);
  lines.push(`- 반영 시간(마지막 수정→거울 준비) p50 ${sec(summary.timing.editToReadyP50Ms)} · p90 ${sec(summary.timing.editToReadyP90Ms)}; 요청→새로고침 신호 p50 ${sec(summary.timing.totalP50Ms)} · p90 ${sec(summary.timing.totalP90Ms)}${summary.counts.reloadTimeouts ? ` · 화면 준비 시간 초과 ${summary.counts.reloadTimeouts}건(시간 통계에서 뺌)` : ''}`);
  if (suggestions.length) lines.push(`- 스튜디오가 먼저 한 제안 ${summary.counts.suggestions}건 · 적용 ${summary.counts.suggestionsApplied}건 (아래 "먼저 한 제안과 답")`);
  if (pending.length) lines.push(`- 진행 중이던 요청 ${pending.length}건은 답이 나오면 다음 인계에 다시 실립니다.`);
  if (lateReloads.length) lines.push(`- 지난 인계 뒤에 화면 준비 결과가 도착한 요청 ${lateReloads.length}건을 표에 다시 실었습니다(요청 건수는 지난 인계에 셌음).`);
  lines.push(`- 사용량: ${summary.usage.models.join(', ') || '—'} · 입력 ${tokens.input} / 출력 ${tokens.output} / 캐시 읽기 ${tokens.cacheRead} / 캐시 쓰기 ${tokens.cacheWrite} 토큰 · CLI 환산 $${summary.usage.costUsdReportedByCli} (${summary.usage.costNote})`, '');
  lines.push('## 요청 (원문)', '', '| 시각 | 누구 | 탭 | 요청 | 결과 | 커밋 | 반영 |', '|---|---|---|---|---|---|---|');
  for (const r of requests) {
    const ready = r.reloadTimedOut ? '화면 준비 시간 초과' : sec(r.editToReadyMs);
    lines.push(`| ${r.carriedFromPrevious ? r.t.slice(0, 10) + ' ' : ''}${r.t.slice(11, 19)} | ${cell(r.user)} | ${r.mode === 'ask' ? '물어보기' : '바꾸기'} | ${cell(r.request)} | ${r.outcome} | ${r.sha ? '`' + r.sha.slice(0, 8) + '`' : ''} | ${r.mode === 'edit' && r.outcome === 'applied' ? `${ready} (전체 ${sec(r.totalToReloadSentMs)})` : ''} |`);
  }
  lines.push('', '## 스튜디오 답 (요약 원문)', '');
  for (const r of requests) lines.push(`- **${r.t.slice(11, 19)} ${r.user}** — ${cell(r.request).slice(0, 200)}`, `  - ${cell(r.answer).slice(0, 1200)}`);
  lines.push('', '## 이견 (비판·거절)', '');
  const disagreements = records.filter(r => r.kind === 'disagreement');
  if (!disagreements.length) lines.push('없음');
  else {
    lines.push('| 시각 | 누구 | 방아쇠 | 요청 | 스튜디오 근거 | 대안 | 처리 | 근거 위치 |', '|---|---|---|---|---|---|---|---|');
    for (const d of disagreements) lines.push(`| ${d.t.slice(11, 19)} | ${cell(d.user)} | ${cell(d.trigger)} | ${cell(d.request)} | ${cell(d.objection)} | ${cell(d.alternative)} | ${cell(d.action)} | ${cell(d.evidence)} |`);
  }
  lines.push('', '## 스튜디오가 먼저 한 제안과 답', '');
  if (!suggestions.length) lines.push('없음');
  else {
    lines.push(`준비 시간 p50 ${sec(summary.suggestionTiming.prepareP50Ms)} · 미리보기 클릭→화면 p50 ${sec(summary.suggestionTiming.previewClickToReadyP50Ms)} · p90 ${sec(summary.suggestionTiming.previewClickToReadyP90Ms)}`, '');
    lines.push('| 준비 | 제안 | 근거 | 준비 시간 | 보여 줌 | 미리보기(클릭→화면) | 답 | 누가 |', '|---|---|---|---|---|---|---|---|');
    for (const s of suggestions) {
      lines.push(`| ${(s.preparedAt || s.t || '').slice(11, 19)} | ${cell(s.title || `(${s.outcome})`)} | ${cell((s.grounds || []).map(g => `${g.kind} ${g.ref}${g.quote ? ` "${g.quote}"` : ''}`).join(' / '))} | ${sec(s.prepareMs)} | ${s.shownAt ? s.shownAt.slice(11, 19) : '—'} | ${s.previewMs.length ? s.previewMs.map(sec).join(', ') : '—'} | ${cell(s.answerLabel)} | ${cell(s.by || '')} |`);
    }
  }
  lines.push('', '## 지휘자/정모 님께 넘긴 질문', '');
  const questions = records.filter(r => r.kind === 'question');
  if (!questions.length) lines.push('없음');
  for (const q of questions) lines.push(`- (${q.t.slice(11, 19)}, ${q.user}, 대상 ${q.for || '?'}) ${cell(q.question)} — ${cell(q.why || '')}`);
  lines.push('', '## 커밋 (지난 인계 이후)', '');
  if (!log.length) lines.push('없음');
  for (const c of log) lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.trailers['Studio-Kind'] || ''} ${cell(c.subject)}${c.reverted ? ' (뒤에 되돌림)' : ''} — ${c.files.join(', ')}`);
  lines.push('', '## 모의 응답이 없어 501이 난 요청', '');
  if (!summary.missing.length) lines.push('없음');
  for (const m of summary.missing) lines.push(`- ${m.request} ×${m.count}`);
  lines.push('', '## 지난 인계 이후 변경', '', '```', sinceLast.trim() || '(변경 없음)', '```');
  lines.push('', '## 브랜치 전체 변경 (base 대비)', '', '```', stat.trim() || '(변경 없음)', '```', '', `전체 patch: \`${day}.patch\` (base 대비 누적).`, '');
  lines.push('_스튜디오 시안은 제품 이력이 아니다. 지휘자가 필요한 diff를 골라 실제 백엔드 기준으로 다시 검토·시험한다(D2·D3)._');

  fs.writeFileSync(path.join(dir, `${day}.md`), maskSecrets(lines.join('\n')) + '\n');
  writeJsonAtomic(path.join(dir, `${day}.json`), JSON.parse(maskSecrets(JSON.stringify(summary))));
  fs.writeFileSync(path.join(dir, `${day}.patch`), patch);
  writeJsonAtomic(stateFile, { lastAt: writtenAt, lastHead: head, lastDay: day, pending });
  return { day, file: path.join(dir, `${day}.md`), summary };
}

// One row per suggestion with any event since the last handoff (prepared, shown, previewed, answered, set aside).
const ANSWER_LABELS = { applied: '적용', declined: '됐어요', skipped: '다른 제안', stale: '화면이 바뀌어 버림', failed: '만들기 실패', none: '근거 있는 제안 없음', interrupted: '재시작에 끊김' };
function suggestionRows(events, since) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const rows = [];
  for (const [id, list] of byId) {
    if (!list.some(e => e.t > since)) continue;
    const prepared = list.find(e => e.event === 'prepared');
    const closed = [...list].reverse().find(e => ANSWER_LABELS[e.event]);
    const shown = list.find(e => e.event === 'shown');
    const row = {
      id, t: list[0].t, title: (prepared && prepared.title) || (closed && closed.title) || null, prepared: !!prepared,
      preparedAt: prepared ? prepared.t : null, kind: prepared ? prepared.kind : null, why: prepared ? prepared.why : null,
      grounds: prepared ? prepared.grounds : [], request: prepared ? prepared.request : null, files: prepared ? prepared.files : [],
      prepareMs: prepared ? prepared.prepareMs : (closed ? closed.prepareMs ?? null : null), model: prepared ? prepared.model : null,
      shownAt: shown ? shown.t : null, previews: list.filter(e => e.event === 'previewed').length,
      previewMs: list.filter(e => e.event === 'preview-ready' && e.readyKind !== 'timeout' && Number.isFinite(e.clickToReadyMs)).map(e => e.clickToReadyMs),
      previewTimeouts: list.filter(e => e.event === 'preview-ready' && e.readyKind === 'timeout').length,
      outcome: closed ? closed.event : 'open', by: closed ? closed.by || null : null, via: closed ? closed.via || null : null,
      sha: closed ? closed.sha || null : null, error: closed ? closed.error || null : null,
    };
    row.answerLabel = row.outcome === 'open' ? '아직 답 없음' : `${ANSWER_LABELS[row.outcome]}${row.via === 'edit' ? ' (화면이 바뀌어 다시 만듦)' : ''}${row.error ? ` (${row.error})` : ''}`;
    rows.push(row);
  }
  return rows;
}

function readJsonFileSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function listDigests(dataDir) {
  const dir = path.join(dataDir, 'public', 'digests');
  if (!fs.existsSync(dir)) return [];
  // Numeric order, so "-10" comes after "-9" the same day.
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).reverse();
}

// The names writeDigest produces ("YYYY-MM-DD", then "-2", "-3", ... without a limit the same day); the read route
// accepts exactly these.
const DIGEST_ID = /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/;

module.exports = { writeDigest, listDigests, DIGEST_ID };
