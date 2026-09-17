"""TEST-D05B-MIGRATION: additive SQL, failed DDL rollback, full display-history restore.

All databases/containers are disposable and labelled. Optional old-image evidence
uses the actual retained pre-change Prisma client; it never replaces the live API.
"""
from __future__ import annotations
import hashlib,json,os,subprocess,sys,tempfile,time,unittest,uuid
from pathlib import Path
import ops_product_transfer_fixture as transfer
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import ops_backup as ops
ROOT=Path(__file__).resolve().parents[1]

class ViewerMigration(unittest.TestCase):
    def test_findings_additive_restrict_owner_key_and_failed_ddl(self):
        """TEST-S2-MIGRATION: additive finding tables, request receipt key, RESTRICT and rollback."""
        index=next(i for i,p in enumerate(transfer.MIGRATIONS) if '20260917120000_findings' in p)
        self.create('findings_before')
        for source in self.sources[:index]:self.sql('findings_before',source)
        item='00000000-0000-4000-8000-000000000001'
        self.sql('findings_before','INSERT INTO "StudyState" (uid,"institutionId","updatedAt") VALUES '+f"('{self.uid}','SYNTHETIC-hospital','2026-09-17'); "+
                 'INSERT INTO "ViewerItem" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt") VALUES '+
                 f"('{item}','{self.uid}','SYNTHETIC-sub','SYNTHETIC-reader',1,false,'{{\"schemaVersion\":1,\"kind\":\"key\",\"seriesUid\":\"2.25.1\",\"sopUid\":\"2.25.2\",\"frame\":1,\"title\":\"SYNTHETIC key\",\"description\":\"\",\"hidden\":false}}','2026-09-17')")
        tables=self.sql('findings_before',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        def old():return {name:self.sql('findings_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}
        before=old()
        # A failed statement inside the additive transaction must leave no finding table behind.
        broken=self.sources[index].decode().replace('COMMIT;','SELECT * FROM s2a_nonexistent_relation; COMMIT;')
        self.sql('findings_before',broken,success=False);self.assertEqual(old(),before)
        self.assertEqual(self.sql('findings_before',"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Finding%'"),'0')
        self.sql('findings_before',self.sources[index]);self.assertEqual(old(),before)
        self.sql('findings_before',self.sources[index],success=False);self.assertEqual(old(),before)
        self.assertEqual(self.sql('findings_before',"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Finding%'"),'2')
        finding='00000000-0000-4000-8000-000000000a01'
        snapshot=('{"schemaVersion":1,"title":"SYNTHETIC finding","text":"","hidden":false,"primary":0,"sources":[{"itemId":"'+item+
                  '","revision":1,"studyUid":"'+self.uid+'","kind":"key","seriesUid":"2.25.1","sopUid":"2.25.2","frame":1,"frameOfReferenceUid":null,'
                  '"label":"SYNTHETIC key","values":null,"calculator":null,"sourceDigest":null,"authorActor":"SYNTHETIC-reader"}]}')
        self.sql('findings_before','INSERT INTO "Finding" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt") VALUES '+
                 f"('{finding}','{self.uid}','SYNTHETIC-sub','SYNTHETIC-reader',1,false,'{snapshot}','2026-09-17')")
        row=('INSERT INTO "FindingRevision" ("findingId",revision,snapshot,action,reason,actor,"authorSub","requestId",fingerprint,"payloadBytes") VALUES '+
             f"('{finding}',1,'{snapshot}','create','','SYNTHETIC-reader','SYNTHETIC-sub','00000000-0000-4000-8000-000000000b01',repeat('a',64),octet_length(convert_to('{snapshot}'::jsonb::text,'UTF8')))")
        self.sql('findings_before',row)
        # The request receipt is unique per author; the same request id from another author is a different receipt.
        self.sql('findings_before',row.replace("',1,'","',2,'"),success=False)
        self.sql('findings_before',row.replace("',1,'","',2,'").replace('SYNTHETIC-sub','SYNTHETIC-other'))
        self.assertEqual(self.sql('findings_before','SELECT count(*) FROM "FindingRevision"'),'2')
        def findings():return {name:self.sql('findings_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in ('Finding','FindingRevision')}
        kept=findings()
        # Byte equality, action vocabulary, source bounds and fingerprint shape fail closed.
        self.sql('findings_before','UPDATE "FindingRevision" SET "payloadBytes"="payloadBytes"+1',success=False)
        self.sql('findings_before',"UPDATE \"FindingRevision\" SET action='delete'",success=False)
        self.sql('findings_before',"UPDATE \"FindingRevision\" SET fingerprint='SYNTHETIC'",success=False)
        self.sql('findings_before',"UPDATE \"Finding\" SET snapshot=snapshot-'sources'",success=False)
        self.sql('findings_before',"UPDATE \"Finding\" SET snapshot=jsonb_set(snapshot,'{sources}','[]'::jsonb)",success=False)
        self.sql('findings_before','UPDATE "Finding" SET revision=1001',success=False)
        # Every invalid head and history shape is refused by its own snapshot CHECK, never passed as
        # UNKNOWN nor failed by another error. History rows get a recomputed payloadBytes so only the
        # shape can refuse them. An aggregate whose argument names only the UPDATE row belongs to the
        # UPDATE itself, which PostgreSQL refuses, so repeated sources are built without one.
        def repeated(count):return "jsonb_set(snapshot,'{sources}',jsonb_build_array("+','.join(["snapshot->'sources'->0"]*count)+'))'
        nine=repeated(9)
        for shape in ["snapshot-'sources'","(snapshot-'sources')||jsonb_build_object('Sources',snapshot->'sources')",
                      "jsonb_set(snapshot,'{sources}','null')","jsonb_set(snapshot,'{sources}','{}')",
                      "jsonb_set(snapshot,'{sources}','\"SYNTHETIC\"')","jsonb_set(snapshot,'{sources}','1')",
                      "jsonb_set(snapshot,'{sources}','[]')",nine,
                      "'null'::jsonb","'\"SYNTHETIC\"'::jsonb","jsonb_build_array(snapshot)"]:
            self.refuses('findings_before',f'UPDATE "Finding" SET snapshot={shape}','Finding_snapshot_check')
            self.refuses('findings_before',f'''UPDATE "FindingRevision" SET snapshot={shape},"payloadBytes"=octet_length(convert_to(({shape})::text,'UTF8'))''',
                         'FindingRevision_snapshot_check')
        self.refuses('findings_before',"UPDATE \"Finding\" SET snapshot=jsonb_set(snapshot,'{title}',to_jsonb(repeat('x',65536)))",'Finding_snapshot_check')
        self.refuses('findings_before','INSERT INTO "Finding" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt") VALUES '+
                     f"('00000000-0000-4000-8000-000000000a02','{self.uid}','SYNTHETIC-sub','SYNTHETIC-reader',1,false,"
                     "'{\"schemaVersion\":1,\"title\":\"SYNTHETIC\",\"text\":\"\",\"hidden\":false,\"primary\":0}','2026-09-17')",'Finding_snapshot_check')
        # SQL NULL never reaches a CHECK: NOT NULL refuses it on both tables.
        for table in ('Finding','FindingRevision'):
            self.sql('findings_before',f'''DO $probe$ BEGIN UPDATE "{table}" SET snapshot=NULL; RAISE EXCEPTION 'SYNTHETIC write accepted';
EXCEPTION WHEN not_null_violation THEN NULL; END $probe$''')
        # The fail-closed form still admits a valid upper bound on both rows; the probe is rolled back.
        eight=repeated(8)
        self.assertEqual(self.sql('findings_before',f'''BEGIN; UPDATE "Finding" SET snapshot={eight};
UPDATE "FindingRevision" SET snapshot={eight},"payloadBytes"=octet_length(convert_to(({eight})::text,'UTF8'));
SELECT (SELECT count(*) FROM "Finding" WHERE jsonb_array_length(snapshot->'sources')=8)||','||(SELECT count(*) FROM "FindingRevision" WHERE jsonb_array_length(snapshot->'sources')=8); ROLLBACK;'''),'1,2')
        # Parent and history rows are protected; hiding is a revision, not a delete.
        self.sql('findings_before',f'''DELETE FROM "StudyState" WHERE uid='{self.uid}' ''',success=False)
        self.sql('findings_before','DELETE FROM "Finding"',success=False)
        self.sql('findings_before','DELETE FROM "ViewerItem"',success=False)
        self.assertEqual(old(),before)
        self.assertEqual(findings(),kept)

    def test_findings_action_check_survives_pg_dump_restore(self):
        """Actual dump/restore evidence for the action CHECK: the shipped explicit-text form must deparse
        identically after pg_restore; the legacy IN-list form on character varying is observed and
        reported, not asserted either way."""
        legacy='CREATE TABLE "ProbeLegacy" ("action" VARCHAR(16) NOT NULL, CONSTRAINT "ProbeLegacy_action_check" CHECK ("action" IN (\'create\',\'edit\',\'hide\',\'restore\')))'
        current='CREATE TABLE "ProbeCurrent" ("action" VARCHAR(16) NOT NULL, CONSTRAINT "ProbeCurrent_action_check" CHECK ("action"::text = ANY (ARRAY[\'create\'::text,\'edit\'::text,\'hide\'::text,\'restore\'::text])))'
        self.create('check_probe'); self.sql('check_probe',legacy+'; '+current)
        query='''SELECT c.relname||' '||pg_get_constraintdef(k.oid,true) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relname LIKE 'Probe%' AND k.contype='c' ORDER BY c.relname'''
        before=self.sql('check_probe',query).splitlines()
        self.create('check_probe_restored')
        with tempfile.TemporaryDirectory(prefix='kin-check-probe-') as folder:
            path=Path(folder)/'probe.dump'
            with path.open('wb') as out:subprocess.run(['docker','exec',self.db,'pg_dump','-U','postgres','-Fc','check_probe'],stdout=out,check=True,timeout=30)
            with path.open('rb') as incoming:subprocess.run(['docker','exec','-i',self.db,'pg_restore','-U','postgres','-d','check_probe_restored','--no-owner','--no-privileges','--exit-on-error'],stdin=incoming,check=True,timeout=30)
        after=self.sql('check_probe_restored',query).splitlines()
        self.assertEqual(len(before),2); self.assertEqual(len(after),2)
        print('ACTION-CHECK legacy before:',before[1]); print('ACTION-CHECK legacy after: ',after[1])
        print('ACTION-CHECK current before:',before[0]); print('ACTION-CHECK current after: ',after[0])
        self.assertEqual(after[0],before[0],'the shipped explicit-text CHECK must survive pg_dump/pg_restore unchanged')
        source=(ROOT/'api/prisma/migrations/20260917120000_findings/migration.sql').read_text(encoding='utf-8')
        self.assertIn('''CHECK ("action"::text = ANY (ARRAY['create'::text,'edit'::text,'hide'::text,'restore'::text]))''',source)
        for value,ok in [('create',True),('delete',False)]:
            self.sql('check_probe_restored',f'''INSERT INTO "ProbeCurrent" VALUES ('{value}')''',success=ok)

    def test_workspace_shortcuts_additive_and_owner_key(self):
        index=next(i for i,p in enumerate(transfer.MIGRATIONS) if '20260910044500_workspace_shortcuts' in p)
        self.create('shortcuts_before')
        for source in self.sources[:index]:self.sql('shortcuts_before',source)
        self.sql('shortcuts_before', '''INSERT INTO "ReadingPreferences" (institution,subject,revision,"autoNote","updatedAt") VALUES ('SYNTHETIC-hospital','SYNTHETIC-sub',1,true,'2026-09-10')''')
        tables=self.sql('shortcuts_before',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        def old():return {name:self.sql('shortcuts_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}
        before=old();self.sql('shortcuts_before',self.sources[index]);self.assertEqual(old(),before)
        self.sql('shortcuts_before',self.sources[index],success=False);self.assertEqual(old(),before)
        row='''INSERT INTO "WorkspaceShortcuts" (institution,subject,revision,bindings,"updatedAt") VALUES ('SYNTHETIC-hospital','SYNTHETIC-sub',1,'{"version":1,"list":16,"current":18,"prior":20}','2026-09-10')'''
        self.sql('shortcuts_before',row);self.sql('shortcuts_before',row,success=False)
        self.sql('shortcuts_before',row.replace('SYNTHETIC-hospital','SYNTHETIC-other'))
        self.assertEqual(self.sql('shortcuts_before','SELECT count(*) FROM "WorkspaceShortcuts"'),'2');self.assertEqual(old(),before)

    def test_reading_appearance_additive_and_owner_key(self):
        index=next(i for i,p in enumerate(transfer.MIGRATIONS) if '20260910023000_reading_appearance' in p)
        self.create('appearance_before')
        for source in self.sources[:index]:self.sql('appearance_before',source)
        self.sql('appearance_before', '''INSERT INTO "ReadingPreferences" (institution,subject,revision,"autoNote","updatedAt") VALUES ('SYNTHETIC-hospital','SYNTHETIC-sub',1,true,'2026-09-10')''')
        tables=self.sql('appearance_before',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        def old():return {name:self.sql('appearance_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}
        before=old();self.sql('appearance_before',self.sources[index]);self.assertEqual(old(),before)
        self.sql('appearance_before',self.sources[index],success=False);self.assertEqual(old(),before)
        row='''INSERT INTO "ReadingAppearance" (institution,subject,revision,sizes,"updatedAt") VALUES ('SYNTHETIC-hospital','SYNTHETIC-sub',1,'{"version":1,"list":16,"current":18,"prior":20}','2026-09-10')'''
        self.sql('appearance_before',row);self.sql('appearance_before',row,success=False)
        self.sql('appearance_before',row.replace('SYNTHETIC-hospital','SYNTHETIC-other'))
        self.assertEqual(self.sql('appearance_before','SELECT count(*) FROM "ReadingAppearance"'),'2');self.assertEqual(old(),before)

    def test_reading_preferences_additive_and_owner_key(self):
        index=next(i for i,p in enumerate(transfer.MIGRATIONS) if '20260910013000_reading_preferences' in p)
        self.create('preferences_before')
        for source in self.sources[:index]:self.sql('preferences_before',source)
        self.sql('preferences_before', '''INSERT INTO "WorkspaceLayout" (institution,subject,revision,value,"updatedAt") VALUES ('SYNTHETIC-hospital','SYNTHETIC-sub',3,'{}','2026-09-10')''')
        tables=self.sql('preferences_before',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        def old():return {name:self.sql('preferences_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}
        before=old();self.sql('preferences_before',self.sources[index]);self.assertEqual(old(),before)
        self.sql('preferences_before',self.sources[index],success=False);self.assertEqual(old(),before)
        row='''INSERT INTO "ReadingPreferences" (institution,subject,revision,"autoNote","updatedAt") VALUES ('SYNTHETIC-hospital','SYNTHETIC-sub',1,true,'2026-09-10')'''
        self.sql('preferences_before',row);self.sql('preferences_before',row,success=False)
        self.sql('preferences_before',row.replace('SYNTHETIC-hospital','SYNTHETIC-other'))
        self.assertEqual(self.sql('preferences_before','SELECT count(*) FROM "ReadingPreferences"'),'2');self.assertEqual(old(),before)

    def test_tech_note_additive_and_restrict(self):
        index=next(i for i,p in enumerate(transfer.MIGRATIONS) if '20260909100000_tech_note_revision' in p)
        self.create('tech_note_before')
        for source in self.sources[:index]: self.sql('tech_note_before',source)
        self.sql('tech_note_before', 'INSERT INTO "StudyState" (uid,"institutionId","updatedAt") VALUES '+f"('{self.uid}','SYNTHETIC-hospital','2026-09-09')")
        tables=self.sql('tech_note_before',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        def original():
            return {name:self.sql('tech_note_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}
        before=original();self.sql('tech_note_before',self.sources[index]);self.assertEqual(original(),before)
        self.sql('tech_note_before',self.sources[index],success=False);self.assertEqual(original(),before)
        self.sql('tech_note_before','INSERT INTO "TechNoteRevision" ("studyUid",version,text,reason,author,"authorSub","institutionId") VALUES '+f"('{self.uid}',1,'SYNTHETIC','','tech','sub','SYNTHETIC-hospital')")
        self.sql('tech_note_before',f'''DELETE FROM "StudyState" WHERE uid='{self.uid}' ''',success=False)
        self.assertEqual(original(),before)

    @classmethod
    def setUpClass(cls):
        cls.token=uuid.uuid4().hex
        cls.db='kin-rehearsal-'+cls.token[:16]+'-viewer-migration'
        cls.addClassCleanup(ops.remove_owned_if_present,'container',cls.db,cls.token)
        ops.run(['docker','run','-d','--name',cls.db,'--label','kin.ops.run='+cls.token,
                 '--network','none','--tmpfs','/var/lib/postgresql/data',
                 '-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if ops.run(['docker','exec',cls.db,'pg_isready','-h','127.0.0.1','-U','postgres'],check=False).returncode==0:break
            time.sleep(.2)
        else: raise RuntimeError('Isolated database did not start')
        cls.sources=[(ROOT/path).read_bytes() for path in transfer.MIGRATIONS]
        cls.source_hashes=[hashlib.sha256(raw).hexdigest() for raw in cls.sources]
        cls.uid='2.25.'+str(uuid.uuid4().int)
        # The hosted transfer's bounded FD implementation is Linux-only. This
        # local rehearsal uses real psql with an isolated, fixed small fixture;
        # preserve all row/catalog checks and never change the hosted implementation.
        original_query=transfer.psql
        def query(name,db,sql):
            if name!=cls.db or db not in {'kin','foreign_restore'}: raise RuntimeError('Unowned migration query')
            result=subprocess.run(['docker','exec','-i',name,'psql','-XqAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],
                input=("SET timezone='UTC'; SET datestyle='ISO, YMD'; "+sql).encode(),capture_output=True,timeout=30,check=True)
            if len(result.stdout)>256*1024: raise RuntimeError('Synthetic query output exceeded bound')
            return result.stdout.strip()
        transfer.psql=query
        cls.addClassCleanup(setattr,transfer,'psql',original_query)

    def sql(self,db,source,success=True):
        reply=subprocess.run(['docker','exec','-i',self.db,'psql','-XqAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],
            input=source.encode() if isinstance(source,str) else source,capture_output=True,timeout=30)
        self.assertEqual(reply.returncode==0,success,reply.stderr.decode(errors='replace'))
        return reply.stdout.decode().strip()

    def refuses(self,db,statement,constraint):
        """Only the named CHECK may refuse: acceptance (a NULL pass) or any other error fails the case,
        and the refused write rolls back with the block's subtransaction."""
        self.sql(db,f'''DO $probe$ DECLARE refused text; BEGIN {statement}; RAISE EXCEPTION 'SYNTHETIC write accepted';
EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS refused = CONSTRAINT_NAME;
IF refused IS DISTINCT FROM '{constraint}' THEN RAISE EXCEPTION 'SYNTHETIC refused by %', refused; END IF; END $probe$''')

    def create(self,name):ops.run(['docker','exec',self.db,'createdb','-U','postgres',name])

    def old_rows(self,db):
        tables=[name for name in transfer.TABLES if not name.startswith('Viewer')]
        return {name:self.sql(db,f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}

    def seed_existing(self,db):
        self.create(db);self.sql(db,self.sources[0])
        self.sql(db,'INSERT INTO "StudyState" (uid,"institutionId","updatedAt") VALUES '+
                 f"('{self.uid}','SYNTHETIC-hospital','2026-09-07'); "+
                 'INSERT INTO "ReportDraft" (uid,author,findings,"baseVersion","updatedAt") VALUES '+
                 f"('{self.uid}','SYNTHETIC-reader','SYNTHETIC original',0,'2026-09-07');")

    def test_01_additive_preserves_existing_rows_and_second_apply_refuses(self):
        self.seed_existing('existing')
        before=self.old_rows('existing')
        self.sql('existing',self.sources[1]);self.assertEqual(self.old_rows('existing'),before)
        self.sql('existing',self.sources[1],success=False);self.assertEqual(self.old_rows('existing'),before)
        self.assertEqual(self.sql('existing',"SELECT count(*) FROM pg_tables WHERE schemaname='public'"),'14')

    def test_02_failed_migration_rolls_back_ddl_and_existing_data(self):
        self.seed_existing('failed')
        before=self.old_rows('failed')
        broken=self.sources[1].decode().replace('COMMIT;','SELECT * FROM d05b_nonexistent_relation; COMMIT;')
        self.sql('failed',broken,success=False)
        self.assertEqual(self.old_rows('failed'),before)
        self.assertEqual(self.sql('failed',"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Viewer%'"),'0')
        self.sql('failed',self.sources[1]);self.assertEqual(self.old_rows('failed'),before)

    def test_03_real_dump_restore_every_row_revision_replay_budget_and_fk(self):
        # Local working-tree rehearsal; the hosted producer separately binds these
        # same source paths and bytes to HEAD via migration_sources().
        original=transfer.migration_sources
        transfer.migration_sources=lambda:self.sources
        try: transfer.create_product(self.db,'kin',self.uid)
        finally:transfer.migration_sources=original
        frozen=transfer.observe(self.db,'kin')
        self.assertEqual(transfer.sorted_rows(frozen['rows']),transfer.sorted_rows(transfer.expected_rows(self.uid)))
        self.assertEqual(frozen['sequences'],transfer.expected_sequences())
        self.create('foreign_restore')
        with tempfile.TemporaryDirectory(prefix='kin-viewer-restore-') as folder:
            path=Path(folder)/'synthetic.dump'
            with path.open('wb') as out:subprocess.run(['docker','exec',self.db,'pg_dump','-U','postgres','-Fc','kin'],stdout=out,check=True,timeout=30)
            with path.open('rb') as incoming:subprocess.run(['docker','exec','-i',self.db,'pg_restore','-U','postgres','-d','foreign_restore',
                '--no-owner','--no-privileges','--exit-on-error'],stdin=incoming,check=True,timeout=30)
        self.assertEqual(transfer.observe(self.db,'foreign_restore'),frozen)
        self.sql('foreign_restore',f'DELETE FROM "StudyState" WHERE uid={transfer.sql_literal(self.uid)}',success=False)
        self.sql('foreign_restore','DELETE FROM "ViewerItem"',success=False)
        self.sql('foreign_restore','DELETE FROM "ViewerRevision"',success=False)
        self.sql('foreign_restore','DELETE FROM "Finding"',success=False)
        self.assertEqual(transfer.observe(self.db,'foreign_restore'),frozen)

    def test_04_fixed_old_app_reads_writes_and_restricts_parent_delete(self):
        old=os.environ.get('KIN_TEST_OLD_API_IMAGE')
        if not old:self.skipTest('Fixed pre-change image is supplied in the local migration rehearsal')
        self.assertRegex(old,r'^sha256:[a-f0-9]{64}$')
        script="""
const assert=require('node:assert/strict'),{PrismaClient}=require('@prisma/client');
const {PacsService}=require('./dist/pacs.service.js');
const p=new PrismaClient();
(async()=>{
 assert.equal(p.viewerItem,undefined);
 const study=await p.studyState.findUnique({where:{uid:process.env.SYNTHETIC_UID}});assert(study);
 await p.reportDraft.upsert({where:{uid_author:{uid:study.uid,author:'SYNTHETIC-old'}},
  create:{uid:study.uid,author:'SYNTHETIC-old',findings:'old client'},update:{findings:'old client'}});
 assert.equal((await p.reportDraft.findUnique({where:{uid_author:{uid:study.uid,author:'SYNTHETIC-old'}}})).findings,'old client');
 await assert.rejects(()=>p.studyState.delete({where:{uid:study.uid}}),e=>e.code==='P2003');
 await p.reportDraft.delete({where:{uid_author:{uid:study.uid,author:'SYNTHETIC-old'}}});
 const uid='2.25.999',id='00000000-0000-4000-8000-000000000099';
 await p.studyState.create({data:{uid,institutionId:'SYNTHETIC-hospital'}});
 await p.$executeRaw`INSERT INTO "ViewerItem" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt") VALUES (${id}::uuid,${uid},'SYNTHETIC-sub','SYNTHETIC-reader',1,true,'{}'::jsonb,NOW())`;
 const svc=new PacsService(p,{},{});
 await assert.rejects(()=>svc.removeState(uid,{sub:'SYNTHETIC-sub',actor:'SYNTHETIC-reader',roles:['technician'],institution:'SYNTHETIC-hospital',kind:'member'}),e=>e.code==='P2003');
 assert(await p.studyState.findUnique({where:{uid}}));
 assert.equal((await p.$queryRaw`SELECT count(*)::int AS n FROM "ViewerItem" WHERE id=${id}::uuid`)[0].n,1);
 await p.$executeRaw`DELETE FROM "ViewerItem" WHERE id=${id}::uuid`;
 await p.studyState.delete({where:{uid}});
 console.log('Fixed old app read/write succeeded; actual removeState FK refused; new tables retained');
})().finally(()=>p.$disconnect()).catch(()=>process.exitCode=1);
"""
        before=transfer.observe(self.db,'foreign_restore')
        ops.temporary_run(['--network','container:'+self.db,'-e','DATABASE_URL=postgresql://postgres@127.0.0.1:5432/foreign_restore',
            '-e','SYNTHETIC_UID='+self.uid,'--entrypoint','node',old,'-e',script])
        self.assertEqual(transfer.observe(self.db,'foreign_restore'),before)

if __name__=='__main__':unittest.main(verbosity=2)
