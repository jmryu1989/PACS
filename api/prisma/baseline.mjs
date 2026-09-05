/** One-time, data-preserving adoption of the pre-Migrate schema. Never run on boot. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const root = resolve(import.meta.dirname, '..');
const prisma = new PrismaClient({ log: [] });
const meta = JSON.parse(readFileSync(resolve(root, 'prisma/baseline.json'), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');

function cli(args) {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/prisma/build/index.js'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    // Prisma diagnostics may include connection details; report the stage, not credentials.
    const reason = args[1] === 'diff' && result.status === 2 ? 'schema drift detected' : `exit ${result.status}`;
    throw new Error(`Prisma ${args.slice(0, 2).join(' ')} failed: ${reason}`);
  }
}

async function rowCounts() {
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables
    WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const counts = {};
  for (const { tablename } of tables) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(tablename)) throw new Error('Unexpected table identifier');
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM "${tablename}"`);
    counts[tablename] = String(rows[0].n);
  }
  return counts;
}

async function main() {
  const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8').replaceAll('\r\n', '\n');
  const sql = readFileSync(resolve(root, `prisma/migrations/${meta.migration}/migration.sql`));
  const folders = readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (meta.migration !== '0_init' || folders.length !== 1 || folders[0] !== meta.migration
      || sha(schema) !== meta.schema_sha256 || sha(sql) !== meta.sql_sha256) {
    throw new Error('Baseline is only valid for the recorded initial schema and unchanged migration');
  }
  const version = JSON.parse(readFileSync(resolve(root, 'node_modules/prisma/package.json'), 'utf8')).version;
  if (version !== meta.prisma_version) throw new Error('Baseline requires the recorded Prisma version');
  const before = await rowCounts();
  if (!Object.keys(before).length) throw new Error('Empty database: use prisma migrate deploy, never baseline');

  // Compare the live DB before writing migration metadata. Never repair drift automatically.
  cli(['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma',
    '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
  const [{ present }] = await prisma.$queryRaw`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
  let applied = false;
  if (present) {
    const rows = await prisma.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`;
    if (rows.length) {
      if (rows.length !== 1 || rows[0].migration_name !== meta.migration
          || rows[0].checksum !== meta.sql_sha256 || !rows[0].finished_at || rows[0].rolled_back_at) {
        throw new Error('Unexpected migration history: investigate without resetting the database');
      }
      applied = true;
    }
  }
  if (!applied) cli(['migrate', 'resolve', '--applied', meta.migration]);
  if (JSON.stringify(before) !== JSON.stringify(await rowCounts())) {
    throw new Error('Table row counts changed during baseline; investigate concurrent writes');
  }
  console.log(`Baseline ${applied ? 'already recorded' : 'recorded'}: ${meta.migration}; schema matches; existing table row counts unchanged.`);
}

try {
  await main();
} catch (error) {
  // Do not stringify PrismaClient errors, which may contain database details.
  console.error(error?.constructor === Error ? error.message : 'Baseline failed; inspect database connectivity and history.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
