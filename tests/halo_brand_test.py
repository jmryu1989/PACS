"""HALO PACS branding on the screens people see: no old product name, and colour tokens that keep their contrast.

1. The files that draw titles, wordmarks, sign-in buttons, notices, mail subjects, download names, the certificate
   subject, operator alerts, the viewer shell and the in-page sentences naming the product carry neither the old
   long name nor the old short name (as a word, in Korean, or as a download-name prefix). Comments are removed by
   syntax (HTML comments; JS/CSS comments outside strings, also inside <script>/<style>; # lines in properties, shell,
   nginx and Python) and log calls (console.*) are removed as expressions, so text beside them is still read.
   Internal identifiers (kin-*, KIN_*, X-KIN-*, /kin-brand/) are not words and never match.
2. The clinical-context source labels are a server contract: the page keeps the server's exact values in
   SOURCE_LABELS (the only place the old word may stay) and shows SOURCE_TEXT, the same labels under the product name.
3. The colour tokens of the sign-in page, the identity-provider theme, the work pages and the notices meet WCAG 2.2
   contrast: 4.5:1 for text, 3:1 for the boundaries a control needs (relative luminance, sRGB).

Pure: reads committed files only. No browser, server or network.
"""
from pathlib import Path
import re
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
OLD = re.compile(r'(?i:korea\s+imaging)'                          # the long name, any case
                 r'|(?<![A-Za-z0-9_\-/.])KIN(?![A-Za-z0-9_\-])'    # the short name as a word
                 r'|(?<![A-Za-z0-9_\-/.])KIN-(?:originals|manual)'  # download names
                 r'|(?<![가-힣])킨(?:[은이을의에과와]|으로|에서)?(?![가-힣])')
SOURCE_LABELS = re.compile(r'const SOURCE_LABELS = Object\.freeze\(\{.*?\}\);', re.S)
CONSOLE = re.compile(r'\bconsole\.(?:log|warn|error|info|debug)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)')
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
    text = CONSOLE.sub(lambda m: blank(m.group()), text)
    if path.endswith('clinical-context.js'):
        text = SOURCE_LABELS.sub(lambda m: blank(m.group()), text)  # the server contract, checked below
    return text


def leftovers(files=VISIBLE, root=ROOT):
    found = []
    for rel in files:
        text = shown_text(rel, (root / rel).read_text(encoding='utf-8'))
        for number, line in enumerate(text.split('\n'), 1):
            if OLD.search(line):
                found.append(f'{rel}:{number}: {line.strip()[:160]}')
    return found


def object_strings(text, name):
    """{key: 'value'} of the frozen object literal assigned to `name` (layout-free)."""
    body = re.search(name + r'[^=]*=\s*Object\.freeze\(\{(.*?)\}\)', text, re.S).group(1)
    return dict(re.findall(r"(\w+):\s*'([^']*)'", body))


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
            '<a download="KIN-originals-1.zip">d</a>\n', encoding='utf-8')                       # 13 found
        found = leftovers(['sample.html'], probe)
        self.assertEqual([1, 5, 6, 7, 8, 10, 12, 13], [int(f.split(':')[1]) for f in found], found)

    def test_source_labels_are_the_server_contract_and_the_page_shows_the_product_name(self):
        client = (ROOT / H / 'clinical-context.js').read_text(encoding='utf-8')
        server = (ROOT / 'api/src/clinical-context-policy.ts').read_text(encoding='utf-8')
        wire = object_strings(server, 'CONTEXT_SOURCE_LABELS')
        self.assertEqual(wire, object_strings(client, 'SOURCE_LABELS'), 'the page checks the exact server values')
        shown = object_strings(client, 'SOURCE_TEXT')
        self.assertEqual(set(wire), set(shown))
        for key, label in wire.items():
            with self.subTest(section=key):
                self.assertEqual(re.sub(r'\bKIN\b', 'HALO PACS', label), shown[key])
                self.assertIsNone(OLD.search(shown[key]))
        rendered = shown_text(H + 'clinical-context.js', client)
        self.assertNotIn('section.sourceLabel', rendered, 'every rendered source reads SOURCE_TEXT')
        self.assertGreaterEqual(rendered.count('SOURCE_TEXT[name]'), 4)

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
