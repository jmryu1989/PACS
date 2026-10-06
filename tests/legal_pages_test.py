"""REQ-SITE-NOTICE → RISK-FALSE-FACT/OMISSION/UNVERIFIED-CITATION → TEST-LEGAL-PAGES.

The user requires the approved public wording and headings to be preserved. Compare
rendered text, not HTML layout or implementation strings. The public fixture holds
only publishable wording and statute identifiers, not the private review document.
No browser, server, network or third-party Python dependency is used.
"""
from collections import Counter
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / 'worklist-v0/legal'
FIXTURES = ROOT / 'tests/fixtures/legal'
CONTRACT = json.loads((FIXTURES / 'draft-contract.json').read_text(encoding='utf-8'))
# Only these two committed tables may supply citations; they are the public copies
# of the reviewed verification table and its 2026-10-06 addendum. No other file
# or location is read, so an unrelated review cannot widen the allowlist.
VERIFY_TABLES = (
    FIXTURES / 'verified-statutes.md',
    FIXTURES / 'verified-statutes-addendum-20261006.md',
)
MISSING_LICENSE = '라이선스 파일 없음 — 배포 전 확인'
MISSING_LICENSE_PACKAGES = {('busboy', '1.6.0'), ('streamsearch', '1.1.0')}


def normalized(value):
    return ' '.join(value.split())


