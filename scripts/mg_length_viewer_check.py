"""REQ-MG-LENGTH-READBACK -> RISK-MG-WRONG-SCALE/FRAME/BASIS -> TEST-MG-LENGTH-SERVED.

Draw on the real served viewer, save, reopen, navigate and download SR. Requires
the existing isolated mgxa fixture and accepted public originals; never rewrites
source DICOM. Screenshots/downloads stay local under the specified output folder.
"""
import argparse
import io
import json
import math
from pathlib import Path
from urllib.parse import urlencode

import numpy as np
import pydicom
from playwright.sync_api import sync_playwright, expect

from mgxa_viewer_check import verify_proxy


READY = """sop => {
  const service = window.services?.cornerstoneViewportService;
  let grid; try { grid = services.viewportGridService.getState().viewports; } catch { return false; }
  for (const c of grid.values()) {
    const v = service.getCornerstoneViewport(c.viewportId), id = v?.getCurrentImageId?.();
    if (id?.includes('/instances/' + sop + '/') && v.getImageData?.()?.imageData) return v.id;
  }
  return false;
}"""
POINTS = """viewportId => {
  const v = services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const imageData = v.getImageData().imageData, dims = imageData.getDimensions();
  const start = [Math.floor(dims[0] / 2), Math.floor(dims[1] / 2), 0];
  const end = [start[0] + Math.min(100, Math.floor(dims[0] / 8)), start[1] + Math.min(40, Math.floor(dims[1] / 8)), 0];
  const box = v.element.getBoundingClientRect();
  return {image: v.getCurrentImageId(), indexPoints: [start, end],
    client: [start, end].map(p => { const c = v.worldToCanvas(imageData.indexToWorld(p)); return [box.x + c[0], box.y + c[1]]; }),
    spacing: Array.from(v.getImageData().spacing), camera: v.getCamera()};
}"""
ANNOTATIONS = """() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'Length').map(a => ({
  image: a.metadata.referencedImageId, points: a.data.handles.points,
  unverified: a.data.kinUnverified === true, invalidated: a.invalidated,
  stats: a.data.cachedStats
}))"""


def geometry(ds, frame):
    """Independent DICOM/NumPy oracle; no product calculator or cached value."""
    shared = ds.get('SharedFunctionalGroupsSequence', [{}])[0]
    frames = ds.get('PerFrameFunctionalGroupsSequence')
    per = frames[frame - 1] if frames else {}
    enhanced = str(ds.SOPClassUID).startswith('1.2.840.10008.5.1.4.1.1.13.1.')

    def attr(seq, key, default=None):
        group = per.get(seq) or shared.get(seq)
        return group[0].get(key, default) if enhanced and group else default if enhanced else ds.get(key, default)

    spacing = attr('PixelMeasuresSequence', 'PixelSpacing')
    if spacing is None:
        spacing = np.array(attr('FramePixelDataPropertiesSequence', 'ImagerPixelSpacing'), dtype=float)
        factor = attr('XRayGeometrySequence', 'EstimatedRadiographicMagnificationFactor')
        if factor is not None:
            spacing /= float(factor)
    spacing = np.array(spacing, dtype=float)
    origin = np.array(attr('PlanePositionSequence', 'ImagePositionPatient', [0, 0, 0]), dtype=float)
    iop = np.array(attr('PlaneOrientationSequence', 'ImageOrientationPatient', [0, 1, 0, 0, 0, -1]), dtype=float)
    matrix = np.column_stack([iop[:3] * spacing[1], iop[3:] * spacing[0]])
    return spacing, origin, matrix


