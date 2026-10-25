#!/usr/bin/env python3
"""Observe public samples on the real authenticated OHIF page with Playwright.

No route fulfillment, injected product module, fake renderer or fabricated patient pair.
Use the isolated stack's normal doctor login to create --storage-state locally.
Screenshots/renderer facts are technical evidence; doctor acceptance remains separate.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode

import pydicom
from playwright.sync_api import sync_playwright

from mgxa_acceptance import ROOT, digest, local_endpoint, verify_orthanc_target, values

SNAPSHOT = """() => {
  const service = window.services?.cornerstoneViewportService;
  let grid;
  try {grid = window.services?.viewportGridService?.getState()?.viewports;} catch {return [];}
  return [...(grid?.values() || [])].map(cell => {
    const v = service?.getCornerstoneViewport(cell.viewportId);
    const canvas = v?.element?.querySelector('canvas');
    if (!v || !canvas || !v.getCurrentImageId?.()) return null;
    let min=255,max=0;
    const pixels=canvas.getContext('2d')?.getImageData(0,0,canvas.width,canvas.height).data;
    if (pixels) for(let i=0;i<pixels.length;i+=4){min=Math.min(min,pixels[i]);max=Math.max(max,pixels[i]);}
    return {image:v.getCurrentImageId(), index:v.getCurrentImageIdIndex?.(),
      viewportId:cell.viewportId, x:cell.x, y:cell.y,
      playing:!!window.services.cineService?.getState()?.cines?.[cell.viewportId]?.isPlaying,
      camera:v.getCamera?.(), width:canvas.width,height:canvas.height,min,max,
      imageIds:v.getImageIds?.() || []};
  }).filter(Boolean);
}"""
IDENTITY = re.compile(r'/studies/([0-9.]+)/series/([0-9.]+)/instances/([0-9.]+)/frames/([1-9][0-9]*)(?:$|[?#])')


def displayed_fps(page):
    label=page.get_by_text(re.compile(r'^\d+(?:\.\d+)?\s*FPS$')).first.inner_text()
    return float(re.search(r'\d+(?:\.\d+)?',label).group())


def mg_projection(row, source_root):
    """Compare served SOP identities with their original standard view attributes."""
    ds=pydicom.dcmread(Path(source_root)/row['path'],stop_before_pixels=True)
    codes=sorted({(str(item.get('CodingSchemeDesignator','')),str(item.get('CodeValue','')))
        for element in ds.iterall() if element.keyword=='ViewCodeSequence'
        for item in element.value})
    return {'laterality':values(ds,'FrameLaterality') or values(ds,'ImageLaterality') or values(ds,'Laterality'),
            'view_codes':codes,'view_position':values(ds,'ViewPosition'),
            'description':values(ds,'SeriesDescription')}


def ready_snapshot(page, studies):
    # Return the very observation that satisfied readiness. A second read can
    # race the viewer's initial dock/layout resize and see its cleared canvas.
    ready=page.wait_for_function('studies => {const cells=('+SNAPSHOT+')();if(!cells.length)return false;const assigned=[...services.viewportGridService.getState().viewports.values()].filter(c=>c.displaySetInstanceUIDs?.length).length;return cells.length===assigned && cells.every(c=>c.max>c.min) && studies.every(s=>cells.some(c=>c.image.includes("/studies/"+s+"/"))) ? cells : false;}',arg=studies)
    try:
        return ready.json_value()
    finally:
        ready.dispose()


def verify_proxy(project, origin, timeout):
    parsed = local_endpoint(origin)
    ids = subprocess.check_output(['docker', 'ps', '-q', '--filter',
        'label=com.docker.compose.project='+project, '--filter',
        'label=com.docker.compose.service=proxy'], text=True, timeout=timeout).split()
    if len(ids) != 1:
        raise ValueError('No single proxy for the loaded synthetic project')
    info = json.loads(subprocess.check_output(['docker','inspect',ids[0]],
                                             text=True, timeout=timeout))[0]
    port = '443/tcp' if parsed.scheme == 'https' else '80/tcp'
    published = info['NetworkSettings']['Ports'].get(port) or []
    if not any(int(p['HostPort']) == (parsed.port or (443 if parsed.scheme=='https' else 80)) for p in published):
        raise ValueError('Viewer origin is not this synthetic project proxy')


def check_images(snapshot, rows, studies):
    expected = {(r['study'], r['series'], r['sop']): r for r in rows}
    if not snapshot:
        raise AssertionError('No rendered image observed on the real viewer')
    visible = set()
    for cell in snapshot:
        match = IDENTITY.search(cell['image'])
        if not match or match.groups()[:3] not in expected:
            raise AssertionError('Rendered image does not identify a selected original')
        study, series, sop, frame = match.groups()
        if study not in studies or not 1 <= int(frame) <= expected[(study, series, sop)]['frames']:
            raise AssertionError('Wrong study or stored frame')
        if not cell['width'] or not cell['height'] or cell['max'] <= cell['min']:
            raise AssertionError('Canvas is empty/uniform; metadata is not display evidence')
        visible.add(study)
    if visible != set(studies):
        raise AssertionError('Requested current/prior studies are not both displayed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--load-result', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--storage-state', required=True)
    parser.add_argument('--timeout', type=float, required=True,
                        help='Navigation/action hang timeout in seconds, from host measurements')
    parser.add_argument('--output', required=True, help='New artifact directory')
    parser.add_argument('--headed', action='store_true')
    parser.add_argument('--case', action='append', help='Rerun only the named case; keep other valid results')
    args = parser.parse_args()
    local_endpoint(args.origin)
    loaded = json.loads(Path(args.load_result).read_text(encoding='utf-8'))
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    result = {'head_sha': subprocess.check_output(['git','rev-parse','HEAD'], cwd=ROOT, text=True).strip(),
              'load_result_sha256': digest(args.load_result), 'origin': args.origin,
              'status': 'RUNNING', 'cases': [], 'doctor_acceptance': 'NOT_RUN',
              'limits': ['Direct viewer launch; worklist selection/report save/reopen need the plan walkthrough',
                         'Nonuniform canvas and identity are smoke evidence, not grayscale or diagnostic accuracy',
                         'No simulated timeline, pixel data, module or renderer']}
    def save():
        (out/'observations.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    save()
    try:
        if loaded['status'] != 'LOADED_ORIGINALS_ONLY':
            raise ValueError('Original import/readback is incomplete')
        target = loaded['target']
        verify_orthanc_target(target['project'], target['url'], args.timeout)
        verify_proxy(target['project'], args.origin, args.timeout)
        rows = [r['source'] for r in loaded['uploads']]
        source_root=json.loads(Path(loaded['inventory']).read_text(encoding='utf-8'))['root']
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed, args=['--enable-unsafe-swiftshader'])
            result['browser']={'version':browser.version,'headless':not args.headed,
                               'args':['--enable-unsafe-swiftshader']}
            context = browser.new_context(storage_state=args.storage_state, ignore_https_errors=True,
                                          viewport={'width':1600,'height':1050})
            context.set_default_timeout(args.timeout * 1000)
            context.tracing.start(screenshots=True, snapshots=True)
            try:
                def run_case(name, studies, action=None, prepare=None):
                    if args.case and name not in args.case:
                        return
                    page = context.new_page()
                    case = {'case': name, 'studies': studies, 'status': 'RUNNING', 'responses': []}
                    result['cases'].append(case)
                    def record(response):
                        if '/ohif/' in response.url or '/dicom-web/' in response.url:
                            case['responses'].append({'url': response.url, 'status': response.status})
                    page.on('response', record)
                    page.on('pageerror',lambda error:case.setdefault('page_errors',[]).append(str(error)))
                    page.on('console',lambda message:case.setdefault('console',[]).append(
                        {'type':message.type,'text':message.text}) if message.type in ('warning','error') else None)
                    try:
                        query={'StudyInstanceUIDs': ','.join(studies)}
                        if len(studies)==2:
                            query['hangingProtocolId']='@ohif/hpCompare'
                        response = page.goto(args.origin.rstrip('/')+'/ohif/viewer?'+urlencode(query), wait_until='domcontentloaded')
                        if not response or not response.ok or '/ohif/viewer' not in page.url:
                            raise AssertionError('Real authenticated OHIF did not open')
                        case['default_open'] = ready_snapshot(page,studies)
                        if prepare:
                            prepare(page, case)
                        case['before'] = ready_snapshot(page,studies) if prepare else case['default_open']
                        check_images(case['before'], rows, studies)
                        page.screenshot(path=str(out/(name+'-before.png')), full_page=True)
                        if action:
                            action(page, case)
                        case['after'] = ready_snapshot(page,studies)
                        check_images(case['after'], rows, studies)
                        case['controls'] = page.get_by_role('button').all_text_contents()
                        if case['status'] == 'RUNNING':
                            case['status'] = 'PASS_TECHNICAL_CHECK_ONLY'
                    except Exception as error:
                        case.update(status='FAIL', error=str(error))
                        try:
                            case['failure_snapshot']=page.evaluate(SNAPSHOT)
                            case['visible_text']=page.locator('body').inner_text()
                        except Exception as observation_error:
                            case['observation_error']=str(observation_error)
                    finally:
                        try:
                            page.screenshot(path=str(out/(name+'-after.png')), full_page=True)
                        except Exception as error:
                            case['screenshot_error'] = str(error)
                        page.close()
                        save()

                # Exercise actual served OHIF controls; Part 1's standalone DOM is not
                # the viewer's UI contract. Preserve the unopened default separately.
                mg = [r for r in rows if r['modality'] == 'MG']
                for index, study in enumerate(sorted({r['study'] for r in mg})):
                    def magnification(page, case):
                        page.locator('[data-cy="Zoom"]').click()
                        canvas=page.locator('[data-cy="viewport-grid"] canvas').first
                        box=canvas.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
                        page.mouse.move(x,y);page.mouse.down();page.mouse.move(x,y+50,steps=12);page.mouse.up()
                        page.wait_for_function('before => ('+SNAPSHOT+')()[0]?.camera.parallelScale !== before',
                                               arg=case['before'][0]['camera']['parallelScale'])
                        case['zoom']=page.evaluate(SNAPSHOT)
                        check_images(case['zoom'],rows,[study])
                        page.screenshot(path=str(out/(case['case']+'-zoom.png')))
                        page.keyboard.press('=')
                        page.wait_for_function('before => ('+SNAPSHOT+')()[0]?.camera.parallelScale !== before',
                                               arg=case['zoom'][0]['camera']['parallelScale'])
                        page.screenshot(path=str(out/(case['case']+'-fit.png')))
                        case['fit'] = page.evaluate(SNAPSHOT)
                        case['one_to_one']='NOT_RUN: separate calibrated 1:1 verification required'
                        case['cad_free']='Observe screenshot and loaded SOPs; no CAD/SR/SEG was imported'
                        case['status']='OBSERVED_MANUAL_REVIEW_REQUIRED'
                    run_case('mg-magnification-'+str(index), [study], magnification)
                pairs = {}
                for row in mg:
                    pairs.setdefault((row['set'], row['patient']), {})[row['study']] = row['date']
                comparison = [sorted(studies, key=studies.get, reverse=True) for studies in pairs.values()
                              if len(set(studies.values())) > 1]
                if not comparison:
                    result['cases'].append({'case':'mg-real-prior', 'status':'NOT_RUN',
                                             'reason':'No imported same-published-patient, different-date pair'})
                for index, studies in enumerate(comparison):
                    def comparison_layout(page,case):
                        cells=case['before']
                        current=[c for c in cells if '/studies/'+case['studies'][0]+'/' in c['image']]
                        prior=[c for c in cells if '/studies/'+case['studies'][1]+'/' in c['image']]
                        if max(c['x'] for c in current)>=min(c['x'] for c in prior):
                            raise AssertionError('Current is not left of prior in the default comparison')
                        case['comparison']='Current left, actual same-subject prior right; images identified'
                        by_sop={r['sop']:r for r in rows}
                        pairs=[]
                        for left in current:
                            for right in prior:
                                if left['y']!=right['y']:
                                    continue
                                a=mg_projection(by_sop[IDENTITY.search(left['image']).group(3)],source_root)
                                b=mg_projection(by_sop[IDENTITY.search(right['image']).group(3)],source_root)
                                pairs.append({'current_image':left['image'],'prior_image':right['image'],
                                    'current_projection':a,'prior_projection':b})
                        case['hanging_pairs']=pairs
                        for pair in pairs:
                            a,b=pair['current_projection'],pair['prior_projection']
                            if not a['laterality'] or not b['laterality'] or not (a['view_codes'] or a['view_position']) or not (b['view_codes'] or b['view_position']):
                                raise AssertionError('Original MG projection is incomplete; hanging not verified')
                            if a['laterality']!=b['laterality'] or (a['view_codes'] and b['view_codes'] and a['view_codes']!=b['view_codes']) or (not (a['view_codes'] and b['view_codes']) and a['view_position']!=b['view_position']):
                                raise AssertionError('Automatic MG comparison pairs different breast lateralities or projections')
                    run_case('mg-real-prior-'+str(index), studies[:2], comparison_layout)

                cine = [r for r in rows if r['modality'] == 'XA' and r['frames'] > 1]
                if not cine:
                    result['cases'].append({'case':'xa-cine-and-frame-navigation', 'status':'NOT_RUN',
                                             'reason':'No public multiframe XA imported; RF is not XA'})
                for index, row in enumerate(cine):
                    def navigate(page, case, row=row):
                        current = case['before'][0]
                        if '/instances/'+row['sop']+'/' not in current['image']:
                            raise AssertionError('Select the XA cine series in the real page before acceptance')
                        if int(IDENTITY.search(current['image']).group(4)) != 1:
                            raise AssertionError('XA traversal must begin at stored frame 1')
                        canvas = page.locator('[data-cy="viewport-grid"] canvas').first
                        canvas.click()
                        case['navigation'] = [current['image']]
                        for frame in range(2, row['frames']+1):
                            page.keyboard.press('ArrowDown')
                            page.wait_for_function("wanted => ("+SNAPSHOT+")().some(c => c.image.split(/[?#]/)[0].endsWith(wanted))",
                                arg='/instances/'+row['sop']+'/frames/'+str(frame))
                            check_images(page.evaluate(SNAPSHOT), rows, [row['study']])
                            case['navigation'].append(page.evaluate(SNAPSHOT)[0]['image'])
                        page.keyboard.press('ArrowUp')
                        page.wait_for_function('last => ('+SNAPSHOT+')()[0]?.index === last-2',arg=row['frames'])
                        case['backward_step']=page.evaluate(SNAPSHOT)[0]['image']
                        check_images(page.evaluate(SNAPSHOT),rows,[row['study']])
                        page.locator('[data-cy="MoreTools-split-button-secondary"]').click()
                        page.locator('[data-cy="Cine"]').click()
                        page.get_by_role('button',name='First Frame',exact=True).click()
                        page.wait_for_function('() => ('+SNAPSHOT+')()[0]?.index === 0')
                        page.evaluate('''() => {
                          window.mgxaRenders=[];
                          for(const cell of services.viewportGridService.getState().viewports.values()){
                            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
                            v.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,()=>{
                              window.mgxaRenders.push({t:performance.now(),index:v.getCurrentImageIdIndex(),image:v.getCurrentImageId()});
                            });
                          }
                        }''')
                        play = page.locator('[data-cy="cine-player-play-pause"]').first
                        case['configured_rate']=displayed_fps(page)
                        case['cine_controls']=page.locator('#kin-cine').inner_text()
                        play.click()
                        # One complete source loop provides every frame and its wrap.
                        page.wait_for_function('n => window.mgxaRenders.filter((r,i,a)=>!i||r.image!==a[i-1].image).length>n',arg=row['frames'])
                        play.click()
                        case['render_timestamps']=page.evaluate('window.mgxaRenders')
                        unique=[r for i,r in enumerate(case['render_timestamps']) if i==0 or r['image']!=case['render_timestamps'][i-1]['image']]
                        case['measured_fps']=(len(unique)-1)*1000/(unique[-1]['t']-unique[0]['t'])
                        if not all((b['index']-a['index'])%row['frames']==1 for a,b in zip(unique,unique[1:])):
                            raise AssertionError('Cine skipped or reordered stored frames')
                        stopped=page.evaluate(SNAPSHOT)[0]
                        # Observe a full loop at the configured rate, rather than inventing
                        # an accuracy tolerance or calling a requested FPS a measured FPS.
                        page.wait_for_timeout(1000*row['frames']/case['configured_rate'])
                        later=page.evaluate(SNAPSHOT)[0]
                        if stopped['image']!=later['image'] or later['playing']:
                            raise AssertionError('Cine continued after Stop')
                        case['stop_observed']=True
                        page.locator('[data-cy="cine-player-left-arrow"]').first.click()
                        changed=displayed_fps(page)
                        if changed==case['configured_rate']:
                            raise AssertionError('Native FPS control did not change the selected rate')
                        page.evaluate('window.mgxaRenders=[]')
                        play.click()
                        page.wait_for_function('n => window.mgxaRenders.filter((r,i,a)=>!i||r.image!==a[i-1].image).length>n',arg=row['frames'])
                        play.click()
                        adjusted=page.evaluate('window.mgxaRenders')
                        unique_adjusted=[r for i,r in enumerate(adjusted) if i==0 or r['image']!=adjusted[i-1]['image']]
                        case['changed_rate']={'configured':changed,'render_timestamps':adjusted,
                            'measured_fps':(len(unique_adjusted)-1)*1000/(unique_adjusted[-1]['t']-unique_adjusted[0]['t'])}
                        case['source_timing']=row['attributes']
                        frame_time=row['attributes'].get('FrameTime',[])
                        case['source_fps']=1000/float(frame_time[0]) if frame_time and float(frame_time[0])>0 else None
                        case['source_rate_contract']='NOT_RUN: Part 1 source-timeline mode requires its real served integration'
                        case['rate_accuracy']='MEASURED_ONLY: no approved frame-rate tolerance supplied'
                    run_case('xa-cine-'+str(index), [row['study']], navigate)
            finally:
                context.tracing.stop(path=str(out/'trace.zip'))
                browser.close()
        if not result['cases']:
            raise ValueError('No cases matched the selection')
        result['status'] = ('FAIL' if any(c['status']=='FAIL' for c in result['cases']) else
                            'PARTIAL' if any(c['status'] in ('NOT_RUN','OBSERVED_MANUAL_REVIEW_REQUIRED') for c in result['cases']) else
                            'TECHNICAL_CHECKS_COMPLETE_DOCTOR_ACCEPTANCE_PENDING')
    except Exception as error:
        result.update(status='BLOCKED', error=str(error))
    finally:
        save()
    print(result['status'])
    return 0 if result['status']=='TECHNICAL_CHECKS_COMPLETE_DOCTOR_ACCEPTANCE_PENDING' else 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
