"""Page defaults for isolated module hosts; the gate and transport are shipped code.

The authority stand-in is only for hosts that already supply a synthetic session.
The real auth authority and its notices are exercised by session_modules_dom_test.py.
"""
from pathlib import Path

HPACS = Path(__file__).resolve().parents[1] / "worklist-v0" / "hpacs-lite"
CORE = "\n".join((HPACS / name).read_text(encoding="utf-8")
                 for name in ("work-context.js", "session-transport.js"))

STANDIN = """
const work = KinWorkContext;
let synLifecycle;
const synSessionId = 'SYN-SESSION-' + (window.synSession?.sub || 'pending');
window.synEnd = () => { synLifecycle({state:'ending', session: synSessionId}); };
Object.assign(KinAuth, {
  onLifecycle(fn) { synLifecycle=fn; fn({state:'active',session:synSessionId}); },
  authFailure(failed) {
    if (failed.session === synSessionId &&
        ['AUTH_SESSION_ENDED','AUTH_SESSION_MISMATCH'].includes(failed.code)) window.synEnd();
  },
});
work.follow(KinAuth);
const transport = KinSessionTransport.page();
"""


def setup_standin(page):
    page.add_script_tag(content=CORE)


def activate(page):
    """Supply the authority's lifecycle in an isolated consumer document."""
    page.add_script_tag(content=CORE)
    page.evaluate("""() => {
      let publish;
      const session='SYN-MODULE-SESSION';
      window.KinAuth={onLifecycle(fn){publish=fn;fn({state:'active',session});},
        authFailure(result){if(result.session===session&&['AUTH_SESSION_ENDED','AUTH_SESSION_MISMATCH'].includes(result.code))publish({state:'ending',session});}};
      window.synEndPage=()=>publish({state:'ending',session});
      KinWorkContext.follow(KinAuth);
    }""")
