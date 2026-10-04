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
const path = '/app/dist/auth.service.js';
let source = fs.readFileSync(path, 'utf8');
if (input.mutant) {
  const line = "const last = await this.endByRequest(sid, session, 'logout', this.requestIp(req));";
  if (source.split(line).length !== 2) throw Error('Mutation anchor changed');
  source = source.replace(line, 'await this.idpLogout(session.refreshToken); ' + line);
}
const copy = new Module(path, module);
copy.filename = path;
copy.paths = Module._nodeModulePaths('/app/dist');
copy._compile(source, path);
const { AuthService } = copy.exports;
(async () => {
  const db = new PrismaService(), observer = new PrismaService();
  await db.$connect(); await observer.$connect();
  const auth = new AuthService(db);
  const sid = auth.sessionId({headers:{cookie:'kin_sid=' + input.cookie}});
  const baseline = await observer.auditLog.count({where:{target:input.sub,action:'auth.logout'}});
  const realFetch = global.fetch;
  const observations = [], pending = [];
  global.fetch = (url, init) => {
    const observed = (async () => {
      if (!String(url).endsWith('/logout')) throw Error('Unexpected IdP request');
      // Separate connection: an uncommitted deletion/audit cannot satisfy this read.
      const sessions = await observer.authSession.count({where:{sid}});
      const audits = await observer.auditLog.count({where:{target:input.sub,action:'auth.logout'}});
      observations.push({sessions,audits:audits-baseline});
      return realFetch(url, init);
    })();
    pending.push(observed);
    return observed;
  };
  try {
    await auth.logout({sid,headers:{'x-real-ip':'127.0.0.1'}});
    await Promise.allSettled(pending);
    console.log(JSON.stringify({observations}));
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
        observed = json.loads(result.stdout)["observations"]
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
