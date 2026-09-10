"""Additional actual consultation boundaries: source reassignment and UTC keyset pages."""
import json
import subprocess
import sys
import unittest
import uuid
from test_consultations import ConsultationE2E, lit
from test_worklist import psql


class ConsultationPagesE2E(ConsultationE2E):
    def test_consult_pages_01_source_institution_change_and_subject_case(self):
        a=self.fixture();row=self.create_request(a)['item'];owner=self.owner()
        psql('UPDATE "StudyState" SET "institutionId"='+lit('kin-center')+' WHERE uid='+lit(a.uid))
        try:
            for actor in ['doctor','doctor2','jmryu','kdoctor']:self.read_request(row['id'],actor,404)
            for actor,direction in [('doctor','sent'),('doctor2','received')]:
                result=self.stack.request('GET','/consultations?direction='+direction,actor)
                self.assertEqual(result.status,200);self.assertNotIn(row['id'],[r['id'] for r in result.body['items']])
            self.change_request(row,'complete',status=404)
        finally:psql('UPDATE "StudyState" SET "institutionId"='+lit(owner[0])+' WHERE uid='+lit(a.uid))
        self.assertEqual(self.read_request(row['id'])['item']['state'],'Requested')
        b=self.fixture();body=self.request_body();body['recipientSub']=body['recipientSub'].upper()
        self.create_request(b,body=body,status=400)
        self.assertEqual(len(self.audits(a)),1)

    def test_consult_pages_02_real_prisma_pagination_in_non_utc_session(self):
        a=self.fixture();first=self.create_request(a)['item'];self.change_request(first,'complete')
        original=json.loads(psql('SELECT to_jsonb(t)::text FROM "StudyConsultation" t WHERE id='+lit(first['id'])+'::uuid')[0])
        # Seed only owned completed requests; live service still executes all page SQL.
        clones=[]
        for _ in range(51):
            id=str(uuid.uuid4());self.ids.add(id)
            clones.append(dict(original,id=id,createdAt='2026-09-10T00:00:00.123',updatedAt='2026-09-10T00:00:00.123'))
        for offset in range(0,len(clones),10):
            psql('INSERT INTO "StudyConsultation" SELECT * FROM json_populate_recordset(NULL::"StudyConsultation",'+lit(json.dumps(clones[offset:offset+10]))+')')
        expected=self.ids.copy();found=[];cursor=None
        while True:
            path='/consultations?direction=received'+('&cursor='+cursor if cursor else '')
            response=self.stack.request('GET',path,'doctor2');self.assertEqual(response.status,200,response.text)
            self.assertEqual(response.body['owner'],self.owner('doctor2'))
            self.assertLessEqual(len(response.body['items']),50)
            found.extend(r['id'] for r in response.body['items']);cursor=response.body['nextCursor']
            if not cursor:break
        self.assertEqual(len(found),52);self.assertEqual(set(found),expected)
        for cursor in ['garbage','e30','%%%']:
            self.assertEqual(self.stack.request('GET','/consultations?direction=received&cursor='+cursor,'doctor2').status,400)
        me=self.stack.request('GET','/me','doctor2').body
        caller=dict(sub=me['sub'],actor=me['actor'],roles=['radiologist'],institution=me['institution'],kind='member')
        script="""const {PrismaClient}=require('@prisma/client');const {ConsultationService}=require('./dist/consultation.service');
          const prisma=new PrismaClient(),caller=CALLER;
          (async()=>{try{const result={};for(const zone of ['UTC','Asia/Seoul']){
            result[zone]=await prisma.$transaction(async tx=>{
              await tx.$queryRaw`SELECT set_config('TimeZone',${zone},true)`;
              const service=new ConsultationService(tx,null),ids=[];let cursor;
              do{const page=await service.list(caller,{direction:'received',...(cursor?{cursor}:{})});ids.push(...page.items.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
              return ids;
            });}console.log(JSON.stringify(result));}finally{await prisma.$disconnect();}})().catch(e=>{console.error(e);process.exit(1);});""".replace('CALLER',json.dumps(caller))
        result=subprocess.run(['docker','compose','exec','-T','api','node','-e',script],capture_output=True,text=True,encoding='utf-8',timeout=30)
        self.assertEqual(result.returncode,0,result.stderr);pages=json.loads(result.stdout)
        self.assertEqual(pages['UTC'],found);self.assertEqual(pages['Asia/Seoul'],found)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ConsultationPagesE2E(name) for name in ConsultationPagesE2E.__dict__ if name.startswith('test_consult_pages_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
