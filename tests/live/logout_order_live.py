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
from session_support import Session, SessionStack, cleanup_sessions
from invariants_live import ROOT


# B2 owns the service/ledger composition; the admin HTTP request-facts adapter
# belongs to REQUEST_FACTS (D1794/D1806). Prepare owned identities through the
# real service here, so this logout-order suite does not depend on that adapter.
PREPARE_MEMBER = r"""
const { PrismaService } = require('/app/dist/prisma.service');
const { KeycloakService } = require('/app/dist/keycloak.service');
const { AdminService } = require('/app/dist/admin.service');
const { AuthService } = require('/app/dist/auth.service');
const { EmrRuntime } = require('/app/dist/emr-runtime/application');
(async () => {
  const db = new PrismaService(), kc = new KeycloakService();
  const runtime = new EmrRuntime(process.env.DATABASE_URL, '/tmp/logout-setup-' + input.sub);
  try {
    await db.$connect(); await runtime.start();
    const admin = await db.memberRights.findFirst({where:{approved:true,suspended:false,roles:{has:'admin'}}});
    if (!admin) throw Error('Imported fixture administrator missing');
    const work = runtime.port.begin();
    let actor;
    try { actor = {issuer:process.env.KC_ISSUER,subject:admin.sub,
      id:await work.resolveRequestIdentity(process.env.KC_ISSUER,admin.sub)}; }
    finally { work.end(); }
    const auth = new AuthService(db,kc,runtime.port,runtime.background.work);
    const service = new AdminService(db,kc,null,auth,runtime.port);
    const result = await service.patchUser(input.sub,input.changes,
      {sub:admin.sub,actor:admin.email || admin.username,roles:admin.roles,institution:admin.institution},
      {actor,roles:admin.roles,rightsVersion:admin.version,institution:admin.institution,
       ip:null,sessionRef:null,requestId:require('node:crypto').randomUUID(),surface:'PATCH admin/users/:id'});
    await runtime.background.drained();
    console.log('MEMBER ' + JSON.stringify(result));
  } finally { await runtime.stop(Date.now()+15000); await db.$disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode=1; });
"""


class LogoutFixtureStack(SessionStack):
    def set_member_rights(self, user_id, **changes):
        if user_id not in self.user_ids.values():
            raise RuntimeError('Logout fixture can prepare only its own identities')
        script = 'const input = ' + json.dumps({'sub': user_id, 'changes': changes}) + ';\n' + PREPARE_MEMBER
        result = subprocess.run(['docker', 'compose', 'exec', '-T', 'api', 'node'], cwd=ROOT,
                                input=script, capture_output=True, text=True, encoding='utf-8', timeout=60)
        if result.returncode:
            raise RuntimeError('Logout fixture member preparation failed: ' + result.stderr[-500:])
        rows = [line[7:] for line in result.stdout.splitlines() if line.startswith('MEMBER ')]
        if len(rows) != 1:
            raise RuntimeError('Logout fixture member preparation returned no result')
        return json.loads(rows[0])


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
  const { EmrRuntime } = require('/app/dist/emr-runtime/application');
  const runtime = new EmrRuntime(process.env.DATABASE_URL, '/tmp/logout-order-' + input.sub);
  await runtime.start();
  const auth = new AuthService(db, new KeycloakService(), runtime.port, runtime.background.work);
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
    await runtime.stop(Date.now() + 15000);
    await db.$disconnect(); await observer.$disconnect();
  }
})().catch(() => { console.error('Logout order probe failed (details withheld)'); process.exitCode=1; });
"""


class LogoutOrderLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = LogoutFixtureStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cleanup_sessions, cls.stack)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()

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
