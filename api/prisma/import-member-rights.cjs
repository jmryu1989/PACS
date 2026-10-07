'use strict';
// Deployment step after migrate deploy, while member writes/traffic are stopped.
// Uses the deployment's configured database and Keycloak; never run against an unspecified realm.
for (const name of ['DATABASE_URL', 'KC_ADMIN_URL', 'KC_REALM', 'KC_ISSUER', 'KC_CLIENT_ID', 'KC_CLIENT_SECRET']) {
  if (!process.env[name]) throw new Error('Missing import setting: ' + name);
}
const { PrismaService } = require('../dist/prisma.service');
const { KeycloakService } = require('../dist/keycloak.service');
const { importMemberRights } = require('../dist/member-rights-import');
const db = new PrismaService();
(async () => {
  try { await importMemberRights(db, new KeycloakService()); process.stdout.write('Member rights import completed\n'); }
  catch { process.stderr.write('Member rights import failed; traffic must remain stopped\n'); process.exitCode = 1; }
  finally { await db.$disconnect(); }
})();
