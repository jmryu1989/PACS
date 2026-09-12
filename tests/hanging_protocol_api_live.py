"""REQ-HP-ACCOUNT/REQ-HP-SITE: strict personal Hanging Protocol schema, owner isolation and CAS,
and the institution (SITE) library that admins publish and members only read."""
import copy,json,unittest
from invariants_live import LiveStack,psql
from workspace_roaming_support import cleanup_workspace

RID='00000000-0000-4000-8000-000000000801'
SITE_RID='00000000-0000-4000-8000-000000000802'

def site_rows():
 """SITE 행은 개인 subject가 아니라 센티널 ''이라서 개인 정리기가 건드리지 않는다."""
 return [row for row in psql('SELECT to_jsonb(t)::text FROM "HangingProtocolPreference" t WHERE subject=\'\';') if row]

class HangingProtocolApiLive(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities)
  cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'HangingProtocolPreference')
  # 이 실행이 만든 기관 행만 지우기 위한 기준선. 기존 행이 있는 기관은 아예 쓰지 않는다.
  cls.site_baseline={json.loads(row)['institution'] for row in site_rows()}
  cls.addClassCleanup(cls.cleanup_site)
 @classmethod
 def cleanup_site(cls):
  removed=0
  for raw in site_rows():
   row=json.loads(raw)
   if row['subject']!='' or row['institution'] in cls.site_baseline:continue
   print('SITE synthetic row '+raw,flush=True)
   if psql('DELETE FROM "HangingProtocolPreference" t WHERE to_jsonb(t)=\''+raw.replace("'","''")+'\'::jsonb RETURNING 1;')!=['1']:
    raise RuntimeError('Synthetic site row changed before exact-row cleanup')
   removed+=1
  print('SITE exact-row cleanup '+str(removed),flush=True)
 def tearDown(self):cleanup_workspace(self.stack,'HangingProtocolPreference');self.cleanup_site()
 def site_get(self,actor='doctor',status=200):
  r=self.stack.request('GET','/hanging-protocols/site',actor);self.assertEqual(r.status,status,r.text);return r.body
 def site_put(self,body,actor='jmryu'):return self.stack.request('PUT','/hanging-protocols/site',actor,body)
 def site_value(self):
  """개인 규칙과 같은 정규화 스키마. MPR 평면 칸을 포함해 기관 규칙도 같은 배치를 연다."""
  return dict(version=1,activeRuleId=SITE_RID,rules=[dict(id=SITE_RID,name='Site Chest CT',enabled=True,
   match=dict(modality='CT',retrieveAE=None,bodyPart=None,description=None),
   selectors=[dict(alias='current',role='current',historical=False,modality='CT',retrieveAE=None,bodyPart=None,description=None,laterality=None,order='ascending',occurrence=1)],
   layout=dict(rows=2,cols=2,cells=['current',dict(alias='current',view='mpr',orientation='axial'),
    dict(alias='current',view='mpr',orientation='sagittal'),dict(alias='current',view='mpr',orientation='coronal')]))])
 def fresh_site(self,actor='doctor'):
  head=self.site_get(actor)
  if head['owner']['institution'] in self.site_baseline:self.skipTest('기존 기관 행이 있어 합성 쓰기를 하지 않습니다')
  return head
 def get(self,actor='doctor'):
  r=self.stack.request('GET','/hanging-protocols',actor);self.assertEqual(r.status,200,r.text);return r.body
 def put(self,body,actor='doctor'):return self.stack.request('PUT','/hanging-protocols',actor,body)
 def value(self):
  return dict(version=1,activeRuleId=RID,rules=[dict(id=RID,name='Chest CT',enabled=True,
   match=dict(modality='CT',retrieveAE=None,bodyPart='CHEST',description=dict(operator='contains',value='follow up')),
   selectors=[dict(alias='current',role='current',historical=False,modality='CT',retrieveAE=None,bodyPart='CHEST',description=None,laterality=None,order='ascending',occurrence=1),
    dict(alias='prior',role='related',historical=True,modality='CT',retrieveAE='PACS',bodyPart='CHEST',description=dict(operator='equals',value='prior'),laterality='L',order='descending',occurrence=2)],
   layout=dict(rows=1,cols=2,cells=['current','prior']))])
 def body(self,actor='doctor',value=None):
  head=self.get(actor);return dict(expectedOwner=head['owner'],revision=head['revision'],value=self.value() if value is None else value)
 def test_01_create_update_reset_and_aba_conflicts(self):
  head=self.get();self.assertEqual(head,dict(owner=head['owner'],revision=0,value=None));self.assertEqual(set(head['owner']),{'institution','subject'})
  b=self.body();created=self.put(b);self.assertEqual(created.status,200,created.text);self.assertEqual(created.body['revision'],1)
  self.assertEqual(created.body['value'],b['value'])
  self.assertEqual(self.put(b).status,409);updated=copy.deepcopy(created.body['value']);updated['rules'][0]['name']='Chest CT next'
  changed=self.put(dict(expectedOwner=head['owner'],revision=1,value=updated));self.assertEqual(changed.status,200,changed.text);self.assertEqual(changed.body['revision'],2)
  reset=self.put(dict(expectedOwner=head['owner'],revision=2,value=None));self.assertEqual(reset.status,200,reset.text);self.assertEqual(reset.body['revision'],3);self.assertIsNone(reset.body['value'])
  self.assertEqual(self.put(dict(expectedOwner=head['owner'],revision=2,value=updated)).status,409)
 def test_02_subject_institution_and_stale_session_are_isolated(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get()
  for actor in ('doctor2','kdoctor','tech','ktech','jmryu'):
   with self.subTest(actor=actor):
    other=self.get(actor);self.assertEqual(other['revision'],0);self.assertIsNone(other['value']);self.assertNotEqual(other['owner'],saved['owner'])
    self.assertEqual(self.put(b,actor).status,409);self.assertEqual(self.put(dict(expectedOwner=other['owner'],revision=0,value=dict(version=1,activeRuleId=None,rules=[])),actor).status,200);self.assertEqual(self.get(),saved)
 def test_03_strict_invalid_matrix_is_atomic(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get();b['revision']=1
  rule=b['value']['rules'][0]
  invalid=[{},dict(b,extra=True),dict(b,revision=True),dict(b,revision=-1),dict(b,revision=2147483647),dict(b,expectedOwner=[saved['owner']['institution'],saved['owner']['subject']]),
   dict(b,value=None,extra=True),dict(b,value={}),dict(b,value=[]),dict(b,value=dict(b['value'],extra=True)),dict(b,value=dict(b['value'],version=2)),dict(b,value=dict(b['value'],activeRuleId='bad')),
   dict(b,value=dict(b['value'],rules=[dict(rule,extra=True)])),dict(b,value=dict(b['value'],rules=[dict(rule,id='bad')])),dict(b,value=dict(b['value'],rules=[rule,dict(rule,id='00000000-0000-4000-8000-000000000802',name='chest ct')])),
   dict(b,value=dict(b['value'],rules=[dict(rule,enabled=1)])),dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[])])),dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],alias='onclick=run')])])),
   dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],historical=True)])])),dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=2,cols=1,cells=['current',None]))])),
   dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=1,cols=2,cells=['missing',None]))])),dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=1,cols=2,cells=['prior','prior']))])),
   dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],modality='ct'))])),dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],modality=' CT'))])),dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],modality='X'*17))])),dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],description=dict(operator='regex',value='x')))])),
   dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],occurrence=0)])])),dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],laterality='LEFT')])])),
   dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=1,cols=2,cells=['current']))])),dict(b,value=dict(version=1,activeRuleId=RID,rules=[])),dict(b,value=dict(b['value'],rules=[])),
   dict(b,value={'version':1,'activeRuleId':None,'rules':[],'__proto__':{}})]
  for value in invalid:
   with self.subTest(value=str(value)[:160]):self.assertEqual(self.put(value).status,400);self.assertEqual(self.get(),saved)
  oversized=dict(b,value=dict(version=1,activeRuleId=None,rules=[],pad='한'*65537))
  self.assertEqual(self.put(oversized).status,413)
  self.assertEqual(self.get(),saved)
 def test_04_explicit_repeat_empty_library_and_corrupt_row_fail_closed(self):
  value=self.value();value['rules'][0]['layout']['cells']=['current','current'];b=self.body(value=value)
  self.assertEqual(self.put(b).status,200);head=self.get();self.assertEqual(head['value']['rules'][0]['layout']['cells'],['current','current'])
  self.assertEqual(self.put(dict(expectedOwner=head['owner'],revision=1,value=dict(version=1,activeRuleId=None,rules=[]))).status,200)
  subject=head['owner']['subject'].replace("'","''");institution=head['owner']['institution'].replace("'","''")
  self.assertEqual(psql('UPDATE "HangingProtocolPreference" SET value=\'{}\'::jsonb WHERE institution=\''+institution+'\' AND subject=\''+subject+'\' RETURNING 1;'),['1'])
  result=self.stack.request('GET','/hanging-protocols','doctor');self.assertEqual(result.status,503,result.text)

 def test_05_site_is_admin_write_and_member_read(self):
  head=self.fresh_site()
  self.assertEqual(head['owner'],dict(institution=head['owner']['institution'],subject=''))
  self.assertEqual((head['revision'],head['value'],head['canManageSite'],head['updatedAt']),(0,None,False,None))
  # 기관 정보는 토큰에서만 오고, 개인 응답은 한 글자도 늘어나지 않는다.
  self.assertEqual(set(self.get()),{'owner','revision','value'})
  body=dict(expectedOwner=head['owner'],revision=0,value=self.site_value())
  for actor in ('doctor','doctor2','tech','ktech'):
   with self.subTest(actor=actor):
    self.assertEqual(self.site_put(body,actor).status,403)
    self.assertEqual(self.site_get(actor)['revision'],0)
  saved=self.site_put(body,'jmryu');self.assertEqual(saved.status,200,saved.text)
  self.assertEqual((saved.body['revision'],saved.body['canManageSite']),(1,True))
  self.assertEqual(saved.body['value'],body['value'])
  self.assertIsNotNone(saved.body['updatedAt'])
  # 관리자가 배포한 규칙을 같은 기관의 일반 회원이 읽되, 관리 권한은 없다고 답한다.
  for actor in ('doctor','tech'):
   with self.subTest(reader=actor):
    read=self.site_get(actor)
    self.assertEqual((read['revision'],read['canManageSite']),(1,False))
    self.assertEqual(read['value'],body['value'])
  self.assertEqual(self.site_put(body,'jmryu').status,409)
  again=self.site_get('jmryu');self.assertEqual(again['revision'],1)
  reset=self.site_put(dict(expectedOwner=head['owner'],revision=1,value=None),'jmryu')
  self.assertEqual(reset.status,200,reset.text);self.assertEqual((reset.body['revision'],reset.body['value']),(2,None))

 def test_06_site_is_isolated_across_institutions_and_forged_bodies(self):
  mine=self.fresh_site();theirs=self.fresh_site('kdoctor')
  self.assertNotEqual(mine['owner']['institution'],theirs['owner']['institution'])
  self.assertEqual(self.site_put(dict(expectedOwner=mine['owner'],revision=0,value=self.site_value()),'jmryu').status,200)
  # 다른 기관은 이 배포를 전혀 보지 못한다.
  for actor in ('kdoctor','ktech'):
   with self.subTest(actor=actor):
    other=self.site_get(actor)
    self.assertEqual((other['owner'],other['revision'],other['value']),(theirs['owner'],0,None))
  # 본문으로 다른 기관이나 개인 subject를 지목해도 쓰이지 않는다.
  forged=[dict(institution=theirs['owner']['institution'],subject=''),
          dict(institution=mine['owner']['institution'],subject=self.get()['owner']['subject']),
          dict(institution='',subject='')]
  for expected in forged:
   with self.subTest(expectedOwner=expected):
    self.assertEqual(self.site_put(dict(expectedOwner=expected,revision=1,value=self.site_value()),'jmryu').status,409)
  self.assertEqual(self.site_get('kdoctor')['revision'],0)
  self.assertEqual(self.site_get('jmryu')['revision'],1)
  self.assertEqual(len([r for r in site_rows() if json.loads(r)['institution']==theirs['owner']['institution']]),0)
  # 개인 경로는 센티널 subject를 절대 받아들이지 않는다.
  self.assertEqual(self.put(dict(expectedOwner=mine['owner'],revision=0,value=self.value())).status,409)

 def test_07_site_write_preserves_every_personal_row(self):
  personal=self.body();self.assertEqual(self.put(personal).status,200)
  other=self.body('doctor2');self.assertEqual(self.put(other,'doctor2').status,200)
  before=[self.get(),self.get('doctor2')]
  head=self.fresh_site('jmryu')
  self.assertEqual(self.site_put(dict(expectedOwner=head['owner'],revision=0,value=self.site_value()),'jmryu').status,200)
  self.assertEqual(self.site_put(dict(expectedOwner=head['owner'],revision=1,value=None),'jmryu').status,200)
  # 두 번의 기관 쓰기 뒤에도 개인 행과 revision은 그대로다 — 기존 개인 왕복도 계속 동작한다.
  self.assertEqual([self.get(),self.get('doctor2')],before)
  self.assertEqual(before[0]['revision'],1)
  updated=copy.deepcopy(before[0]['value']);updated['rules'][0]['name']='Chest CT after site'
  changed=self.put(dict(expectedOwner=before[0]['owner'],revision=1,value=updated))
  self.assertEqual(changed.status,200,changed.text);self.assertEqual(changed.body['revision'],2)
  self.assertEqual(self.get('doctor2'),before[1])

if __name__=='__main__':unittest.main(verbosity=2)
