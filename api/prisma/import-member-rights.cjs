'use strict';
// Deployment step after migrate deploy, while member writes/traffic are stopped.
// Uses the deployment's configured database and Keycloak; never run against an unspecified realm.
for (const name of ['DATABASE_URL', 'KC_ADMIN_URL', 'KC_REALM', 'KC_ISSUER', 'KC_CLIENT_ID', 'KC_CLIENT_SECRET']) {
  if (!process.env[name]) throw new Error('Missing import setting: ' + name);
}
const { PrismaService } = require('../dist/prisma.service');
const { KeycloakService } = require('../dist/keycloak.service');
const { importMemberRights, retryMemberRoster } = require('../dist/member-rights-import');
const { EmrRuntime } = require('../dist/emr-runtime/application');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--retry-roster')) throw new Error('Usage: import-member-rights.cjs [--retry-roster]');
const db = new PrismaService();
let runtime;
(async () => {
  try {
    if (args[0] === '--retry-roster') {
      const result = await retryMemberRoster(db, new KeycloakService());
      process.stdout.write(JSON.stringify(result) + '\n');
      if (result.unconfirmed) process.exitCode = 1;
    } else {
      if (!process.env.KIN_EMR_STATE_DIR) throw new Error('Missing failure journal directory');
      runtime = new EmrRuntime(process.env.DATABASE_URL, join(process.env.KIN_EMR_STATE_DIR, 'outage'));
      await runtime.start();
      const imported = await importMemberRights(db, new KeycloakService(), runtime.port);
      await imported?.publication;
      process.stdout.write('Member rights import completed; roster outcomes are recorded separately\n');
    }
  }
  catch { process.stderr.write('Member rights import/roster operation failed; inspect the recorded outcome\n'); process.exitCode = 1; }
  finally {
    try { if (runtime) await runtime.stop(Date.now() + 5000); }
    catch { process.stderr.write('Member rights ledger cleanup failed\n'); process.exitCode = 1; }
    finally { await db.$disconnect(); }
  }
})();
