"""Real served worklist on the synthetic HTTP/PG consumer fixture; no substituted API responses."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

facts = json.load(sys.stdin)
output = Path(facts['output'])
output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    # A fixture-owned BFF session uses the synthetic provider's signed token; all API responses are served by production.
    page.context.add_cookies([{'name': 'kin_sid', 'value': facts['sid'], 'url': facts['origin'], 'httpOnly': True}])
    page.set_extra_http_headers({'x-real-ip': '192.0.2.41'})
    responses = []
    page.on('response', lambda response: responses.append({'url': response.url, 'status': response.status})
            if '/api/' in response.url else None)
    try:
        page.goto(facts['origin'] + '/worklist/main.html', wait_until='networkidle')
        page.wait_for_function("document.body.innerText.includes('SYN CONSUMER')")
        assert any('/api/studies' in r['url'] and r['status'] == 200 for r in responses), responses
    finally:
        page.screenshot(path=str(output / 'worklist.png'), full_page=True)
        (output / 'responses.json').write_text(json.dumps(responses, indent=2), encoding='utf-8')
        (output / 'body.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
        browser.close()
