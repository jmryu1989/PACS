# coding: utf-8
"""REQ-D-WORKSPACE-FLOW / RISK-D-WORKSPACE-TARGET / TEST-D-WORKSPACE-FLOW.

Visible queue order and keyboard movement must retain report/viewer ownership.
"""
import json, os, re, sys, unittest
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready
from test_template_preservation import TemplatePreservationE2E


class ReadingFlowE2E(ReadingWorkspaceE2E):
 def test_flow_01_navigation_follows_visible_sort(self):
  a,b=self.pair();p=self.login();self.choose(p,a)
  p.locator('#quick').fill(a.patient_id)
  expect(p.locator('#rows tr[data-uid]')).to_have_count(2)
  # Exercise both sort directions; one necessarily reverses the API order.
  for _ in range(2):
   p.locator('#heads th[data-key="date"]').click()
   order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
   p.locator('#rows tr[data-uid="'+order[0]+'"]').click()
   p.locator('#b-next').click()
   expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',order[1])
   p.locator('#b-prev').click()
   expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',order[0])

 def test_flow_02_keyboard_roundtrip_retains_report_and_viewer(self):
  a,b=self.pair();original=self.originals();p=self.login()
  p.set_viewport_size(dict(width=1680,height=1100));f=self.workspace(p,a)
  p.locator('#relrows tr[data-uid="'+b.uid+'"]').click()
  expect(p.locator('#prior-findings')).to_have_text('PRIOR '+b.uid)
  p.get_by_role('button',name='Report Editor',exact=True).click()
  p.locator('#findings').fill('KEYBOARD UNSAVED REPORT')
  p.keyboard.press('Control+Alt+ArrowRight')
  expect(p.locator('#reading-target')).to_contain_text(a.uid)
  p.keyboard.press('Control+Alt+3')
  expect(p.locator('.prior-report-pane')).to_be_focused()
  p.keyboard.press('Control+Alt+2')
  expect(p.locator('#reading-frame')).to_be_focused()
  p.keyboard.press('Control+Alt+4')
  expect(p.locator('#findings')).to_be_focused()
  expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED REPORT')
  f.get_by_role('button',name='Comparison',exact=True).click()
  f.get_by_label('Job Title',exact=True).fill('KEYBOARD UNSAVED VIEWER')
  canvas_ready(f,2)
  view_state="() => cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>({image:v.getCurrentImageId?.(),camera:v.getCamera(),voi:v.getProperties().voiRange})))"
  before_view=f.evaluate(view_state)
  p.keyboard.press('Control+Alt+ArrowRight')
  expect(p.locator('#reading-target')).to_contain_text(a.uid)
  # A shortcut dispatched inside the real OHIF document returns to the list.
  p.keyboard.press('Control+Alt+1');expect(p.locator('#quick')).to_be_focused()
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
  key='ArrowRight' if order.index(a.uid)==0 else 'ArrowLeft'
  p.keyboard.press('Escape')
  expect(p.get_by_role('button',name='Worklist',exact=True)).to_be_focused()
  expect(p.locator('.split > .left')).not_to_be_visible()
  p.keyboard.press('Control+Alt+'+key)
  expect(p.locator('#reading-target')).to_contain_text(b.uid)
  expect(p.locator('#reading-frame')).not_to_be_visible()
  expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
  p.get_by_role('button',name='Return to Previous Viewer',exact=True).click()
  expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED REPORT')
  expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEYBOARD UNSAVED VIEWER')
  print('RETAINED VIEWPORT STATE',dict(before=before_view,after=f.evaluate(view_state)),flush=True)
  canvas_ready(f,2)
  self.assertEqual(f.evaluate(view_state),before_view)
  self.assertEqual(self.originals(),original)
  self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ.get('KIN_EVIDENCE_DIR',str(Path(__file__).parent/'artifacts')))
  folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'reading-flow.png'))

 def test_flow_03_queue_edges_filter_and_modal_guard(self):
  a,b=self.pair();p=self.login();self.workspace(p,a)
  p.keyboard.press('Control+Alt+1')
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rs)=>rs.map(r=>r.dataset.uid)')
  p.locator('#rows tr[data-uid="'+order[0]+'"]').click()
  expect(p.locator('#reading-position')).to_have_text('현재 목록 1 / 2')
  expect(p.get_by_role('button',name='Previous Study',exact=True)).to_be_disabled()
  expect(p.get_by_role('button',name='Image',exact=True)).to_be_enabled(timeout=60000)
  p.keyboard.press('Control+Alt+2');expect(p.locator('#reading-frame')).to_be_focused()
  p.keyboard.press('Control+Alt+ArrowRight')
  expect(p.locator('#reading-position')).to_have_text('현재 목록 2 / 2')
  expect(p.get_by_role('button',name='Next Study',exact=True)).to_be_disabled()
  # The visible list can change without changing the active reading target.
  p.keyboard.press('Control+Alt+1');p.locator('#quick').fill('NO-SUCH-READING-FLOW-PATIENT')
  expect(p.locator('#reading-position')).to_have_text('현재 목록 0건')
  expect(p.get_by_role('button',name='Previous Study',exact=True)).to_be_disabled()
  expect(p.get_by_role('button',name='Next Study',exact=True)).to_be_disabled()
  p.locator('#quick').fill(a.patient_id);p.keyboard.press('Escape')
  current=p.locator('#reading-target').inner_text()
  p.evaluate("() => { const d=document.createElement('dialog');d.id='flow-test-dialog';d.textContent='synthetic dialog';document.body.append(d);d.showModal(); }")
  p.keyboard.press('Control+Alt+ArrowLeft');p.keyboard.press('Control+Alt+1')
  self.assertEqual(p.locator('#reading-target').inner_text(),current)
  expect(p.locator('.split > .left')).not_to_be_visible()
  p.evaluate("() => document.getElementById('flow-test-dialog').remove()")
  p.get_by_role('button',name='Study Info & Templates',exact=True).click()
  p.get_by_role('button',name='Back to Worklist',exact=True).click();p.locator('#m-reading').click()
  expect(p.get_by_role('button',name='Study Info & Templates',exact=True)).to_have_attribute('aria-expanded','false')


