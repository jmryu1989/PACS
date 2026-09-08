/* Read-only report output. Every asynchronous result belongs to one open dialog. */
(function () {
  'use strict';
  const fields = ['findings', 'conclusion', 'recommendation'];
  const paperCss = `body{margin:0;color:#18212b;background:#fff;font:14px/1.55 "Malgun Gothic",sans-serif}
    main{max-width:190mm;margin:0 auto;padding:10mm}h1{font-size:21px;margin:0 0 8px}h2{font-size:15px;margin:18px 0 5px}
    pre,p{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0}header{border-bottom:2px solid #34495c;padding-bottom:12px}
    .source{font-weight:bold}.keys{break-before:page}.key{break-inside:avoid;margin:16px 0 24px;border-top:1px solid #b4bdc5;padding-top:12px}
    .key img{display:block;max-width:100%;max-height:180mm;width:auto;height:auto;margin:8px auto;background:black}
    .key-row{display:flex;gap:6mm;break-inside:avoid}.key-row .key{flex:0 0 calc((100% - 6mm)/2);min-width:0}
    .key-row .key img{max-height:80mm}.key strong{overflow-wrap:anywhere}
    .reference{font-size:10px;color:#526171;overflow-wrap:anywhere}.note{font-size:12px;color:#526171}
    @page{size:A4;margin:12mm 12mm 22mm}
    .identity-example{border:1px solid #b4bdc5;padding:8px;margin-top:12px;font-size:12px}
    @media print{main{max-width:none;padding:0}h2{break-after:avoid}header{break-inside:avoid}.identity-example{display:none}}`;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const el = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node; };
  function supportsPageIdentity() {
    try {
      const sheet = new CSSStyleSheet(); sheet.replaceSync('@page{@bottom-left{content:"identity"}}');
      return sheet.cssRules[0]?.cssRules[0]?.name === 'bottom-left';
    } catch { return false; }
  }
  window.KinReportPreview = function ({ api, context, actorName, toast }) {
    const dialog = el('dialog'); dialog.id = 'report-preview'; dialog.setAttribute('aria-labelledby', 'report-preview-title');
    dialog.style.cssText = 'width:min(1150px,94vw);height:90vh;padding:0;border:1px solid #61748c;border-radius:8px;background:#18212b;color:#edf2f8';
    const top = el('div', undefined, dialog); top.style.cssText = 'display:flex;gap:12px;padding:12px;align-items:center;flex-wrap:wrap';
    const title = el('strong', '판독문·키 이미지 미리보기', top); title.id = 'report-preview-title';
    const source = el('select', undefined, top); source.setAttribute('aria-label', '출력 판독문');
    for (const [value, label] of [['saved', '서버 저장본'], ['editor', '현재 편집문 · 미확정']]) { const option = el('option', label, source); option.value = value; }
    const layout = el('select', undefined, top); layout.setAttribute('aria-label', '키 이미지 배치');
    for (const [value, label] of [['single', '키 이미지 · 한 열'], ['double', '키 이미지 · 두 열']]) { const option = el('option', label, layout); option.value = value; }
    const refresh = el('button', '다시 확인', top), closeButton = el('button', '닫기', top);
    const middle = el('div', undefined, dialog); middle.style.cssText = 'display:flex;gap:12px;height:calc(100% - 130px);min-height:150px;padding:0 12px';
    const sidebar = el('div', undefined, middle); sidebar.style.cssText = 'flex:0 1 260px;min-width:140px;overflow:auto';
    el('strong', '함께 출력할 키 이미지', sidebar);
    const windowControls = el('fieldset', undefined, sidebar); windowControls.style.cssText = 'border:0;padding:10px 0;margin:0';
    el('legend', '선택 키 이미지 밝기', windowControls);
    const brightness = el('select', undefined, windowControls); brightness.setAttribute('aria-label', '출력 영상 밝기');
    for (const [value, label] of [['auto', '자동 밝기'], ['manual', 'CT 출력 W/L 직접 지정']]) { const option = el('option', label, brightness); option.value = value; }
    const windowFields = el('div', undefined, windowControls); windowFields.style.display = 'none';
    const widthLabel = el('label', 'W (폭) ', windowFields), windowWidth = el('input', undefined, widthLabel);
    const centerLabel = el('label', 'L (중심) ', windowFields), windowCenter = el('input', undefined, centerLabel);
    for (const input of [windowWidth, windowCenter]) { input.type = 'number'; input.step = 'any'; input.style.cssText = 'width:100%;box-sizing:border-box;margin:4px 0 8px'; }
    windowWidth.min = '1'; windowWidth.max = '20000'; windowWidth.value = '400';
    windowCenter.min = '-10000'; windowCenter.max = '10000'; windowCenter.value = '40';
    const applyWindow = el('button', '밝기 적용', windowFields);
    const count = el('p', '', sidebar), choices = el('div', undefined, sidebar);
    const paper = el('iframe', undefined, middle); paper.title = '출력물 미리보기'; paper.setAttribute('sandbox', 'allow-same-origin');
    paper.style.cssText = 'flex:1;min-width:0;border:0;background:white';
    const footer = el('div', undefined, dialog); footer.style.cssText = 'display:flex;gap:12px;align-items:center;padding:12px';
    const status = el('span', '', footer); status.setAttribute('role', 'status'); status.style.cssText = 'flex:1;white-space:pre-wrap';
    const printButton = el('button', '인쇄 / PDF', footer); printButton.disabled = true;
    document.body.append(dialog);
    let epoch = 0, session = null, request = null, urls = [], rendered = null, printWindow = null, focusBefore = null;
    const check = s => {
      const now = context();
      if (!s || session !== s || !dialog.open || s.epoch !== epoch || now.uid !== s.uid || !now.online)
        throw new Error('출력 대상이 바뀌었습니다. 미리보기를 다시 여세요.');
      return now;
    };
    const releaseImages = () => { urls.forEach(URL.revokeObjectURL); urls = []; rendered = null; printButton.disabled = true; paper.srcdoc = ''; };
    function close() {
      epoch++; session = null; request?.abort(); request = null;
      if (printWindow && !printWindow.closed) printWindow.close(); printWindow = null;
      releaseImages(); choices.replaceChildren(); status.textContent = ''; count.textContent = '';
      if (dialog.open) dialog.close(); focusBefore?.focus(); focusBefore = null;
    }
    async function bounded(work) {
      request?.abort(); const controller = request = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try { return await work(controller.signal); }
      finally { clearTimeout(timer); controller.abort(); if (request === controller) request = null; }
    }
    async function snapshot(s, signal) {
      const data = await api('GET', '/studies/' + encodeURIComponent(s.uid) + '/report-preview', undefined, signal);
      check(s);
      if (data.study?.uid !== s.uid || !data.report || !Array.isArray(data.keys)) throw new Error('검사 정보를 확인할 수 없습니다');
      return data;
    }
    const selectedKeys = () => Array.from(choices.querySelectorAll('input:checked')).map(input => session.data.keys.find(k => k.id === input.value));
    function documentBody(s, images, windowing) {
      const root = el('main'), head = el('header', undefined, root), d = s.data, st = d.study;
      el('h1', 'KIN PACS 판독문', head);
      el('p', `환자: ${st.name} (${st.id}) · ${st.sex} · 생년월일 ${st.birth || '미확인'}`, head);
      el('p', `검사: ${st.desc || st.modality || '(설명 없음)'} · ${st.date || '날짜 미확인'} · Acc: ${st.acc || '-'}`, head);
      const editing = source.value === 'editor', report = editing ? s.editor : d.report;
      el('p', editing ? '현재 편집문 · 미확정 (출력으로 저장되거나 승인되지 않음)' : !d.report.version ? '저장된 판독문 없음' :
        `${d.report.rs === 'A' ? '승인된 저장본' : '미승인 저장본'} · v${d.report.version} · RS ${d.report.rs}`, head).className = 'source';
      el('p', `작성자: ${actorName(editing ? d.actor : d.report.author) || '-'} · 승인 판독의: ${editing ? '-' : actorName(d.report.repDoc) || '-'} · 승인일(UTC): ${editing ? '-' : d.report.confirm || '-'}`, head);
      const identity = `환자 ${st.name} (${st.id}) · 검사 ${st.date || '-'} · Acc ${st.acc || '-'}\n${editing ? '현재 편집문 · 미확정' : !d.report.version ? '저장된 판독문 없음' : (d.report.rs === 'A' ? '승인된 저장본' : '미승인 저장본') + ' · v' + d.report.version}`;
      el('p', '모든 출력 페이지에 반복되는 식별정보\n' + identity, root).className = 'identity-example';
      for (const [index, name] of fields.entries()) { el('h2', ['Findings', 'Conclusion', 'Recommendation'][index], root); el('pre', report[name] || '(내용 없음)', root); }
      if (images.length) {
        const keys = el('section', undefined, root); keys.className = 'keys';
        el('h2', `저장한 키 이미지 · ${images.length}장`, keys);
        el('p', '저장한 원본 프레임의 미리보기입니다. ' + (windowing ? `출력 W ${windowing.width} / L ${windowing.center}` : '밝기 자동 조정') + ' · 주석 미포함 · 실제 크기 아님.', keys).className = 'note';
        el('p', layout.value === 'double' ? '두 열 · 왼쪽에서 오른쪽 순서. 실제 페이지 나눔은 인쇄 미리보기에서 확인하세요.' : '한 열 · 선택한 순서', keys).className = 'note';
        let row = keys;
        for (const [index, { key, url }] of images.entries()) {
          if (layout.value === 'double' && index % 2 === 0) { row = el('div', undefined, keys); row.className = 'key-row'; }
          const figure = el('section', undefined, row); figure.className = 'key';
          el('strong', key.item.title || '(제목 없음)', figure);
          el('p', key.item.description || '', figure);
          const img = el('img', undefined, figure); img.src = url; img.alt = key.item.title || '저장한 키 이미지';
          el('p', `환자 ${st.name} (${st.id}) · ${st.date} · 프레임 ${key.item.frame} · r${key.revision}`, figure);
          el('p', `Study ${st.uid}\nSeries ${key.item.seriesUid}\nSOP ${key.item.sopUid}`, figure).className = 'reference';
        }
      }
      return { markup: root.outerHTML, identity };
    }
    function html({ markup, identity }) {
      // Encode every character: patient strings cannot terminate a CSS string
      // or its HTML style element. Page-margin boxes keep identity off the body.
      const cssText = '"' + Array.from(identity, char => '\\' + char.codePointAt(0).toString(16) + ' ').join('') + '"';
      const margins = '@page{@bottom-left{content:' + cssText + ';font:9px/1.4 "Malgun Gothic",sans-serif;white-space:pre-wrap;width:170mm;vertical-align:middle}' +
        '@bottom-right{content:counter(page) " / " counter(pages);font:9px sans-serif;vertical-align:middle}}';
      return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>KIN PACS 판독문</title><style>' + paperCss + margins + '</style></head><body>' + markup + '</body></html>';
    }
    async function jsonResource(path, signal) {
      const response = await fetch(path, { signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error('키 이미지 원본을 확인하지 못했습니다');
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
          if (bytes > 524288) throw new Error('원본 정보가 조회 한도를 초과했습니다'); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(await new Blob(chunks).text());
    }
    async function digest(path, signal) {
      const info = await jsonResource(path + '/attachments/dicom/info', signal);
      if (!/^[a-f0-9]{32}$/i.test(info.UncompressedMD5)) throw new Error('원본 파일을 확인할 수 없습니다');
      return info.UncompressedMD5.toLowerCase();
    }
    async function windowPixels(chunks, tags, windowing, signal, budget) {
      // Lossless Orthanc PAM avoids /rendered's minimum width/slope clamps.
      // The selected extraction endpoint fixes signedness; PAM stores BE16.
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
      const match = /^P7\nWIDTH (\d+)\nHEIGHT (\d+)\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n/.exec(header);
      if (!match) throw new Error('출력 원본 화소 형식이 올바르지 않습니다');
      const width = Number(match[1]), height = Number(match[2]), offset = match[0].length;
      if (width !== Number(tags.Columns) || height !== Number(tags.Rows) || !width || !height ||
          width * height > 16777216 || bytes.length !== offset + width * height * 2)
        throw new Error('출력 원본 화소 크기가 일치하지 않습니다');
      if (signal.aborted) throw new Error('출력 이미지 확인이 취소됐습니다');
      budget.pixels += width * height;
      if (budget.pixels > 33554432) throw new Error('출력 이미지 해상도 한도를 초과했습니다');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      try {
        const context = canvas.getContext('2d'), image = context.createImageData(width, height);
        const data = new DataView(bytes.buffer, offset), signed = Number(tags.PixelRepresentation) === 1;
        const slope = Number(tags.RescaleSlope), intercept = Number(tags.RescaleIntercept);
        for (let i = 0; i < width * height; i++) {
          const stored = signed ? data.getInt16(i * 2, false) : data.getUint16(i * 2, false);
          const value = stored * slope + intercept;
          const level = windowing.width === 1 ? (value > windowing.center - .5 ? 255 : 0) :
            Math.round(Math.max(0, Math.min(255, ((value - (windowing.center - .5)) / (windowing.width - 1) + .5) * 255)));
          image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = level; image.data[i * 4 + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob || signal.aborted) throw new Error('출력 이미지 확인이 취소됐습니다');
        return blob;
      } finally { canvas.width = canvas.height = 0; }
    }
    async function frame(s, key, signal, budget, windowing) {
      const item = key.item;
      const located = await api('POST', '/dicom/lookup', { studyUid: s.uid, sopUid: item.sopUid }, signal); check(s);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(located.id)) throw new Error('원본 영상 식별을 확인할 수 없습니다');
      const prefix = '/instances/' + located.id;
      const originalDigest = await digest(prefix, signal);
      const tags = await jsonResource(prefix + '/simplified-tags', signal); check(s);
      const frames = Number(tags.NumberOfFrames || 1);
      if (tags.StudyInstanceUID !== s.uid || tags.SeriesInstanceUID !== item.seriesUid || tags.SOPInstanceUID !== item.sopUid ||
          !Number.isSafeInteger(item.frame) || item.frame < 1 || item.frame > frames) throw new Error('키 이미지의 원본 프레임이 일치하지 않습니다');
      if (windowing && (tags.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' || tags.Modality !== 'CT' ||
          tags.PhotometricInterpretation !== 'MONOCHROME2' || frames !== 1 ||
          Number(tags.BitsAllocated) !== 16 || ![0, 1].includes(Number(tags.PixelRepresentation)) ||
          Number(tags.SamplesPerPixel) !== 1 ||
          tags.ModalityLUTSequence !== undefined || tags.VOILUTSequence !== undefined ||
          (tags.VOILUTFunction !== undefined && tags.VOILUTFunction !== 'LINEAR') ||
          !String(tags.RescaleSlope ?? '').trim() || !Number.isFinite(Number(tags.RescaleSlope)) || Number(tags.RescaleSlope) <= 0 ||
          !String(tags.RescaleIntercept ?? '').trim() || !Number.isFinite(Number(tags.RescaleIntercept))))
        throw new Error('직접 W/L은 일반 흑백 CT 키 이미지에서 사용할 수 있습니다. 선택을 바꾸거나 자동 밝기로 돌아가세요.');
      const rendering = windowing ? (Number(tags.PixelRepresentation) === 1 ? '/image-int16' : '/image-uint16') : '/preview';
      const mime = windowing ? 'image/x-portable-arbitrarymap' : 'image/png';
      const response = await fetch(prefix + '/frames/' + (item.frame - 1) + rendering, { signal, cache: 'no-store', headers: { Accept: mime } });
      if (!response.ok || !response.headers.get('content-type')?.startsWith(mime) || !response.body) throw new Error('키 이미지를 불러오지 못했습니다');
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; budget.bytes += part.value.length;
          if (bytes > 8388608 || budget.bytes > 67108864) throw new Error('출력 이미지 용량 한도를 초과했습니다'); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => {}); }
      check(s); if (signal.aborted) throw new Error('출력 이미지 확인이 취소됐습니다');
      const blob = windowing ? await windowPixels(chunks, tags, windowing, signal, budget) : new Blob(chunks, { type: 'image/png' });
      if (windowing) { budget.bytes += blob.size; if (blob.size > 8388608 || budget.bytes > 67108864) throw new Error('출력 이미지 용량 한도를 초과했습니다'); }
      const header = new DataView(await blob.slice(0, 24).arrayBuffer());
      if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(12) !== 0x49484452)
        throw new Error('출력 이미지 형식이 올바르지 않습니다');
      const width = header.getUint32(16), height = header.getUint32(20); if (!windowing) budget.pixels += width * height;
      if (!width || !height || width * height > 16777216 || budget.pixels > 33554432) throw new Error('출력 이미지 해상도 한도를 초과했습니다');
      if (signal.aborted) throw new Error('출력 이미지 확인이 취소됐습니다');
      const url = URL.createObjectURL(blob); urls.push(url);
      const image = new Image(), abort = () => { image.removeAttribute('src'); }; image.src = url;
      signal.addEventListener('abort', abort, { once: true });
      try { if (signal.aborted) throw new Error('출력 이미지 확인이 취소됐습니다'); await image.decode(); }
      finally { signal.removeEventListener('abort', abort); }
      check(s);
      if (await digest(prefix, signal) !== originalDigest) throw new Error('키 이미지 원본이 변경되었습니다. 다시 확인을 누르세요.');
      return { key, url, prefix, digest: originalDigest };
    }
    async function prepare() {
      const s = session; if (!s?.data) return;
      request?.abort(); releaseImages(); status.textContent = '출력할 내용을 확인하고 있습니다…';
      const keys = selectedKeys(), selection = keys.map(k => k.id); count.textContent = `${keys.length}장 선택 · 한 번에 최대32장`;
      if (keys.length > 32) { status.textContent = '키 이미지를32장 이하로 선택하세요.'; return; }
      const selectionEpoch = ++s.selectionEpoch;
      try {
        // Capture numeric settings with this request, not at eventual render time.
        let windowing = null;
        if (brightness.value === 'manual') {
          const width = Number(windowWidth.value), center = Number(windowCenter.value);
          if (!windowWidth.value.trim() || !windowCenter.value.trim() || !Number.isFinite(width) || !Number.isFinite(center) ||
              width < 1 || width > 20000 || center < -10000 || center > 10000)
            throw new Error('W는1~20000, L은-10000~10000의 숫자로 입력한 뒤 밝기를 적용하세요.');
          windowing = { width, center };
        }
        await bounded(async signal => {
          if (source.value === 'editor' && !s.data.canPreviewEditor) throw new Error('현재 편집문을 출력할 권한이 없습니다');
          const images = new Array(keys.length), budget = { bytes: 0, pixels: 0 }; let next = 0;
          await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async () => {
            while (next < keys.length) { const i = next++; images[i] = await frame(s, keys[i], signal, budget, windowing); }
          }));
          const current = await snapshot(s, signal);
          if (!same(current, s.data)) throw new Error('저장본 또는 키 이미지가 변경되었습니다. 다시 확인을 누르세요.');
          check(s); if (selectionEpoch !== s.selectionEpoch) return;
          if (source.value === 'editor' && !same(context().editor, s.editor)) throw new Error('편집문이 바뀌었습니다. 다시 확인을 누르세요.');
          rendered = { html: html(documentBody(s, images, windowing)), images, selection, source: source.value, selectionEpoch };
          paper.srcdoc = rendered.html; printButton.disabled = !supportsPageIdentity();
          status.textContent = printButton.disabled ? '이 브라우저는 페이지별 식별정보 출력을 지원하지 않습니다. 최신 Chrome 또는 Edge에서 여세요.' :
            '미리보기 내용을 확인하세요. A4 · 기본 여백으로 출력하며, 인쇄 대화상자에서 페이지 나눔과 식별정보를 확인하세요.';
        });
      } catch (error) {
        if (session !== s || selectionEpoch !== s.selectionEpoch) return;
        releaseImages(); status.textContent = error.name === 'AbortError' ? '불러오기가 지연됐습니다. 다시 확인을 누르세요.' : error.message;
      }
    }
    async function reload() {
      const s = session; if (!s) return;
      s.selectionEpoch++; releaseImages(); choices.replaceChildren(); status.textContent = '저장본과 키 이미지를 불러오는 중…'; source.disabled = true; layout.disabled = true; windowControls.disabled = true;
      try {
        s.data = await bounded(signal => snapshot(s, signal)); s.editor = { ...check(s).editor };
        source.querySelector('[value=editor]').disabled = !s.data.canPreviewEditor;
        if (!s.data.canPreviewEditor) source.value = 'saved'; source.disabled = false; layout.disabled = false; windowControls.disabled = false;
        for (const key of s.data.keys) {
          const label = el('label', undefined, choices); label.style.cssText = 'display:block;padding:8px 0;border-bottom:1px solid #465362;overflow-wrap:anywhere';
          const input = el('input', undefined, label); input.type = 'checkbox'; input.value = key.id; input.setAttribute('aria-label', key.item.title || '제목 없는 키 이미지');
          el('span', ` ${key.item.title || '(제목 없음)'} · 프레임 ${key.item.frame}`, label); input.onchange = prepare;
        }
        if (!s.data.keys.length) el('p', '저장한 키 이미지가 없습니다.', choices);
        await prepare();
      } catch (error) { if (session === s) { releaseImages(); status.textContent = error.name === 'AbortError' ? '조회가 지연됐습니다. 다시 확인을 누르세요.' : error.message; } }
    }
    async function print() {
      const s = session, ready = rendered; if (!s || !ready || printButton.disabled) return;
      if (!supportsPageIdentity()) return;
      if (printWindow && !printWindow.closed) printWindow.close();
      printWindow = window.open('', '_blank');
      if (!printWindow) { toast('인쇄 창을 열 수 없습니다. 팝업 허용 여부를 확인하세요.', 'err'); return; }
      const target = printWindow; printButton.disabled = true; status.textContent = '출력 직전 상태를 다시 확인하고 있습니다…';
      try {
        await bounded(async signal => {
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(4, ready.images.length) }, async () => {
            while (next < ready.images.length) { const image = ready.images[next++];
              if (await digest(image.prefix, signal) !== image.digest) throw new Error('키 이미지 원본이 변경되었습니다. 다시 확인을 누르세요.'); }
          }));
          const latest = await snapshot(s, signal);
          if (ready !== rendered || !same(latest, s.data) || (ready.source === 'editor' && !same(check(s).editor, s.editor)))
            throw new Error('출력 내용이 변경되었습니다. 다시 확인을 누르세요.');
          if (target.closed) throw new Error('인쇄 창이 닫혔습니다. 다시 인쇄를 누르세요.');
          target.document.open(); target.document.write(ready.html); target.document.close();
          await Promise.all(Array.from(target.document.images, image => image.decode())); check(s);
          if (target.closed || ready !== rendered) throw new Error('인쇄 창이 닫혔거나 출력 내용이 변경되었습니다');
          target.focus(); target.print();
          if (session === s) status.textContent = '인쇄 대화상자에서 인쇄하거나 PDF로 저장하세요. 취소해도 원본은 바뀌지 않습니다.';
        });
      } catch (error) {
        if (!target.closed) target.close();
        // A late cancelled print owns only its captured output, not a newer layout.
        if (session === s && rendered === ready) { releaseImages(); status.textContent = error.message; }
      }
      finally { if (session === s && rendered === ready) printButton.disabled = !supportsPageIdentity(); }
    }
    closeButton.onclick = close; refresh.onclick = reload; source.onchange = prepare; layout.onchange = prepare; printButton.onclick = print;
    const invalidateWindow = () => {
      if (!session) return;
      session.selectionEpoch++; request?.abort(); releaseImages();
      status.textContent = '출력 W/L을 바꿨습니다. 밝기 적용을 누르세요.';
    };
    brightness.onchange = () => { windowFields.style.display = brightness.value === 'manual' ? 'block' : 'none'; if (brightness.value === 'manual') invalidateWindow(); else void prepare(); };
    windowWidth.oninput = invalidateWindow; windowCenter.oninput = invalidateWindow; applyWindow.onclick = prepare;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('beforeunload', close);
    window.addEventListener('storage', event => { if (event.key === 'kin-session-ended') close(); });
    return { close, open() {
      close(); const current = context();
      if (!current.uid || !current.online) { toast('검사를 선택하고 서버 연결을 확인하세요.', 'err'); return; }
      focusBefore = document.activeElement; source.value = 'saved'; layout.value = 'single'; session = { uid: current.uid, epoch, selectionEpoch: 0 };
      brightness.value = 'auto'; windowFields.style.display = 'none'; windowWidth.value = '400'; windowCenter.value = '40';
      dialog.showModal(); void reload();
    } };
  };
})();
