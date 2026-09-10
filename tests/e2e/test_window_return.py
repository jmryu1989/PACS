# coding: utf-8
"""TEST-WINDOW-RETURN: scoped editor focus without opener, navigation or save."""
import json,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E,canvas_ready

class WindowReturnE2E(ViewerTechNoteE2E):
 def popup(self,a):
  p=self.login();f=self.workspace(p,a)
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);expect(v.locator('#kin-viewer-focus-4')).to_be_enabled();return p,f,v
 def returned(self,p,v):
  p.wait_for_function("()=>document.activeElement===document.querySelector('#findings')");expect(v.locator('#kin-viewer-return-status')).to_contain_text('판독문')
  v.wait_for_function("()=>/돌아왔습니다|위치를 준비했습니다/.test(document.querySelector('#kin-viewer-return-status').textContent)")
  result=dict(status=v.locator('#kin-viewer-return-status').text_content(),parentFocused=p.evaluate('()=>document.hasFocus()'),childFocused=v.evaluate('()=>document.hasFocus()'),headed=os.environ.get('KIN_E2E_HEADED')=='1')
  if result['status']=='판독문으로 돌아왔습니다.':self.assertTrue(result['parentFocused'])
  print('RETURN_FOCUS',json.dumps(result,ensure_ascii=True),flush=True)
 def test_return_01_active_prior_live_work_and_reuse(self):
  a,b=self.pair();p,f,v=self.popup(a);p.locator('#findings').fill('KEEP RETURN REPORT');v.get_by_label('작업 제목',exact=True).fill('KEEP RETURN VIEWER');self.active(v,b.uid)
  before=self.snapshot(v);parent_before=self.snapshot(f);self.assertEqual(len(before),2);old_url=v.url;self.assertTrue(v.evaluate('()=>window.opener===null'))
  if os.environ.get('KIN_E2E_HEADED')=='1':
   for page in [p,v]:page.context.new_cdp_session(page).send('Emulation.setFocusEmulationEnabled',{'enabled':False})
   v.bring_to_front()
  v.keyboard.press('Control+Alt+4');self.returned(p,v);expect(p.locator('#findings')).to_have_value('KEEP RETURN REPORT');expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP RETURN VIEWER');self.assertEqual(self.snapshot(v),before);self.assertEqual(self.snapshot(f),parent_before);self.assertEqual(self.jobs(a),[])
  p.bring_to_front();p.keyboard.press('Control+Alt+2');expect(p.locator('#reading-frame')).to_be_focused();p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused()
  history=v.evaluate('()=>window.history.length');active=v.evaluate('()=>services.viewportGridService.getState().activeViewportId')
  requests=[];v.on('request',lambda r:requests.append(r.url) if r.is_navigation_request() else None);v.evaluate("()=>window.syntheticReturnMarker='KEEP DOCUMENT'")
  p.get_by_role('button',name='Open Viewer Window',exact=True).click();v.wait_for_function('(old)=>location.href!==old',arg=old_url);self.assertEqual(v.url.split('#')[0],old_url.split('#')[0]);self.assertEqual(v.evaluate('()=>window.syntheticReturnMarker'),'KEEP DOCUMENT');self.assertEqual(requests,[])
  v.bring_to_front();v.keyboard.press('Control+Alt+4');self.returned(p,v);self.assertEqual(self.snapshot(v),before);expect(v.get_by_label('작업 제목',exact=True)).to_have_value('KEEP RETURN VIEWER');self.assertEqual(v.evaluate('()=>window.history.length'),history);self.assertEqual(v.evaluate('()=>services.viewportGridService.getState().activeViewportId'),active);self.assertTrue(v.evaluate('()=>window.opener===null'))
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'returned-editor.png'))

 def test_return_02_target_and_modal_refusal(self):
  a,b=self.pair();p,f,v=self.popup(a);self.active(v,a.uid);p.locator('#reading-appearance-open').click();v.keyboard.press('Control+Alt+4');expect(v.locator('#kin-viewer-return-status')).to_contain_text('대화상자');expect(p.locator('#reading-appearance-dialog')).to_be_visible();p.locator('#reading-appearance-close').click()
  self.choose(p,b);v.keyboard.press('Control+Alt+4');expect(v.locator('#kin-viewer-return-status')).to_contain_text('판독 대상이나 화면');expect(p.locator('#reading-target')).to_contain_text(b.uid)
  self.open_note(v);before=v.locator('#kin-viewer-return-status').text_content();active=v.evaluate('()=>document.activeElement.id');v.keyboard.press('Control+Alt+4');self.assertEqual(v.evaluate('()=>document.activeElement.id'),active);self.assertEqual(v.locator('#kin-viewer-return-status').text_content(),before);v.locator('#tech-note-close').click()

 def test_return_03_late_reply_aba_duplicate_and_session_end(self):
  a,b=self.pair();p,f,v=self.popup(a);self.active(v,a.uid)
  p.evaluate("()=>{window.syntheticReplies=[];const send=BroadcastChannel.prototype.postMessage;window.syntheticSend=send;BroadcastChannel.prototype.postMessage=function(m){if(m.type==='result')window.syntheticReplies.push([this,m]);else send.call(this,m)}}")
  v.locator('#kin-viewer-focus-4').focus();v.keyboard.press('Control+Alt+4');v.keyboard.press('Control+Alt+4');p.wait_for_function('()=>window.syntheticReplies.length===1');expect(v.locator('#kin-viewer-focus-4')).to_have_attribute('aria-busy','true')
  self.active(v,b.uid);self.active(v,a.uid);p.evaluate('()=>{for(const [c,m] of window.syntheticReplies.splice(0))window.syntheticSend.call(c,m)}');expect(v.locator('#kin-viewer-return-status')).to_contain_text('영상 선택이나 세션이 바뀌어');expect(v.locator('#kin-viewer-focus-4')).to_have_attribute('aria-busy','false')
  p.close();v.keyboard.press('Control+Alt+4');expect(v.locator('#kin-viewer-return-status')).to_contain_text('응답이 없습니다',timeout=10000)
  v.keyboard.press('Control+Alt+4');v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-viewer-focus-4')).to_be_disabled();expect(v.locator('#kin-viewer-return-status')).to_have_text('세션이나 영상 창이 변경되었습니다.')

 def test_return_04_direct_viewer_has_no_parent_link(self):
  a,b=self.pair();v=self.launch(self.login(),[a]);self.ready(v);expect(v.locator('#kin-viewer-focus-4')).to_be_disabled();expect(v.locator('#kin-viewer-return-status')).to_contain_text('영상 새 창으로')
  v.keyboard.press('Control+Alt+4');expect(v.locator('#kin-viewer-return-status')).to_contain_text('영상 새 창으로');self.assertTrue(v.evaluate('()=>window.opener===null'))

 def test_return_05_wrong_owner_and_scope_cannot_move_editor_focus(self):
  a,b=self.pair();p,f,v=self.popup(a);target=p.locator('#reading-tools-focus');target.focus();me=v.request.get(self.stack.api+'/me').json();owner=json.dumps([me['institution'],me['sub']],ensure_ascii=False,separators=(',',':'))
  for message,expected in [(dict(owner='wrong-owner',studies=[a.uid,b.uid],activeUid=a.uid),'session'),(dict(owner=owner,studies=['1.2.3'],activeUid='1.2.3'),'context')]:
   result=v.evaluate("""message=>new Promise((resolve,reject)=>{const token=new URLSearchParams(location.hash.slice(1)).get('kin-reading-return'),c=new BroadcastChannel('kin-reading-return:'+token),request=crypto.randomUUID();const timer=setTimeout(()=>{c.close();reject(Error('no scoped reply'))},5000);c.onmessage=e=>{if(e.data.type==='result'&&e.data.request===request){clearTimeout(timer);c.close();resolve(e.data.result)}};c.postMessage({...message,type:'request',request})})""",message)
   self.assertEqual(result,expected);expect(target).to_be_focused();expect(p.locator('#reading-target')).to_contain_text(a.uid)

 def test_return_06_visible_feedback_and_rebind_cancels_pending(self):
  a,b=self.pair();p,f,v=self.popup(a);self.active(v,a.uid);v.get_by_role('button',name='측정·주석',exact=True).click();p.locator('#reading-appearance-open').click();v.keyboard.press('Control+Alt+4')
  expect(v.locator('#kin-viewer-return-status')).to_contain_text('대화상자');expect(v.locator('#kin-viewer-return-status')).to_be_in_viewport();expect(v.locator('#kin-viewer-layout')).not_to_be_visible();expect(v.locator('#kin-viewer-history')).to_be_visible();p.locator('#reading-appearance-close').click()
  p.evaluate("()=>{window.syntheticReplies=[];const send=BroadcastChannel.prototype.postMessage;window.syntheticSend=send;BroadcastChannel.prototype.postMessage=function(m){if(m.type==='result')window.syntheticReplies.push([this,m]);else send.call(this,m)}}")
  v.keyboard.press('Control+Alt+4');p.wait_for_function('()=>window.syntheticReplies.length===1');p.get_by_role('button',name='Open Viewer Window',exact=True).click();expect(v.locator('#kin-viewer-return-status')).to_contain_text('이전 복귀 요청은 취소');expect(v.locator('#kin-viewer-focus-4')).to_have_attribute('aria-busy','false')
  p.evaluate('()=>{for(const [c,m] of window.syntheticReplies.splice(0)){try{window.syntheticSend.call(c,m)}catch(_){}}}');expect(v.locator('#kin-viewer-return-status')).to_contain_text('이전 복귀 요청은 취소')

 def test_return_07_native_closed_panel_keeps_feedback_visible(self):
  a,b=self.pair();p=self.login();self.workspace(p,a)
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  v=opened.value;canvas_ready(v,2);expect(v.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000);expect(v.locator('#kin-workspace-dock')).to_have_count(0);self.active(v,a.uid)
  v.locator('#kin-viewer-layout > summary').click();expect(v.locator('#kin-viewer-note-open')).not_to_be_visible();p.locator('#reading-appearance-open').click();v.keyboard.press('Control+Alt+4');expect(v.locator('#kin-viewer-return-status')).to_contain_text('대화상자');expect(v.locator('#kin-viewer-return-status')).to_be_in_viewport();expect(v.locator('#kin-viewer-note-open')).not_to_be_visible()

  p.locator('#reading-appearance-close').click();before=self.snapshot(v)
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeExit()");expect(v.locator('#kin-viewer-return-status')).to_have_count(0)
  v.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.viewer-tech-note').onModeEnter()");expect(v.locator('#kin-viewer-note-open')).to_be_enabled(timeout=45000);expect(v.locator('#kin-viewer-return-status')).to_have_count(1);expect(v.locator('#kin-viewer-return-status')).to_be_in_viewport();expect(v.locator('#kin-viewer-note-open')).not_to_be_visible()
  v.keyboard.press('Control+Alt+4');self.returned(p,v);self.assertEqual(self.snapshot(v),before)

def load_tests(loader,tests,pattern):return unittest.TestSuite(WindowReturnE2E(n) for n in loader.getTestCaseNames(WindowReturnE2E) if n.startswith('test_return_'))
if __name__=='__main__':unittest.main(verbosity=2)
