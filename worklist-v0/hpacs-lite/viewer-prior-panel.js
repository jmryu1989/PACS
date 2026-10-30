window.KinViewerPriorPanel = (() => {
  const messages = { loading: '불러오는 중…', 'no-study': '검사를 확인할 수 없습니다.',
    none: '현재 유효한 승인 판독문이 없습니다.' };
  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    parent?.append(node); return node;
  }
  function button(text, parent, action) {
    const node = element('button', text, parent); node.type = 'button'; node.onclick = action;
    // Native viewer image shortcuts must not consume a focused overlay button's
    // activation (in particular Space, whose browser click normally waits for keyup).
    node.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) node.click();
    };
    return node;
  }
  function status(host, value, retry) {
    const node = element('p', value.message || messages[value.state] || '', host); node.setAttribute('role', 'status');
    if (value.state === 'error') button('Retry', host, retry);
  }
  // Hosts and their lifetime belong to the viewer adapter; rendering here has
  // no workspace/editor access and never modifies an image assignment.
  function list(host, value, { openImages, openReport, retry, close }) {
    host.replaceChildren(); host.hidden = value.state === 'closed';
    if (host.hidden) return;
    host.setAttribute('aria-label', 'Studies'); host.setAttribute('role', 'region');
    button('Close', host, close);
    if (value.state !== 'ready') { status(host, value, retry); return; }
    const guidance = element('p', '왼쪽 클릭·Enter·Space는 영상, 오른쪽 클릭·Shift+F10·Report는 승인 판독문을 엽니다.', host);
    guidance.style.color = '#B4B4B4';
    const scroll = element('div', null, host); scroll.style.overflow = 'auto'; scroll.style.minHeight = '0';
    const table = element('table', null, scroll), header = element('tr', null, element('thead', null, table));
    for (const title of ['Comparison', 'Status', 'Modality', 'Study Date', 'Study Description', 'Report']) element('th', title, header);
    const body = element('tbody', null, table);
    for (const study of value.studies) {
      const row = element('tr', null, body);
      element('td', study.relation, row);
      element('td', ({ W: 'Awaiting Report', T: 'In Progress', P: 'Preliminary', A: 'Approved', H: 'On Hold' })[study.state?.rs] || 'Unverified', row);
      element('td', study.modality || 'Unknown', row);
      element('td', study.date || 'Unknown', row);
      const images = button(study.desc || study.uid, element('td', null, row), () => openImages(study.uid, images));
      images.title = [study.name, study.id, study.acc, study.uid].filter(Boolean).join(' | ');
      const report = button('Report', element('td', null, row), () => openReport(study.uid, report));
      row.onclick = event => { if (!event.target.closest('button')) openImages(study.uid, images); };
      row.oncontextmenu = event => { event.preventDefault(); openReport(study.uid, event.target.closest('button') || images); };
      row.onkeydown = event => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
          event.preventDefault(); event.stopPropagation(); openReport(study.uid, event.target.closest('button') || images);
        }
      };
    }
    if (!value.studies.some(study => study.relation === 'Prior')) element('p', '이 환자의 이전 날짜 검사가 없습니다.', host);
    if (value.message) {
      element('p', value.message, host).setAttribute('role', 'status');
      if (value.retryImageUid) button('Retry', host, () => openImages(value.retryImageUid));
    }
  }
  function report(host, value, { retry, close }) {
    host.replaceChildren(); host.hidden = value.state === 'closed';
    if (host.hidden) return;
    host.setAttribute('role', 'region'); host.setAttribute('aria-label', 'Previous Report');
    button('Close', host, close);
    element('h3', 'Previous Report', host);
    if (value.study) {
      const study = value.study;
      element('p', [study.name, study.id, study.date || 'Unknown', study.modality, study.desc, study.acc].filter(Boolean).join(' | '), host);
      element('p', study.uid, host);
    }
    if (value.state !== 'ready') { status(host, value, retry); return; }
    const report = value.report;
    element('p', ['Version ' + report.version, report.action === 'addendum' ? 'Addendum' : 'Approved',
      report.author || 'Unknown', report.at || 'Unknown'].join(' | '), host);
    for (const [title, text] of [['Findings', report.findings], ['Conclusion', report.conclusion], ['Recommendation', report.recommendation]]) {
      element('h4', title, host);
      const content = element('p', text ?? '', host); content.style.whiteSpace = 'pre-wrap'; content.style.overflowWrap = 'anywhere';
    }
  }
  return { list, report };
})();
