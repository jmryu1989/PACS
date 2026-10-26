#!/usr/bin/env python3
"""Verify the synthetic remote demo from the laptop against its PUBLIC URL (D1872), the way Minhoon will use it.

Cases: TLS (self-signed, warning expected), health, reader login -> worklist with every loaded study, CT opened from
the worklist into a separate viewer window (current + automatic prior = two panes), report editor typing Korean
through Chromium IME composition events, save + read-back, Related Report showing the approved prior, MG DBT current
vs prior comparison (with the viewer's frame request timings), XA cine frames, clinician-only login. Each case is PASS / FAIL /
NOT_RUN with its evidence; headless Chromium is not Minhoon's GPU, monitors or IME (those stay with him).
The typing case discards its own draft and hold afterwards so the reader account starts clean.
"""
import argparse
import json
from pathlib import Path
import socket
import ssl
import sys
import time
import traceback

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / 'scripts'))
sys.path.insert(0, str(HERE))
from demo_setup import SEED_TEXT, api, login  # noqa: E402
from mgxa_viewer_check import SNAPSHOT, ready_snapshot  # noqa: E402

KOREAN = '한글 입력 확인 — 시연 검증용 문장'   # typed, saved, read back, then discarded
# Chromium IME composition steps for the first two syllables (jamo -> syllable), then the rest committed as text.
COMPOSE = [['ㅎ', '하', '한'], ['ㄱ', '그', '글']]


