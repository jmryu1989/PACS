

    function srTree(dataset, expected) {
      const classes = ['11', '22', '33', '34'].map(n => '1.2.840.10008.5.1.4.1.1.88.' + n);
      const first = tag => dataset?.[tag]?.Value?.[0];
      if (!dataset || first('0020000D') !== expected.study || first('0020000E') !== expected.series ||
          first('00080018') !== expected.sop || first('00080016') !== expected.sopClass ||
          !classes.includes(first('00080016')) || first('00080060') !== 'SR' || first('0040A040') !== 'CONTAINER')
        throw new Error('SR 문서 식별 또는 지원 형식이 일치하지 않습니다.');
      const labels = {'0040A730':'Content Sequence', '0040A040':'Value Type', '0040A010':'Relationship Type',
        '0040A043':'Concept Name', '0040A160':'Text Value', '0040A168':'Concept Code', '0040A300':'Measured Value',
        '0040A30A':'Numeric Value', '004008EA':'Measurement Units', '00080100':'Code Value', '00080102':'Coding Scheme',
        '00080104':'Code Meaning', '0040A120':'DateTime', '0040A121':'Date', '0040A122':'Time', '0040A123':'Person Name',
        '0040A124':'UID', '00081199':'Referenced SOP', '00081150':'Referenced SOP Class', '00081155':'Referenced SOP Instance',
        '00081160':'Referenced Frame', '00700022':'Graphic Data', '00700023':'Graphic Type', '0040DB73':'Referenced Content Item'};
      let nodes = 0, chars = 0;
      const plain = v => v && typeof v === 'object' && !Array.isArray(v);
      const text = v => {
        if (typeof v !== 'string' && typeof v !== 'number' && v !== null) throw new Error('지원하지 않는 SR 값입니다.');
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('잘못된 SR 숫자입니다.');
        const s = v === null ? '(빈 값)' : String(v); chars += s.length;
        if (++nodes > 2000 || chars > 200000) throw new Error('SR 원문 표시 상한을 초과했습니다.');
        return s;
      };
      function walk(ds, depth) {
        if (++nodes > 2000) throw new Error('SR 원문 표시 상한을 초과했습니다.');
        if (!plain(ds) || depth > 32) throw new Error('SR 원문 구조 또는 깊이가 지원 범위를 벗어납니다.');
        return Object.entries(ds).map(([tag, attr]) => {
          if (++nodes > 2000) throw new Error('SR 원문 표시 상한을 초과했습니다.');
          if (!/^[0-9A-F]{8}$/.test(tag) || !plain(attr) || !/^[A-Z]{2}$/.test(attr.vr)) throw new Error('잘못된 DICOM JSON 구조입니다.');
          // External/binary values must never be silently omitted or fetched as links.
          if ('BulkDataURI' in attr || 'InlineBinary' in attr) throw new Error('외부 또는 바이너리 값을 포함한 SR은 지원하지 않습니다.');
          if (Object.keys(attr).some(k => !['vr','Value'].includes(k)) || attr.Value !== undefined && !Array.isArray(attr.Value)) throw new Error('잘못된 DICOM JSON 값입니다.');
          const values = (attr.Value || []).map(v => attr.vr === 'SQ' ? walk(v, depth + 1) : attr.vr === 'PN' && plain(v)
            ? Object.entries(v).map(([k, value]) => text(k) + ': ' + text(value)).join(' / ') : text(v));
          return { tag, label: labels[tag] || '', vr: attr.vr, values };
        });
      }
      return walk(dataset, 0);
    }

    // SR reader UI: a document belongs to one explicit viewing selection and request generation.
    const srStyle = document.createElement('style'); srStyle.textContent = '#sr-dialog::backdrop{background:#0009}#sr-dialog button,#sr-dialog select{background:#1b2b42;color:#dae6f6;border:1px solid #6683aa;border-radius:4px;padding:5px;font:inherit}#sr-dialog button:disabled{opacity:.45}#sr-tree details{margin:6px 0}#sr-tree summary{cursor:pointer;color:#9fceff}'; document.head.append(srStyle);
    const srDialog = document.createElement('dialog'); srDialog.id = 'sr-dialog';
    srDialog.setAttribute('aria-labelledby','sr-title');
    srDialog.style.cssText = 'width:min(900px,94vw);max-height:88vh;background:#141c29;color:#dae6f6;border:1px solid #6683aa;border-radius:8px;padding:16px;overflow:auto';
    srDialog.innerHTML = `<h2 id="sr-title" style="margin:0 0 8px">외부 SR 원문 · 읽기 전용</h2><div id="sr-context" style="overflow-wrap:anywhere"></div>
      <p>외부 문서의 값과 참조를 그대로 표시합니다. 판독 저장·확정과 별개입니다.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button id="sr-reload" type="button">Refresh List</button><button id="sr-close" type="button">Close</button></div>
      <p><label>SR 시리즈 <select id="sr-series" style="max-width:100%"></select></label></p>
      <p><label>SR 문서 <select id="sr-document" style="max-width:100%"></select></label> <button id="sr-read" type="button" disabled>Read Source</button></p>
      <p id="sr-status" role="status" aria-live="polite"></p><div id="sr-tree" style="overflow-wrap:anywhere;white-space:pre-wrap"></div>`;
    document.body.append(srDialog);
    let srEpoch = 0, srAbort = null, srUid = null, srSeries = [], srDocuments = [];
    const srVal = (ds, tag) => String(ds?.[tag]?.Value?.[0] ?? '');
    const srValidUid = value => typeof value === 'string' && /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value) && value.length <= 64;
    function srClear() {
      ++srEpoch; srAbort?.abort(); srAbort = null;
      $('#sr-tree').replaceChildren(); $('#sr-status').textContent = ''; $('#sr-read').disabled = true;
    }
    function closeSR() { srClear(); srUid = null; srSeries = []; srDocuments = []; $('#sr-context').textContent = ''; $('#sr-series').replaceChildren(); $('#sr-document').replaceChildren(); if (srDialog.open) srDialog.close(); }
    async function srLoad(path, consume) {
      srClear(); const epoch = srEpoch, uid = srUid, controller = srAbort = new AbortController();
      const at = work.capture("document");
      const active = () => epoch === srEpoch && uid === srUid && uid === viewingUid() && srDialog.open;
      // 이 읽기의 답·실패·끝이 화면에 닿는 자리는 모두 이 읽기를 시작한 문맥과 이 창의 세대를 함께 지난다. 받은 조각은 이
      // 읽기만의 것이라 쌓는 데는 관문이 없고, 다 받아 해석한 뒤 화면에 쓰는 한 자리에서 지난다.
      const apply = effect => work.commit(at, () => { if (active()) effect(); });
      $('#sr-status').textContent = '불러오는 중…';
      try {
        const res = await transport.request(path, { context: at, signal: controller.signal, cache: 'no-store',
          headers: { Accept: 'application/dicom+json' }, read: 'stream', deadlineMs: 15000 });
        if (!res.ok) {
          if ([401,403].includes(res.status)) apply(() => {
            srSeries = []; srDocuments = []; $('#sr-series').replaceChildren(); $('#sr-document').replaceChildren();
          });
          throw new Error('문서를 읽을 수 없습니다 (HTTP ' + res.status + '). 로그인과 접근 권한을 확인하세요.');
        }
        const chunks = []; let total = 0;
        while (true) {
          const { done, value } = await res.stream.read(); if (done) break;
          total += value.byteLength;
          if (total > 2 * 1024 * 1024) { await res.stream.cancel(); throw new Error('SR 응답이 2 MiB 상한을 초과했습니다.'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!Array.isArray(data)) throw new Error('잘못된 SR 목록 또는 문서입니다.');
        apply(() => { consume(data); $('#sr-status').textContent = data.length ? '불러왔습니다. 지원 범위의 원문 트리이며 임상 해석을 추가하지 않습니다.' : 'SR 항목이 없습니다.'; });
      } catch (e) {
        apply(() => { $('#sr-tree').replaceChildren(); $('#sr-status').textContent = e.transport === 'timeout' ? '요청 시간이 초과되었습니다. 다시 시도하세요.' : 'SR 열람 실패: ' + e.message; });
      } finally { apply(() => { $('#sr-read').disabled = !srDocuments.some(d => srVal(d,'00080018') === $('#sr-document').value); }); }
    }
    function srOptions(select, rows, tag, label) {
      select.replaceChildren(new Option('선택하세요', ''), ...rows.map(ds => new Option(label(ds), srVal(ds,tag))));
    }
    function srList() {
      srSeries = []; srDocuments = []; $('#sr-series').replaceChildren(); $('#sr-document').replaceChildren();
      if (!srValidUid(srUid)) return;
      srLoad('/dicom-web/studies/' + srUid + '/series?Modality=SR&limit=101', rows => {
        if (rows.length > 100) throw new Error('SR 시리즈 100개 상한을 초과했습니다.');
        const seen = new Set();
        for (const ds of rows) {
          const id = srVal(ds,'0020000E');
          if (srVal(ds,'0020000D') !== srUid || srVal(ds,'00080060') !== 'SR' || !srValidUid(id) || seen.has(id)) throw new Error('SR 시리즈 식별이 일치하지 않습니다.');
          seen.add(id);
        }
        srSeries = rows; srOptions($('#sr-series'), rows, '0020000E', d => (srVal(d,'00200011') || '번호 없음') + ' · ' + (srVal(d,'0008103E') || '설명 없음') + ' · ' + srVal(d,'0020000E'));
      });
    }
    $('#sr-open').addEventListener('click', () => {
      closeSR(); const s = viewed(); if (!s || demoMode || !srValidUid(s.uid)) return;
      srUid = s.uid; $('#sr-context').textContent = '열람 검사 · ' + s.name + ' (' + s.id + ') · ' + s.date + ' · ' + shownStudyDesc(s);
      srDialog.showModal(); srList();
    });
    $('#sr-series').addEventListener('change', () => {
      srClear(); srDocuments = []; $('#sr-document').replaceChildren(); const series = $('#sr-series').value;
      if (!srSeries.some(d => srVal(d,'0020000E') === series)) return;
      srLoad('/dicom-web/studies/' + srUid + '/series/' + series + '/instances?includefield=00080016&limit=201', rows => {
        if (rows.length > 200) throw new Error('SR 문서 200개 상한을 초과했습니다.');
        const seen = new Set();
        for (const ds of rows) {
          const id = srVal(ds,'00080018');
          if (srVal(ds,'0020000D') !== srUid || srVal(ds,'0020000E') !== series || !srValidUid(id) || seen.has(id)) throw new Error('SR 문서 식별이 일치하지 않습니다.');
          seen.add(id);
        }
        srDocuments = rows; srOptions($('#sr-document'), rows, '00080018', d => (srVal(d,'00200013') || '번호 없음') + ' · ' + srVal(d,'00080018'));
      });
    });
    $('#sr-document').addEventListener('change', () => { srClear(); $('#sr-read').disabled = !srDocuments.some(d => srVal(d,'00080018') === $('#sr-document').value); });
    $('#sr-read').addEventListener('click', () => {
      const sop = $('#sr-document').value, ds = srDocuments.find(d => srVal(d,'00080018') === sop); if (!ds) return;
      const expected = { study: srUid, series: $('#sr-series').value, sop, sopClass: srVal(ds,'00080016') };
      srLoad('/dicom-web/studies/' + expected.study + '/series/' + expected.series + '/instances/' + sop + '/metadata', rows => {
        if (rows.length !== 1) throw new Error('선택한 SR 한 문서가 아닙니다.');
        const tree = srTree(rows[0], expected), fragment = document.createDocumentFragment();
        function render(entries, parent, depth) {
          for (const entry of entries) {
            const title = '(' + entry.tag.slice(0,4) + ',' + entry.tag.slice(4) + ') ' + entry.label + ' [' + entry.vr + ']';
            if (entry.vr === 'SQ') {
              const details = document.createElement('details'), summary = document.createElement('summary');
              summary.textContent = title + ' · ' + entry.values.length + '개'; details.append(summary); details.open = depth < 2;
              entry.values.forEach((item, i) => { const group = document.createElement('div'); group.style.marginLeft = '16px'; const heading = document.createElement('strong'); heading.textContent = 'Item ' + (i + 1); group.append(heading); render(item,group,depth+1); details.append(group); }); parent.append(details);
            } else { const line = document.createElement('div'); line.textContent = title + ' = ' + (entry.values.length ? entry.values.join(' \\ ') : '(빈 값)'); parent.append(line); }
          }
        }
        const primary = new Set(['0040A040','0040A043','0040A050','0040A491','0040A493','0040A730']);
        render(tree.filter(e => primary.has(e.tag)),fragment,0);
        const metadata = document.createElement('details'), summary = document.createElement('summary'); metadata.dataset.srMetadata = '';
        summary.textContent = '문서 식별정보 및 기타 태그'; metadata.append(summary); render(tree.filter(e => !primary.has(e.tag)),metadata,2); fragment.append(metadata);
        $('#sr-tree').replaceChildren(fragment);
      });
    });
    $('#sr-reload').addEventListener('click', srList); $('#sr-close').addEventListener('click', closeSR);
    srDialog.addEventListener('cancel', e => { e.preventDefault(); closeSR(); });
    window.addEventListener('pagehide', closeSR);