class Element:
    def __init__(self, tag, attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def text(self):
        return ''.join(child if isinstance(child, str) else child.text() for child in self.children)

    def all(self, *tags):
        for child in self.children:
            if isinstance(child, Element):
                if not tags or child.tag in tags:
                    yield child
                yield from child.all(*tags)


class Document(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Element('document')
        self.stack = [self.root]
        self.errors = []
        self.feed(source)
        self.close()
        if len(self.stack) != 1:
            self.errors.append('unclosed elements: ' + str([node.tag for node in self.stack[1:]]))

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        if len(self.stack) > 1 and self.stack[-1].tag == tag:
            self.stack.pop()
        else:
            self.errors.append('unexpected closing tag: ' + tag)

    def handle_data(self, value):
        self.stack[-1].children.append(value)


LAW_NAMES = {
    '개인정보 보호법 시행령': 'PI령', '개인정보법 시행령': 'PI령',
    '개인정보 보호법': 'PI법', '개인정보법': 'PI법',
    '의료법 시행규칙': 'MA규', '의료법': 'MA법',
    '상법 시행령': 'CO령', '상법': 'CO법',
    '전자상거래법 시행령': 'EC령', '전자상거래법': 'EC법',
    '약관법': 'TA법', '안전성 확보조치 기준': 'G-안전',
}
ALIASES = r'(?:[A-Z]{2}(?:법|령|규)|G-안전)'
TOKENS = re.compile(
    '|'.join(re.escape(name) for name in sorted(LAW_NAMES, key=len, reverse=True))
    + '|' + ALIASES + r'|시행규칙|시행령|(?<![가-힣])영(?=\s+제)|(?<![가-힣])법(?=\s+제)'
    + r'|제\d+(?:[·ㆍ]\d+)*조(?:의\d+)?')


def citations(text, default='PI법'):
    # Business placeholders describe facts still to be decided, not assertions.
    text = re.sub(r'\{\{.*?\}\}', '', text)
    law = default
    found = set()
    for match in TOKENS.finditer(text):
        token = match.group()
        if token.startswith('제'):
            articles = re.fullmatch(r'제([\d·ㆍ]+)조(의\d+)?', token)
            for number in re.split('[·ㆍ]', articles[1]):
                found.add((law, number + (articles[2] or '')))
        elif token in LAW_NAMES:
            law = LAW_NAMES[token]
        elif re.fullmatch(ALIASES, token):
            law = token
        elif token in ('시행령', '영'):
            law = law[:2] + '령'
        elif token == '시행규칙':
            law = law[:2] + '규'
        elif token == '법':
            law = law[:2] + '법'
    return found


def verification_citations(path, minimum_rows=10):
    result = set()
    row_count = 0
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if not line.startswith('|'):
            continue
        cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if len(cells) in (2, 5) and re.fullmatch(r'(?:PR\d+|OT5|EC2|EC4|TC1|E6)', cells[0]):
            result.update(citations(cells[1]))
            # OT5's checked implementing decree is in the original row's memo.
            if cells[0] == 'OT5' and len(cells) == 5:
                for value in re.findall(r'CO령 제\d+조', cells[4]):
                    result.update(citations(value))
            row_count += 1
        elif len(cells) == 3 and cells[0] == '6 안전성 확보조치 고시':
            result.update(citations(cells[2].split('. 제5조')[0], default='G-안전'))
            row_count += 1
    if row_count < minimum_rows or not result:
        raise AssertionError('검증표의 관련 행을 읽지 못했습니다: ' + str(path))
    return result


def verified_citations():
    return verification_citations(VERIFY_TABLES[0]) | verification_citations(VERIFY_TABLES[1], 8)


def dependency_rows(root):
    manifest = json.loads((root / 'api/package.json').read_text(encoding='utf-8'))
    lock = json.loads((root / 'api/package-lock.json').read_text(encoding='utf-8'))
    for section in ('dependencies', 'devDependencies'):
        if manifest.get(section, {}) != lock['packages'][''].get(section, {}):
            raise AssertionError('manifest/lock mismatch: ' + section)
    rows = []
    for path, item in lock['packages'].items():
        if not path:
            continue
        name = path.split('node_modules/')[-1]
        direct = path == 'node_modules/' + name and any(name in manifest.get(key, {}) for key in ('dependencies', 'devDependencies'))
        scope = ('직접 · ' if direct else '간접 · ') + ('개발' if item.get('dev') else '실행')
        license_name = item.get('license')
        if not license_name:
            if (name, item['version']) not in MISSING_LICENSE_PACKAGES:
                raise AssertionError('라이선스 원문 확인이 필요한 새 패키지: ' + path)
            license_name = MISSING_LICENSE
        rows.append((name, item['version'], license_name, scope, path))
    return Counter(rows)


class LegalPagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs = {name: Document((PAGES / name).read_text(encoding='utf-8')) for name in CONTRACT['pages']}

    def test_pages_are_readable_static_korean_documents(self):
        self.assertEqual(set(CONTRACT['pages']), {path.name for path in PAGES.glob('*.html')})
        for name, doc in self.docs.items():
            with self.subTest(page=name):
                self.assertEqual(doc.errors, [])
                self.assertEqual(next(doc.root.all('html')).attrs.get('lang'), 'ko')
                self.assertEqual(len(list(doc.root.all('main'))), 1)
                self.assertEqual(len(list(doc.root.all('h1'))), 1)
                self.assertFalse(list(doc.root.all('script', 'iframe', 'form')))
                ids = [node.attrs['id'] for node in doc.root.all() if 'id' in node.attrs]
                self.assertEqual(len(ids), len(set(ids)))
                for node in doc.root.all():
                    self.assertNotIn('hidden', node.attrs)
                    self.assertNotEqual(node.attrs.get('aria-hidden'), 'true')
                    self.assertFalse(any(key.startswith('on') for key in node.attrs))

    def test_all_draft_headings_and_sentences_are_preserved(self):
        for name, requirements in CONTRACT['pages'].items():
            doc = self.docs[name]
            headings = [normalized(node.text()) for node in doc.root.all('h2', 'h3', 'h4')]
            self.assertEqual(headings[:len(requirements['headings'])], requirements['headings'], name)
            # Text nodes are joined per block, so CSS/layout changes cannot weaken the contract.
            blocks = [normalized(node.text().replace('확정 전: ', '')) for node in doc.root.all('p', 'li', 'td', 'th')]
            for expected in requirements['text']:
                with self.subTest(page=name, text=expected[:50]):
                    self.assertIn(normalized(expected), blocks)

    def test_every_business_placeholder_has_its_own_visible_marker(self):
        counts = {}
        for name, doc in self.docs.items():
            observed = []
            for node in doc.root.all():
                for value in node.attrs.values():
                    self.assertNotIn('{{', value or '', name)
                for value in node.children:
                    if isinstance(value, str) and '{{' in value:
                        self.assertRegex(value, r'확정 전:\s*\{\{[^{}]+\}\}', name)
                        for match in re.finditer(r'\{\{[^{}]+\}\}', value):
                            self.assertTrue(value[:match.start()].rstrip().endswith('확정 전:'), name)
                            observed.append(match.group())
            expected = re.findall(r'\{\{[^{}]+\}\}', ' '.join(CONTRACT['pages'][name]['text']))
            self.assertEqual(Counter(observed), Counter(expected), name)
            counts[name] = len(observed)
        print('business_placeholders=' + str(sum(counts.values())))

    def test_open_source_components_match_manifest_and_lock(self):
        doc = self.docs['open-source-notices.html']
        actual = Counter(tuple(normalized(cell.text()) for cell in row.all('td')) for row in doc.root.all('tr') if list(row.all('td')))
        expected = dependency_rows(ROOT)
        self.assertEqual(actual, expected)
        marked = {(row[0], row[1]) for row in actual if row[2] == MISSING_LICENSE}
        self.assertEqual(marked, MISSING_LICENSE_PACKAGES)
        for name, version in MISSING_LICENSE_PACKAGES:
            self.assertEqual([row[2] for row in actual if row[:2] == (name, version)], [MISSING_LICENSE])
        print('dependency_rows=' + str(sum(expected.values())))
        # New browser manifests or vendored trees require explicit inventory; no silent omission.
        for path in (ROOT / 'worklist-v0').rglob('*'):
            if path.is_file():
                self.assertNotEqual(path.name, 'package.json', '새 브라우저 의존성을 고지에 반영해야 합니다')
                self.assertFalse({'vendor', 'vendored', 'node_modules'} & set(path.parts), str(path))

    def test_every_statute_citation_exists_in_verified_table(self):
        verified = verified_citations()
        missing = set()
        cited = set()
        for name, doc in self.docs.items():
            for node in doc.root.all('p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'caption'):
                for citation in citations(node.text()):
                    cited.add(citation)
                    if citation not in verified:
                        missing.add((name, *citation))
        print(f'statutes={len(cited)}; missing_statutes={len(missing)}; tables={[path.relative_to(ROOT).as_posix() for path in VERIFY_TABLES]}')
        self.assertFalse(missing, '검증표에 없는 조문(초안 v2는 보존): ' + repr(sorted(missing)))

    def test_local_links_and_public_contact_anchors_resolve(self):
        for name, doc in self.docs.items():
            for node in doc.root.all('a', 'link', 'img'):
                value = node.attrs.get('href', node.attrs.get('src', ''))
                parsed = urlsplit(value)
                self.assertFalse(parsed.scheme or parsed.netloc, value)
                self.assertTrue(value, name)
                if parsed.path.startswith('/kin-brand/'):
                    target = ROOT / 'proxy/branding' / parsed.path.removeprefix('/kin-brand/')
                elif parsed.path.startswith('/worklist/'):
                    target = ROOT / 'worklist-v0' / parsed.path.removeprefix('/worklist/')
                else:
                    target = PAGES / (parsed.path or name)
                self.assertTrue(target.is_file(), value)
                if parsed.fragment:
                    target_doc = Document(target.read_text(encoding='utf-8'))
                    self.assertIn(parsed.fragment, [element.attrs.get('id') for element in target_doc.root.all()], value)
        privacy_ids = {node.attrs.get('id') for node in self.docs['privacy.html'].root.all()}
        self.assertTrue({'contact', 'accounts', 'processors'} <= privacy_ids)

    def test_citation_matching_keeps_law_and_article_branches_separate(self):
        verified = verified_citations()
        self.assertEqual(citations('〔상법 제289조, 영 제6조〕'), {('CO법', '289'), ('CO령', '6')})
        self.assertEqual(citations('법 제35조③ 및 법 제36·37조'), {('PI법', '35'), ('PI법', '36'), ('PI법', '37')})
        self.assertEqual(citations('법 제37조의2 및 {{제15조제1항의 해당 근거}}'), {('PI법', '37의2')})
        self.assertNotIn(('PI법', '999'), verified)
        self.assertIn(('PI법', '37의2'), verified)
        self.assertNotIn(('MA규', '30'), verified)

    def test_committed_statute_tables_retain_original_row_identifiers(self):
        exported = verification_citations(VERIFY_TABLES[0])
        self.assertIn(('G-안전', '8'), exported)
        self.assertIn(('CO령', '6'), exported)
        addendum = verification_citations(VERIFY_TABLES[1], 8)
        self.assertEqual(addendum, {
            ('MA규', '15'), ('PI법', '35'), ('PI법', '36'), ('PI법', '37'),
            ('PI령', '16'), ('PI령', '41'), ('PI령', '43'), ('PI령', '44'),
        })


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