def run_case(result, name, fn, out):
    case = {'case': name, 'status': 'RUNNING', 'started': time.strftime('%Y-%m-%dT%H:%M:%S')}
    result['cases'].append(case)
    t0 = time.monotonic()
    try:
        fn(case)
        if case['status'] == 'RUNNING':
            case['status'] = 'PASS'
    except Exception as error:
        case.update(status='FAIL', error=f'{type(error).__name__}: {error}', trace=traceback.format_exc()[-3000:])
    case['seconds'] = round(time.monotonic() - t0, 1)
    (out / 'verify.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--inventory', required=True)
    parser.add_argument('--output', required=True, help='New directory')
    parser.add_argument('--timeout', type=float, default=180, help='Per-action hang timeout (s); DBT frames are large')
    parser.add_argument('--headed', action='store_true')
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    creds = json.loads(Path(args.credentials).read_text(encoding='utf-8'))
    inv = json.loads(Path(args.inventory).read_text(encoding='utf-8'))
    origin = creds['origin'].rstrip('/')
    host = origin.split('://', 1)[1]
    demo = inv['demo']
    ct_current, ct_prior = demo['ct_current_prior']['TCGA-CW-5580']
    typing_uid = demo['ct_current_prior']['TCGA-B8-A54F'][0]
    mg_current, mg_prior = demo['mg_studies_by_date'][0][1], demo['mg_studies_by_date'][-1][1]
    reader, clinician = creds['accounts']['reader'], creds['accounts']['clinician']
    result = {'origin': origin, 'sha': creds.get('sha'), 'run_name': creds.get('run_name'), 'cases': [],
              'limits': ['Headless Chromium + SwiftShader on the laptop: not Minhoon\'s RTX 3060, monitors or OS IME',
                         'IME is exercised with Chromium composition events (Input.imeSetComposition), not a real Korean IME',
                         'Display detection / per-monitor placement needs the real two-monitor PC: NOT_RUN here',
                         'Network timings are from the laptop network, not Minhoon\'s']}

    def tls(case):
        pem = ssl.get_server_certificate((host, 443))
        case['certificate_sha256'] = __import__('hashlib').sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
        try:
            with socket.create_connection((host, 443), timeout=10) as raw:
                with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
                    case['browser_warning_expected'] = False
        except ssl.SSLCertVerificationError as error:
            case['browser_warning_expected'] = True
            case['verify_error'] = error.verify_message
        try:
            socket.create_connection((host, 80), timeout=5).close()
            case['port_80'] = 'open'
        except OSError:
            case['port_80'] = 'closed (use https:// explicitly)'
    run_case(result, 'tls-self-signed', tls, out)

    def health(case):
        r = requests.get(origin + '/api/health', verify=False, timeout=30)
        case['body'] = r.json()
        if r.status_code != 200 or case['body'].get('memberRights') != 'ready':
            raise AssertionError('health not ready')
    requests.packages.urllib3.disable_warnings()
    run_case(result, 'health', health, out)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed, args=['--enable-unsafe-swiftshader'])
        result['browser'] = browser.version
        try:
            # Portrait worklist/report monitor; the viewer opens as its own window (landscape monitor at the clinic).
            ctx = browser.new_context(ignore_https_errors=True, viewport={'width': 1080, 'height': 1800}, locale='ko-KR')
            ctx.set_default_timeout(args.timeout * 1000)
            ctx.tracing.start(screenshots=True, snapshots=False)
            state = {}

            def reader_login(case):
                t0 = time.monotonic()
                page = login(ctx, origin, reader['username'], reader['password'], args.timeout * 1000, shot=out / 'reader-login-failure.png')
                case['landed'] = page.url.split('#')[0]
                case['login_seconds'] = round(time.monotonic() - t0, 1)
                if not case['landed'].endswith('/worklist/hpacs-lite/main.html'):
                    raise AssertionError('reader did not land on main.html')
                state['page'] = page
            run_case(result, 'reader-login', reader_login, out)

            def worklist(case):
                page = state['page']
                page.wait_for_selector('#rows tr[data-uid]')
                time.sleep(2)
                uids = page.eval_on_selector_all('#rows tr[data-uid]', 'rows => rows.map(r => r.dataset.uid)')
                case['rows'] = len(uids)
                case['missing'] = sorted(set(demo['studies']) - set(uids))
                page.screenshot(path=str(out / 'worklist.png'))
                if case['missing']:
                    raise AssertionError(f"{len(case['missing'])} loaded studies are not in the default worklist")
            run_case(result, 'worklist-shows-all-loaded-studies', worklist, out)

            def ct_viewer_window(case):
                page = state['page']
                row = page.locator(f'#rows tr[data-uid="{ct_current}"]')
                t0 = time.monotonic()
                with ctx.expect_page(timeout=args.timeout * 1000) as popup:
                    row.dblclick()
                viewer = popup.value
                viewer.set_viewport_size({'width': 1920, 'height': 1080})
                viewer.wait_for_load_state('domcontentloaded')
                case['viewer_url'] = viewer.url.split('#')[0]
                snap = ready_snapshot(viewer, [ct_current])
                case['first_render_seconds'] = round(time.monotonic() - t0, 1)
                case['panes'] = len(snap)
                case['studies_in_panes'] = sorted({c['image'].split('/studies/')[1].split('/')[0] for c in snap})
                case['two_windows_open'] = len(ctx.pages) >= 2 and not page.is_closed()
                viewer.screenshot(path=str(out / 'ct-viewer-window.png'))
                if ct_prior not in case['studies_in_panes']:
                    case['status'] = 'PARTIAL'
                    case['note'] = 'current rendered; automatic prior not in a pane'
                state['viewer'] = viewer
            run_case(result, 'ct-from-worklist-in-viewer-window', ct_viewer_window, out)

            def related_report(case):
                page = state['page']
                page.bring_to_front()
                page.locator(f'#rows tr[data-uid="{ct_current}"]').click()
                rel = page.locator(f'#relrows tr[data-uid="{ct_prior}"]')
                rel.wait_for()
                case['related_row'] = rel.inner_text()
                rel.click()
                page.get_by_text(SEED_TEXT['conclusion']).first.wait_for()
                page.screenshot(path=str(out / 'related-report.png'))
            run_case(result, 'related-report-shows-approved-prior', related_report, out)

            def korean_typing(case):
                page = state['page']
                back = page.get_by_role('button', name='Back to Current Draft')
                if back.count() and back.first.is_visible():
                    back.first.click()
                page.locator(f'#rows tr[data-uid="{typing_uid}"]').click()
                box = page.locator('#findings')
                box.wait_for()
                box.click()
                cdp = ctx.new_cdp_session(page)
                for steps in COMPOSE:
                    for text in steps:
                        cdp.send('Input.imeSetComposition', {'text': text, 'selectionStart': len(text), 'selectionEnd': len(text)})
                    cdp.send('Input.insertText', {'text': steps[-1]})
                page.keyboard.insert_text(KOREAN[2:])
                typed = box.input_value()
                case['typed'] = typed
                if typed != KOREAN:
                    raise AssertionError('editor text differs from the composed input')
                page.locator('#b-save').click()
                deadline = time.monotonic() + 60
                while True:
                    draft = api(page, 'GET', f'/studies/{typing_uid}/draft')
                    snap = (draft['json'] or {}).get('snapshot') or {}
                    if snap.get('findings') == KOREAN or time.monotonic() > deadline:
                        break
                    time.sleep(2)
                case['server_findings'] = snap.get('findings')
                page.screenshot(path=str(out / 'report-korean.png'))
                if snap.get('findings') != KOREAN:
                    raise AssertionError('saved draft on the server is not the typed Korean text')
                # Leave the account clean: discard this check's draft and release its hold. No reload: the page's
                # one-time entry proof is spent, and the page is closed at the end of the run anyway.
                time.sleep(3)
                draft = api(page, 'GET', f'/studies/{typing_uid}/draft')
                body = {'expectedOwner': draft['json']['owner'], 'expectedRevision': draft['json']['revision']}
                case['cleanup_draft'] = api(page, 'DELETE', f'/studies/{typing_uid}/draft', body)['status']
                case['cleanup_hold'] = api(page, 'POST', f'/studies/{typing_uid}/release', {})['status']
                after = api(page, 'GET', f'/studies/{typing_uid}/draft')
                case['draft_present_after_cleanup'] = (after['json'] or {}).get('present')
            run_case(result, 'report-editor-korean-ime-save', korean_typing, out)

            def open_direct(case, studies, compare, shot):
                page = ctx.new_page()
                page.set_viewport_size({'width': 1920, 'height': 1080})
                query = 'StudyInstanceUIDs=' + ','.join(studies) + ('&hangingProtocolId=@ohif/hpCompare' if compare else '')
                t0 = time.monotonic()
                page.goto(origin + '/ohif/viewer?' + query, wait_until='domcontentloaded')
                snap = ready_snapshot(page, studies)
                case['first_render_seconds'] = round(time.monotonic() - t0, 1)
                case['panes'] = len(snap)
                case['images'] = [c['image'].split('/studies/')[1][:160] for c in snap]
                # The viewer's own frame requests up to first render (laptop network, not Minhoon's).
                case['frame_requests'] = page.evaluate("""() => { const f = performance.getEntriesByType('resource')
                  .filter(e => e.name.includes('/frames/')); return {count: f.length,
                  mb: Math.round(f.reduce((a, e) => a + (e.encodedBodySize || 0), 0) / 1e5) / 10,
                  max_ms: Math.round(Math.max(0, ...f.map(e => e.duration)))}; }""")
                page.screenshot(path=str(out / shot))
                return page, snap

            def mg_compare(case):
                page, snap = open_direct(case, [mg_current, mg_prior], True, 'mg-dbt-compare.png')
                shown = {c['image'].split('/studies/')[1].split('/')[0] for c in snap}
                if shown != {mg_current, mg_prior}:
                    raise AssertionError('current and prior MG not both displayed')
                page.close()
            run_case(result, 'mg-dbt-current-vs-prior', mg_compare, out)

            def xa_cine(case):
                if not demo['xa_study']:
                    case['status'] = 'NOT_RUN'
                    case['reason'] = 'XA skipped at deploy (-SkipXa)'
                    return
                page, snap = open_direct(case, demo['xa_study'], False, 'xa-cine.png')
                page.locator('[data-cy="viewport-grid"] canvas').first.click()
                seen = {snap[0]['image']}
                for _ in range(4):
                    page.keyboard.press('ArrowDown')
                    time.sleep(0.7)
                    seen.update(c['image'] for c in page.evaluate(SNAPSHOT))
                case['distinct_frames_seen'] = len(seen)
                if len(seen) < 3:
                    raise AssertionError('XA frame navigation did not move through stored frames')
                page.close()
            run_case(result, 'xa-cine-frames', xa_cine, out)

            def clinician_login(case):
                cctx = browser.new_context(ignore_https_errors=True, viewport={'width': 1440, 'height': 900}, locale='ko-KR')
                cctx.set_default_timeout(args.timeout * 1000)
                try:
                    page = login(cctx, origin, clinician['username'], clinician['password'], args.timeout * 1000,
                                 shot=out / 'clinician-login-failure.png')
                    case['landed'] = page.url.split('#')[0]
                    if not case['landed'].endswith('/worklist/hpacs-lite/clinician.html'):
                        raise AssertionError('clinician-only account did not land on clinician.html')
                    time.sleep(3)
                    text = page.locator('body').inner_text()
                    case['sees_patients'] = [p for p in ('TCGA-CW-5580', 'TCGA-B8-A54F', 'EA1141-4339969') if p in text]
                    case['radiology_route'] = api(page, 'GET', f'/studies/{ct_prior}/draft')['status']
                    page.screenshot(path=str(out / 'clinician.png'))
                    if not case['sees_patients']:
                        case['status'] = 'PARTIAL'
                        case['note'] = 'landed on clinician.html; patient list not observed in page text'
                    if case['radiology_route'] != 403:
                        raise AssertionError('clinician-only account reached a radiologist draft route')
                finally:
                    cctx.close()
            run_case(result, 'clinician-only-login', clinician_login, out)
        finally:
            ctx.tracing.stop(path=str(out / 'trace.zip'))
            browser.close()

    statuses = [c['status'] for c in result['cases']]
    result['status'] = 'FAIL' if 'FAIL' in statuses else 'PARTIAL' if any(s != 'PASS' for s in statuses) else 'PASS'
    result['doctor_acceptance'] = 'NOT_RUN (Minhoon\'s own session is the acceptance)'
    (out / 'verify.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'cases': {c['case']: c['status'] for c in result['cases']}}, ensure_ascii=False))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