class W6DoctorPathE2E(TemplatePreservationE2E):
 """REQ-WS6 -> RISK-WS6 -> TEST-WS6: measured report path, explicit live selection.

 Real BFF, study, template, save and approval; browser fake microphone and one
 declared synthetic ASR response. Browser microphone permission UI is suppressed;
 this measures app clicks/prompts, not first-use permission friction or speech accuracy.
 Kept outside the three reading-flow selections so their existing budget stays fixed.
 """
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  cls.browser.close()
  cls.browser=cls.pw.chromium.launch(channel='chromium',headless=True,args=[
   '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  cls.addClassCleanup(cls.browser.close)

 def test_w6_doctor_path_clicks_and_prompts(self):
  fixture=self.fixture();self.seed_report(fixture)
  template=self.template(findings='SYN W6 TEMPLATE',conclusion='SYN W6 CONCLUSION',recommendation='')
  context=self.browser.new_context(ignore_https_errors=True,viewport=dict(width=1680,height=1100))
  self.contexts.append(context)
  clicks=[];prompts=[];caps={};completed=[]
  page=context.new_page();page.set_default_timeout(20000)
  page.expose_binding('w6ObserveClick',lambda source,value:clicks.append(value))
  context.add_init_script("""document.addEventListener('click', e => {
    if (e.isTrusted) window.w6ObserveClick({id:e.target.id || '', tag:e.target.tagName});
  }, true);""")
  page.on('dialog',lambda dialog:(prompts.append(dialog.type),dialog.dismiss()))
  def bootstrap(route):
   response=route.fetch();body=response.json();caps.update(body['dictation'])
   body['dictation']['available']=True
   route.fulfill(response=response,json=body)
  context.route('**/api/bootstrap*',bootstrap)
  def transcript(route):
   route.fulfill(status=200,content_type='application/json',body=json.dumps({
    'text':'SYN W6 DICTATION','seconds':1.0,
    **{k:caps[k] for k in ('languagePin','enginePin','modelPin')}}))
  context.route('**/api/studies/'+fixture.uid+'/dictation',transcript)
  def checkpoint(name):
   expect(page.locator('dialog[open], [role="dialog"]:visible, .modal:visible')).to_have_count(0)
   completed.append(name)
  try:
   page.goto(self.stack.proxy+'/')
   try:
    page.locator('#username').fill(self.stack.username('doctor'))
    page.locator('#password').fill(self.stack.passwords['doctor'])
    page.locator('#kc-login').click()
   except Exception:
    raise RuntimeError('Synthetic BFF login could not be submitted') from None
   page.wait_for_url('**/worklist/hpacs-lite/main.html')
   expect(page.locator('#dbstat')).to_contain_text('DB Connected');checkpoint('login/worklist')
   self.select(page,fixture);checkpoint('open study')
   page.locator('#findings').click();page.keyboard.press('Control+A');page.keyboard.type('SYN W6 TYPED')
   checkpoint('type')
   page.locator('#tpl-search').fill(template['title'])
   page.locator('#tplrows').get_by_text(template['title'],exact=True).dblclick()
   expect(page.locator('#findings')).to_have_value('SYN W6 TYPED\nSYN W6 TEMPLATE')
   checkpoint('template')
   # W6R1-03: the template's write leaves the dictation target in Findings, where the reader typed; no re-choice click.
   page.locator('#b-dictate').click();expect(page.locator('#dictation-stop')).to_be_visible()
   page.wait_for_timeout(500)
   page.locator('#dictation-stop').click();expect(page.locator('#dictation-insert')).to_be_enabled()
   page.locator('#dictation-insert').click()
   expect(page.locator('#findings')).to_have_value(re.compile('SYN W6 DICTATION'))
   checkpoint('dictation')
   self.commit(page,fixture,'#b-save','T');checkpoint('save')
   self.commit(page,fixture,'#b-approve','A');checkpoint('approve')
   expected=page.locator('#findings').input_value()
   self.assertIn('SYN W6 TYPED',expected);self.assertIn('SYN W6 TEMPLATE',expected)
   versions=self.versions(fixture);self.assertEqual(versions[-1]['findings'],expected)
   with page.expect_event('close'):
    page.close(run_before_unload=True)
   self.assertTrue(page.is_closed());completed.append('close')
   self.assertEqual(prompts,[])
   self.assertTrue(any(x['id']=='kc-login' for x in clicks),'login click must be observed across navigation')
  finally:
   print('W6-DOCTOR-PATH '+json.dumps({'completed':completed,'click_count':len(clicks),'clicks':clicks,
    'native_prompts':prompts,'custom_dialog_checkpoint_count':len([x for x in completed if x!='close']),
    'browser_microphone_permission_prompts':'not measured (fake UI)',
    'browser_close_actions':int('close' in completed),'synthetic_asr':True,
    'baseline_comparison':'not measured; no incremental-friction verdict'},ensure_ascii=False),flush=True)


def load_tests(loader,tests,pattern):
 return unittest.TestSuite(ReadingFlowE2E(n) for n in loader.getTestCaseNames(ReadingFlowE2E) if n.startswith('test_flow_'))


if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
