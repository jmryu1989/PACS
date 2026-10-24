"""Shared synthetic wire boundary for the report component browser cases.

U5S-REQ-08/11/15/17 -> RISK-WRONG-SESSION/LOST-DRAFT -> report DOM suites.
The gate, transport and draft client are shipped assets. Only the server is synthetic.
Existing component fixtures supply endpoint outcomes; this boundary owns session admission,
the stored per-study revision and canonical envelopes, including reads after uncertain writes.
"""
from pathlib import Path

LITE = Path(__file__).resolve().parents[1] / "worklist-v0/hpacs-lite"
ASSETS = ("work-context.js", "session-transport.js", "report-draft-client.js", "report-editor-frame.js", "related-report-mode.js")

BOOT = r"""
const work = KinWorkContext;
const contractOwner = {institution:'SYN-INST', sub:'SYN-READER', author:'doctor@kin'};
let contractLifecycle;
work.follow({onLifecycle(fn) { contractLifecycle=fn; fn({state:'active',session:'SYN-SESSION'}); }});
const contractRows = new Map();
const contractFields = ['findings','conclusion','recommendation'];
function contractRow(uid) {
  if (!contractRows.has(uid)) {
    const state = typeof appState === 'undefined' ? {} : appState[uid] || {};
    const draft = state.draft;
    contractRows.set(uid, {revision:0, snapshot:draft ? {
      ...Object.fromEntries(contractFields.map(k=>[k,draft[k] || ''])), baseVersion:draft.baseVersion || 0,
      citations:[], structured:[]
    } : null});
    state.draftRevision='SYNEPOCH:0'; state.draftEpoch='SYNEPOCH';
  }
  return contractRows.get(uid);
}
if (typeof appState !== 'undefined') Object.keys(appState).forEach(contractRow);
const contractEnvelope = uid => {
  const row=contractRow(uid);
  return {uid,owner:contractOwner,revision:`SYNEPOCH:${row.revision}`,present:!!row.snapshot,
    snapshot:structuredClone(row.snapshot),updatedAt:row.snapshot?'2026-10-04T00:00:00.000Z':null};
};
const contractEndpoint = window.fetch;
window.fetch = async (url, init={}) => {
  const path=String(url).replace(/^https?:\/\/[^/]+/,''), method=init.method || 'GET';
  const headers=new Headers(init.headers);
  const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if (path === '/api/me') return response(200,{...contractOwner,actor:contractOwner.author,sessionId:'SYN-SESSION'});
  if (!headers.get('X-KIN-Session')) return response(428,{code:'AUTH_SESSION_REQUIRED'});
  if (headers.get('X-KIN-Session') !== 'SYN-SESSION') return response(409,{code:'AUTH_SESSION_MISMATCH'});
  if (method !== 'GET' && headers.get('X-KIN-CSRF') !== '1') return response(403,{code:'AUTH_CSRF_REQUIRED'});
  const found=path.match(/^\/api\/studies\/([^/]+)\/(draft|report(?:\/commit|\/citations|\/structure)?)$/);
  const uid=found ? decodeURIComponent(found[1]) : null, what=found?.[2];
  if (uid && method==='GET' && (what==='report/citations' || what==='report/structure')) {
    const row=contractRow(uid);
    const seeded = what==='report/citations'
      ? (typeof citeReplies !== 'undefined' ? citeReplies[0] : null)
      : (typeof structReplies !== 'undefined' ? structReplies[0] : null);
    if (row.revision===0 && row.snapshot && Array.isArray(seeded?.draft)) {
      if (what==='report/citations') row.snapshot.citations=seeded.draft.map(e=>e.cid);
      else row.snapshot.structured=seeded.draft.map(e=>e.sid);
    }
  }
  if (uid && method==='GET' && what==='draft') {
    const row=contractRow(uid);
    // The dedicated reads and the draft read describe the same fixture state.
    if (row.revision===0 && row.snapshot) {
      if (typeof citeReplies !== 'undefined' && citeReplies[0]?.draft)
        row.snapshot.citations=citeReplies[0].draft.map(e=>e.cid);
      if (typeof structReplies !== 'undefined' && structReplies[0]?.draft)
        row.snapshot.structured=structReplies[0].draft.map(e=>e.sid);
    }
    return response(200,contractEnvelope(uid));
  }
  const sent=uid && method!=='GET' ? JSON.parse(init.body) : null;
  if (sent) {
    if (!sent.expectedOwner || !sent.expectedRevision) return response(400,{code:'REPORT_DRAFT_PRECONDITION_REQUIRED'});
    if (['institution','sub','author'].some(k=>sent.expectedOwner[k]!==contractOwner[k])) return response(409,{code:'REPORT_DRAFT_OWNER_CHANGED'});
    if (sent.expectedRevision!==contractEnvelope(uid).revision) return response(409,{code:'REPORT_DRAFT_CONFLICT'});
  }
  const result=await contractEndpoint(url,init);
  if (result instanceof Response) return result;
  if (typeof result.text === 'function') return new Response(await result.text(),{status:result.status});
  let body;
  try { body=await result.json(); } catch (_) { return new Response('',{status:result.status}); }
  // A list or bootstrap answer names each study's stored draft boundary, as the server's does.
  if (result.ok && !uid && method==='GET' && body && body.states && typeof body.states==='object')
    for (const [id,state] of Object.entries(body.states))
      if (state && state.draftRevision===undefined) state.draftRevision=contractEnvelope(id).revision;
  if (!result.ok || !uid) return response(result.status,body);
  const row=contractRow(uid);
  if (method==='GET') return response(result.status,{...body,draftRevision:contractEnvelope(uid).revision});
  if (method==='PUT') {
    if ([...contractFields,'baseVersion','citationIds','structureIds'].some(k=>!(k in sent)))
      return response(400,{code:'REPORT_DRAFT_PRECONDITION_REQUIRED'});
    row.snapshot=contractFields.some(k=>sent[k]) ? {...Object.fromEntries(contractFields.map(k=>[k,sent[k]])),
      baseVersion:sent.baseVersion,citations:[...sent.citationIds],structured:[...sent.structureIds]} : null;
    if (row.snapshot && body.inserted?.cid) row.snapshot.citations.push(body.inserted.cid);
    const applied=body.applied;
    if (row.snapshot && applied?.sid) row.snapshot.structured=[...row.snapshot.structured.filter(sid=>sid!==sent.structure?.replacesSid),applied.sid];
    row.revision++;
    return response(200,{...contractEnvelope(uid),inserted:body.inserted,applied});
  }
  row.snapshot=null; row.revision++;
  return response(200,{...contractEnvelope(uid),state:{...body,draft:null,draftRevision:contractEnvelope(uid).revision}});
};
KinAuth.authFailure = failed => {
  if (failed.session === 'SYN-SESSION') contractLifecycle({state:'confirmed',session:'SYN-SESSION'});
};
const transport = KinSessionTransport.page();
function staleAnswer() { return Object.assign(new Error('stale'),{name:'AbortError'}); }
function onSessionEnd() {}
function onCommonEnd() {}
// W5 Phase B: the page always mounts its Related Report mode (order-list-store.js) and the sliced report region calls it
// (refresh, blocked, admits, noticeDiscard, announce). A fixture declares the page's `relatedMode` binding; the contract
// mounts the shipped module on main.html's own mode markup (install_contract) over the fixture's report fields. It stays
// inactive here: entering it is the complete page's (tests/related_report_mode_dom_test.py).
if (typeof relatedMode !== 'undefined' && relatedMode === null)
  relatedMode = KinRelatedReportMode({ editor: () => document.querySelector('.redit') ?? document.getElementById('findings').parentElement,
    field: name => document.getElementById(name) });
"""


