// Clinical Info: Copy Clinical Info / Paste to Findings / Undo Paste (a worklist add-on, feature-mounts.js).
// The text is the DICOM request tags Clinical Context shows now for the study it shows ("Keyword: value", one per line).
// Paste goes through the page's report edit gate (context.report.insertAtTop) with that study as the source: the gate puts
// it at the top of Findings only when that study is the one whose report the editor holds and the editor takes edits.
// Nothing is saved here; the usual draft autosave follows the edit. Undo Paste removes exactly the pasted text, through the
// same gate, until Findings is edited again or another study opens.
(function (root) {
  'use strict';

  function install(context) {
    const doc = root.document;
    const copy = doc.getElementById('clinical-copy'), paste = doc.getElementById('clinical-paste');
    const panel = doc.getElementById('clinical-context'), editor = doc.getElementById('report-editor');
    if (!copy || !paste) return () => {};
    const head = copy.closest('h3');
    const status = doc.createElement('div');
    status.id = 'clinical-paste-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    Object.assign(status.style, { flex: 'none', padding: '2px 10px', fontSize: '11px', overflowWrap: 'anywhere' });
    status.hidden = true;
    head?.after(status);
    const NONE = '이 검사에는 임상 정보가 없습니다';

    let ended = false, undoable = false;
    const shown = () => {
      const now = context.clinicalTags();
      return now && now.tags.length ? now : null;
    };
    const textOf = now => now.tags.map(tag => tag.keyword + ': ' + tag.value).join('\n');

    function render() {
      if (ended) return;
      const now = shown();
      for (const button of [copy, paste]) {
        button.disabled = !now;
        button.title = now ? '' : NONE;
      }
      copy.title = now ? 'Clinical Context에 보이는 DICOM 요청 태그(이름: 값)를 클립보드에 넣습니다.' : NONE;
      paste.title = now ? '같은 글을 Findings 맨 위에 넣습니다. 저장은 평소처럼 자동 저장이 합니다.' : NONE;
    }
    function say(text, withUndo = false) {
      undoable = withUndo;
      status.replaceChildren();
      status.hidden = !text;
      if (!text) return;
      status.append(text);
      if (withUndo) {
        const undo = doc.createElement('button');
        undo.type = 'button'; undo.className = 'chip'; undo.id = 'clinical-paste-undo'; undo.textContent = 'Undo Paste';
        undo.title = '방금 넣은 임상 정보만 Findings에서 뺍니다.';
        undo.addEventListener('click', undoPaste);
        status.append(' ', undo);
      }
    }

    async function copyText() {
      const now = shown();
      if (!now) { render(); return; }
      try {
        if (!root.navigator.clipboard?.writeText) throw new Error('no clipboard');
        await root.navigator.clipboard.writeText(textOf(now));
      } catch (_) {
        if (!ended) context.toast('클립보드에 넣지 못했습니다 — 브라우저가 클립보드 쓰기를 막았습니다.', 'err');
        return;
      }
      if (!ended) context.toast('Clinical info copied', 'ok');
    }
    function pasteText() {
      const now = shown();
      if (!now) { render(); return; }
      const result = context.report.insertAtTop('findings', textOf(now), { sourceUid: now.uid });
      if (result.status === 'applied') say('Pasted to Findings (not saved)', true);
      else { say('Not pasted: ' + result.reason); context.toast(result.reason, 'err'); }
    }
    function undoPaste() {
      const result = context.report.undoInsert();
      say(result.status === 'applied' ? 'Paste undone.' : 'Not undone: ' + result.reason);
    }

    copy.addEventListener('click', copyText);
    paste.addEventListener('click', pasteText);
    // An edit of Findings after the paste (the reader's own, or the browser's Undo) retires Undo Paste. The editor's root moves
    // with it into the report window, so this hears typing there too.
    const edited = event => { if (undoable && event.target?.id === 'findings') say(''); };
    editor?.addEventListener('input', edited);
    const panelWatch = new MutationObserver(() => render());
    if (panel) panelWatch.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    context.onSelect(() => { say(''); render(); });
    context.onRender(() => render());
    render();
    return () => {
      ended = true;
      panelWatch.disconnect();
      editor?.removeEventListener('input', edited);
      copy.removeEventListener('click', copyText);
      paste.removeEventListener('click', pasteText);
      copy.disabled = paste.disabled = true;
      say('');
    };
  }
  install.addOnName = 'Clinical Info Copy/Paste';
  (root.KinWorklistAddOns ||= []).push(install);
})(window);
