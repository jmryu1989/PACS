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