def _page_markup(start, end):
    """One element of the delivered main.html, cut from its opening marker through its closing tag."""
    page = (LITE / 'main.html').read_text(encoding='utf-8')
    at = page.index(start)
    return page[at:page.index(end, at) + len(end)]


def install_contract(html):
    """Load the same assets for every component; no product source is modified."""
    # W4: the sliced report region registers the Notice controls and Approve & Next and draws the hidden-Recommendation
    # notice from its draft bar. A fixture that carries the draft bar / the Approve button carries these as the page has them.
    if 'id="draftbar"' in html and 'id="report-notice"' not in html:
        notice = _page_markup('<div class="draftbar" id="report-notice"', '</button>\n        </div>')
        recnote = _page_markup('<details class="recnote" id="recnote"', '</details>')
        at = html.rindex('<', 0, html.index('id="draftbar"'))
        html = html[:at] + notice + recnote + html[at:]
    if 'id="b-approve"' in html and 'id="b-approve-next"' not in html:
        at = html.index('id="b-approve"')
        at = html.rindex('<', 0, at)
        html = html[:at] + _page_markup('<button class="approve" id="b-approve-next"', '</button>') + html[at:]
    # W5 Phase B: main.html's Related Report mode markup (the mode mounts on it) and the Notice's Discard Insert, as the page has
    # them, for a fixture that slices the report region without them.
    if 'let relatedMode = null;' in html:
        if 'id="report-notice-discard"' not in html:
            at = html.index('<script', html.index('<body'))
            html = html[:at] + _page_markup('<button id="report-notice-discard"', '</button>') + html[at:]
        if 'id="related-mode"' not in html:
            at = html.index('<script', html.index('<body'))
            html = html[:at] + _page_markup('<section id="related-mode"', '</section>') + html[at:]
    scripts = ''.join('<script>' + (LITE / asset).read_text(encoding='utf-8') + '</script>' for asset in ASSETS)
    html = html.replace('<head>', '<head>' + scripts, 1)
    # Fixtures retain their endpoint-specific fault injection, which is installed before BOOT.
    html = html.replace('APIFN', BOOT + '\nAPIFN', 1)
    # A component fixture writes its own draft bar; the page's bar also carries the conflict choice (Keep This Text, Load
    # Server Draft) and View Approved Report, whose listeners the sliced report region registers at load.
    for control in ('b-draft-keep', 'b-draft-load', 'b-approved-view'):
        if 'id="draftbar"' in html and f'id="{control}"' not in html:
            html = html.replace('<button id="b-report-reload"', f'<button id="{control}"></button><button id="b-report-reload"', 1)
    return html.replace('</body>', '<script>if (typeof draftOwner !== "undefined") draftOwner = contractOwner; '
                        'if (typeof markSelectionChanged === "function") markSelectionChanged(selectedUid);'
                        'else if (typeof selectedUid !== "undefined") work.select(selectedUid);</script></body>')


