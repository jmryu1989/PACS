"""HALO PACS branding on the screens people see: no old product name, and colour tokens that keep their contrast.

1. The files that draw titles, wordmarks, sign-in buttons, notices, mail subjects, the viewer shell and the
   in-page sentences naming the product carry neither the old long name nor the old short name as a word.
   Comments are not read (they are not shown). Internal identifiers (kin-*, KIN_*, X-KIN-*, /kin-brand/) are not
   words and never match. The few remaining values are listed below with the reason they stay.
2. The colour tokens of the sign-in page, the identity-provider theme, the work pages and the notices meet WCAG 2.2
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
    'config/ohif/branding-defaults.js', 'config/ohif/branding.js', 'config/ohif/history.js',
    'api/src/query-retrieve.ts', 'api/src/pacs/metrics.ts', 'api/src/study-transfer-local.service.ts',
    'scripts/build-open-source-notices.py', 'tools/minhoon-studio/server/static.js',
]
OLD_LONG = re.compile(r'korea\s+imaging\s+network|korea\s+imaging', re.I)
OLD_WORD = re.compile(r'(?<![A-Za-z0-9_\-/.])KIN(?![A-Za-z0-9_\-])')
# (file, text on the line) -> why it stays.
KEPT = {
    (H + 'clinical-context.js', "priorReports: 'KIN signed report (head version)', history: 'DICOM study + KIN study state',"):
        'server contract value compared exactly by both halves; the page shows SOURCE_TEXT instead',
    (H + 'clinical-context.js', "requestTags: 'DICOM header (one original instance)', techNote: 'KIN Tech Note',"):
        'server contract value compared exactly by both halves; the page shows SOURCE_TEXT instead',
}


def visible_lines(path, text):
    """Lines with comments removed (//, /* */, <!-- -->, # in properties, shell, nginx, python); log calls skipped."""
    text = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group().count('\n'), text, flags=re.S)
    text = re.sub(r'<!--.*?-->', lambda m: '\n' * m.group().count('\n'), text, flags=re.S)
    hash_comments = path.endswith(('.properties', '.template', '.py', '.sh'))
    for number, line in enumerate(text.split('\n'), 1):
        line = re.sub(r'(^|[\s;,{}()>])//(?!/?[A-Za-z0-9.-]+\.[a-z]).*$', r'\1', line)
        if hash_comments:
            line = re.sub(r'^\s*#.*$', '', line)
        if re.search(r'\bconsole\.(log|warn|error|info)\(', line):
            continue  # a server or browser log, not a screen
        yield number, line


def leftovers(files=VISIBLE, root=ROOT):
    found = []
    for rel in files:
        text = (root / rel).read_text(encoding='utf-8')
        for number, line in visible_lines(rel, text):
            if OLD_LONG.search(line) or OLD_WORD.search(line):
                if (rel, line.strip()) not in KEPT:
                    found.append(f'{rel}:{number}: {line.strip()[:160]}')
    return found


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
        # The check itself: an old word in text or an attribute is found; identifiers and comments are not.
        probe = Path(self.enterContext(tempfile.TemporaryDirectory()))
        sample = probe / 'sample.html'
        sample.write_text('<title>X — KIN</title>\n<a href="/kin-brand/a.svg" data-x="KIN_A X-KIN-Session">ok</a>\n'
                          '<!-- KIN comment -->\n<script>// KIN note\nconst a = "KIN 계정"; /* Korea Imaging */</script>\n'
                          '<p title="KOREA IMAGING NETWORK"></p>\n', encoding='utf-8')
        found = leftovers(['sample.html'], probe)
        self.assertEqual(['sample.html:1', 'sample.html:5', 'sample.html:6'], [f.rsplit(':', 1)[0] for f in found])

    def test_every_kept_value_still_exists(self):
        for (rel, line), why in KEPT.items():
            with self.subTest(file=rel, why=why):
                self.assertIn(line, (ROOT / rel).read_text(encoding='utf-8'))

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
