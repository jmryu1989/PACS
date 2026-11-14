"""HALO PACS branding on the screens people see: no old product name, and colour tokens that keep their contrast.

1. The files that draw titles, wordmarks, sign-in buttons, notices, mail subjects, download names, the certificate
   subject, operator alerts, the viewer shell and the in-page sentences naming the product carry neither the old
   long name nor the old short name (as a word, in Korean, or as a download-name prefix). Comments are removed by
   syntax (HTML comments; JS/CSS comments outside strings, also inside <script>/<style>; # lines in properties, shell,
   nginx and Python) and each log call (console.*) is removed by parsing the call to its closing parenthesis, so
   text beside it is still read. Internal identifiers (kin-*, KIN_*, X-KIN-*, /kin-brand/) are not words.
2. The clinical-context source labels are a server contract (tests/clinical_context_vectors.json texts.sourceLabels,
   which the server and model suites check against both halves). A string literal whose value is exactly one of those
   labels may stay in clinical-context.js; the shipped model, run in node, must expose those labels and render every
   section with the product name instead.
3. The colour tokens of the sign-in page, the identity-provider theme, the work pages and the notices meet WCAG 2.2
   contrast: 4.5:1 for text, 3:1 for the boundaries a control needs (relative luminance, sRGB).

Reads committed files; node runs the shipped clinical-context model. No browser, server or network.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
H = 'worklist-v0/hpacs-lite/'
KC = 'keycloak/themes/kin-login/login/'
VISIBLE = [
    H + name for name in (
        'index.html', 'main.html', 'admin.html', 'clinician.html', 'audit.html', 'page-boot.js', 'viewer-identity.js',
        'clinical-context.js', 'critical-result-inbox.js', 'critical-result-send.js', 'order-reconciliation.js',
        'study-arrivals.js', 'study-identity.js', 'study-info-panel.js', 'kin-emblem-j1.svg')
] + [
    'worklist-v0/legal/' + name for name in ('privacy.html', 'operator-notice.html', 'accessibility.html', 'open-source-notices.html')
] + [
    KC + 'messages/messages.properties', KC + 'messages/messages_en.properties', KC + 'messages/messages_ko.properties',
    KC + 'resources/css/login.css', KC + 'resources/img/kin-emblem-j1.svg',
    'keycloak/themes/kin-email/email/messages/messages_ko.properties', 'keycloak/kin-realm.json',
    'proxy/branding/kin-emblem-j1.svg', 'proxy/branding/viewer-manifest.json', 'proxy/nginx.conf.template',
    'proxy/10-selfsigned.sh', 'config/ohif/branding-defaults.js', 'config/ohif/branding.js', 'config/ohif/history.js',
    'api/src/query-retrieve.ts', 'api/src/pacs/metrics.ts', 'api/src/study-transfer-local.service.ts',
    'scripts/build-open-source-notices.py', 'scripts/ops_notify.py', 'scripts/ops_email_monitor.py',
    'tools/minhoon-studio/server/static.js',
]
# Korean particles that can follow the name (each may take a trailing 는/도/만/의/은): 킨에서는, 킨으로는, 킨만 …
PARTICLES = '|'.join(sorted('은 는 이 가 을 를 의 에 에서 에게 께 과 와 로 으로 만 도 까지 부터 처럼 보다 이나 나 이며 이고 이다 입니다 이라'.split(),
                           key=len, reverse=True))
OLD = re.compile(r'(?i:korea\s+imaging)'                          # the long name, any case
                 r'|(?<![A-Za-z0-9_\-/.])KIN(?![A-Za-z0-9_\-])'    # the short name as a word
                 r'|(?<![A-Za-z0-9_\-/.])KIN-(?:originals|manual)'  # download names
                 r'|(?<![가-힣])킨(?:' + PARTICLES + r')?(?:는|도|만|의|은)?(?![가-힣])')
VECTORS = ROOT / 'tests/clinical_context_vectors.json'
CONSOLE = re.compile(r'\bconsole\s*\.\s*(?:log|warn|error|info|debug)\s*\(')
STRING = re.compile(r'''(["'`])((?:\\.|(?!\1).)*)\1''', re.S)
REGEX_BEFORE = set('(,=:[!&|?{};+-*%<>~^') | {''}


def blank(text):
    """The same text with every character but newlines replaced by spaces (keeps line numbers)."""
    return re.sub(r'[^\n]', ' ', text)


def strip_script(text, css=False):
    """JS/TS/CSS source without comments; strings, template literals and regex literals are kept as written."""
    out, i, n, last = [], 0, len(text), ''
    while i < n:
        c, nxt = text[i], text[i + 1:i + 2]
        if c in '"\'`':
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1])
            i, last = j + 1, c
        elif c == '/' and nxt == '*':
            j = text.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append(blank(text[i:j]))
            i = j
        elif c == '/' and nxt == '/' and not css:
            j = text.find('\n', i)
            j = n if j < 0 else j
            out.append(blank(text[i:j]))
            i = j
        elif c == '/' and not css and last in REGEX_BEFORE:
            j, in_class = i + 1, False
            while j < n and text[j] != '\n' and (in_class or text[j] != '/'):
                in_class = (in_class or text[j] == '[') and text[j] != ']'
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1])
            i, last = j + 1, '/'
        else:
            out.append(c)
            if not c.isspace():
                last = c
            i += 1
    return ''.join(out)


def strip_html(text):
    text = re.sub(r'<!--.*?-->', lambda m: blank(m.group()), text, flags=re.S)

    def inner(match, css):
        return match.group(1) + strip_script(match.group(2), css=css) + match.group(3)
    text = re.sub(r'(<script\b[^>]*>)(.*?)(</script>)', lambda m: inner(m, False), text, flags=re.S | re.I)
    return re.sub(r'(<style\b[^>]*>)(.*?)(</style>)', lambda m: inner(m, True), text, flags=re.S | re.I)


def end_of_call(text, open_at):
    """Index just past the parenthesis closing the one at open_at; string and template literals are skipped."""
    depth, i, n = 0, open_at, len(text)
    while i < n:
        c = text[i]
        if c in '"\'`':
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == '\\' else 1
            i = j + 1
            continue
        depth += {'(': 1, ')': -1}.get(c, 0)
        i += 1
        if depth == 0:
            return i
    return n


def strip_logs(text):
    out, at = [], 0
    for match in CONSOLE.finditer(text):
        if match.start() < at:
            continue
        end = end_of_call(text, match.end() - 1)
        out += [text[at:match.start()], blank(text[match.start():end])]
        at = end
    return ''.join(out) + text[at:]


def wire_labels():
    return json.loads(VECTORS.read_text(encoding='utf-8'))['texts']['sourceLabels']


def shown_text(path, text):
    """The text that can reach a person: comments removed by syntax, log calls removed as expressions."""
    if path.endswith(('.html', '.svg')):
        text = strip_html(text)
    elif path.endswith(('.js', '.ts', '.cjs')):
        text = strip_script(text)
    elif path.endswith('.css'):
        text = strip_script(text, css=True)
    elif path.endswith(('.properties', '.template', '.py', '.sh')):
        text = re.sub(r'(?m)^[ \t]*#.*$', '', text)
    text = strip_logs(text)
    if path.endswith('clinical-context.js'):
        # The server's contract values, kept as the page's check of the answer (see the model test below).
        contract = set(wire_labels().values())
        text = STRING.sub(lambda m: blank(m.group()) if m.group(2) in contract else m.group(), text)
    return text


def leftovers(files=VISIBLE, root=ROOT):
    found = []
    for rel in files:
        text = shown_text(rel, (root / rel).read_text(encoding='utf-8'))
        for number, line in enumerate(text.split('\n'), 1):
            if OLD.search(line):
                found.append(f'{rel}:{number}: {line.strip()[:160]}')
    return found


MODEL_RUN = r"""
const vm = require('vm'), fs = require('fs');
const [model, vectors] = process.argv.slice(1);
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(model, 'utf8'), context, { filename: 'clinical-context.js' });
const api = context.KinClinicalContext, valid = JSON.parse(fs.readFileSync(vectors, 'utf8')).answers.valid;
const views = {};
for (const name of ['A-PRESENT-OWNER', 'A-PRESENT-TELE']) {
  views[name] = api.view(JSON.parse(JSON.stringify(valid[name])), {}, { format: value => value, actor: value => value });
}
process.stdout.write(JSON.stringify({ labels: api.SOURCE_LABELS, views }));
"""


def run_model():
    node = shutil.which('node')
    if not node:
        raise AssertionError('node is required: the clinical-context model is run, not read')
    result = subprocess.run([node, '-e', MODEL_RUN, str(ROOT / H / 'clinical-context.js'), str(VECTORS)],
                            capture_output=True, text=True, encoding='utf-8', timeout=60)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def luminance(colour):
    value = colour.lstrip('#')
    if len(value) == 3:
        value = ''.join(c * 2 for c in value)
    channels = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(a, b):
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def tokens(rel):
    """The custom properties of the first :root block whose values are plain 6-digit colours."""
    text = (ROOT / rel).read_text(encoding='utf-8')
    block = re.search(r':root\s*\{(.*?)\}', text, re.S).group(1)
    return {name: value.lower() for name, value in re.findall(r'(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;', block)}


TEXT, UI = 4.5, 3.0
# (file, foreground token, background token, minimum)
PAIRS = [
    (H + 'index.html', '--kin-text', '--kin-panel', TEXT), (H + 'index.html', '--kin-muted', '--kin-panel', TEXT),
    (H + 'index.html', '--kin-dim', '--kin-panel', TEXT), (H + 'index.html', '--kin-highlight', '--kin-bg', TEXT),
    (H + 'index.html', '--kin-btn-text', '--kin-btn', TEXT), (H + 'index.html', '--kin-btn-line', '--kin-panel', UI),
    (H + 'index.html', '--kin-muted', '--kin-bg', TEXT),
    (KC + 'resources/css/login.css', '--kin-text', '--kin-card-bg', TEXT),
    (KC + 'resources/css/login.css', '--kin-label', '--kin-card-bg', TEXT),
    (KC + 'resources/css/login.css', '--kin-dim', '--kin-card-bg', TEXT),
    (KC + 'resources/css/login.css', '--kin-muted', '--kin-bg', TEXT),
    (KC + 'resources/css/login.css', '--kin-input-border', '--kin-card-bg', UI),
    (KC + 'resources/css/login.css', '--kin-btn-line', '--kin-card-bg', UI),
    (H + 'admin.html', '--text', '--panel', TEXT), (H + 'admin.html', '--muted', '--panel2', TEXT),
    (H + 'admin.html', '--bg', '--accent', TEXT),
    (H + 'clinician.html', '--text', '--panel', TEXT), (H + 'clinician.html', '--muted', '--panel2', TEXT),
    (H + 'clinician.html', '--focus', '--bg', UI),
    ('worklist-v0/legal/legal.css', '--kin-text', '--kin-panel', TEXT),
    ('worklist-v0/legal/legal.css', '--kin-muted', '--kin-panel', TEXT),
    ('worklist-v0/legal/legal.css', '--kin-highlight', '--kin-panel', TEXT),
]


class HaloBrandTest(unittest.TestCase):
    def test_no_old_product_name_on_visible_surfaces(self):
        self.assertEqual([], leftovers())

    def test_the_guard_reads_what_it_should(self):
        # Found: titles, attributes, text that looks like a comment but is page text, script strings beside a log call,
        # Korean and download names. Not found: identifiers, real comments, words that merely contain the syllable.
        probe = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (probe / 'sample.html').write_text(
            '<title>X — KIN</title>\n'                                                         # 1 found
            '<a href="/kin-brand/a.svg" data-x="KIN_A X-KIN-Session">ok</a>\n'                 # 2
            '<!-- KIN comment -->\n'                                                            # 3
            '<script>// KIN note\n'                                                             # 4
            'const a = "KIN 계정"; /* Korea Imaging */ const re = /a\\/b/; const u = "https://x.test/KIN";</script>\n'  # 5 found
            '<p title="KOREA IMAGING NETWORK"></p>\n'                                           # 6 found
            '<p>/* KIN */</p>\n'                                                                # 7 found (page text)
            '<script>console.warn("KIN log"); el.textContent = "KIN 화면";</script>\n'           # 8 found (beside the log)
            '<script>console.warn("KIN log only");</script>\n'                                  # 9
            '<p>킨으로 계속 · 지킨다</p>\n'                                                        # 10 found (킨으로)
            '<p>지킨다 · 킨스 · 피킨</p>\n'                                                        # 11
            '<style>/* KIN */ .a { content: "KIN"; }</style>\n'                                 # 12 found (content)
            '<a download="KIN-originals-1.zip">d</a>\n'                                         # 13 found
            '<script>console.log("("); el.textContent = "KIN"; console.log(")");</script>\n'  # 14 found
            '<p>킨에서는 · 킨으로는 · 킨만</p>\n', encoding='utf-8')                                # 15 found
        found = leftovers(['sample.html'], probe)
        self.assertEqual([1, 5, 6, 7, 8, 10, 12, 13, 14, 15], [int(f.split(':')[1]) for f in found], found)
        for word in ('킨에서는', '킨으로는', '킨만', '킨이', '킨의'):
            self.assertTrue(OLD.search(word), word)
        for word in ('지킨다', '킨스', '피킨', '치킨'):
            self.assertIsNone(OLD.search(word), word)

    def test_source_labels_are_the_server_contract_and_the_page_shows_the_product_name(self):
        wire = wire_labels()
        shown = json.loads(VECTORS.read_text(encoding='utf-8'))['texts']['sourceTexts']
        self.assertEqual(set(wire), set(shown))
        for key, label in wire.items():
            with self.subTest(section=key):
                self.assertEqual(re.sub(r'\bKIN\b', 'HALO PACS', label), shown[key])
        run = run_model()
        self.assertEqual(wire, run['labels'], 'the page checks the exact server values')
        for name, view in run['views'].items():
            with self.subTest(answer=name):
                texts = list(strings(view))
                self.assertEqual([], [text for text in texts if OLD.search(text)])
                for section in view['sections']:
                    self.assertIn(shown[section['name']], ' '.join(strings(section)), section['name'])

    def test_colour_tokens_meet_contrast(self):
        for rel, fg, bg, minimum in PAIRS:
            values = tokens(rel)
            with self.subTest(file=rel, pair=(fg, bg)):
                self.assertIn(fg, values)
                self.assertIn(bg, values)
                self.assertGreaterEqual(round(contrast(values[fg], values[bg]), 2), minimum,
                                        f'{fg} {values[fg]} on {bg} {values[bg]}')

    def test_contrast_formula(self):
        self.assertEqual(21.0, round(contrast('#000000', '#ffffff'), 2))
        self.assertEqual(5.79, round(contrast('#ffffff', '#245cdb'), 2))
        self.assertEqual(7.24, round(contrast('#8ab4c8', '#212121'), 2))


if __name__ == '__main__':
    unittest.main(verbosity=2)
