# coding: utf-8
"""TEST-WORKSPACE-SHORTCUTS: real embedded navigation and preference failure guards."""
import os, unittest, re, json
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E
from viewer_session import end_document

class WorkspaceShortcutsE2E(ViewerTechNoteE2E):
 def editor(self,p):p.locator('#workspace-shortcuts-edit').click();expect(p.locator('#workspace-shortcuts-dialog')).to_be_visible()
 def assign(self,p,id,chord):
  p.get_by_role('tab',name='Viewer' if id in ('image','note','tools','nativeTools') else 'Worklist',exact=True).click()
  p.locator('#workspace-shortcut-'+id).press(chord)
 def apply(self,p):p.locator('#workspace-shortcuts-apply').click()
 def stored(self,p):return p.evaluate("()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('kin-workspace-shortcuts:v2:')))")

 def test_shortcuts_01_remap_image_report_list_and_preserve(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.tools(f)
  p.locator('#findings').fill('KEEP SHORTCUT REPORT');f.get_by_label('Job Title',exact=True).fill('KEEP SHORTCUT JOB')
  f.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');before=self.snapshot(f)
  print('before canvas sizes',f.locator('.cornerstone-canvas').evaluate_all('es=>es.map(e=>[e.width,e.height])'),flush=True)
  self.editor(p);self.assign(p,'report','Control+Alt+R');self.assign(p,'image','Control+Alt+I');self.assign(p,'list','Control+Alt+L');self.apply(p)
  expect(p.locator('#workspace-shortcuts-dialog')).not_to_be_visible();p.keyboard.press('Control+Alt+I');self.assertEqual(p.evaluate('()=>document.activeElement.id'),'reading-frame')
  p.keyboard.press('Control+Alt+R');expect(p.locator('#findings')).to_be_focused();p.keyboard.press('Control+Alt+L');expect(p.locator('#quick')).to_be_focused()
  p.keyboard.press('Control+Alt+R');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP SHORTCUT REPORT')
  p.keyboard.press('Control+Alt+I');p.keyboard.press('Control+Alt+4');self.assertEqual(p.evaluate('()=>document.activeElement.id'),'reading-frame')
  p.keyboard.press('Control+Alt+R');expect(p.locator('#findings')).to_be_focused();expect(f.get_by_label('Job Title',exact=True)).to_have_value('KEEP SHORTCUT JOB')
  f.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  print('after canvas sizes',f.locator('.cornerstone-canvas').evaluate_all('es=>es.map(e=>[e.width,e.height])'),flush=True);self.assertEqual(self.snapshot(f),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);self.editor(p);p.screenshot(path=str(folder/'workspace-shortcuts.png'));p.locator('#workspace-shortcuts-cancel').click()

 def test_shortcuts_05_standalone_uses_saved_navigation_keys(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.editor(p)
  for action,key in [('image','I'),('report','R'),('note','N'),('tools','T'),('nativeTools','Z')]:self.assign(p,action,'Control+Alt+'+key)
  self.apply(p);p.locator('#findings').fill('KEEP POPUP SHORTCUT REPORT')
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  v=opened.value
  from test_viewer_tech_note import canvas_ready
  canvas_ready(v,2);self.ready(v)
  expect(v.locator('#kin-viewer-note-open')).to_have_attribute('aria-keyshortcuts','Control+Alt+N')
  expect(v.locator('#kin-viewer-focus-4')).to_have_attribute('aria-keyshortcuts','Control+Alt+R')
  v.get_by_label('Job Title',exact=True).fill('KEEP POPUP SHORTCUT JOB');before=self.snapshot(v)
  v.keyboard.press('Control+Alt+I');focus=v.evaluate('()=>document.activeElement') is not None
  self.assertTrue(focus);self.assertTrue(v.evaluate("()=>document.activeElement.matches('[data-viewport-uid],.viewport-element')||!!document.activeElement.querySelector('canvas')"))
  v.keyboard.press('Control+Alt+6');expect(v.locator('#tech-note-dialog')).not_to_be_visible()
  v.keyboard.press('Control+Alt+N');expect(v.locator('#tech-note-meta')).not_to_be_empty();v.locator('#tech-note-close').click()
  v.keyboard.press('Control+Alt+T');expect(v.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-history]')).to_be_focused()
  v.keyboard.press('Control+Alt+Z');expect(v.get_by_role('toolbar',name='Frequent Tools').get_by_role('button').first).to_be_focused()
  v.keyboard.press('Control+Alt+4');expect(v.get_by_role('toolbar',name='Frequent Tools').get_by_role('button').first).to_be_focused()
  v.keyboard.press('Control+Alt+R');expect(v.locator('#kin-viewer-return-status')).to_have_text(re.compile(r'판독문으로 돌아왔습니다\.|판독문 위치를 준비했습니다\. 목록 창을 선택하세요\.'))
  expect(p.locator('#findings')).to_have_value('KEEP POPUP SHORTCUT REPORT');expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP POPUP SHORTCUT JOB');self.assertEqual(self.snapshot(v),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'standalone-shortcuts.png'))

 def test_shortcuts_02_reserved_duplicate_cancel_defaults_and_input(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.editor(p)
  for key in ['Control+Alt+C','Control+Alt+8','Control+R','F5']:
   self.assign(p,'report',key);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('예약 키')
  self.assign(p,'report','Control+Alt+2');self.apply(p);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('중복');self.assertEqual(self.stored(p),{})
  p.locator('#workspace-shortcuts-cancel').click();self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+4')
  self.assign(p,'next','Control+Alt+N');self.apply(p);field=p.locator('#findings');field.fill('KEEP CURSOR');field.press('Control+Alt+N');expect(field).to_be_focused();expect(p.locator('#reading-report-target')).to_contain_text(a.uid)
  self.editor(p);p.keyboard.press('Control+Alt+4');expect(p.locator('#workspace-shortcuts-dialog')).to_be_visible();p.locator('#workspace-shortcuts-default').click();self.apply(p)
  self.assertEqual(json.loads(next(iter(self.stored(p).values()))),p.evaluate('()=>KinWorkspaceShortcuts.defaultsV2'))

 def test_shortcuts_04_owner_corruption_recovery_and_navigation(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a)
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rows)=>rows.map(r=>r.dataset.uid)');i=order.index(a.uid);direction=1 if i+1<len(order) else -1;wanted=order[i+direction]
  self.editor(p);self.assign(p,'next' if direction==1 else 'previous','Control+Alt+N');self.apply(p);key=next(iter(self.stored(p)))
  p.locator('#workspace-shortcuts-edit').focus();p.keyboard.press('Control+Alt+N');expect(p.locator('#reading-report-target')).to_contain_text(wanted)
  p.evaluate("key=>{localStorage.setItem('kin-workspace-shortcuts:v2:foreign-owner',localStorage.getItem(key));localStorage.removeItem(key)}",key)
  p.reload();f=self.workspace(p,a);self.editor(p);expect(p.locator('#workspace-shortcut-next')).to_have_value('Control+Alt+ArrowRight');p.locator('#workspace-shortcuts-cancel').click()
  p.evaluate("key=>localStorage.setItem(key,'invalid-json')",key);p.reload();f=self.workspace(p,a);expect(p.locator('#workspace-shortcuts-status')).to_contain_text('미배정')
  self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Unassigned');expect(p.locator('#workspace-shortcut-finalize')).to_have_value('Unassigned')
  p.get_by_role('tab',name='Viewer',exact=True).click();expect(p.locator('#workspace-shortcut-image')).to_have_value('Unassigned')
  p.locator('#workspace-shortcuts-default').click();self.apply(p);expect(p.locator('#workspace-shortcuts-dialog')).not_to_be_visible();self.assertIn('foreign-owner',' '.join(self.stored(p)))
  self.editor(p);p.set_viewport_size(dict(width=600,height=900));expect(p.locator('#workspace-shortcuts-apply')).to_be_in_viewport();self.assertLessEqual(p.locator('#workspace-shortcuts-dialog').bounding_box()['width'],600)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'shortcut-editor-narrow.png'));p.keyboard.press('Escape')

 def test_shortcuts_03_storage_conflict_failure_restore_and_end(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.editor(p);self.assign(p,'report','Control+Alt+R');self.apply(p);saved=self.stored(p);key=next(iter(saved))
  p.reload();f=self.workspace(p,a);self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R')
  p.evaluate("key=>localStorage.setItem(key,JSON.stringify({...KinWorkspaceShortcuts.defaultsV2,report:'Control+Alt+KeyT'}))",key)
  self.apply(p);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('다른 창');p.locator('#workspace-shortcuts-cancel').click();self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+T')
  p.evaluate("()=>{window.originalShortcutSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-workspace-shortcuts:'))throw Error('synthetic failure');return originalShortcutSet.call(this,k,v)}}")
  self.assign(p,'report','Control+Alt+R');self.apply(p);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('저장하지 못');expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R')
  p.evaluate('()=>Storage.prototype.setItem=originalShortcutSet');self.apply(p)
  self.editor(p);end_document(p);expect(p.locator('#workspace-shortcuts-dialog')).to_have_count(0)

 def test_shortcuts_06_local_v1_migration_and_per_action_notice(self):
  a,b=self.pair();p=self.login();self.workspace(p,a)
  # Setup-only legacy storage: represents a browser last saved by the v1 client.
  p.evaluate("""()=>{const owner=JSON.stringify([KinAuth.session().institution,KinAuth.session().sub]);
   localStorage.setItem('kin-workspace-shortcuts:v1:'+owner,JSON.stringify({...KinWorkspaceShortcuts.defaults,report:'KeyR',image:'KeyC'}));}""")
  p.reload();self.workspace(p,a);expect(p.locator('#workspace-shortcuts-status')).to_contain_text('Image')
  expect(p.locator('#workspace-shortcuts-status')).to_contain_text('미배정')
  self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R')
  expect(p.locator('#workspace-shortcut-finalize')).to_have_value('Control+S')
  p.get_by_role('tab',name='Viewer',exact=True).click();expect(p.locator('#workspace-shortcut-image')).to_have_value('Unassigned')
  self.apply(p);value=json.loads(next(iter(self.stored(p).values())))
  self.assertEqual(value['version'],2);self.assertEqual(value['report'],'Control+Alt+KeyR');self.assertIsNone(value['image'])
  self.assertEqual(p.evaluate("v=>KinWorkspaceShortcuts.action(v,{ctrlKey:true,altKey:false,code:'KeyS'})",value),'finalize')

 def test_shortcuts_07_frame_finalize_dispatch(self):
  a,b=self.pair();p=self.login();self.workspace(p,a)
  assert_frame_finalize(self,p)


def assert_frame_finalize(case,p):
 """D1371 setup-only hook: FLOW owns the real command and its approval gate.
 Exercise the shipped frame listener with real document events, not a copied handler.
 """
 result=p.evaluate("""() => {
  const original=window.KinReportCommands, frame=document.querySelector('#reading-frame'), doc=frame.contentDocument;
  let calls=0;
  const fire=target=>{const e=new KeyboardEvent('keydown',{key:'s',code:'KeyS',ctrlKey:true,bubbles:true,cancelable:true});target.dispatchEvent(e);return e.defaultPrevented;};
  try {
   window.KinReportCommands={finalize(){calls++;return true;}};
   const ran=fire(doc), once=calls;
   // A top-document event belongs only to FLOW's dispatcher. This helper only
   // counts frame dispatches so it remains valid before and after FLOW integration.
   window.KinReportCommands={finalize(){calls++;return false;}};
   const blocked=fire(doc), blockedCalls=calls;
   window.KinReportCommands={};const missingMethod=fire(doc);
   delete window.KinReportCommands;const missingHook=fire(doc);
   return {ran,once,blocked,blockedCalls,missingMethod,missingHook,calls};
  } finally {if(original===undefined)delete window.KinReportCommands;else window.KinReportCommands=original;}
 }""")
 case.assertEqual(result,dict(ran=True,once=1,blocked=False,blockedCalls=2,missingMethod=False,missingHook=False,calls=2))

def load_tests(loader,tests,pattern):return unittest.TestSuite(WorkspaceShortcutsE2E(n) for n in loader.getTestCaseNames(WorkspaceShortcutsE2E) if n.startswith('test_shortcuts_'))
if __name__=='__main__':unittest.main(verbosity=2)
