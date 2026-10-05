"""U5S-REQ-26: 요청 큐의 영수증·계정·A→B→A 음성 대조. 제품 파일은 수정하지 않는다."""
import io,json,unittest
from unittest.mock import patch
import clinician_request_dom_test as h

RECEIPT=("          && applied.kind === attempt.kind && applied.from === attempt.from && applied.to === TARGET[attempt.action]\n"
         "          && applied.revision === attempt.payload.revision + 1\n"
         "          && !!at && !Number.isNaN(at.getTime()) && at.toISOString() === applied.at;\n")
MUTANTS=[
 ('receipt','receipt','block',[(RECEIPT,"          && Number.isSafeInteger(applied.revision) && applied.revision >= 1 && STATES.includes(applied.to);\n",1)]),
 ('any-2xx','status','block',[("        return sent.status === 201 && !!applied && typeof applied === 'object' && typeof answer.replayed === 'boolean'\n","        return !!applied && typeof applied === 'object' && typeof answer.replayed === 'boolean'\n",1)]),
 ('actor-rule','actor','block',[("        return can('admin') || (can('clinician') && !!item && ownIds.get(item.id) === true);\n","        return can('admin') || (can('clinician') && !!item && item.requester.actor === KinAuth.session().user);\n",1)]),
 ('no-sequence','aba','block',[("if (!work.admits(at) || ended || lock !== null || mine !== detailSeq || detailId !== id) return;","if (!work.admits(at) || ended || lock !== null) return;",2)]),
 ('question-one-area','question','questions',[('        notifyAccountChanged(detail);\n','',1)]),
 ('request-one-area','request','block',[('        notifyAccountChanged(detail);\n','',1)]),
]

class Probe(h.MainRequestDOMTest):
 block=h.BLOCK;questions_source=h.QUESTION_BLOCK
 def open_main(self,block=None,api_fn=h.API_FN,questions=None):
  return super().open_main(self.block if block is None or block==h.BLOCK else block,api_fn,
                          self.questions_source if questions==h.QUESTION_BLOCK else questions)
 def accepted(self):
  self.open_main();self.open_queue();self.open_item(21,'Requested');self.act('accept')
  self.wait_until(lambda:len(self.writes)==1,'Accept sent');self.settle()
 def test_receipt(self):
  self.mangles=[h.bad_receipt({'to':'Closed','revision':99})];self.accepted()
  self.assertEqual('unknown',self.queue()['detail']['result'][0],'RQ-NC-receipt')
 def test_status(self):
  self.statuses=[200];self.accepted()
  self.assertEqual('unknown',self.queue()['detail']['result'][0],'RQ-NC-status')
 def test_actor(self):
  self.use_roles(['clinician','radiologist'],'SYN-MEMBER-SUB','syn-clinician','SYN Clinician')
  self.open_main();self.open_queue();self.open_item(21,'Requested')
  self.wait_until(lambda:len(self.mine_calls)==1,'own request IDs');self.settle()
  self.assertTrue(self.cancel_control()[0],'RQ-NC-actor')
 def test_aba(self):
  self.open_main();self.open_queue();self.held_detail=[]
  self.open_item(21,None);self.open_item(23,None);self.open_item(21,None)
  self.release(self.held_detail[0][1],{'owner':[h.INSTITUTION,'SYN-TECH-SUB'],'item':h.item(21,h.uid(11),'Requested',reason='SYN-LATE-21',at=5)})
  detail=self.queue()['detail']
  self.assertEqual(('loading',[]),(detail['state'],detail['lines']),'RQ-NC-aba')
 def test_question(self):
  thread=self.open_both();self.open_queue();self.open_item(21,'Requested')
  self.page.locator('#image-request-note').fill('SYN no carry over');self.open_question_thread(thread)
  self.q_faults['reply']=[(409,{'code':'OWNER_CHANGED','message':'SYN changed'})]
  self.send_answer('SYN reply');self.settle()
  self.assertEqual(('locked',''),(self.reading()['state'],self.page.locator('#image-request-note').input_value()),'RQ-NC-question')
 def test_request(self):
  thread=self.open_both();self.open_question_thread(thread);self.open_queue();self.open_item(21,'Requested')
  self.write_errors=[(409,{'code':'OWNER_CHANGED','message':'SYN changed'})];self.act('accept');self.settle()
  self.assertEqual(('locked',None),(self.questions_row()['state'],self.questions_row()['thread']),'RQ-NC-request')

def run(case,block,questions):
 stream=io.StringIO()
 with patch.object(Probe,'block',block),patch.object(Probe,'questions_source',questions):
  result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.TestSuite([Probe('test_'+case)]))
 return result,stream.getvalue()

def main():
 copies=[]
 for name,case,kind,edits in MUTANTS:
  source=h.BLOCK if kind=='block' else h.QUESTION_BLOCK
  for old,new,count in edits:
   assert source.count(old)==count,(name,source.count(old),count)
   source=source.replace(old,new)
  copies.append((name,case,kind,source))
 failed=[];killed=[]
 for _,case,_,_ in copies:
  result,log=run(case,h.BLOCK,h.QUESTION_BLOCK);print(log,end='')
  if not result.wasSuccessful() or result.skipped:failed.append('baseline-'+case)
 if failed:print(json.dumps({'failed':failed}));return 1
 for name,case,kind,source in copies:
  result,log=run(case,source if kind=='block' else h.BLOCK,source if kind=='questions' else h.QUESTION_BLOCK);print(log,end='')
  if result.errors or result.skipped or len(result.failures)!=1 or 'RQ-NC-'+case not in result.failures[0][1]:failed.append(name)
  else:killed.append(name)
 print(json.dumps({'baseline_probes':len(copies),'killed':killed,'failed':failed}));return int(bool(failed))
if __name__=='__main__':raise SystemExit(main())
