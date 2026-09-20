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
        # The service never stores an item without its create revision; that history row, not any finding
        # link, is what RESTRICTs deleting the item (ViewerRevision_itemId_fkey).
        self.sql('findings_before','INSERT INTO "ViewerRevision" ("itemId",revision,snapshot,action,reason,actor,"payloadBytes",at) '+
                 f"SELECT id,1,snapshot,'create','',\"authorActor\",octet_length(convert_to(snapshot::text,'UTF8')),'2026-09-17' FROM \"ViewerItem\" WHERE id='{item}'")
        self.assertEqual(self.sql('findings_before','SELECT count(*) FROM "ViewerRevision"'),'1')
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
        self.refuses('findings_before',row.replace("',1,'","',2,'"),'FindingRevision_authorSub_requestId_key','unique_violation')
        self.sql('findings_before',row.replace("',1,'","',2,'").replace('SYNTHETIC-sub','SYNTHETIC-other'))
        self.assertEqual(self.sql('findings_before','SELECT count(*) FROM "FindingRevision"'),'2')
        def findings():return {name:self.sql('findings_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in ('Finding','FindingRevision')}
        kept=findings()
        # Byte equality, action vocabulary, source bounds and fingerprint shape fail closed.
        self.refuses('findings_before','UPDATE "FindingRevision" SET "payloadBytes"="payloadBytes"+1','FindingRevision_payload_check')
        self.refuses('findings_before',"UPDATE \"FindingRevision\" SET action='delete'",'FindingRevision_action_check')
        self.refuses('findings_before',"UPDATE \"FindingRevision\" SET fingerprint='SYNTHETIC'",'FindingRevision_fingerprint_check')
        self.sql('findings_before',"UPDATE \"Finding\" SET snapshot=snapshot-'sources'",success=False)
        self.sql('findings_before',"UPDATE \"Finding\" SET snapshot=jsonb_set(snapshot,'{sources}','[]'::jsonb)",success=False)
        self.refuses('findings_before','UPDATE "Finding" SET revision=1001','Finding_revision_check')
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
        self.refuses('findings_before','DELETE FROM "Finding"','FindingRevision_findingId_fkey','foreign_key_violation')
        self.refuses('findings_before','DELETE FROM "ViewerItem"','ViewerRevision_itemId_fkey','foreign_key_violation')
        # Each study restriction holds on its own: with the other family's rows removed inside the probe
        # (rolled back with it), only the named foreign key can refuse the study delete.
        study=f'''DELETE FROM "StudyState" WHERE uid='{self.uid}' '''
        self.refuses('findings_before','DELETE FROM "ViewerRevision"; DELETE FROM "ViewerItem"; '+study,'Finding_studyUid_fkey','foreign_key_violation')
        self.refuses('findings_before','DELETE FROM "FindingRevision"; DELETE FROM "Finding"; '+study,'ViewerItem_studyUid_fkey','foreign_key_violation')
        # Sources are frozen copies, not relational links: no finding FK names the viewer tables, and the
        # item may go (with its own history, rolled back) while the finding and its history stay.
        self.assertEqual(self.sql('findings_before','''SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('"Finding"'::regclass,'"FindingRevision"'::regclass) AND confrelid IN ('"ViewerItem"'::regclass,'"ViewerRevision"'::regclass)'''),'0')
        self.assertEqual(self.sql('findings_before','''BEGIN; DELETE FROM "ViewerRevision"; DELETE FROM "ViewerItem";
SELECT (SELECT count(*) FROM "ViewerItem")||','||(SELECT count(*) FROM "Finding")||','||(SELECT count(*) FROM "FindingRevision"); ROLLBACK;'''),'0,1,2')
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

    def test_report_citations_additive_nullable_bounded_and_named(self):
        """TEST-S3-U2a-CITATION-MIGRATION-LIVE: two additive JSONB columns, the NULL that keeps the old
        behaviour, the canonical byte bound, and above all the constraint NAME - the service maps a CHECK
        violation to a named 409 by that name, so if PostgreSQL does not report it the mapping is a 500."""
        index=next(i for i,p in enumerate(transfer.MIGRATIONS) if '20260920120000_report_citations' in p)
        self.create('citations_before')
        for source in self.sources[:index]:self.sql('citations_before',source)
        self.sql('citations_before','INSERT INTO "StudyState" (uid,"institutionId","updatedAt") VALUES '+
                 f"('{self.uid}','SYNTHETIC-hospital','2026-09-20')")
        self.sql('citations_before','INSERT INTO "Report" (uid,findings,conclusion,recommendation,version,"updatedBy","updatedAt") VALUES '+
                 f"('{self.uid}','SYNTHETIC findings','','',1,'SYNTHETIC-reader','2026-09-20')")
        self.sql('citations_before','INSERT INTO "ReportVersion" (uid,version,action,findings,conclusion,recommendation,author) VALUES '+
                 f"('{self.uid}',1,'approve','SYNTHETIC findings','','','SYNTHETIC-reader')")
        self.sql('citations_before','INSERT INTO "ReportDraft" (uid,author,findings,conclusion,recommendation,"baseVersion","updatedAt") VALUES '+
                 f"('{self.uid}','SYNTHETIC-reader','SYNTHETIC draft','','',1,'2026-09-20')")
        tables=self.sql('citations_before',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        def old():return {name:self.sql('citations_before',f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C"') for name in tables}
        before=old()
        columns="SELECT count(*) FROM information_schema.columns WHERE table_name IN ('ReportDraft','ReportVersion') AND column_name='citations'"
        # A failed statement inside the additive transaction must leave no half-added column behind.
        broken=self.sources[index].decode().replace('COMMIT;','SELECT * FROM s3_nonexistent_relation; COMMIT;')
        self.sql('citations_before',broken,success=False)
        self.assertEqual(self.sql('citations_before',columns),'0')
        self.assertEqual(old(),before)
        self.sql('citations_before',self.sources[index])
        self.assertEqual(self.sql('citations_before',columns),'2')
        self.assertEqual(self.sql('citations_before',"SELECT count(*) FROM information_schema.columns WHERE table_name IN ('ReportDraft','ReportVersion') AND column_name='citations' AND is_nullable='YES' AND data_type='jsonb'"),'2')
        self.sql('citations_before',self.sources[index],success=False)
        # Rows written before the column existed keep NULL, and NULL is what "no citations" means.
        self.assertEqual(self.sql('citations_before','SELECT count(*) FROM "ReportDraft" WHERE citations IS NULL'),'1')
        self.assertEqual(self.sql('citations_before','SELECT count(*) FROM "ReportVersion" WHERE citations IS NULL'),'1')
        for table in ('ReportDraft','ReportVersion'):
            with self.subTest(table):
                self.sql('citations_before',f'UPDATE "{table}" SET citations=NULL')
                self.sql('citations_before',f'''UPDATE "{table}" SET citations='[]'::jsonb''')
                self.sql('citations_before',f'''UPDATE "{table}" SET citations=(SELECT jsonb_agg(jsonb_build_object('cid',i)) FROM generate_series(1,64) i)''')
                self.assertEqual(self.sql('citations_before',f'SELECT jsonb_array_length(citations) FROM "{table}"'),'64')
                # 65 entries, a non-array and an oversized array each fail closed, and each names the
                # constraint the service looks for. `refuses` fails the case if anything else refuses.
                self.refuses('citations_before',f'''UPDATE "{table}" SET citations=(SELECT jsonb_agg(jsonb_build_object('cid',i)) FROM generate_series(1,65) i)''',f'{table}_citations_check')
                self.refuses('citations_before',f'''UPDATE "{table}" SET citations=jsonb_build_array(jsonb_build_object('t',repeat('a',70000)))''',f'{table}_citations_check')
                for value in ("'{}'","'\"text\"'","'1'","'null'","'true'"):
                    self.refuses('citations_before',f'''UPDATE "{table}" SET citations={value}::jsonb''',f'{table}_citations_check')
                self.sql('citations_before',f'UPDATE "{table}" SET citations=NULL')
        # The bound is the canonical jsonb text form in UTF-8 bytes. Multi-byte text has to be measured
        # as bytes, not characters, or the service's identical measure would disagree with this CHECK.
        korean=self.sql('citations_before',"SELECT octet_length(convert_to(jsonb_build_array(jsonb_build_object('t',repeat('가',30000)))::text,'UTF8'))")
        self.assertGreater(int(korean),65536)
        self.refuses('citations_before','''UPDATE "ReportDraft" SET citations=jsonb_build_array(jsonb_build_object('t',repeat('가',30000)))''','ReportDraft_citations_check')
        # The service asks the database for exactly this number before it writes.
        fits=self.sql('citations_before',"SELECT octet_length(convert_to(jsonb_build_array(jsonb_build_object('t',repeat('가',10000)))::text,'UTF8'))")
        self.assertLess(int(fits),65536)
        self.sql('citations_before','''UPDATE "ReportDraft" SET citations=jsonb_build_array(jsonb_build_object('t',repeat('가',10000)))''')
        self.sql('citations_before','UPDATE "ReportDraft" SET citations=NULL')
        # A restored database must refuse the same writes: a CHECK that deparses differently would be a
        # different rule on the machine the data actually lands on.
        query='''SELECT c.relname||' '||pg_get_constraintdef(k.oid,true) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE k.conname LIKE '%citations_check' ORDER BY c.relname'''
        definitions=self.sql('citations_before',query).splitlines()
        self.assertEqual(len(definitions),2)
        self.create('citations_restored')
        with tempfile.TemporaryDirectory(prefix='kin-citations-') as folder:
            path=Path(folder)/'citations.dump'
            with path.open('wb') as out:subprocess.run(['docker','exec',self.db,'pg_dump','-U','postgres','-Fc','citations_before'],stdout=out,check=True,timeout=60)
            with path.open('rb') as incoming:subprocess.run(['docker','exec','-i',self.db,'pg_restore','-U','postgres','-d','citations_restored','--no-owner','--no-privileges','--exit-on-error'],stdin=incoming,check=True,timeout=60)
        self.assertEqual(self.sql('citations_restored',query).splitlines(),definitions)
        self.refuses('citations_restored','''UPDATE "ReportVersion" SET citations='{}'::jsonb''','ReportVersion_citations_check')
        self.sql('citations_restored','''UPDATE "ReportVersion" SET citations='[]'::jsonb''')

    # The application half of the citation CHECK: the same PacsService the product runs, over a real
    # PrismaClient, against a real migrated database. Everything else in this file reads the
    # constraint name through PL/pgSQL, which proves the database refuses but says nothing about what
    # the driver hands the service - and the named 409 is decided by exactly that.
    CITATION_PRELUDE = """
const assert=require('node:assert/strict'),{PrismaClient}=require('@prisma/client');
const {PacsService}=require('./dist/pacs.service.js');
const UID=process.env.SYNTHETIC_UID, ITEM='00000000-0000-4000-8000-0000000000e1';
const FINDING='00000000-0000-4000-8000-0000000000f1', ACTOR='SYNTHETIC-reader';
const CALLER={kind:'member',sub:'SYNTHETIC-sub',actor:ACTOR,roles:['radiologist','admin'],institution:'SYNTHETIC-hospital'};
const TEXT='SYNTHETIC 인용 줄';
const p=new PrismaClient();
const entry=(n,prefix)=>({v:2,cid:prefix+String(n).padStart(12,'0'),field:'findings',findingId:FINDING,
 findingRevision:1,sourceIndex:0,sourceRef:{kind:'item',itemId:ITEM,sourceRevision:1},
 linkStateAtInsert:'current',headRevisionAtInsert:1,insertedText:TEXT,
 insertedAt:'2026-09-20T00:00:00.000Z',insertedBy:ACTOR});
const many=(n,prefix)=>Array.from({length:n},(_,i)=>entry(i,prefix||'00000000-0000-4000-8000-'));
const studyAccess={prepare:async()=>{},require:async()=>{},allowed:async()=>new Set()};
const findings={readableFindings:async(_t,_c,uid,ids)=>ids.map(id=>({id,revision:1,hidden:false,
 sources:[{kind:'item',itemId:ITEM,revision:1,studyUid:uid}],
 links:[{itemId:ITEM,linkState:'current',headRevision:1,headHidden:false}]}))};
const svc=new PacsService(p,{},{usersInGroupWithRole:async()=>[]},studyAccess,findings);
const draft=()=>p.reportDraft.findUnique({where:{uid_author:{uid:UID,author:ACTOR}}});
const refused=async(fn,code)=>{const e=await fn().then(()=>null,x=>x);
 assert.ok(e,'the write was accepted');
 assert.equal(e.getStatus&&e.getStatus(),409,String(e.message)+' | '+e.constructor.name);
 const body=e.getResponse&&e.getResponse();
 assert.equal(body&&body.code,code,JSON.stringify(body));
 assert.ok(!/저장했습니다/.test(String(body&&body.message)),'an old tab would take the destructive branch');
 return body;};
const body=(findings,extra)=>Object.assign({findings:findings,conclusion:'',recommendation:'',baseVersion:1},extra||{});
"""

    CITATION_WRITE_PATHS = CITATION_PRELUDE + """
(async()=>{
 // 1. What does the driver actually raise? This is the fact the service's narrow mapping depends on.
 const raw=await p.reportDraft.update({where:{uid_author:{uid:UID,author:ACTOR}},data:{citations:many(65)}}).then(()=>null,e=>e);
 assert.ok(raw,'the database accepted 65 entries');
 console.log('DRIVER class='+raw.constructor.name+' code='+String(raw.code)+
  ' names_constraint='+String(raw.message).includes('ReportDraft_citations_check'));
 // 2. TEST INSTRUMENTATION, this instance only: the product refuses over-limit writes before they
 //    reach the database, so the backstop is unreachable while that check is in place. The product
 //    keeps it; removing it here is what makes the CHECK the thing under test.
 svc.citationBudget=async()=>{};
 // 3. putReport - an insertion onto a draft that is already at the cap.
 await p.reportDraft.update({where:{uid_author:{uid:UID,author:ACTOR}},data:{citations:many(64),findings:TEXT}});
 const insert={field:'findings',findingId:FINDING,findingRevision:1,sourceIndex:0,
  insertedText:TEXT,expectedLinkState:'current',expectedHeadRevision:1};
 await refused(()=>svc.putReport(UID,body(TEXT,{insert:insert}),CALLER),'REPORT_CITATION_LIMIT');
 assert.equal((await draft()).citations.length,64,'the refused insertion must leave the draft alone');
 // 4. commitReport - head 40 + draft 30, the contract's own named over-limit union.
 await p.reportVersion.update({where:{uid_version:{uid:UID,version:1}},data:{citations:many(40)}});
 await p.reportDraft.update({where:{uid_author:{uid:UID,author:ACTOR}},data:{citations:many(30,'11111111-0000-4000-8000-')}});
 const versions=await p.reportVersion.count({where:{uid:UID}});
 await refused(()=>svc.commitReport(UID,body(TEXT,{action:'save'}),CALLER),'REPORT_CITATION_LIMIT');
 assert.equal(await p.reportVersion.count({where:{uid:UID}}),versions,'a refused commit writes no version');
 assert.equal((await draft()).citations.length,30,'and leaves the draft and its citations in place');
 console.log('PUT and COMMIT translated a real CHECK violation into REPORT_CITATION_LIMIT');
})().then(()=>p.$disconnect(),e=>{console.error(e);process.exitCode=1;return p.$disconnect();});
"""

    CITATION_FORCE_AND_CONTROL = CITATION_PRELUDE + """
(async()=>{
 svc.citationBudget=async()=>{};
 // 5. forceDiscardDrafts - the draft was seeded past the cap with its own CHECK dropped, so the
 //    refusal has to come from the ReportVersion CHECK inside createMany.
 assert.equal((await draft()).citations.length,65);
 const versions=await p.reportVersion.count({where:{uid:UID}});
 await refused(()=>svc.forceDiscardDrafts(UID,CALLER),'REPORT_CITATION_LIMIT');
 assert.equal(await p.reportVersion.count({where:{uid:UID}}),versions);
 assert.equal((await draft()).citations.length,65,'a refused forced release discards nothing');
 // 6. Negative control: a real CHECK violation that is NOT ours must stay what it is. Swallowing it
 //    would disguise a genuine fault as "remove a citation".
 const control=await svc.putReport(UID,body('SYNTHETIC-CONTROL'),CALLER).then(()=>null,e=>e);
 assert.ok(control,'the control write was accepted');
 assert.notEqual(control.getStatus&&control.getStatus(),409);
 assert.ok(!JSON.stringify((control.getResponse&&control.getResponse())||'').includes('REPORT_CITATION_LIMIT'));
 console.log('CONTROL class='+control.constructor.name+' code='+String(control.code)+' stayed unmapped');
 // 7. A commit must wait for the draft row it is about to delete. Without the lock a same-author
 //    insertion landing between the read and the delete is thrown away with the row.
 await p.reportDraft.update({where:{uid_author:{uid:UID,author:ACTOR}},data:{citations:many(1),findings:TEXT}});
 const holder=new PrismaClient();
 let released=false;
 const hold=holder.$transaction(async tx=>{
  await tx.$queryRaw`SELECT citations FROM "ReportDraft" WHERE uid=${UID} AND author=${ACTOR} FOR UPDATE`;
  await new Promise(r=>setTimeout(r,8000));
  released=true;
 },{timeout:20000});
 await new Promise(r=>setTimeout(r,500));
 const blocked=await svc.commitReport(UID,body(TEXT,{action:'save'}),CALLER).then(()=>null,e=>e);
 assert.ok(blocked,'the commit read past a locked draft row');
 assert.equal(released,false,'the commit returned before the holder let go');
 assert.equal((await draft()).citations.length,1,'the attestation survived the blocked commit');
 await hold;
 // Once the row is free the same commit succeeds and carries the attestation into the version.
 const state=await svc.commitReport(UID,body(TEXT,{action:'save'}),CALLER);
 assert.ok(state);
 const head=await p.report.findUnique({where:{uid:UID}});
 const signed=await p.reportVersion.findUnique({where:{uid_version:{uid:UID,version:head.version}}});
 assert.equal(signed.citations.length,1,'the citation the other tab wrote is in the signed version');
 assert.equal(await draft(),null,'and the draft row is gone, under the same lock that protected it');
 console.log('FORCE-DISCARD translated a real CHECK violation; control unmapped; commit serialized on the draft row');
 await holder.$disconnect();
})().then(()=>p.$disconnect(),e=>{console.error(e);process.exitCode=1;return p.$disconnect();});
"""

    def test_report_citations_runtime_check_translation_and_draft_lock(self):
        """TEST-S3-U2a-CITATION-RUNTIME (pin A1 / anchor P1): the compiled PacsService, a real
        PrismaClient and a real migrated database turn an actual CHECK violation into the named 409
        on putReport, commitReport and forceDiscardDrafts; an unrelated real CHECK stays unmapped;
        and a commit waits for the draft row it deletes."""
        image = os.environ.get('KIN_TEST_API_IMAGE')
        if not image:
            self.skipTest('The built API image is supplied by hosted CI (KIN_TEST_API_IMAGE)')
        self.create('citations_runtime')
        for source in self.sources: self.sql('citations_runtime', source)
        self.sql('citations_runtime',
                 'INSERT INTO "StudyState" (uid,"institutionId",rs,ss,em,"updatedAt") VALUES '
                 + f"('{self.uid}','SYNTHETIC-hospital','T','Verified','N','2026-09-20'); "
                 + 'INSERT INTO "Report" (uid,findings,conclusion,recommendation,version,"updatedBy","updatedAt") VALUES '
                 + f"('{self.uid}','SYNTHETIC 인용 줄','','',1,'SYNTHETIC-reader','2026-09-20'); "
                 + 'INSERT INTO "ReportVersion" (uid,version,action,findings,conclusion,recommendation,author) VALUES '
                 + f"('{self.uid}',1,'save','SYNTHETIC 인용 줄','','','SYNTHETIC-reader'); "
                 + 'INSERT INTO "ReportDraft" (uid,author,findings,conclusion,recommendation,"baseVersion","updatedAt") VALUES '
                 + f"('{self.uid}','SYNTHETIC-reader','SYNTHETIC 인용 줄','','',1,'2026-09-20')")
        run = ['--network', 'container:'+self.db,
               '-e', 'DATABASE_URL=postgresql://postgres@127.0.0.1:5432/citations_runtime',
               '-e', 'SYNTHETIC_UID='+self.uid, '--entrypoint', 'node', image, '-e']
        first = ops.temporary_run(run+[self.CITATION_WRITE_PATHS], timeout=180)
        print(first)
        self.assertIn('names_constraint=true', first,
                      'the service matches this CHECK by constraint name; if the driver does not carry it, say so here')
        self.assertIn('PUT and COMMIT translated a real CHECK violation', first)
        # The draft's own CHECK has to go before a draft can be seeded past the cap; the ReportVersion
        # CHECK, which is what forceDiscardDrafts must hit, stays. The control constraint proves the
        # mapping stays narrow against a different real violation.
        self.sql('citations_runtime', 'ALTER TABLE "ReportDraft" DROP CONSTRAINT "ReportDraft_citations_check"; '
                 + 'ALTER TABLE "ReportDraft" ADD CONSTRAINT "ReportDraft_synthetic_probe_check" '
                 + "CHECK (findings <> 'SYNTHETIC-CONTROL'); "
                 + 'UPDATE "ReportDraft" SET citations=(SELECT jsonb_agg(jsonb_build_object('
                 + "'v',2,'cid','00000000-0000-4000-8000-'||lpad(i::text,12,'0'),'field','findings',"
                 + "'insertedText','SYNTHETIC 인용 줄','insertedBy','SYNTHETIC-reader')) FROM generate_series(1,65) i)")
        second = ops.temporary_run(run+[self.CITATION_FORCE_AND_CONTROL], timeout=180)
        print(second)
        self.assertIn('stayed unmapped', second)
        self.assertIn('FORCE-DISCARD translated a real CHECK violation', second)

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

    def refuses(self,db,statement,constraint,condition='check_violation'):
        """Only the named constraint may refuse: acceptance (a NULL pass) or any other error fails the case,
        and the refused write rolls back with the block's subtransaction."""
        self.sql(db,f'''DO $probe$ DECLARE refused text; BEGIN {statement}; RAISE EXCEPTION 'SYNTHETIC write accepted';
EXCEPTION WHEN {condition} THEN GET STACKED DIAGNOSTICS refused = CONSTRAINT_NAME;
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