def bind_api_fixture(page, api_source):
    """Connect a manually settled endpoint fixture to the shipped page API/transport.

    Used by the identity correction cases: their pending response controls remain
    server controls, while issuance and error translation are the product's.
    """
    page.add_script_tag(content=(LITE / 'session-transport.js').read_text(encoding='utf-8'))
    page.add_script_tag(content=r"""
const API='/api', endpointApi=api, identityWireRequests=[];
const transport=KinSessionTransport.create({gate:work, fetch:async (url,init) => {
  const headers=new Headers(init.headers);
  identityWireRequests.push({url,session:headers.get('X-KIN-Session')});
  if (!headers.get('X-KIN-Session')) return new Response(JSON.stringify({code:'AUTH_SESSION_REQUIRED'}),{status:428});
  if (headers.get('X-KIN-Session')!=='SYN-SESSION') return new Response(JSON.stringify({code:'AUTH_SESSION_MISMATCH'}),{status:409});
  try {
    const value=await endpointApi(init.method,String(url).slice(API.length),init.body?JSON.parse(init.body):undefined);
    return new Response(JSON.stringify(value),{status:200});
  } catch (error) {
    return new Response(JSON.stringify({message:error.message,code:error.code}),{status:error.status || 500});
  }
}});
function staleAnswer(){return Object.assign(new Error('stale'),{name:'AbortError'});}
""" + '\napi = ' + api_source + ';')