def open_history(page):
    tab = page.locator('#kin-workspace-dock nav').get_by_role('button', name='Measurements', exact=True)
    # Hover cancels the dock's pending auto-hide before the real tab click.
    tab.hover()
    if tab.get_attribute('aria-expanded') != 'true':
        tab.click()
    expect(page.locator('#kin-viewer-history')).to_be_visible()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', required=True)
    parser.add_argument('--load', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout', type=float, required=True)
    args = parser.parse_args()
    fixture_dir = Path(args.fixture)
    fixture = json.loads((fixture_dir / 'fixture.json').read_text())
    load = json.loads(Path(args.load).read_text())
    inventory = json.loads(Path(load['inventory']).read_text())
    verify_proxy(fixture['project'], fixture['origin'], args.timeout)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    result = {'status': 'RUNNING', 'cases': [], 'origin': fixture['origin']}

    def save():
        (out / 'observations.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--enable-unsafe-swiftshader'])
        context = browser.new_context(ignore_https_errors=True, storage_state=str(fixture_dir / 'storage-state.json'),
                                      viewport={'width': 1600, 'height': 1050}, accept_downloads=True)
        context.set_default_timeout(args.timeout * 1000)
        result['browser'] = browser.version
        for upload in load['uploads']:
            source = upload['source']
            if source['modality'] != 'MG':
                continue
            ds = pydicom.dcmread(Path(inventory['root']) / source['path'], stop_before_pixels=True)
            case = {'sop': source['sop'], 'path': source['path'], 'source_sha256': source['sha256'], 'status': 'RUNNING', 'http_failures': []}
            result['cases'].append(case)
            save()
            page = context.new_page()
            page.on('response', lambda r, c=case: c['http_failures'].append({'url': r.url, 'status': r.status})
                    if r.url.startswith(fixture['origin']) and r.status >= 400 else None)
            page.on('pageerror', lambda e, c=case: c.setdefault('page_errors', []).append(str(e)))
            page.on('dialog', lambda d: d.accept())
            try:
                url = fixture['origin'] + '/ohif/viewer?' + urlencode({'StudyInstanceUIDs': source['study'], 'SeriesInstanceUIDs': source['series']})
                page.goto(url, wait_until='domcontentloaded')
                viewport = page.wait_for_function(READY, arg=source['sop']).json_value()
                frame = max(1, source['frames'] // 2)
                page.evaluate("""([id, frame]) => services.cornerstoneViewportService.getCornerstoneViewport(id).setImageIdIndex(frame - 1)""", [viewport, frame])
                page.wait_for_function("""([id, frame]) => services.cornerstoneViewportService.getCornerstoneViewport(id).getCurrentImageId()?.endsWith('/frames/' + frame)""", arg=[viewport, frame])
                open_history(page)
                expect(page.locator('#kin-viewer-history')).to_be_visible()
                # Select the actual pane before choosing Length, through its real pointer boundary.
                planned = page.evaluate(POINTS, viewport)
                page.mouse.click(*planned['client'][0])
                open_history(page)
                page.locator('#kin-viewer-history').get_by_role('button', name='Length', exact=True).click()
                planned = page.evaluate(POINTS, viewport)
                case['planned'] = planned
                page.mouse.move(*planned['client'][0]); page.mouse.down()
                page.mouse.move(*planned['client'][1], steps=12); page.mouse.up()
                open_history(page)
                row = page.locator('#kin-viewer-history section').filter(has=page.get_by_role('button', name='Save', exact=True)).last
                expect(row).to_be_visible()
                page.wait_for_function("""() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'Length' && !a.invalidated && Object.keys(a.data.cachedStats || {}).length)""")
                with page.expect_response(lambda r: '/viewer-items' in r.url and r.request.method == 'POST') as saved:
                    row.get_by_role('button', name='Save', exact=True).click()
                response = saved.value
                case['save_http'] = response.status
                case['save_body'] = response.json()
                case['save_request'] = response.request.post_data_json
                assert response.ok, case['save_body']
                expect(page.locator('#kin-viewer-history')).to_contain_text('Saved r1')
                marks = page.evaluate(ANNOTATIONS)
                mark = next(m for m in marks if '/instances/' + source['sop'] + '/' in m['image'])
                spacing, origin, matrix = geometry(ds, frame)
                pixel_points = [np.linalg.lstsq(matrix, np.array(p) - origin, rcond=None)[0] for p in mark['points']]
                delta = pixel_points[1] - pixel_points[0]
                expected = math.hypot(delta[0] * spacing[1], delta[1] * spacing[0])
                case.update(frame=frame, drawn=mark, pixel_points=[p.tolist() for p in pixel_points], expected_mm=expected)
                case['svg_text'] = page.locator('svg text').all_text_contents()
                assert any('mm' in t for t in case['svg_text']) and any('PixelSpacing' in t for t in case['svg_text']), case['svg_text']
                page.screenshot(path=str(out / f'{len(result["cases"])}-saved.png'))
                case['phase'] = 'saved'; save()
                page.reload(wait_until='domcontentloaded')
                page.wait_for_function('''study => window.cornerstone?.getEnabledElements?.().some(e =>
                  e.viewport.getCurrentImageId?.()?.includes('/studies/' + study + '/'))''', arg=source['study'])
                open_history(page)
                page.locator('#kin-viewer-history section[data-item-id="' + case['save_body']['id'] + '"]').get_by_role('button', name='Go to Image', exact=True).click()
                page.wait_for_function("""([sop, frame]) => cornerstoneTools.annotation.state.getAllAnnotations().some(a =>
                  a.metadata.toolName === 'Length' && a.metadata.referencedImageId.includes('/instances/' + sop + '/') &&
                  a.metadata.referencedImageId.endsWith('/frames/' + frame) && !a.invalidated && !a.data.kinUnverified)""", arg=[source['sop'], frame])
                page.wait_for_function('''([sop, frame]) => {
                  const id = services.viewportGridService.getActiveViewportId();
                  const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
                  return v?.getCurrentImageId()?.includes('/instances/' + sop + '/') && v.getCurrentImageId().endsWith('/frames/' + frame) && v.getImageData?.()?.imageData;
                }''', arg=[source['sop'], frame])
                case['reopened_view'] = page.evaluate(POINTS, page.evaluate('() => services.viewportGridService.getActiveViewportId()'))
                case['reopened'] = page.evaluate(ANNOTATIONS)
                case['measurement_exports'] = page.evaluate('''() => services.measurementService.getMeasurements().map(m => ({
                  displayText: m.displayText, report: m.getReport?.()
                }))''')
                assert any('Measurement basis' in m.get('report', {}).get('columns', []) for m in case['measurement_exports'])
                open_history(page)
                with page.expect_download() as download:
                    page.get_by_role('button', name='Download SR', exact=True).first.click()
                raw = Path(download.value.path()).read_bytes()
                (out / f'{len(result["cases"])}-manual-sr.dcm').write_bytes(raw)
                sr = pydicom.dcmread(io.BytesIO(raw))
                groups = next(n for n in sr.ContentSequence if n.ConceptNameCodeSequence[0].CodeValue == '126010').ContentSequence
                found = []
                for group in groups:
                    numeric = next(n for n in group.ContentSequence if n.ValueType == 'NUM')
                    coords = numeric.ContentSequence[0]
                    ref = coords.ContentSequence[0].ReferencedSOPSequence[0]
                    if str(ref.ReferencedSOPInstanceUID) != source['sop']:
                        continue
                    value = float(numeric.MeasuredValueSequence[0].NumericValue)
                    assert abs(value - expected) <= .001, (value, expected)  # Existing server Length tolerance.
                    assert int(ref.get('ReferencedFrameNumber', 1)) == frame
                    comments = [str(n.TextValue) for n in group.ContentSequence if n.ValueType == 'TEXT']
                    assert any('PixelSpacing' in t for t in comments)
                    found.append({'value': value, 'frame': int(ref.get('ReferencedFrameNumber', 1)), 'comments': comments, 'graphic': list(coords.GraphicData)})
                assert found, 'Missing source in downloaded SR'
                case['sr'] = found
                page.screenshot(path=str(out / f'{len(result["cases"])}-reopened.png'))
                case['status'] = 'PASS'
            except Exception as error:
                case.update(status='FAIL', error=str(error))
                try:
                    case['history_text'] = page.locator('#kin-viewer-history').inner_text(timeout=5000)
                    case['annotations'] = page.evaluate(ANNOTATIONS)
                    page.screenshot(path=str(out / f'{len(result["cases"])}-failure.png'))
                except Exception:
                    pass
            finally:
                page.close()
                save()
        browser.close()
    result['status'] = 'PASS' if result['cases'] and all(c['status'] == 'PASS' for c in result['cases']) else 'FAIL'
    save()
    print(result['status'], [(c['sop'][-8:], c['status']) for c in result['cases']])
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
