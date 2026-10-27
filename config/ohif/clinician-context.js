
/* S5-U2b. 서버 /me의 역할이 업무 역할 clinician뿐인가 — api/src/clinician-policy.ts clinicianOnly와 같은 규칙이다(Keycloak
   기본 역할은 보지 않고, 기존 세 역할이 하나라도 섞이면 아니다). 이 뷰어가 쓰기 컨트롤을 두지 않을 때만 쓰며 권한 판정이
   아니다: 쓰기와 작성자 쪽 읽기는 서버가 거절하고, 이 판정은 그 거절을 부를 버튼을 주지 않을 뿐이다. */
function kinViewerClinicianOnly(me) {
  const roles = me && me.kind === 'member' && Array.isArray(me.roles) ? me.roles : [];
  const app = roles.filter(role => ['radiologist', 'technician', 'admin', 'clinician'].includes(role));
  return app.length > 0 && app.every(role => role === 'clinician');
}

/* Shared viewer role, distinct from the document's session authority. Ordinary HTTP failures
 * keep this verdict. Only the page gate ends the document; successful role reads cannot reopen it.
 */
const kinViewerSession = (() => {
  let role = 'unconfirmed', ended = false, owner = null, read = null, ending = false, why = null;
  const waiting = new Set(), watchers = new Set(), changes = new Set(), enders = new Set(), endings = new Set();
  const state = () => ended ? 'refused' : role;
  // Preserve the reason for existing panel subscribers; the page gate alone authorizes an end.
  const tell = () => { for (const watch of [...endings]) { try { watch(why); } catch (_) {} } };
  function settle(next, reason = 'refused') {
    const previous = state();
    if (ended) return previous;
    if (ending) return previous;
    if (role === 'read-only' && next !== 'refused') return previous;
    if (next === 'refused') {
      // The mounted write modules end in place first, while the document still reads as it was (F01; e2e volume preferences 09/14).
      ending = true; why = reason;
      for (const end of [...enders]) { try { end(); } catch (_) {} }
      ending = false; ended = true;
    } else role = next;
    const now = state();
    for (const resolve of [...waiting]) { waiting.delete(resolve); resolve(now); }
    if (now === 'read-only' && previous !== now) for (const watch of [...watchers]) { try { watch(); } catch (_) {} }
    if (now !== previous) for (const watch of [...changes]) { try { watch(now); } catch (_) {} }
    if (next === 'refused') tell();
    return now;
  }
  // The account a /me answer is from. An answer without one (not a member, no sub) is refused: it cannot be compared with the owner.
  const account = me => me?.kind === 'member' && typeof me.sub === 'string' && me.sub.length > 0
    ? JSON.stringify([typeof me.institution === 'string' ? me.institution : null, me.sub]) : null;
  function note(me) {
    const who = account(me);
    if (who !== null && owner !== null && who !== owner) return state();
    if (who !== null && owner === null) owner = who;
    return who === null ? settle('unconfirmed') : settle(kinViewerClinicianOnly(me) ? 'read-only' : 'writer');
  }
  // F02: the document's own logout receivers, for its whole life (a panel's listener leaves with the panel at mode exit).
  const loggedOut = () => { settle('refused', 'logout'); };
  let logoutChannel = null;
  try { logoutChannel = kinViewerOnEnd(loggedOut); } catch (_) {}
  // Account validation rejects that response locally; it cannot end or rebind the document.
  function sameAccount(me) {
    const who = account(me);
    if (who === null) return null;
    if (owner === null) owner = who;
    if (who === owner) return true;
    return false;
  }
  // A module receives the shared role verdict. Its refusal can only follow a page-gate end.
  const writeModule = Object.freeze({
    answer(me) { if (sameAccount(me) !== true) return false; note(me); return state() === 'writer'; },
    refuse(reason) { if (typeof window === 'object' && window.KinViewerSessionBoundary?.ended()) settle('refused', reason); },
    sameAccount,
    ended: () => ended,
    onEnd(end) { enders.add(end); return () => { enders.delete(end); }; },
  });
  return {
    state,
    owner: () => owner === null ? null : JSON.parse(owner),
    ended: () => ended,
    readOnly: () => state() === 'read-only',
    writer: () => state() === 'writer',
    note,
    // Retained for consumers during disposal; ordinary response failures have no authority here.
    refuse: reason => typeof window === 'object' && window.KinViewerSessionBoundary?.ended() ? settle('refused', reason) : state(),
    writeModule,
    onReadOnly(watch) { watchers.add(watch); return () => { watchers.delete(watch); }; },
    onChange(watch) { changes.add(watch); return () => { changes.delete(watch); }; },
    // End subscribers follow only the page gate, including subscribers mounted after its end.
    onEnded(watch) {
      endings.add(watch);
      if (ended) { try { watch(why); } catch (_) {} }
      return () => { endings.delete(watch); };
    },
    // An unexpected member answer refuses only the panel reading it.
    sameAccount,
    // 같은 때 붙는 확장끼리 /me 읽기 하나를 나눠 쓴다. 답은 그 읽기나 다른 확장의 성공한 /me 중 먼저 온 쪽이다.
    decide() {
      if (ended) return Promise.resolve(state());
      if (role === 'read-only') return Promise.resolve(role);
      const answer = new Promise(resolve => waiting.add(resolve));
      if (!read && typeof fetch === 'function') {
        read = fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
          if (response.ok) note(await response.json());
        }).catch(() => {}).finally(() => { read = null; for (const resolve of [...waiting]) { waiting.delete(resolve); resolve(state()); } });
      }
      return answer;
    },
  };
})();
