/* MODULE_A A5: the page's report display reports (A-090). The server records each report version or version-evidence
 * answer it provides (provide-prepared, A2) and answers its event ID as `accessRef`; A4's
 * `POST studies/:uid/view-observations` records that this browser displayed it (`client-shown`). This module decides when
 * a provided report counts as displayed and sends that report once.
 *
 * Displayed: the screen the provision belongs to is still the latest of its kind (the page's own `live` check: request
 * sequence, selection, open modal, work context), the document is visible, and at least one of its nodes is on screen:
 * connected, not inside [hidden]/[inert] or behind an open modal, rendered, and inside the viewport. An answer that only
 * arrived, a row outside the scrolled History list, or a read the page discarded (A->B->A) is not a display.
 *
 * One display event per opening and stored version: an opening is one Source selection of the Related Report or one
 * opening of Report History. A re-render of the same opening (the page re-reads the Source on every list refresh) is the
 * same event; a new opening is a new event even when the body is the same. The report keeps its event ID and display
 * time, so a resend after a lost acknowledgement is the same event, which the server replays. A resend happens only at
 * the page's next existing chance (a re-render, the node coming on screen again, a modal over it closing, the tab becoming
 * visible); no timer,
 * backoff or queue is added. A refused or unconfirmed report stays unconfirmed; it never removes the report from screen.
 * It is the browser's display report, not proof that a person read the text.
 */
(function (root) {
  'use strict';
  const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // The server's own refusals of this report (malformed, refused access, unknown provision, another report under the ID):
  // resending the same report cannot change them.
  const REFUSED = [400, 403, 404, 409];
  // The page's open modals (the same set Related Report mode's Esc yields to); what lies outside one is covered.
  const MODALS = 'dialog:modal, .modal.show, #structmodal.modal.on';
  const COVERS = MODALS + ', [inert]';

  function create(doc) {
    const surfaces = new Map();     // surface name -> { subject, entries: Map(key -> entry) }
    const observed = new Set();     // the nodes of watched entries
    const onScreen = new WeakMap(); // node -> its last viewport intersection
    let observer = null;

    function visible(node) {
      if (!node || !node.isConnected || node.closest('[hidden], [inert]')) return false;
      for (const modal of doc.querySelectorAll(MODALS)) if (!modal.contains(node)) return false;
      if (typeof node.checkVisibility === 'function' ? !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : !node.getClientRects().length) return false;
      return onScreen.get(node) === true;
    }
    const displayed = entry => doc.visibilityState === 'visible' && entry.nodes.some(visible);

    async function send(entry) {
      entry.state = 'sending';
      const body = { accessRef: entry.accessRef, eventId: entry.eventId, shownAt: entry.shownAt };
      let answer;
      try { answer = await entry.send(body); }
      catch (error) {
        // An ended session is the session's own end; a refusal stays refused; anything else (503, a lost reply, a discarded
        // answer) is unknown and the same event may be resent at the next chance.
        entry.state = error?.auth ? 'ended' : REFUSED.includes(error?.status) ? 'refused' : 'failed';
        return;
      }
      entry.state = answer && answer.eventId === entry.eventId && answer.accessRef === entry.accessRef ? 'acked' : 'unconfirmed';
    }

    function check(entry) {
      if (entry.state !== 'waiting' && entry.state !== 'failed') return;
      let live = false;
      try { live = entry.live() === true; } catch (_) { live = false; }
      if (!live || !displayed(entry)) return;
      if (!entry.eventId) {
        entry.eventId = root.crypto.randomUUID();
        entry.shownAt = new Date().toISOString();
      }
      send(entry);
    }
    function checkAll() {
      for (const surface of surfaces.values()) for (const entry of surface.entries.values()) check(entry);
    }

    function observe(nodes) {
      if (!observer) {
        if (typeof root.IntersectionObserver !== 'function') return;
        observer = new root.IntersectionObserver(records => {
          for (const record of records) if (observed.has(record.target))
            onScreen.set(record.target, record.isIntersecting && record.intersectionRect.width > 0 && record.intersectionRect.height > 0);
          checkAll();
        });
      }
      for (const node of nodes) if (!observed.has(node)) { observed.add(node); observer.observe(node); }
    }
    function release() {
      const kept = new Set();
      for (const surface of surfaces.values()) for (const entry of surface.entries.values()) entry.nodes.forEach(node => kept.add(node));
      // A node no longer watched forgets where it was: observed again later, it waits for a fresh notification.
      for (const node of observed) if (!kept.has(node)) { observer.unobserve(node); observed.delete(node); onScreen.delete(node); }
    }

    /**
     * The provision `accessRef` of `uid` is drawn on `nodes` for the opening `subject` of `surface`. `key` names the stored
     * version shown (one event per opening and key); `live` is the page's check that this screen is still current;
     * `report(body)` sends the display report in the work context of the read that provided it.
     */
    function watch(surface, subject, key, { uid, accessRef, nodes, live, report }) {
      if (typeof accessRef !== 'string' || !UUID4.test(accessRef) || typeof uid !== 'string' || !uid) return;
      const opening = open(surface, subject);
      const shown = (Array.isArray(nodes) ? nodes : [nodes]).filter(Boolean);
      let entry = opening.entries.get(key);
      if (!entry) {
        entry = { uid, accessRef, eventId: null, shownAt: null, state: 'waiting', nodes: shown, live, send: report };
        opening.entries.set(key, entry);
      } else {
        // A re-render of the same version in this opening. Before it was displayed, the newest provision is the one on
        // screen; after, the event already names the provision it displayed and a resend must be that same report.
        if (!entry.eventId) { entry.uid = uid; entry.accessRef = accessRef; }
        entry.nodes = shown;
        entry.live = live;
        entry.send = report;
      }
      observe(shown);
      check(entry);
    }

    /**
     * The surface's opening of `subject`: the current one when it is that subject's, otherwise a new one (a selection of
     * another subject ends the old opening even before anything of the new one is drawn: A -> B -> A is a new A).
     */
    function open(surface, subject) {
      let opening = surfaces.get(surface);
      if (!opening || opening.subject !== subject) {
        if (opening) end(surface);
        opening = { subject, entries: new Map() };
        surfaces.set(surface, opening);
      }
      return opening;
    }

    /** Ends the surface's opening except the versions in `keep` (still on screen); the next watch of another subject opens anew. */
    function end(surface, keep = []) {
      const opening = surfaces.get(surface);
      if (!opening) return;
      for (const key of [...opening.entries.keys()]) if (!keep.includes(key)) opening.entries.delete(key);
      if (!keep.length) surfaces.delete(surface);
      release();
      // A closed modal (History) may uncover another surface's report.
      checkAll();
    }

    doc.addEventListener('visibilitychange', checkAll);
    // A closed modal uncovers the page behind it without moving it, so the viewport observer says nothing. The page closes
    // its modals in more than one way (dialog.close() drops [open]; Unmatched Studies and the others drop .show or .on;
    // [inert] may be lifted), so the uncovering is watched on those attributes rather than on one close event. Only a cover
    // that went away is a chance: other class changes are not, or every repaint would resend an unconfirmed report.
    let covers = new Set();
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(() => {
      const now = new Set(doc.querySelectorAll(COVERS));
      const lifted = [...covers].some(node => !now.has(node));
      covers = now;
      if (lifted) checkAll();
    }).observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'inert'] });
    return Object.freeze({ open: (surface, subject) => { open(surface, subject); }, watch, end });
  }

  root.KinReportViews = create(root.document);
})(window);
