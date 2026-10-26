(function (root) {
  'use strict';
  // KEY-ADMIN: the admin creates, rotates or retires one member's server-held approval key (D1770). The doctor's
  // approval does not change; this dialog only drives POST admin/users/:id/signing-key, which runs ServerKeys.manage.
  // The page owns termination; the dialog releases its pending request with that lifecycle (as Study Access does).
  const CLINICAL = ['radiologist', 'clinician', 'technician'];
  let active = null, session = null, closeActive = null, refused = null;

  function attach(lifecycle, onRefused) {
    if (session) return;
    session = lifecycle; refused = onRefused;
    lifecycle.onEnd(() => closeActive?.());
  }

  /** Own-institution members with a clinical role: only they can hold a key; the server rechecks everything. */
  function eligible(user) {
    const s = KinAuth.session();
    return !!s?.institution && user.institution === s.institution && user.roles.some(role => CLINICAL.includes(role));
  }

  function open(user) {
    if (!session || session.ended() || !eligible(user)) return;
    if (active) { active.focus(); return; }
    const owner = (() => { const s = KinAuth.session(); return [s?.institution, s?.sub]; })();
    const dialog = document.createElement('dialog'); active = dialog; dialog.id = 'signing-key-dialog';
    dialog.style.cssText = 'width:min(760px,calc(100vw - 32px));max-height:90vh;overflow:auto';
    dialog.innerHTML = `<form class="dialog-body" id="signing-key-form"><h2>Signing Key</h2><p data-target></p>
      <p>온라인 승인 서명키는 서버가 회원별로 보관합니다. 판독의·임상의는 지금처럼 승인하며 추가 절차가 없습니다. 키를 교체하거나 폐기해도 이미 서명된 기록은 보관된 공개키로 계속 검증됩니다. 모든 변경은 접속기록에 남습니다.</p>
      <p data-status role="status"></p>
      <div class="audit-table" data-wrap hidden><table><thead><tr><th scope="col">Key ID</th><th scope="col">Status</th><th scope="col">Registered (UTC)</th><th scope="col">Ended (UTC)</th></tr></thead><tbody data-rows></tbody></table></div>
      <label style="margin-top:12px">Change Reason<input name="reason" maxlength="2000" required autocomplete="off"></label>
      <div class="dialog-actions"><button type="button" data-close>Close</button><button type="button" data-reload>Reload</button>
        <button type="button" class="primary" data-action="provision" hidden>Create Key</button>
        <button type="button" class="primary" data-action="replace" hidden>Rotate Key</button>
        <button type="button" class="danger" data-action="revoke" hidden>Retire Key</button></div></form>`;
    const $ = q => dialog.querySelector(q), form = $('form'), status = $('[data-status]');
    $('[data-target]').textContent = `${user.name || user.username} · ${user.username} · ${user.institution}`;
    // view: the last answer this dialog drew; unknown: a change whose result was not read back (Reload decides).
    let generation = 0, view = null, busy = false, unknown = false, closed = false;
    const sameOwner = () => {
      const s = KinAuth.session();
      return s?.state === 'approved' && JSON.stringify([s.institution, s.sub]) === JSON.stringify(owner);
    };

    function controls() {
      const current = view?.current ?? null, ready = !!view && !busy && !unknown;
      $('[data-action="provision"]').hidden = !view || !!current;
      $('[data-action="replace"]').hidden = !current;
      $('[data-action="revoke"]').hidden = !current;
      for (const button of dialog.querySelectorAll('[data-action]')) button.disabled = !ready;
      form.elements.reason.disabled = !ready;
      $('[data-reload]').disabled = busy;
    }

    function render(result) {
      if (!result || result.subject !== user.id || typeof result.institutionId !== 'string' || !Array.isArray(result.keys) ||
          !(result.current === null || typeof result.current === 'string') ||
          result.keys.some(key => !key || typeof key.kid !== 'string' || !['active', 'suspended', 'revoked'].includes(key.status)))
        throw Error('서명키 응답의 회원·형식을 확인하지 못했습니다');
      view = result;
      const rows = result.keys.map(key => {
        const tr = document.createElement('tr');
        for (const value of [key.kid, key.status === 'active' ? 'Active' : key.status === 'revoked' ? 'Retired' : 'Suspended',
          key.registeredAt, key.endedAt ?? '—']) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        return tr;
      });
      $('[data-rows]').replaceChildren(...rows);
      $('[data-wrap]').hidden = !rows.length;
      const current = result.keys.find(key => key.kid === result.current);
      status.textContent = current ? `Active Key · ${current.kid} · ${current.registeredAt}`
        : 'No Active Key · 이 회원의 온라인 승인은 키를 만들기 전까지 거절됩니다.';
    }

    async function request(method, body) {
      if (closed || session.ended()) throw Error('세션이 종료되었습니다');
      if (!sameOwner()) throw Error('계정이 변경되었습니다. 다시 로그인하세요');
      const context = KinWorkContext.capture('document');
      let response;
      try {
        response = await KinSessionTransport.page().request('/api/admin/users/' + encodeURIComponent(user.id) + '/signing-key',
          { method, json: body, context, deadlineMs: 15000 });
      } catch (error) { throw Object.assign(error, { unread: true }); }
      // A body read after the end or after Close is dropped: nothing of it is drawn or kept.
      if (closed || session.ended() || !KinWorkContext.admits(context)) throw Error('세션이 종료되었습니다');
      if (!sameOwner()) throw Error('계정이 변경되었습니다. 응답을 적용하지 않았습니다');
      const result = response.body;
      if (response.incomplete) throw Object.assign(Error('응답을 끝까지 받지 못했습니다'), { unread: true });
      if (!response.ok) throw Object.assign(Error(typeof result?.message === 'string' ? result.message : '서명키 요청을 처리하지 못했습니다'),
        { status: response.status });
      return result;
    }

    async function reload() {
      if (closed || busy) return;
      const token = ++generation; busy = true; controls(); status.textContent = 'Loading';
      try {
        const result = await request('GET');
        if (closed || token !== generation) return;
        render(result); unknown = false; form.elements.reason.value = '';
      } catch (error) {
        if (closed || token !== generation) return;
        if (error.status === 403) { dispose(); refused?.(error.message); return; }
        status.textContent = error.message || '서명키를 불러오지 못했습니다';
      } finally { if (!closed && token === generation) { busy = false; controls(); } }
    }

    async function change(action) {
      if (closed || busy || unknown || !view) return;
      if (!form.reportValidity()) return;
      const reason = form.elements.reason.value;
      if (action === 'revoke' && !confirm('이 회원의 서명키를 폐기하면 새 키를 만들기 전까지 온라인 승인이 거절됩니다. 폐기하시겠습니까?')) return;
      const token = ++generation; busy = true; controls(); status.textContent = 'Saving';
      try {
        const result = await request('POST', { action, expectedKid: action === 'provision' ? null : view.current, reason });
        if (closed || token !== generation) return;
        render(result); form.elements.reason.value = '';
        status.textContent += action === 'provision' ? ' · Created' : action === 'replace' ? ' · Rotated' : ' · Retired';
      } catch (error) {
        if (closed || token !== generation) return;
        // The change may have committed before the answer was lost; Reload shows what the server holds. A 503 is a
        // refusal inside the transaction (nothing changed). A 403/409 also asks for Reload: a lost admin role then
        // closes the dialog through the read, as Study Access does.
        if (error.unread || !error.status || error.status >= 500 && error.status !== 503) unknown = true;
        if ([403, 409].includes(error.status)) view = null;
        status.textContent = (error.message || '서명키를 변경하지 못했습니다') +
          (unknown ? ' · 결과를 확인하지 못했습니다. Reload로 현재 키를 확인하세요.' : view ? '' : ' · Reload로 현재 키를 확인하세요.');
      } finally { if (!closed && token === generation) { busy = false; controls(); } }
    }

    function close() {
      if (busy && !confirm('서명키 요청의 결과를 아직 받지 못했습니다. 닫으시겠습니까?')) return;
      dispose();
    }
    // Close, the page session's end (the attached lifecycle) and pagehide all end here: the generation moves and
    // the view goes with the dialog.
    function dispose() {
      closed = true; generation++; view = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (active === dialog) active = null;
      if (closeActive === dispose) closeActive = null;
      window.removeEventListener('pagehide', dispose);
    }
    for (const button of dialog.querySelectorAll('[data-action]')) button.onclick = () => change(button.dataset.action);
    $('[data-reload]').onclick = () => { unknown = false; reload(); };
    $('[data-close]').onclick = close;
    form.onsubmit = event => event.preventDefault();
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    closeActive = dispose;
    window.addEventListener('pagehide', dispose, { once: true });
    document.body.append(dialog); dialog.showModal(); controls(); reload();
  }

  root.KinSigningKeyAdmin = { open, attach, eligible, close: () => closeActive?.() };
})(window);
