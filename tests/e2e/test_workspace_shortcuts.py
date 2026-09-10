# coding: utf-8
"""TEST-WORKSPACE-SHORTCUTS: real embedded navigation and preference failure guards."""
import os, unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E

class WorkspaceShortcutsE2E(ViewerTechNoteE2E):
 def editor(self,p):p.locator('#workspace-shortcuts-edit').click();expect(p.locator('#workspace-shortcuts-dialog')).to_be_visible()
 def assign(self,p,id,chord):p.locator('#workspace-shortcut-'+id).press(chord)
 def apply(self,p):p.locator('#workspace-shortcuts-apply').click()
 def stored(self,p):return p.evaluate("()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('kin-workspace-shortcuts:v1:')))")

 def test_shortcuts_01_remap_image_report_list_and_preserve(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.tools(f)
  p.locator('#findings').fill('KEEP SHORTCUT REPORT');f.get_by_label('작업 제목',exact=True).fill('KEEP SHORTCUT JOB')
  f.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');before=self.snapshot(f)
  print('before canvas sizes',f.locator('.cornerstone-canvas').evaluate_all('es=>es.map(e=>[e.width,e.height])'),flush=True)
  self.editor(p);self.assign(p,'report','Control+Alt+R');self.assign(p,'image','Control+Alt+I');self.assign(p,'list','Control+Alt+L');self.apply(p)
  expect(p.locator('#workspace-shortcuts-dialog')).not_to_be_visible();p.keyboard.press('Control+Alt+I');self.assertEqual(p.evaluate('()=>document.activeElement.id'),'reading-frame')
  p.keyboard.press('Control+Alt+R');expect(p.locator('#findings')).to_be_focused();p.keyboard.press('Control+Alt+L');expect(p.locator('#quick')).to_be_focused()
  p.keyboard.press('Control+Alt+R');expect(p.locator('#findings')).to_be_focused();expect(p.locator('#findings')).to_have_value('KEEP SHORTCUT REPORT')
  p.keyboard.press('Control+Alt+I');p.keyboard.press('Control+Alt+4');self.assertEqual(p.evaluate('()=>document.activeElement.id'),'reading-frame')
  p.keyboard.press('Control+Alt+R');expect(p.locator('#findings')).to_be_focused();expect(f.get_by_label('작업 제목',exact=True)).to_have_value('KEEP SHORTCUT JOB')
  f.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  print('after canvas sizes',f.locator('.cornerstone-canvas').evaluate_all('es=>es.map(e=>[e.width,e.height])'),flush=True);self.assertEqual(self.snapshot(f),before)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);self.editor(p);p.screenshot(path=str(folder/'workspace-shortcuts.png'));p.locator('#workspace-shortcuts-cancel').click()

 def test_shortcuts_02_reserved_duplicate_cancel_defaults_and_input(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.editor(p)
  for key in ['Control+Alt+C','Control+Alt+8','Control+R','F5']:
   self.assign(p,'report',key);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('예약 키')
  self.assign(p,'report','Control+Alt+2');self.apply(p);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('중복');self.assertEqual(self.stored(p),{})
  p.locator('#workspace-shortcuts-cancel').click();self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+4')
  self.assign(p,'next','Control+Alt+N');self.apply(p);field=p.locator('#findings');field.fill('KEEP CURSOR');field.press('Control+Alt+N');expect(field).to_be_focused();expect(p.locator('#reading-report-target')).to_contain_text(a.uid)
  self.editor(p);p.keyboard.press('Control+Alt+4');expect(p.locator('#workspace-shortcuts-dialog')).to_be_visible();p.locator('#workspace-shortcuts-default').click();self.apply(p)
  self.assertEqual(next(iter(self.stored(p).values())),p.evaluate('()=>JSON.stringify(KinWorkspaceShortcuts.defaults)'))

 def test_shortcuts_04_owner_corruption_recovery_and_navigation(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a)
  order=p.locator('#rows tr[data-uid]').evaluate_all('(rows)=>rows.map(r=>r.dataset.uid)');i=order.index(a.uid);direction=1 if i+1<len(order) else -1;wanted=order[i+direction]
  self.editor(p);self.assign(p,'next' if direction==1 else 'previous','Control+Alt+N');self.apply(p);key=next(iter(self.stored(p)))
  p.locator('#workspace-shortcuts-edit').focus();p.keyboard.press('Control+Alt+N');expect(p.locator('#reading-report-target')).to_contain_text(wanted)
  p.evaluate("key=>{localStorage.setItem('kin-workspace-shortcuts:v1:foreign-owner',localStorage.getItem(key));localStorage.removeItem(key)}",key)
  p.reload();f=self.workspace(p,a);self.editor(p);expect(p.locator('#workspace-shortcut-next')).to_have_value('Control+Alt+ArrowRight');p.locator('#workspace-shortcuts-cancel').click()
  p.evaluate("key=>localStorage.setItem(key,'invalid-json')",key);p.reload();f=self.workspace(p,a);expect(p.locator('#workspace-shortcuts-status')).to_contain_text('저장값 오류')
  self.editor(p);p.locator('#workspace-shortcuts-default').click();self.apply(p);expect(p.locator('#workspace-shortcuts-dialog')).not_to_be_visible();self.assertIn('foreign-owner',' '.join(self.stored(p)))
  self.editor(p);p.set_viewport_size(dict(width=600,height=900));expect(p.locator('#workspace-shortcuts-apply')).to_be_in_viewport();self.assertLessEqual(p.locator('#workspace-shortcuts-dialog').bounding_box()['width'],600)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'shortcut-editor-narrow.png'));p.keyboard.press('Escape')

 def test_shortcuts_03_storage_conflict_failure_restore_and_end(self):
  a,b=self.pair();p=self.login();f=self.workspace(p,a);self.editor(p);self.assign(p,'report','Control+Alt+R');self.apply(p);saved=self.stored(p);key=next(iter(saved))
  p.reload();f=self.workspace(p,a);self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R')
  p.evaluate("key=>localStorage.setItem(key,JSON.stringify({...KinWorkspaceShortcuts.defaults,report:'KeyT'}))",key)
  self.apply(p);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('다른 창');p.locator('#workspace-shortcuts-cancel').click();self.editor(p);expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+T')
  p.evaluate("()=>{window.originalShortcutSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-workspace-shortcuts:'))throw Error('synthetic failure');return originalShortcutSet.call(this,k,v)}}")
  self.assign(p,'report','Control+Alt+R');self.apply(p);expect(p.locator('#workspace-shortcuts-message')).to_contain_text('저장하지 못');expect(p.locator('#workspace-shortcut-report')).to_have_value('Control+Alt+R')
  p.evaluate('()=>Storage.prototype.setItem=originalShortcutSet');self.apply(p)
  self.editor(p);p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(p.locator('#workspace-shortcuts-dialog')).to_have_count(0)

def load_tests(loader,tests,pattern):return unittest.TestSuite(WorkspaceShortcutsE2E(n) for n in loader.getTestCaseNames(WorkspaceShortcutsE2E) if n.startswith('test_shortcuts_'))
if __name__=='__main__':unittest.main(verbosity=2)
