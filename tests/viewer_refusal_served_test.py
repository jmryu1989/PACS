# coding: utf-8
"""Patientless-image refusal on the real authenticated, served OHIF page.

Run against an isolated mgxa_fixture with the unchanged public GDCM XA imported.
No substituted responses, loader events, renderers or product hooks.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--storage-state', required=True)
    parser.add_argument('--study', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout', required=True, type=float)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    result = {'status': 'NOT_RUN', 'responses': []}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--enable-unsafe-swiftshader'])
        context = browser.new_context(ignore_https_errors=True, storage_state=args.storage_state,
                                      viewport={'width': 1600, 'height': 1050})
        page = context.new_page()
        page.set_default_timeout(args.timeout * 1000)
        expect.set_options(timeout=args.timeout * 1000)
        def record(response):
            if '/frames/' in response.url and response.status >= 400:
                result['responses'].append({'url': response.url, 'status': response.status,
                                            'body': response.json()})
        page.on('response', record)
        try:
            response = page.goto(args.origin.rstrip('/') + '/ohif/viewer?' +
                                 urlencode({'StudyInstanceUIDs': args.study}))
            assert response.ok and '/ohif/viewer' in page.url, 'Authenticated served viewer must open'
            alert = page.get_by_role('alert').filter(has_text='PatientID').first
            expect(alert).to_be_visible()
            expect(alert).to_contain_text('환자 정보 등록·정정')
            expect(alert).to_contain_text('다시 열어')
            expect(alert).to_contain_text('HTTP 404')
            refused = [r for r in result['responses'] if
                       r['body'].get('code') == 'IMAGE_SOURCE_IDENTITY_UNAVAILABLE']
            assert refused and all(r['status'] == 404 for r in refused), 'Unchanged source remains refused'
            expect(alert).to_contain_text(refused[0]['body']['message'])
            result['visible_text'] = alert.inner_text()
            result['status'] = 'PASS'
        except Exception as error:
            result.update(status='FAIL', error=str(error))
        finally:
            page.screenshot(path=str(out / 'refusal.png'), full_page=True)
            (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            browser.close()
    print(result['status'])
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
