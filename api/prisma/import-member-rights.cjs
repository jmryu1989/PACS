'use strict';
// Deployment step after migrate deploy, while member writes/traffic are stopped.
// Uses the deployment's configured database and Keycloak; never run against an unspecified realm.
for (const name of ['DATABASE_URL', 'KC_ADMIN_URL', 'KC_REALM', 'KC_ISSUER', 'KC_CLIENT_ID', 'KC_CLIENT_SECRET']) {
  if (!process.env[name]) throw new Error('Missing import setting: ' + name);
}
const { PrismaService } = require('../dist/prisma.service');
const { KeycloakService } = require('../dist/keycloak.service');
const { importMemberRights, retryMemberRoster } = require('../dist/member-rights-import');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--retry-roster')) throw new Error('Usage: import-member-rights.cjs [--retry-roster]');
const db = new PrismaService();
(async () => {
  try {
    if (args[0] === '--retry-roster') {
      const result = await retryMemberRoster(db, new KeycloakService());
      process.stdout.write(JSON.stringify(result) + '\n');
      if (result.unconfirmed) process.exitCode = 1;
    } else {
      const imported = await importMemberRights(db, new KeycloakService());
      await imported?.publication;
      process.stdout.write('Member rights import completed; roster outcomes are recorded separately\n');
    }
  }
  catch { process.stderr.write('Member rights import/roster operation failed; inspect the recorded outcome\n'); process.exitCode = 1; }
  finally { await db.$disconnect(); }
})();
