/* CD-01 Product Information: one shared panel for main, admin and Clinician Home.
 *
 * The facts come from product-info-data.js, which the page loads with itself, so the panel opens and reopens after
 * the network is gone; only the server build check needs GET /api/version, and its failure reads Unverified instead
 * of a quiet agreement. Every string is set with textContent: a config value is data, never markup. The panel
 * writes nothing, asks for no confirmation and leaves the page's selection, draft and dictation alone. It is
 * built on open and removed on close, so the page's own tables and headings are the same as before while it is
 * closed. A trigger is any element with data-product-info.
 */
(function (global) {
  'use strict';
  const doc = global.document;
  const STYLE_ID = 'kpi-style';
  const VERSION_TIMEOUT_MS = 8000;
  const HEX40 = /^[0-9a-f]{40}$/;
  const HEX64 = /^[0-9a-f]{64}$/;
  const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const CSS = `
dialog.kpi-dialog { width: min(980px, calc(100vw - 24px)); max-height: calc(100vh - 24px); padding: 0; overflow: hidden;
  border: 1px solid #29405d; border-radius: 10px; background: #101b2a; color: #eef4ff; box-shadow: 0 20px 70px #000b;
  font: 13px/1.5 system-ui, sans-serif; }
dialog.kpi-dialog::backdrop { background: #000a; }
dialog.kpi-dialog .kpi-shell { display: flex; flex-direction: column; max-height: calc(100vh - 26px); }
dialog.kpi-dialog .kpi-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #29405d; }
dialog.kpi-dialog .kpi-head h2 { flex: 1; margin: 0; font-size: 16px; }
dialog.kpi-dialog .kpi-body { overflow: auto; padding: 12px 16px 16px; }
dialog.kpi-dialog .kpi-intro { margin: 0 0 10px; color: #a9b9cc; }
dialog.kpi-dialog h3 { margin: 14px 0 6px; font-size: 14px; }
dialog.kpi-dialog table { width: 100%; border-collapse: collapse; table-layout: fixed; }
dialog.kpi-dialog th, dialog.kpi-dialog td { padding: 6px 8px; border-bottom: 1px solid #22364f; text-align: left;
  vertical-align: top; overflow-wrap: anywhere; white-space: normal; }
dialog.kpi-dialog th { position: static; background: #142237; color: #b9c9dc; font-size: 12px; }
dialog.kpi-dialog col.kpi-item { width: 22%; } dialog.kpi-dialog col.kpi-state { width: 14%; }
dialog.kpi-dialog col.kpi-basis { width: 20%; }
dialog.kpi-dialog .kpi-status { display: inline-block; border: 1px solid #56607a; border-radius: 999px; padding: 0 8px;
  font-size: 12px; font-weight: 700; color: #dde3ee; }
dialog.kpi-dialog .kpi-status[data-status="confirmed"], dialog.kpi-dialog .kpi-status[data-status="match"] {
  border-color: #3f8a5f; background: #16442d; color: #b8f0cf; }
dialog.kpi-dialog .kpi-status[data-status="mismatch"] { border-color: #7c343e; background: #3c1b23; color: #ffd9dd; }
dialog.kpi-dialog .kpi-value { font-weight: 650; }
dialog.kpi-dialog .kpi-note { color: #a9b9cc; }
dialog.kpi-dialog .kpi-detail { margin: 2px 0 0; color: #c8d5e6; }
dialog.kpi-dialog .kpi-notices { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 0; padding: 0; list-style: none; }
dialog.kpi-dialog a { color: #9cc3ff; }
dialog.kpi-dialog button { min-height: 28px; border: 1px solid #3c5b80; border-radius: 7px; background: #19304b;
  color: #eef4ff; padding: 4px 11px; font: inherit; cursor: pointer; }
dialog.kpi-dialog :focus-visible { outline: 2px solid #9cc3ff; outline-offset: 2px; }
`;

  let current = null;   // {dialog, trigger, seq}
  let sequence = 0;

  function el(tag, attrs, text) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** GET /api/version as this panel reads it: anything outside the public build facts is not a server answer. */
  function parseVersion(body) {
    if (!body || typeof body !== 'object' || body.schema !== 1) return null;
    const build = body.build, version = body.productVersion;
    if (typeof body.factsDigest !== 'string' || !HEX64.test(body.factsDigest)) return null;
    if (!build || typeof build !== 'object' || !version || typeof version !== 'object') return null;
    if (build.revision !== null && !(typeof build.revision === 'string' && HEX40.test(build.revision))) return null;
    if (build.tag !== null && !(typeof build.tag === 'string' && TAG.test(build.tag))) return null;
    if (typeof version.status !== 'string' || !(version.value === null || typeof version.value === 'string')) return null;
    return { factsDigest: body.factsDigest, revision: build.revision, tag: build.tag,
      productVersion: { status: version.status, value: version.value } };
  }

  /** The build commit the deployment stamped on this page (proxy/15-kin-config.envsh); null when it stamped none.
   * The page files come from a checkout, not an image, so this is their only build identity. */
  function pageRevision() {
    const meta = doc.querySelector('meta[name="kin-build-revision"]');
    const value = meta ? meta.getAttribute('content') : null;
    return value && HEX40.test(value) ? value : null;
  }

  /** The page's embedded facts and stamped commit against the server's. Unknown is never reported as the same build:
   * product facts can agree across code builds, so two known commits must also agree, and one known commit beside an
   * unknown one cannot be confirmed either way. */
  function compareBuild(local, server, page) {
    if (!server) return { status: 'unverified', label: 'Unverified',
      note: '서버 빌드 정보를 확인하지 못했습니다. 이 표의 값은 이 페이지에 내장된 제품 정보입니다.' };
    const same = server.factsDigest === local.factsDigest
      && server.productVersion.status === local.productVersion.status
      && server.productVersion.value === local.productVersion.value;
    if (!same) return { status: 'mismatch', label: 'Mismatch',
      note: `이 화면과 서버의 제품 정보가 서로 다른 빌드입니다(화면 ${local.factsDigest.slice(0, 12)}, 서버 `
        + `${server.factsDigest.slice(0, 12)}). 페이지를 새로 고친 뒤에도 같으면 관리자에게 알려 주십시오.` };
    if (page && server.revision && page !== server.revision) return { status: 'mismatch', label: 'Mismatch',
      note: `이 화면과 서버가 서로 다른 빌드입니다(화면 커밋 ${page.slice(0, 12)}, 서버 커밋 ${server.revision.slice(0, 12)}). `
        + '페이지를 새로 고친 뒤에도 같으면 관리자에게 알려 주십시오.' };
    if (!page !== !server.revision) return { status: 'unverified', label: 'Unverified',
      note: `${page ? '서버' : '이 화면'}에 빌드 커밋이 없어 같은 빌드인지 확인할 수 없습니다. 제품 정보는 서로 같습니다.` };
    if (page) return { status: 'match', label: 'Match',
      note: `이 화면과 서버가 같은 빌드입니다(커밋 ${page.slice(0, 12)}, 제품 정보 ${local.factsDigest.slice(0, 12)}).` };
    return { status: 'match', label: 'Match',
      note: `이 화면과 서버가 같은 제품 정보 빌드를 사용합니다(${local.factsDigest.slice(0, 12)}). 화면과 서버 모두 빌드 커밋이 없습니다.` };
  }

  function serverRows(server, check) {
    const pending = check.status === 'checking';
    const known = !pending && server;
    return [
      { id: 'build.revision', label: 'Server Build', basis: '디지털의료제품법 제22조제4호',
        status: known && server.revision ? 'confirmed' : pending ? 'checking' : 'unverified',
        statusLabel: known && server.revision ? 'Confirmed' : pending ? 'Checking' : 'Unverified',
        value: known ? server.revision : null,
        note: pending ? '서버 빌드 정보를 확인하는 중입니다.'
          : !server ? '서버 빌드 정보를 확인하지 못했습니다.'
          : server.revision ? '서버 API가 빌드된 저장소 커밋입니다. 출시 버전이나 제조번호가 아닙니다.'
          : '빌드 식별 없음: 서버가 커밋 SHA 없이 빌드되었습니다(개발 빌드).' },
      { id: 'build.tag', label: 'Build Tag', basis: '디지털의료제품법 제22조제4호',
        status: known && server.tag ? 'confirmed' : pending ? 'checking' : known ? 'not_applicable' : 'unverified',
        statusLabel: known && server.tag ? 'Confirmed' : pending ? 'Checking' : known ? 'None' : 'Unverified',
        value: known ? server.tag : null,
        note: pending ? '서버 빌드 정보를 확인하는 중입니다.'
          : !server ? '서버 빌드 정보를 확인하지 못했습니다.'
          : server.tag ? '이 빌드의 커밋을 직접 가리키는 태그입니다.'
          : '해당 빌드 태그 없음: 이 빌드의 커밋을 직접 가리키는 태그가 없습니다.' },
      { id: 'build.check', label: 'Build Check', basis: '화면·서버 제품 정보 일치',
        status: check.status, statusLabel: check.label, value: null, note: check.note },
    ];
  }

  function rowNode(row) {
    const tr = el('tr', { 'data-row': row.id });
    tr.append(el('td', {}, row.label));
    const state = el('td');
    state.append(el('span', { class: 'kpi-status', 'data-status': row.status }, row.statusLabel));
    tr.append(state);
    const detail = el('td');
    if (row.value !== null && row.value !== undefined) detail.append(el('div', { class: 'kpi-value' }, row.value));
    for (const item of row.details || []) detail.append(el('p', { class: 'kpi-detail' }, `${item.label}: ${item.value}`));
    if (row.href) {
      const line = el('div');
      line.append(el('a', { href: row.href, target: '_blank', rel: 'noopener' }, 'Open Document'));
      detail.append(line);
    }
    detail.append(el('div', { class: 'kpi-note' }, row.note));
    tr.append(detail);
    tr.append(el('td', {}, row.basis));
    return tr;
  }

  function tableNode(title, rows) {
    const id = 'kpi-' + title.toLowerCase().replace(/[^a-z]+/g, '-');
    const section = el('section', { 'aria-labelledby': id });
    section.append(el('h3', { id }, title));
    const table = el('table', { 'data-section': title });
    const cols = el('colgroup');
    for (const name of ['kpi-item', 'kpi-state', 'kpi-detail-col', 'kpi-basis']) cols.append(el('col', { class: name }));
    table.append(cols);
    const head = el('thead'), tr = el('tr');
    for (const name of ['Item', 'Status', 'Detail', 'Basis']) tr.append(el('th', { scope: 'col' }, name));
    head.append(tr);
    const body = el('tbody');
    for (const row of rows) body.append(rowNode(row));
    table.append(head, body);
    section.append(table);
    return section;
  }

  function versionSection(data, server, check) {
    const rows = data.rows.filter((row) => row.section === 'Version').concat(serverRows(server, check));
    return tableNode('Version', rows);
  }

  function build(data) {
    const dialog = el('dialog', { class: 'kpi-dialog', id: 'product-info-dialog', 'aria-labelledby': 'product-info-title' });
    const shell = el('div', { class: 'kpi-shell' });
    const head = el('div', { class: 'kpi-head' });
    head.append(el('h2', { id: 'product-info-title' }, 'Product Information'));
    const close = el('button', { type: 'button', id: 'product-info-close', title: '제품 정보를 닫고 하던 화면으로 돌아갑니다.' }, 'Close');
    close.addEventListener('click', () => api.close());
    head.append(close);
    const body = el('div', { class: 'kpi-body' });
    body.append(el('p', { class: 'kpi-intro' }, '이 제품의 표시·첨부 정보입니다. ‘발급 전’·‘확정 전’ 항목은 아직 정해지지 않은 값이며, '
      + '이 화면이 인허가 요건의 충족을 뜻하지 않습니다.'));
    for (const section of data.sections) {
      if (section === 'Version') { body.append(el('div', { 'data-version-slot': '' })); continue; }
      body.append(tableNode(section, data.rows.filter((row) => row.section === section)));
    }
    const notices = el('section', { 'aria-labelledby': 'kpi-notices' });
    notices.append(el('h3', { id: 'kpi-notices' }, 'Notices'));
    const list = el('ul', { class: 'kpi-notices' });
    for (const notice of data.notices) {
      const item = el('li');
      item.append(el('a', { href: notice.href, target: '_blank', rel: 'noopener', 'data-notice': notice.id }, notice.label));
      list.append(item);
    }
    notices.append(list);
    notices.append(el('p', { class: 'kpi-note' }, '고지 문서는 새 탭에서 열리며 지금 화면의 작업은 그대로 남습니다.'));
    body.append(notices);
    shell.append(head, body);
    dialog.append(shell);
    return dialog;
  }

  function showVersion(dialog, data, server, check) {
    const slot = dialog.querySelector('[data-version-slot]');
    if (!slot) return;
    slot.replaceChildren(versionSection(data, server, check));
  }

  async function readVersion() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS) : null;
    try {
      const response = await global.fetch(new URL('/api/version', global.location.origin).href,
        { credentials: 'same-origin', cache: 'no-store', signal: controller ? controller.signal : undefined });
      if (!response.ok) return null;
      return parseVersion(await response.json());
    } catch (_) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function injectStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const style = el('style', { id: STYLE_ID });
    style.textContent = CSS;
    doc.head.append(style);
  }

  const api = {
    parseVersion,
    compareBuild,
    open(trigger) {
      const data = global.KinProductInfoData;
      if (current) { current.dialog.querySelector('#product-info-close').focus(); return; }
      if (!data) return;
      injectStyle();
      const dialog = build(data);
      const seq = ++sequence;
      current = { dialog, trigger: trigger || doc.activeElement, seq };
      // dialog.close() fires its close event in a later task, after a quick reopen may already have made another
      // panel current; an event acts only on the panel whose dialog sent it.
      const own = () => !!current && current.dialog === dialog;
      dialog.addEventListener('close', () => { if (own()) api.close(); });
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (own()) api.close(); });
      showVersion(dialog, data, null, { status: 'checking', label: 'Checking', note: '서버 빌드 정보를 확인하는 중입니다.' });
      doc.body.append(dialog);
      dialog.showModal();
      dialog.querySelector('#product-info-close').focus();
      readVersion().then((server) => {
        // A late answer belongs to the panel that asked; a closed or reopened panel ignores it.
        if (!current || current.seq !== seq) return;
        showVersion(dialog, data, server, compareBuild(data, server, pageRevision()));
      });
    },
    close() {
      const open = current;
      if (!open) return;
      current = null;
      if (open.dialog.open) open.dialog.close();
      open.dialog.remove();
      const trigger = open.trigger;
      if (trigger && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus();
    },
    isOpen() { return !!current; },
  };

  function bind() {
    for (const trigger of doc.querySelectorAll('[data-product-info]')) {
      if (trigger.dataset.productInfoBound) continue;
      trigger.dataset.productInfoBound = '1';
      trigger.addEventListener('click', (event) => { event.preventDefault(); api.open(trigger); });
      // A non-button trigger (the main menu bar items are divs) still opens from the keyboard.
      if (trigger.tagName !== 'BUTTON') trigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); api.open(trigger); }
      });
    }
  }

  global.KinProductInfo = api;
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})(window);
