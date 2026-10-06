"""U5S-REQ-05/26 -> U5S-RISK-AUDIT/SESSION/EVIDENCE -> S05 exact IdP invocation order.

Companion to the HTTP 204 test: load this stack's compiled AuthService in its API
container with the real Prisma/database and Keycloak. Observe committed rows from
a second DB client immediately before forwarding the actual IdP fetch. No storage
mock and no source/runtime-server modification. The mutant is an in-memory copy.
"""
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_support import Session, setup_stack
from invariants_live import ROOT


PROBE = r"""
const fs = require('node:fs');
const Module = require('node:module');
const { PrismaService } = require('/app/dist/prisma.service');
const { KeycloakService } = require('/app/dist/keycloak.service');
const path = '/app/dist/auth.service.js';
let source = fs.readFileSync(path, 'utf8');
if (input.mutant) {
  // The Log out's own end commit; the mutant asks the provider to end the SSO session before it. The end call takes
  // a token deadline as an AbortSignal (D600): a bare number makes the token fetch throw, nothing is sent, and the
  // mutant would be inert. Same bound the product's recorded end uses.
  const call = "await this.endByRequest(sid, session, 'logout', ";
  if (source.split(call).length !== 2) throw Error('Mutation anchor changed');
  source = source.replace(call, 'await this.keycloak.endSession(this.idpSidOf(session), AbortSignal.timeout(IDP_END_MS)) && ' + call);
}
const copy = new Module(path, module);
copy.filename = path;
copy.paths = Module._nodeModulePaths('/app/dist');
copy._compile(source, path);
const { AuthService } = copy.exports;
(async () => {
  const db = new PrismaService(), observer = new PrismaService();
  await db.$connect(); await observer.$connect();
  // The product's wiring: one Nest provider each, no constructor arguments, the container's environment.
  const auth = new AuthService(db, new KeycloakService());
  const sid = auth.sessionId({headers:{cookie:'kin_sid=' + input.cookie}});
  const row = await observer.authSession.findUnique({where:{sid}});
  if (!row || !row.idpSid) throw Error('The logged-in session must name its provider session');
  const endPath = '/sessions/' + encodeURIComponent(row.idpSid);
  const baseline = await observer.auditLog.count({where:{target:input.sub,action:'auth.logout'}});
  const realFetch = global.fetch;
  const observations = [], pending = [];
  global.fetch = (url, init) => {
    const target = String(url), method = (init && init.method) || 'GET';
    // The service-account token grant only authorises the end request; it ends nothing.
    if (method === 'POST' && target.endsWith('/protocol/openid-connect/token')) return realFetch(url, init);
    const observed = (async () => {
      if (method !== 'DELETE' || !target.endsWith(endPath)) throw Error('Unexpected IdP request');
      // Separate connection: an uncommitted deletion/audit cannot satisfy this read.
      const sessions = await observer.authSession.count({where:{sid}});
      const audits = await observer.auditLog.count({where:{target:input.sub,action:'auth.logout'}});
      observations.push({sessions,audits:audits-baseline});
      return realFetch(url, init);
    })();
    pending.push(observed);
    return observed;
  };
  const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end && !(await done()); ) await new Promise(r => setTimeout(r, 50)); };
  try {
    await auth.logout({sid,headers:{'x-real-ip':'127.0.0.1'}});
    // The answer does not wait for Keycloak: wait (bounded) for this session's post-commit provider end and its recorded answer.
    await until(() => observations.some(o => o.sessions === 0), 10000);
    await Promise.allSettled(pending);
    await until(async () => !!(await observer.idpSessionEnd.findUnique({where:{idpSid:row.idpSid}}))?.confirmedAt, 5000);
    console.log('ORDER ' + JSON.stringify({observations}));
  } finally {
    global.fetch = realFetch;
    await db.$disconnect(); await observer.$disconnect();
  }
})().catch(() => { console.error('Logout order probe failed (details withheld)'); process.exitCode=1; });
"""


class LogoutOrderLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        setup_stack(cls)

    def probe(self, mutant):
        session = Session(self.stack).login(self)
        script = "const input = " + json.dumps({"cookie": session.sid(), "sub": session.me["sub"], "mutant": mutant}) + ";\n" + PROBE
        result = subprocess.run(["docker", "compose", "exec", "-T", "api", "node"], cwd=ROOT,
                                input=script, capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(result.returncode, 0, "The order probe must execute; a harness error is not evidence")
        # The probe prints one ORDER line; anything else on stdout (a warning of the service) is not the result.
        lines = [line for line in result.stdout.splitlines() if line.startswith("ORDER ")]
        self.assertEqual(len(lines), 1, "One order result")
        observed = json.loads(lines[0][len("ORDER "):])["observations"]
        self.assertTrue(observed, "The real IdP call must have been observed")
        return observed

    def test_revocation_and_audit_visible_before_real_idp_fetch(self):
        self.assertEqual(self.probe(False), [{"sessions": 0, "audits": 1}])

    def test_mutant_idp_before_revocation_is_detected(self):
        observed = self.probe(True)
        self.assertEqual(observed[0], {"sessions": 1, "audits": 0}, "The wrong order must be witnessed before the mutation commits")
        with self.assertRaises(AssertionError):
            self.assertEqual(observed, [{"sessions": 0, "audits": 1}])
        print("U5-MUTANT M04 killed: IdP invocation preceded committed revocation/audit")


if __name__ == "__main__":
    unittest.main(verbosity=2)
