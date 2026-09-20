"""TEST-S2-API-01..12 (REQ-S2-RECORD/PROVENANCE/FRESHNESS/BOUNDARY/IDEMPOTENT/PRESERVE, S2-B2 comparison source,
S2-L1 saved locations: 11 version 2 records, schema handshake, version rule and exact copies; 12 malformed job copies and races)
and TEST-S3-U2a-CITATION-LIVE (13: contract section 9 items 14, 15 server half, 17, 18, 19, 20 and 22 - the report citation
backend needs this stack's real lineage, revocation and polling payload, and no part of it needs the screen).

Real Nest/Prisma, Keycloak and Orthanc with owned synthetic CTs. Direct SQL touches only this
run's study identities, run-owned readers' SYNTHETIC access policies and lock, fault and limit
setup; every write effect is compared through the persisted rows. No clinical fixture is used.
"""
from __future__ import annotations
import io, json, re, subprocess, sys, time, unittest, urllib.error, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from pydicom import dcmread
from invariants_live import ROOT, psql
from viewer_api_test import ViewerStack, literal
sys.path.insert(0, str(ROOT/'tests/e2e'))
from viewer_precision_fixture import synthetic_ct

FINDING_TABLES = ('Finding', 'FindingRevision')
SNAPSHOT_TABLES = FINDING_TABLES+('ViewerItem', 'ViewerRevision', 'ViewerRequest', 'ViewerStorageBudget', 'AuditLog')
# The StudyState columns that decide who may read a study; comparison tests change and restore only these.
BOUNDARY_COLUMNS = ('rs', 'preDoc', 'preReviewer', 'institutionId', 'teleInstitutionId')

class FindingStack(ViewerStack):
    """ViewerStack already tears down Finding/FindingRevision before StudyState; this name marks the suites that rely on it."""
    def cleanup_fixture(self, uid):
        if uid not in self.active or not re.fullmatch(r'[0-9.]+', uid):
            raise RuntimeError('Finding cleanup requires this run-owned synthetic study')
        super().cleanup_fixture(uid)

class FindingAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = FindingStack()
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.stack.create_test_identity('adminonly', ['admin'], 'hallym')
        cls.stack.token('adminonly')
        # Comparison-study readers whose access policies the S2-B2 tests restrict and always clear.
        for user in ('xauthor', 'xreader'):
            cls.stack.create_test_identity(user, ['radiologist'], 'hallym')
            cls.stack.token(user)
        started = time.monotonic()
        required = {cls.stack.actor(user) for user in ['jmryu', 'doctor2']}
        while True:
            peers = cls.stack.request('GET', '/colleagues', 'doctor')
            if peers.status != 200:
                raise RuntimeError(f'Colleague fixture readiness failed: HTTP {peers.status}')
            if required.issubset({peer['id'] for peer in peers.body}): break
            if time.monotonic()-started >= 70:
                raise RuntimeError('This run\'s reviewers did not become visible before the readiness deadline')
            time.sleep(1)

    def setUp(self):
        self.fixture = synthetic_ct(self.stack, 'FINDING-'+uuid.uuid4().hex[:12], 'finding', '20260917', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3])
        self.addCleanup(self.stack.cleanup_fixture, self.fixture.uid)
        self.uid = self.fixture.uid
        self.path = '/studies/'+self.uid+'/findings'
        self.items_path = '/studies/'+self.uid+'/viewer-items'
        self.originals = {}
        for instance in self.instances():
            raw = self.stack.orthanc_bytes('/instances/'+instance['ID']+'/file')
            self.originals[str(dcmread(io.BytesIO(raw)).SOPInstanceUID)] = raw
        self.slices = sorted((dcmread(io.BytesIO(raw)) for raw in self.originals.values()), key=lambda ds: int(ds.InstanceNumber))
        self.addCleanup(self.assert_originals)

    def instances(self):
        found = self.stack._orthanc_request('POST', '/tools/lookup', self.uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        return self.stack._orthanc_request('GET', '/studies/'+study+'/instances').body

    def assert_originals(self):
        current = {}
        for instance in self.instances():
            raw = self.stack.orthanc_bytes('/instances/'+instance['ID']+'/file')
            current[str(dcmread(io.BytesIO(raw)).SOPInstanceUID)] = raw
        self.assertEqual(current, self.originals)

    # ---- helpers -------------------------------------------------------------------------
    def call(self, method='POST', body=None, user='doctor', path=None, status=200):
        response = self.stack.request(method, path or self.path, user, body)
        self.assertEqual(response.status, status, response.text)
        return response.body

    def length_item(self, index=0, extent=20.0, label='길이', slices=None):
        ds = (slices or self.slices)[index]; ipp = [float(x) for x in ds.ImagePositionPatient]
        return dict(schemaVersion=1, kind='length', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
                    frameOfReferenceUid=str(ds.FrameOfReferenceUID), label=label,
                    points=[[ipp[0]+10, ipp[1]+10, ipp[2]], [ipp[0]+10+extent, ipp[1]+10, ipp[2]]],
                    viewPlaneNormal=[0, 0, 1], viewUp=[0, 1, 0], baseline=dict(calculator='kin-native-manual-v1', values=[extent]))

    def key_item(self, index=1, title='키 <script>', slices=None):
        ds = (slices or self.slices)[index]
        return dict(schemaVersion=1, kind='key', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, title=title, description='')

    def item(self, item, user='doctor', status=200):
        return self.call(body=dict(requestId=str(uuid.uuid4()), item=item), user=user, path=self.items_path, status=status)

    def revise_item(self, head, action='edit', item=None, reason=None, user='doctor', status=200, items_path=None):
        snapshot = {k: v for k, v in head['item'].items() if k not in ('hidden', 'sourceDigest')} if item is None else item
        command = dict(requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action=action, item=snapshot)
        if reason is not None: command['reason'] = reason
        return self.call(body=command, path=(items_path or self.items_path)+'/'+head['id']+'/revisions', user=user, status=status)

    def finding_body(self, sources, title='소견 <b>제목</b>', text='본문 한글', primary=None, request_id=None):
        item = dict(schemaVersion=1, title=title, text=text, sources=[dict(itemId=s['id'], revision=s['revision']) if 'id' in s else s for s in sources])
        if primary is not None: item['primary'] = primary
        return dict(requestId=request_id or str(uuid.uuid4()), item=item)

    def create(self, sources, user='doctor', status=200, **kwargs):
        command = self.finding_body(sources, **kwargs)
        return self.call(body=command, user=user, status=status), command

    def revise(self, head, action='edit', item=None, reason=None, user='doctor', status=200, sources=None, request_id=None, expected=None):
        if item is None:
            item = dict(schemaVersion=1, title=head['item']['title'], text=head['item']['text'], primary=head['item'].get('primary', 0),
                        sources=[dict(itemId=s['itemId'], revision=s['revision']) for s in head['item']['sources']])
            if sources is not None: item['sources'] = [dict(itemId=s['id'], revision=s['revision']) if 'id' in s else s for s in sources]
        command = dict(requestId=request_id or str(uuid.uuid4()), expectedRevision=head['revision'] if expected is None else expected, action=action, item=item)
        if reason is not None: command['reason'] = reason
        return self.call(body=command, path=self.path+'/'+head['id']+'/revisions', user=user, status=status), command

    def scoped(self, uid):
        assert uid in self.stack.active
        uid = literal(uid)
        return {'Finding': f'"studyUid"={uid}', 'FindingRevision': f'"findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid})',
                'ViewerItem': f'"studyUid"={uid}', 'ViewerRevision': f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})',
                'ViewerRequest': f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})', 'ViewerStorageBudget': f'"studyUid"={uid}',
                'AuditLog': f'target={uid}'}

    def snapshot(self, tables=SNAPSHOT_TABLES):
        where = self.scoped(self.uid)
        return {t: psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE {where[t]} ORDER BY to_jsonb(t)::text COLLATE "C"') for t in tables}

    def state(self, uid=None, tables=SNAPSHOT_TABLES):
        """snapshot() of any run-owned study in one psql round trip: the same rows in the same per-table order."""
        where = self.scoped(uid or self.uid)
        union = ' UNION ALL '.join(f'SELECT {literal(t)} AS tbl, to_jsonb(x)::text AS payload FROM "{t}" x WHERE {where[t]}' for t in tables)
        state = {t: [] for t in tables}
        for line in psql(f'SELECT tbl, payload FROM ({union}) s ORDER BY tbl, payload COLLATE "C"'):
            name, row = line.split('|', 1)
            state[name].append(row)
        return state

    def revision_rows(self, finding_id):
        return psql(f'SELECT to_jsonb(t)::text FROM "FindingRevision" t WHERE "findingId"={literal(finding_id)}::uuid ORDER BY revision')

    def current(self, head):
        """Head-shaped view of the latest revision, read through the product route."""
        revisions, cursor = [], None
        while True:
            page = self.call(method='GET', path=self.path+'/'+head['id']+'/revisions?limit=100'+('&cursor='+str(cursor) if cursor else ''))
            revisions += page['revisions']; cursor = page['nextCursor']
            if not cursor: break
        last = revisions[-1]
        return dict(id=head['id'], revision=last['revision'], item=last['item'], hidden=last['item']['hidden'])

    def report_rows(self):
        return {t: psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE uid={literal(self.uid)} ORDER BY to_jsonb(t)::text')
                for t in ['StudyState', 'Report', 'ReportDraft', 'ReportVersion']}

    def study_update(self, changes, uid=None):
        uid = uid or self.uid
        assert uid in self.stack.active
        psql(f'UPDATE "StudyState" SET {changes} WHERE uid={literal(uid)}')

    def parent_lock(self, inside=None, uid=None):
        # Same shape as viewer_api_test.parent_lock; `inside` runs while the parent row is locked.
        uid = uid or self.uid
        assert uid in self.stack.active
        return self.hold(f'SELECT uid FROM "StudyState" WHERE uid={literal(uid)} FOR UPDATE')

    def hold(self, statement):
        """An open psql transaction that has run the row-locking `statement`; finish_lock() commits it."""
        process = subprocess.Popen(['docker', 'exec', '-i', 'kin-db', 'psql', '-XqAt', '-U', 'kin', '-d', 'kin', '-v', 'ON_ERROR_STOP=1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        process.stdin.write("BEGIN; SET LOCAL statement_timeout='8s'; "+statement+"; SELECT 'LOCKED';\n"); process.stdin.flush()
        while process.stdout.readline().strip() != 'LOCKED':
            if process.poll() is not None: raise RuntimeError('Parent lock setup failed')
        return process

    def holder_rows(self, holder, sql):
        """Read-only `sql` run in the holder's own open session: no process start-up delay while requests wait on
        its lock. pg_stat_clear_snapshot() drops the per-transaction activity cache so every call sees fresh data."""
        holder.stdin.write(f"SELECT pg_stat_clear_snapshot(); {sql}; SELECT 'DONE';\n"); holder.stdin.flush()
        rows = []
        while (line := holder.stdout.readline().strip()) != 'DONE':
            if not line and holder.poll() is not None: self.fail('The lock holder session ended: '+holder.stderr.read())
            if line: rows.append(line)
        return rows

    def waiting(self, fragment, count, event='%'):
        """SQL condition: at least `count` other sessions wait on a lock (wait_event LIKE `event`) in a statement containing `fragment`."""
        return (f"(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event LIKE {literal(event)} "
                f"AND query LIKE {literal('%'+fragment+'%')} AND pid<>pg_backend_pid()) >= {count}")

    def holder_wait(self, holder, condition, timeout=10):
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            if self.holder_rows(holder, f'SELECT ({condition})::int') == ['1']: return
            time.sleep(.02)
        self.fail('Requests were not observed waiting: '+condition)

    def staged(self, holder, stages, then='', check=None):
        """With `holder` open, submit each stage's requests and wait (bounded) until that stage's SQL condition holds;
        run `check(holder)`, then `then` inside the holder, release it and return every response in submission order."""
        try:
            with ThreadPoolExecutor(sum(len(requests) for requests, _ in stages)) as pool:
                futures = []
                for requests, condition in stages:
                    futures += [pool.submit(self.stack.request, method, path, user, body) for method, path, user, body in requests]
                    self.holder_wait(holder, condition)
                if check is not None: check(holder)
                current, holder = holder, None
                self.finish_lock(current, then)
                return [future.result(timeout=30) for future in futures]
        finally:
            if holder is not None and holder.poll() is None: self.finish_lock(holder)

    def wait_blocked(self, count=1, timeout=2):
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            query = "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM \"StudyState\"%' AND pid<>pg_backend_pid()"
            if int(psql(query)[0]) >= count: return
            time.sleep(.03)
        self.fail(f'API did not observably wait on the parent lock ({count} waiting request(s) expected)')

    def finish_lock(self, process, sql=''):
        process.stdin.write(sql+' COMMIT;\n'); process.stdin.flush()
        try: process.communicate(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.communicate(); raise
        self.assertEqual(process.returncode, 0, 'Parent lock transaction failed')

    def expected_copy(self, head, study=None):
        item = head['item']
        return dict(itemId=head['id'], revision=head['revision'], studyUid=study or self.uid, kind=item['kind'], seriesUid=item['seriesUid'], sopUid=item['sopUid'],
                    frame=item['frame'], frameOfReferenceUid=item.get('frameOfReferenceUid'), label=item.get('label', item.get('title', '')),
                    values=item.get('baseline', {}).get('values'), calculator=item.get('baseline', {}).get('calculator'),
                    sourceDigest=item.get('sourceDigest'), authorActor=head['authorActor'])

    # ---- TEST-S2-API-01 ------------------------------------------------------------------
    def test_01_lifecycle_provenance_history_and_preservation(self):
        self.call(path='/studies/'+self.uid+'/report/commit', body=dict(action='approve', baseVersion=0, findings=self.fixture.secret, conclusion='approved', recommendation=''), status=201)
        self.call(method='PUT', path='/studies/'+self.uid+'/report', body=dict(findings='private draft', conclusion='', recommendation=''))
        reports = self.report_rows()
        length = self.item(self.length_item()); self.assertEqual(length.get('referenceStatus'), 'verified')
        key = self.item(self.key_item())
        viewer_before = self.snapshot(('ViewerItem', 'ViewerRevision', 'ViewerRequest', 'ViewerStorageBudget'))
        head, create = self.create([length, key], primary=1)
        self.assertEqual(head['authorSub'], self.stack.user_ids['doctor']); self.assertEqual(head['revision'], 1); self.assertFalse(head['hidden'])
        self.assertEqual(head['item']['sources'], [self.expected_copy(length), self.expected_copy(key)])
        self.assertEqual(head['item']['sources'][0]['values'], [20.0]); self.assertIsNotNone(head['item']['sources'][0]['sourceDigest'])
        self.assertEqual(head['item']['primary'], 1); self.assertEqual(head['item']['title'], create['item']['title'])
        listed = self.call(method='GET')['items']
        self.assertEqual(listed, [{**head, 'links': [dict(itemId=length['id'], linkState='current', headRevision=1, headHidden=False),
                                                     dict(itemId=key['id'], linkState='current', headRevision=1, headHidden=False)]}])
        before = self.snapshot()
        self.assertEqual(self.call(body=create), head); self.assertEqual(self.snapshot(), before)
        edited, _ = self.revise(head, item=dict(schemaVersion=1, title='수정 제목', text='수정 본문 😀', primary=0,
                                                sources=[dict(itemId=s['itemId'], revision=s['revision']) for s in head['item']['sources']]))
        self.assertEqual(edited['revision'], 2); self.assertEqual(edited['item']['sources'], head['item']['sources'])
        hidden, _ = self.revise(edited, 'hide', reason='중복 소견'); self.assertTrue(hidden['hidden']); self.assertEqual(hidden['revision'], 3)
        self.assertEqual(self.call(method='GET')['items'], [])
        self.assertTrue(self.call(method='GET', path=self.path+'?includeHidden=true')['items'][0]['hidden'])
        self.revise(hidden, 'hide', reason='다시', status=409); self.revise(hidden, 'edit', status=409, expected=2)
        self.call(method='DELETE', path='/studies/'+self.uid, user='tech', status=409)
        restored, _ = self.revise(hidden, 'restore', reason='복원'); self.assertFalse(restored['hidden']); self.assertEqual(restored['revision'], 4)
        self.assertEqual(self.call(body=create), head)
        history = self.call(method='GET', path=self.path+'/'+head['id']+'/revisions')['revisions']
        self.assertEqual([r['action'] for r in history], ['create', 'edit', 'hide', 'restore'])
        self.assertEqual(history[0]['item'], head['item']); self.assertEqual(history[1]['reason'], ''); self.assertEqual(history[2]['reason'], '중복 소견')
        self.assertEqual([r['payloadBytes'] for r in history], [int(x) for x in psql(f'SELECT "payloadBytes" FROM "FindingRevision" WHERE "findingId"={literal(head["id"])}::uuid ORDER BY revision')])
        self.assertEqual(psql(f'SELECT count(*) FROM "FindingRevision" WHERE "findingId"={literal(head["id"])}::uuid AND "payloadBytes"=octet_length(convert_to(snapshot::text,\'UTF8\'))'), ['4'])
        audit = ' '.join(self.snapshot(('AuditLog',))['AuditLog'])
        for action in ['finding.create', 'finding.edit', 'finding.hide', 'finding.restore']: self.assertIn(action, audit)
        self.assertNotIn('수정 제목', audit); self.assertNotIn(create['item']['title'], audit)
        self.assertEqual(self.report_rows(), reports)
        self.assertEqual(self.snapshot(('ViewerItem', 'ViewerRevision', 'ViewerRequest', 'ViewerStorageBudget')), viewer_before)

    # ---- TEST-S2-API-02 ------------------------------------------------------------------
    def test_02_source_boundaries_and_forged_provenance(self):
        length = self.item(self.length_item()); key = self.item(self.key_item())
        other = self.stack.create_fixture(); self.addCleanup(self.stack.cleanup_fixture, other.uid)
        other_instance = self.stack.first_instance_id(other.uid)
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+other_instance+'/file')))
        foreign = self.call(body=dict(requestId=str(uuid.uuid4()), item=dict(schemaVersion=1, kind='key', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, title='다른 검사', description='')),
                            path='/studies/'+other.uid+'/viewer-items')
        before = self.snapshot()
        # S2-B2: an item of another readable study is a comparison source now; this one belongs to a different
        # patient, so it is refused with 400 (test_09 covers unreadable studies, which answer like unknown ids).
        self.create([foreign], status=400)
        self.create([dict(itemId=str(uuid.uuid4()), revision=1)], status=404)
        stale = self.call(body=self.finding_body([dict(itemId=length['id'], revision=2)]), status=409)
        self.assertEqual((stale['code'], stale['itemId'], stale['headRevision'], stale['headHidden']), ('FINDING_SOURCE_STALE', length['id'], 1, False))
        self.assertEqual(self.snapshot(), before)
        hidden_key = self.revise_item(key, 'hide', reason='숨김')
        self.assertEqual((hidden_key['hidden'], hidden_key['revision']), (True, 2))
        # The deliberate source hide is the only change, checked row by row; the post-hide state is then
        # the baseline every later refused request must leave untouched.
        after_hide = self.snapshot()
        def parsed(state, table): return [json.loads(row) for row in state[table]]
        for table in FINDING_TABLES: self.assertEqual(after_hide[table], before[table])
        def others(state): return [row for row in parsed(state, 'ViewerItem') if row['id'] != key['id']]
        self.assertEqual(others(after_hide), others(before))
        self.assertEqual([(row['hidden'], row['revision']) for row in parsed(after_hide, 'ViewerItem') if row['id'] == key['id']], [(True, 2)])
        added = {}
        for table, expected in [('ViewerRevision', dict(itemId=key['id'], revision=2, action='hide', reason='숨김')),
                                ('ViewerRequest', dict(itemId=key['id'], revision=2)), ('AuditLog', dict(action='viewer.hide', target=self.uid))]:
            rows = list(after_hide[table])
            for row in before[table]: rows.remove(row)
            added[table] = [json.loads(row) for row in rows]
            self.assertEqual([{k: row[k] for k in expected} for row in added[table]], [expected])
        [(items, revisions, used)] = [(r['itemCount'], r['revisionCount'], r['payloadBytes']) for r in parsed(before, 'ViewerStorageBudget')]
        self.assertEqual([(r['itemCount'], r['revisionCount'], r['payloadBytes']) for r in parsed(after_hide, 'ViewerStorageBudget')],
                         [(items, revisions+1, used+added['ViewerRevision'][0]['payloadBytes'])])
        before = after_hide
        refused = self.call(body=self.finding_body([key]), status=409)
        self.assertEqual((refused['code'], refused['headHidden'], refused['headRevision']), ('FINDING_SOURCE_STALE', True, 2))
        for forged in [{'values': [1]}, {'kind': 'length'}, {'sourceDigest': 'x'}, {'seriesUid': '2.25.1'}, {'studyUid': self.uid}]:
            self.call(body=self.finding_body([dict(itemId=length['id'], revision=1, **forged)]), status=400)
        self.call(body=self.finding_body([length, length]), status=400)
        self.call(body=self.finding_body([]), status=400)
        self.call(body=self.finding_body([dict(itemId=str(uuid.uuid4()), revision=1) for _ in range(9)]), status=400)
        self.call(body=self.finding_body([length], primary=1), status=400)
        self.call(body=self.finding_body([length], title='x'*201), status=400)
        self.call(body={**self.finding_body([length]), 'author': 'forged'}, status=400)
        for query in ['?limit=101', '?limit=0', '?cursor=invalid', '?includeHidden=yes', '?recheck='+length['id']]:
            self.call(method='GET', path=self.path+query, status=400)
        self.assertEqual(self.snapshot(), before)
        token = self.stack.token('doctor')
        raw = json.dumps(self.finding_body([length])).encode()
        response = self.stack.bearer_request('POST', self.path, token, raw+b' '*32769, headers={'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400)
        response = self.stack.bearer_request('POST', self.path, token, raw.replace(b'"revision": 1', b'"revision": 1e999'), headers={'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400)
        self.assertEqual(self.snapshot(), before)
        # The right revision of a visible head still links; the copy is server data.
        restored_key = self.revise_item(hidden_key, 'restore', reason='복원')
        head, _ = self.create([length, restored_key])
        self.assertEqual(head['item']['sources'][1]['revision'], 3); self.assertEqual(head['item']['sources'][1]['label'], key['item']['title'])
        for path, auth in [(self.path, True), (self.path, False), ('/studies/2.25.0/findings', True)]:
            from urllib.request import Request
            from urllib.error import HTTPError
            headers = {'Authorization': 'Bearer '+token} if auth else {}
            try: response = self.stack._open(Request(self.stack.api+path, headers=headers))
            except HTTPError as e: response = e
            with response: self.assertEqual(response.headers.get('Cache-Control'), 'no-store')

    # ---- TEST-S2-API-03 ------------------------------------------------------------------
    def test_03_freshness_frozen_copies_refresh_hidden_and_missing(self):
        length = self.item(self.length_item())
        head, create = self.create([length])
        edited_item = self.revise_item(length, item={**self.length_item(extent=25.0, label='다시 잰 길이'), 'baseline': dict(calculator='kin-native-manual-v1', values=[25.0])})
        self.assertEqual(edited_item['revision'], 2); self.assertEqual(edited_item['item']['baseline']['values'], [25.0])
        listed = self.call(method='GET')['items'][0]
        self.assertEqual(listed['links'], [dict(itemId=length['id'], linkState='revised', headRevision=2, headHidden=False)])
        self.assertEqual(listed['item']['sources'][0]['values'], [20.0]); self.assertEqual(listed['item']['sources'][0]['label'], '길이')
        # A text edit keeps the unchanged pair byte for byte even though the head moved on.
        text_edit, _ = self.revise(head, item=dict(schemaVersion=1, title='본문만 수정', text='새 본문', primary=0, sources=[dict(itemId=length['id'], revision=1)]))
        self.assertEqual(text_edit['item']['sources'], head['item']['sources'])
        self.assertEqual(self.call(method='GET')['items'][0]['links'][0]['linkState'], 'revised')
        r1r2 = self.revision_rows(head['id']); self.assertEqual(len(r1r2), 2)
        # Explicit refresh copies the current head; the old rows stay byte-equal.
        refreshed, _ = self.revise(text_edit, sources=[dict(itemId=length['id'], revision=2)])
        self.assertEqual(refreshed['revision'], 3); self.assertEqual(refreshed['item']['sources'][0]['revision'], 2)
        self.assertEqual(refreshed['item']['sources'][0]['values'], [25.0]); self.assertEqual(refreshed['item']['sources'][0]['label'], '다시 잰 길이')
        self.assertEqual(refreshed['item']['sources'][0]['sourceDigest'], length['item']['sourceDigest'])
        self.assertEqual(self.revision_rows(head['id'])[:2], r1r2)
        self.assertEqual(self.call(method='GET')['items'][0]['links'][0], dict(itemId=length['id'], linkState='current', headRevision=2, headHidden=False))
        # Refreshing to a revision that is not the head, or to a hidden head, is refused; the finding is unchanged.
        before = self.snapshot(FINDING_TABLES)
        self.revise(refreshed, sources=[dict(itemId=length['id'], revision=1)], status=409)
        hidden_item = self.revise_item(edited_item, 'hide', reason='숨김')
        self.assertEqual(self.call(method='GET')['items'][0]['links'][0], dict(itemId=length['id'], linkState='hidden', headRevision=3, headHidden=True))
        self.revise(refreshed, sources=[dict(itemId=length['id'], revision=3)], status=409)
        self.assertEqual(self.snapshot(FINDING_TABLES), before)
        # Hide/restore of the finding itself keeps the frozen pair while the source is hidden; a hide that
        # smuggles a different pair is refused.
        self.revise(refreshed, 'hide', reason='보류', sources=[dict(itemId=length['id'], revision=3)], status=409)
        self.assertEqual(self.snapshot(FINDING_TABLES), before)
        hidden, _ = self.revise(refreshed, 'hide', reason='보류'); restored, _ = self.revise(hidden, 'restore', reason='재개')
        self.assertEqual(restored['item']['sources'], refreshed['item']['sources'])
        self.revise_item(hidden_item, 'restore', reason='복원')
        self.assertEqual(self.call(method='GET')['items'][0]['links'][0], dict(itemId=length['id'], linkState='revised', headRevision=4, headHidden=False))
        # A copy whose item cannot be found in this study reads as missing, never as current.
        psql(f'''UPDATE "Finding" SET snapshot=jsonb_set(snapshot,'{{sources,0,itemId}}','"{uuid.uuid4()}"'::jsonb) WHERE id={literal(head["id"])}::uuid''')
        self.assertEqual(self.call(method='GET')['items'][0]['links'][0]['linkState'], 'missing')
        self.assertEqual(self.call(method='GET')['items'][0]['links'][0]['headRevision'], None)

    # ---- TEST-S2-API-04 ------------------------------------------------------------------
    def test_04_every_route_role_tenant_preliminary_and_retired_owner(self):
        key = self.item(self.key_item(0))
        head, command = self.create([key])
        revision_path = self.path+'/'+head['id']+'/revisions'
        edit = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(schemaVersion=1, title='t', text='', sources=[dict(itemId=key['id'], revision=1)]))
        routes = [('GET', self.path, None), ('POST', self.path, command), ('GET', revision_path, None), ('POST', revision_path, edit)]
        for method, path, body in routes:
            self.call(method, body, 'kdoctor', path, 403)
            gateway = self.stack.bearer_request(method, path, self.stack.service_token('gateway'), body)
            self.assertEqual(gateway.status, 403)
            self.call(method, body, 'adminonly', path, 200 if method == 'GET' else 403)
            self.call(method, body, 'tech', path, 200 if method == 'GET' else 403)
        self.call(body=edit, path=revision_path, user='doctor2', status=403)
        self.study_update('"teleInstitutionId"=\'kin-center\'')
        self.call(method='GET', user='kdoctor')
        tele_key = self.item(self.key_item(1, title='tele key'), user='kdoctor')
        tele, _ = self.create([tele_key], user='kdoctor')
        self.study_update('"teleInstitutionId"=NULL')
        self.call(method='GET', user='kdoctor', status=403)
        self.assertEqual(len(self.call(method='GET')['items']), 2)
        self.revise(tele, user='doctor', status=403)
        self.call(path='/studies/'+self.uid+'/report/commit', body=dict(action='preliminary', baseVersion=0, reviewer=self.stack.actor('jmryu'), findings='preliminary', conclusion='', recommendation=''), status=201)
        for method, path, body in routes:
            for user in ['doctor2', 'adminonly', 'tech']:
                self.call(method, body, user, path, 403)
        self.call(method='GET', user='jmryu')
        self.assertEqual(self.call(body=command), head)
        self.study_update('"institutionId"=NULL, "teleInstitutionId"=NULL')
        for method, path, body in routes: self.call(method, body, 'jmryu', path, 403)

    # ---- TEST-S2-API-05 ------------------------------------------------------------------
    def test_05_concurrency_replay_lock_order_timeout_and_limits(self):
        length = self.item(self.length_item())
        head, command = self.create([length])
        path = self.path+'/'+head['id']+'/revisions'
        edits = [dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(schemaVersion=1, title=str(i), text='', sources=[dict(itemId=length['id'], revision=1)])) for i in range(2)]
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(lambda x: self.stack.request('POST', path, 'doctor', x), edits))
        self.assertEqual(sorted(r.status for r in responses), [200, 409])
        before = self.snapshot()
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(lambda _: self.stack.request('POST', self.path, 'doctor', command), range(2)))
        self.assertEqual([r.body for r in responses], [head, head]); self.assertEqual(self.snapshot(), before)
        new = self.finding_body([length])
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(lambda _: self.stack.request('POST', self.path, 'doctor', new), range(2)))
        self.assertEqual([r.status for r in responses], [200, 200]); self.assertEqual(responses[0].body, responses[1].body)
        self.call(body={**command, 'item': {**command['item'], 'text': 'different'}}, status=409)
        self.call(body={**edits[0], 'requestId': command['requestId']}, path=path, status=409)
        self.call(body={**edits[0], 'requestId': command['requestId']}, path=self.path+'/'+str(uuid.uuid4())+'/revisions', status=409)
        self.call(method='GET', path=self.path+'/'+str(uuid.uuid4())+'/revisions', status=404)
        # Lock timeout is retryable and inert.
        before = self.snapshot()
        lock = self.parent_lock()
        try:
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(self.stack.request, 'POST', self.path, 'doctor', self.finding_body([length]))
                self.wait_blocked()
                self.assertEqual(future.result(timeout=7).status, 503)
        finally: self.finish_lock(lock)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.call(body=command), head)
        # Lock order: a source head that moves while this write waits for the parent lock is seen,
        # so the stale pair is refused instead of copying revision 1 values under a revision-2 head.
        lock = self.parent_lock()
        try:
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(self.stack.request, 'POST', self.path, 'doctor', self.finding_body([dict(itemId=length['id'], revision=1)]))
                self.wait_blocked()
                holder, lock = lock, None
                self.finish_lock(holder, f'UPDATE "ViewerItem" SET revision=2 WHERE id={literal(length["id"])}::uuid;')
                response = future.result(timeout=7)
        finally:
            if lock is not None: self.finish_lock(lock)
        try:
            self.assertEqual(response.status, 409, response.text)
            self.assertEqual((response.body['code'], response.body['headRevision']), ('FINDING_SOURCE_STALE', 2))
        finally: psql(f'UPDATE "ViewerItem" SET revision=1 WHERE id={literal(length["id"])}::uuid')
        self.assertEqual(self.snapshot(), before)
        # Limits: findings per study, lifetime revisions, lifetime bytes and revisions per finding.
        # Synthetic rows are seeded only on this owned fixture and removed again; the API never writes them.
        uid = literal(self.uid)
        def synthetic_snapshot(filler=''):
            return json.dumps(dict(schemaVersion=1, title='SYNTHETIC', text=filler, hidden=False, primary=0, sources=[dict(itemId=length['id'], revision=1, studyUid=self.uid,
                kind='length', seriesUid='2.25.1', sopUid='2.25.2', frame=1, frameOfReferenceUid=None, label='', values=None, calculator=None, sourceDigest=None, authorActor='SYNTHETIC')]))
        def seed_findings(count, filler=''):
            snapshot = literal(synthetic_snapshot(filler))
            psql(f'''INSERT INTO "Finding" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt")
                SELECT gen_random_uuid(),{uid},'SYNTHETIC','SYNTHETIC',1,false,{snapshot}::jsonb,now() FROM generate_series(1,{count})''')
            psql(f'''INSERT INTO "FindingRevision" ("findingId",revision,snapshot,action,reason,actor,"authorSub","requestId",fingerprint,"payloadBytes")
                SELECT id,1,snapshot,'create','','SYNTHETIC','SYNTHETIC',gen_random_uuid(),repeat('0',64),octet_length(convert_to(snapshot::text,'UTF8')) FROM "Finding"
                WHERE "studyUid"={uid} AND "authorSub"='SYNTHETIC' AND NOT EXISTS (SELECT 1 FROM "FindingRevision" r WHERE r."findingId"="Finding".id)''')
        def seed_revisions(count, filler=''):
            # Up to 1000 revisions per synthetic finding; each synthetic finding costs one revision itself.
            while count > 0:
                seed_findings(1, filler); count -= 1
                extra = min(count, 999)
                if extra:
                    psql(f'''INSERT INTO "FindingRevision" ("findingId",revision,snapshot,action,reason,actor,"authorSub","requestId",fingerprint,"payloadBytes")
                        SELECT f.id,n,f.snapshot,'edit','','SYNTHETIC','SYNTHETIC',gen_random_uuid(),repeat('0',64),octet_length(convert_to(f.snapshot::text,'UTF8'))
                        FROM "Finding" f, generate_series(2,{extra+1}) n WHERE f."studyUid"={uid} AND f."authorSub"='SYNTHETIC' AND f.revision=1
                        AND NOT EXISTS (SELECT 1 FROM "FindingRevision" r WHERE r."findingId"=f.id AND r.revision=2)''')
                    psql(f'''UPDATE "Finding" SET revision={extra+1} WHERE "studyUid"={uid} AND "authorSub"='SYNTHETIC' AND revision=1''')
                    count -= extra
        def unseed():
            psql(f'DELETE FROM "FindingRevision" WHERE "findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid} AND "authorSub"=\'SYNTHETIC\'); DELETE FROM "Finding" WHERE "studyUid"={uid} AND "authorSub"=\'SYNTHETIC\'')
        def used_bytes():
            return int(psql(f'SELECT COALESCE(sum(r."payloadBytes"),0) FROM "FindingRevision" r JOIN "Finding" f ON f.id=r."findingId" WHERE f."studyUid"={uid}')[0])
        count = int(psql(f'SELECT count(*) FROM "Finding" WHERE "studyUid"={uid}')[0])
        seed_findings(256-count)
        try:
            refused = self.call(body=self.finding_body([length]), status=409); self.assertEqual(refused['code'], 'FINDING_STORAGE_LIMIT')
            self.assertEqual(self.call(body=command), head)
            hidden, _ = self.revise(self.current(head), 'hide', reason='한도 내 숨김')
            self.assertTrue(hidden['hidden'])
        finally: unseed()
        revisions = int(psql(f'SELECT count(*) FROM "FindingRevision" r JOIN "Finding" f ON f.id=r."findingId" WHERE f."studyUid"={uid}')[0])
        seed_revisions(4096-revisions)
        try:
            refused = self.call(body=self.finding_body([length]), status=409); self.assertEqual(refused['code'], 'FINDING_STORAGE_LIMIT')
            self.assertEqual(self.call(body=command), head)
        finally: unseed()
        # Fill the lifetime byte budget with 60 000-byte filler snapshots (under the 65 536-byte cap), then
        # leave fewer bytes than the smallest real snapshot so the next real write is refused.
        seed_revisions(1, 'x'*60000)
        row_bytes = int(psql(f'SELECT max("payloadBytes") FROM "FindingRevision" r JOIN "Finding" f ON f.id=r."findingId" WHERE f."studyUid"={uid}')[0])
        seed_revisions((16*1024*1024-used_bytes())//row_bytes, 'x'*60000)
        remaining = 16*1024*1024-used_bytes()
        if remaining > 500: seed_revisions(1, 'x'*(remaining-(row_bytes-60000)-100))
        self.assertLess(16*1024*1024-used_bytes(), 200)
        try:
            refused = self.call(body=self.finding_body([length]), status=409); self.assertEqual(refused['code'], 'FINDING_STORAGE_LIMIT')
            self.assertEqual(self.call(body=command), head)
        finally: unseed()
        psql(f'UPDATE "Finding" SET revision=1000 WHERE id={literal(head["id"])}::uuid')
        try:
            current = self.current(head); current['revision'] = 1000
            refused, _ = self.revise(current, 'restore', reason='재개', status=409); self.assertEqual(refused['code'], 'FINDING_STORAGE_LIMIT')
        finally: psql(f'UPDATE "Finding" SET revision=(SELECT max(revision) FROM "FindingRevision" WHERE "findingId"={literal(head["id"])}::uuid) WHERE id={literal(head["id"])}::uuid')
        # An audit fault rolls the whole write back.
        name = 'finding_fault_'+uuid.uuid4().hex
        psql(f'CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target={uid} AND NEW.action LIKE \'finding.%\' THEN RAISE EXCEPTION \'SYNTHETIC finding audit fault\'; END IF; RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION {name}();')
        try:
            before = self.snapshot(); self.call(body=self.finding_body([length]), status=500); self.assertEqual(self.snapshot(), before)
        finally: psql(f'DROP TRIGGER {name} ON "AuditLog"; DROP FUNCTION {name}();')

    # ---- TEST-S2-API-06 ------------------------------------------------------------------
    def test_06_pagination_hidden_cursor_and_report_independence(self):
        key = self.item(self.key_item(0))
        heads = [self.create([key], title='소견 '+str(i))[0] for i in range(4)]
        ordered = sorted(heads, key=lambda h: h['id'])
        first = self.call(method='GET', path=self.path+'?limit=2')
        self.assertEqual([x['id'] for x in first['items']], [x['id'] for x in ordered[:2]])
        self.revise(ordered[1], 'hide', reason='숨김')
        second = self.call(method='GET', path=self.path+'?limit=2&cursor='+first['nextCursor'])
        self.assertEqual([x['id'] for x in second['items']], [x['id'] for x in ordered[2:]]); self.assertIsNone(second['nextCursor'])
        path = self.path+'/'+ordered[1]['id']+'/revisions'
        history = self.call(method='GET', path=path+'?limit=1'); self.assertEqual(history['nextCursor'], 1)
        tail = self.call(method='GET', path=path+'?limit=1&cursor=1'); self.assertEqual(tail['revisions'][0]['revision'], 2); self.assertIsNone(tail['nextCursor'])
        # Findings remain workspace records after approval: report rows are untouched by a finding edit and vice versa.
        self.call(path='/studies/'+self.uid+'/report/commit', body=dict(action='approve', baseVersion=0, findings=self.fixture.secret, conclusion='approved', recommendation=''), status=201)
        reports = self.report_rows(); findings = self.snapshot(FINDING_TABLES)
        self.revise(ordered[0], item=dict(schemaVersion=1, title='승인 후 수정', text='', sources=[dict(itemId=key['id'], revision=1)]))
        self.assertEqual(self.report_rows(), reports)
        self.assertNotEqual(self.snapshot(FINDING_TABLES), findings)
        self.assertEqual(self.call(method='GET', path='/studies/'+self.uid+'/report/versions')[0]['findings'], self.fixture.secret)

    # ---- TEST-S2-API-07 ------------------------------------------------------------------
    def test_07_maximum_legitimate_snapshot_fits_and_bytes_are_recorded(self):
        ds = self.slices[0]; ipp = [float(x) for x in ds.ImagePositionPatient]
        arrows = []
        for n in range(8):
            arrow = dict(schemaVersion=1, kind='arrow', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
                         frameOfReferenceUid=str(ds.FrameOfReferenceUID), label='가'*1000, points=[[ipp[0]+5+n, ipp[1]+5, ipp[2]], [ipp[0]+9+n, ipp[1]+9, ipp[2]]])
            arrows.append(self.item(arrow))
        head, _ = self.create(arrows, title='제'*200, text='본'*4000, primary=7)
        self.assertEqual(len(head['item']['sources']), 8); self.assertEqual(head['item']['sources'][3]['label'], '가'*1000)
        row = json.loads(psql(f'SELECT to_jsonb(t)::text FROM "FindingRevision" t WHERE "findingId"={literal(head["id"])}::uuid')[0])
        self.assertEqual(row['payloadBytes'], int(psql(f'SELECT octet_length(convert_to(snapshot::text,\'UTF8\')) FROM "FindingRevision" WHERE "findingId"={literal(head["id"])}::uuid')[0]))
        self.assertLessEqual(row['payloadBytes'], 65536); self.assertGreater(row['payloadBytes'], 36000)
        self.assertEqual(self.call(method='GET')['items'][0]['item'], head['item'])

    # ---- S2-B2 comparison-study helpers ------------------------------------------------------
    def originals_of(self, uid):
        found = self.stack._orthanc_request('POST', '/tools/lookup', uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        raws = [self.stack.orthanc_bytes('/instances/'+i['ID']+'/file') for i in self.stack._orthanc_request('GET', '/studies/'+study+'/instances').body]
        return {str(dcmread(io.BytesIO(raw)).SOPInstanceUID): raw for raw in raws}

    def study(self, uid, slices):
        return SimpleNamespace(uid=uid, path='/studies/'+uid+'/findings', items='/studies/'+uid+'/viewer-items', slices=slices)

    def comparison(self, patient=None, label='prior'):
        """A run-owned synthetic CT of the anchor's patient unless another id is given; its originals must survive."""
        fixture = synthetic_ct(self.stack, patient or self.fixture.patient_id, label, '20250917', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3])
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        originals = self.originals_of(fixture.uid)
        self.addCleanup(lambda: self.assertEqual(self.originals_of(fixture.uid), originals))
        return self.study(fixture.uid, sorted((dcmread(io.BytesIO(raw)) for raw in originals.values()), key=lambda ds: int(ds.InstanceNumber)))

    def item_in(self, study, item, user='xauthor', status=200):
        return self.call(body=dict(requestId=str(uuid.uuid4()), item=item), user=user, path=study.items, status=status)

    def edit_body(self, sources, title='수정', primary=0):
        return dict(schemaVersion=1, title=title, text='', primary=primary, sources=[dict(itemId=s['id'], revision=s['revision']) for s in sources])

    def hide_body(self, head, reason):
        """A hide command for `head` that keeps its exact pairs, title and text."""
        item = head['item']
        return dict(requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action='hide', reason=reason, item=dict(
            schemaVersion=1, title=item['title'], text=item['text'], primary=item['primary'],
            sources=[dict(itemId=s['itemId'], revision=s['revision']) for s in item['sources']]))

    def ids(self, user, query='?includeHidden=true&limit=100', path=None):
        body = self.call(method='GET', user=user, path=(path or self.path)+query)
        self.assertIsNone(body['nextCursor'])
        return [item['id'] for item in body['items']]

    def access(self, user, uids=None, rules=None):
        """SYNTHETIC study-access policy for a run-owned reader; no uids and no rules lifts the restriction."""
        method, path, admin, body = self.access_request(user, uids, rules)
        self.call(method, body, admin, path, 201)

    def access_request(self, user, uids=None, rules=None):
        """The admin policy write of access() as (method, path, user, body), based on the current revision."""
        admin = self.call(method='GET', path='/me', user='jmryu')
        subject = self.call(method='GET', path='/me', user=user)['sub']
        subjects = vars(self).setdefault('access_subjects', set())
        if subject not in subjects:
            subjects.add(subject); self.addCleanup(self.clear_access, subject)
        if uids is not None: rules = [dict(patientId=None, modalities=[], dateFrom=None, dateTo=None, studyUids=sorted(uids))]
        policy = dict(version=1, restricted=rules is not None, startsAt=None, endsAt=None, rules=rules or [])
        path = '/admin/users/'+subject+'/study-access'
        revision = self.call(method='GET', path=path, user='jmryu')['revision']
        return ('POST', path, 'jmryu', dict(expectedOwner=[admin['institution'], admin['sub']], policy=policy,
                revision=revision, reason='SYNTHETIC finding comparison access', requestId=str(uuid.uuid4())))

    def clear_access(self, subject):
        self.assertIn(subject, self.stack.user_ids.values())
        for table in ('StudyAccessRevision', 'StudyAccessPolicy'):
            for raw in psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE subject={literal(subject)}'):
                self.assertTrue(json.loads(raw)['reason'].startswith('SYNTHETIC'))
                self.assertEqual(psql(f'DELETE FROM "{table}" t WHERE to_jsonb(t)={literal(raw)}::jsonb RETURNING 1'), ['1'])
        for raw in psql(f"SELECT to_jsonb(t)::text FROM \"AuditLog\" t WHERE target={literal(subject)} AND action='study.access'"):
            self.assertTrue(json.loads(json.loads(raw)['detail'])['reason'].startswith('SYNTHETIC'))
            self.assertEqual(psql(f'DELETE FROM "AuditLog" t WHERE to_jsonb(t)={literal(raw)}::jsonb RETURNING 1'), ['1'])

    def boundary(self, uid):
        columns = ', '.join("'%s', \"%s\"" % (c, c) for c in BOUNDARY_COLUMNS)
        return json.loads(psql(f'SELECT jsonb_build_object({columns})::text FROM "StudyState" WHERE uid={literal(uid)}')[0])

    def restore_boundary(self, uid, saved):
        assert uid in self.stack.active
        assignments = ', '.join("\"%s\"=s.j->>'%s'" % (c, c) for c in BOUNDARY_COLUMNS)
        psql(f'UPDATE "StudyState" t SET {assignments} FROM (SELECT {literal(json.dumps(saved))}::jsonb AS j) s WHERE t.uid={literal(uid)}')
        self.assertEqual(self.boundary(uid), saved)

    def job_command(self, studies):
        cells = []
        for study in studies:
            ds = study.slices[0]; z = float(ds.ImagePositionPatient[2])
            cells.append(dict(study=study.uid, series=str(ds.SeriesInstanceUID), sop=str(ds.SOPInstanceUID), frame=1,
                camera=dict(focalPoint=[128, 128, z], position=[128, 128, z+1000], viewUp=[0, -1, 0], viewPlaneNormal=[0, 0, 1], parallelScale=128,
                            rotation=0, flipHorizontal=False, flipVertical=False),
                properties=dict(voiRange=dict(lower=-1000, upper=-1), VOILUTFunction='LINEAR', invert=False)))
        return dict(id=str(uuid.uuid4()), title='SYNTHETIC comparison lock order', description='Synthetic lock order',
                    snapshot=dict(version=1, studies=[s.uid for s in studies], rows=1, cols=len(studies), active=0, cells=cells))

    def clear_jobs(self, uid):
        # Full-row equality guards and run-owned authors only, as test_viewer_jobs cleans its jobs.
        for raw in psql(f'SELECT to_jsonb(j)::text FROM "ViewerJob" j WHERE "studyUid"={literal(uid)}'):
            job = json.loads(raw); self.assertIn(job['authorSub'], self.stack.user_ids.values())
            sql = 'BEGIN; '
            for rev in psql(f'SELECT to_jsonb(r)::text FROM "ViewerJobRevision" r WHERE "jobId"={literal(job["id"])}::uuid'):
                sql += f'DELETE FROM "ViewerJobRevision" r WHERE to_jsonb(r)={literal(rev)}::jsonb; '
            psql(sql+f'DELETE FROM "ViewerJob" j WHERE to_jsonb(j)={literal(raw)}::jsonb; COMMIT;')
        self.assertEqual(psql(f'SELECT count(*) FROM "ViewerJob" WHERE "studyUid"={literal(uid)}'), ['0'])

    def locked_request(self, uid, requests, then='', probe=None):
        """Hold `uid`'s row until every request waits on a StudyState lock; optionally prove from the holder's session
        that no waiting request holds the `probe` row (NOWAIT succeeds); run `then` and release; return the responses."""
        def check(holder):
            self.assertEqual(self.holder_rows(holder, f'SELECT uid FROM "StudyState" WHERE uid={literal(probe)} FOR UPDATE NOWAIT'), [probe])
        return self.staged(self.parent_lock(uid=uid), [(requests, self.waiting('FROM "StudyState"', len(requests)))], then,
                           None if probe is None else check)

    def advisory_locks(self, holder, key):
        """'shared-granted exclusive-granted shared-waiting exclusive-waiting' for the study-access advisory lock of `key`
        (a bigint key shows its high half in classid and its low half in objid, objsubid 1)."""
        [counts] = self.holder_rows(holder, f"""SELECT count(*) FILTER (WHERE mode='ShareLock' AND granted)||' '||
            count(*) FILTER (WHERE mode='ExclusiveLock' AND granted)||' '||count(*) FILTER (WHERE mode='ShareLock' AND NOT granted)||' '||
            count(*) FILTER (WHERE mode='ExclusiveLock' AND NOT granted) FROM pg_locks l CROSS JOIN (SELECT hashtextextended({literal(key)}, 0) AS h) k
            WHERE l.locktype='advisory' AND l.objsubid=1 AND l.classid::text::bigint=((k.h>>32)&4294967295) AND l.objid::text::bigint=(k.h&4294967295)""")
        return counts

    # ---- TEST-S2-API-08 (S2-B2 T08a-h) -------------------------------------------------------
    def test_08_comparison_lineage_visibility_history_replay_and_refused_edits(self):
        prior, anchor = self.comparison(), self.study(self.uid, self.slices)
        label = 'P비교표식'+uuid.uuid4().hex[:8]
        x = self.item_in(anchor, self.length_item())
        p = self.item_in(prior, self.key_item(0, title=label, slices=prior.slices))
        # T08a: an anchor item and a same-patient prior item are copied from their own heads.
        f1, create1 = self.create([x, p], user='xauthor', primary=1)
        self.assertEqual((f1['studyUid'], f1['item']['primary']), (self.uid, 1))
        self.assertEqual(f1['item']['sources'], [self.expected_copy(x), self.expected_copy(p, prior.uid)])
        current = [dict(itemId=x['id'], linkState='current', headRevision=1, headHidden=False), dict(itemId=p['id'], linkState='current', headRevision=1, headHidden=False)]
        self.assertEqual(self.call(method='GET', user='xauthor')['items'], [{**f1, 'links': current}])
        history = self.call(method='GET', user='xauthor', path=self.path+'/'+f1['id']+'/revisions')
        self.assertEqual(([r['item'] for r in history['revisions']], history['nextCursor']), ([f1['item']], None))
        self.assertNotIn(prior.uid, ' '.join(self.state(tables=('AuditLog',))['AuditLog']))
        # Cross-study findings interleave by random id with same-study ones: one keeps P only in an older
        # revision (T08e), one is hidden (restore target for T08g).
        cross = [f1] + [self.create([x, p], user='xauthor', title='P '+str(i))[0] for i in range(2)]
        f2, edit2 = self.revise(cross[1], user='xauthor', item=self.edit_body([x], title='X만 남김'))
        f3, _ = self.revise(cross[2], 'hide', reason='보류', user='xauthor')
        own = []
        while len(own) < 4 or not any(min(o['id'] for o in own) < c['id'] < max(o['id'] for o in own) for c in cross):
            self.assertLess(len(own), 24, 'random ids never interleaved')
            own.append(self.create([x], user='xauthor', title='X '+str(len(own)))[0])
        visible, hidden = sorted(o['id'] for o in own), sorted(c['id'] for c in cross)
        # T08h preparation: the prior item moves to revision 2 after it was copied.
        p2 = self.revise_item(p, item=self.key_item(0, title=label+' r2', slices=prior.slices), user='xauthor', items_path=prior.items)
        self.assertEqual(p2['revision'], 2)
        def captured():
            return dict(listed=self.call(method='GET', user='xauthor', path=self.path+'?includeHidden=true&limit=100'),
                        histories={c['id']: self.call(method='GET', user='xauthor', path=self.path+'/'+c['id']+'/revisions') for c in cross},
                        rows={c['id']: self.revision_rows(c['id']) for c in cross})
        before = captured()
        self.assertEqual([i['id'] for i in before['listed']['items']], sorted(visible+hidden))
        self.assertEqual(next(i for i in before['listed']['items'] if i['id'] == f1['id'])['links'][1],
                         dict(itemId=p['id'], linkState='revised', headRevision=2, headHidden=False))
        absent = self.stack.request('GET', self.path+'/'+str(uuid.uuid4())+'/revisions', 'xreader')
        self.assertEqual((absent.status, absent.body['message']), (404, '소견이 없습니다'))
        # T08b: a reader restricted to X sees only same-study findings and no text of P.
        self.access('xreader', [self.uid])
        listed = self.stack.request('GET', self.path+'?includeHidden=true&limit=100', 'xreader')
        self.assertEqual(listed.status, 200, listed.text)
        self.assertEqual(([i['id'] for i in listed.body['items']], listed.body['nextCursor']), (visible, None))
        for secret in [prior.uid, label, p['id'], str(prior.slices[0].SeriesInstanceUID)]+[str(ds.SOPInstanceUID) for ds in prior.slices]+hidden:
            self.assertNotIn(secret, listed.text)
        # T08c: filtering happens before LIMIT; every page is full and every cursor is readable.
        pages, cursor = [], None
        while True:
            body = self.call(method='GET', user='xreader', path=self.path+'?includeHidden=true&limit=1'+('&cursor='+cursor if cursor else ''))
            self.assertEqual(len(body['items']), 1)
            pages.append(body['items'][0]['id']); cursor = body['nextCursor']
            if cursor is None: break
            self.assertIn(cursor, visible)
        self.assertEqual(pages, visible)
        for hidden_id in hidden:
            neighbour = str(uuid.UUID(int=uuid.UUID(hidden_id).int-1))
            at, near = (self.stack.request('GET', self.path+'?includeHidden=true&limit=100&cursor='+c, 'xreader') for c in (hidden_id, neighbour))
            self.assertEqual((at.status, at.text), (near.status, near.text))
            self.assertEqual([i['id'] for i in at.body['items']], [v for v in visible if v > hidden_id])
        # T08e: history of every unreadable finding, including f2 whose head no longer names P, is an absent id.
        for c in cross:
            response = self.stack.request('GET', self.path+'/'+c['id']+'/revisions', 'xreader')
            self.assertEqual((response.status, response.text), (absent.status, absent.text))
        # T08d: the prior becoming non-designated RS=P, leaving the institution, or tele-only in another
        # institution hides the lineage from an unrestricted reader too, until it is reverted.
        saved, full = self.boundary(prior.uid), self.call(method='GET', user='doctor', path=self.path+'?includeHidden=true&limit=100')
        self.assertEqual([i['id'] for i in full['items']], sorted(visible+hidden))
        for changes in ["rs='P', \"preDoc\"='SYNTHETIC-A', \"preReviewer\"='SYNTHETIC-B'",
                        "\"institutionId\"='kin-center', \"teleInstitutionId\"=NULL",
                        "\"institutionId\"='kin-center', \"teleInstitutionId\"='hallym'"]:
            with self.subTest(prior=changes):
                self.study_update(changes, prior.uid)
                try:
                    self.assertEqual(self.ids('doctor'), visible)
                    response = self.stack.request('GET', self.path+'/'+f1['id']+'/revisions', 'doctor')
                    self.assertEqual((response.status, response.text), (absent.status, absent.text))
                finally: self.restore_boundary(prior.uid, saved)
                self.assertEqual(self.call(method='GET', user='doctor', path=self.path+'?includeHidden=true&limit=100'), full)
        # T08f/T08g: the author loses P. Replays, edits keeping or dropping the pair, hide and restore are all
        # an absent finding, and nothing of X or P changes.
        self.access('xauthor', [self.uid])
        x_before, p_before = self.state(), self.state(prior.uid)
        refused = [self.stack.request('POST', self.path, 'xauthor', create1),
                   self.stack.request('POST', self.path+'/'+cross[1]['id']+'/revisions', 'xauthor', edit2)]
        refused += [self.stack.request('POST', self.path+'/'+head['id']+'/revisions', 'xauthor', dict(
            requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action=action, item=item, **extra)) for head, action, item, extra in [
            (f1, 'edit', self.edit_body([x, p], title='쌍 유지', primary=1), {}),
            (f1, 'edit', self.edit_body([x], title='쌍 제거'), {}),
            (f1, 'hide', self.edit_body([x, p], title='숨김', primary=1), {'reason': '숨김'}),
            (f1, 'restore', self.edit_body([x, p], title='복원', primary=1), {'reason': '복원'}),
            (f3, 'restore', self.edit_body([x, p], title='복원'), {'reason': '복원'})]]
        self.assertEqual([(r.status, r.text) for r in refused], [(absent.status, absent.text)]*len(refused))
        self.assertEqual((self.state(), self.state(prior.uid)), (x_before, p_before))
        self.assertEqual(self.ids('xauthor'), visible)
        # T08h: re-granting P restores byte-equal list, history and rows; replays return the recorded rows,
        # and an edit keeps the frozen P copy although the P head is at revision 2.
        self.access('xauthor')
        self.assertEqual(captured(), before)
        self.assertEqual(self.call(body=create1, user='xauthor'), f1)
        self.assertEqual(self.call(body=edit2, path=self.path+'/'+cross[1]['id']+'/revisions', user='xauthor'), f2)
        kept, _ = self.revise(f1, user='xauthor', item=self.edit_body([x, p], title='재허용 후 수정', primary=1))
        self.assertEqual((kept['revision'], kept['item']['sources']), (2, f1['item']['sources']))
        self.assertEqual(self.revision_rows(f1['id'])[:1], before['rows'][f1['id']])
        self.assertEqual(self.ids('xreader'), visible)

    # ---- TEST-S2-API-09 (S2-B2 T09a-g) -------------------------------------------------------
    def test_09_same_patient_institution_access_and_one_comparison_study(self):
        prior, second = self.comparison(label='prior'), self.comparison(label='second')
        other = self.comparison(patient='FINDING-OTHER-'+uuid.uuid4().hex[:8], label='other')
        x = self.item_in(self.study(self.uid, self.slices), self.length_item())
        p, p2, o = (self.item_in(s, self.key_item(0, title='비교 '+name, slices=s.slices)) for s, name in ((prior, 'P'), (second, 'P2'), (other, 'O')))
        before = self.state()
        # T09a: another patient's study. T09d: a request spanning two comparison studies.
        wrong = self.call(body=self.finding_body([x, o]), user='xauthor', status=400)
        self.assertEqual(wrong['message'], '같은 환자의 검사만 소견에 연결할 수 있습니다')
        self.call(body=self.finding_body([x, p, p2]), user='xauthor', status=400)
        self.call(body=self.finding_body([p, p2]), user='xauthor', status=400)
        self.assertEqual(self.state(), before)
        # T09b: another institution that the caller can open through tele access is refused with 403.
        saved = self.boundary(second.uid)
        self.study_update("\"institutionId\"='kin-center', \"teleInstitutionId\"='hallym'", second.uid)
        try:
            self.call(method='GET', user='xauthor', path=second.items)
            self.call(body=self.finding_body([x, p2]), user='xauthor', status=403)
        finally: self.restore_boundary(second.uid, saved)
        self.assertEqual(self.state(), before)
        # T09c: an item of a study the caller cannot open answers exactly like an unknown id, in either
        # position next to a stale anchor pair, and writes nothing.
        stale = dict(itemId=x['id'], revision=2)
        def probes(ref):
            return [self.stack.request('POST', self.path, 'xauthor', self.finding_body(order)) for order in ([ref], [ref, stale], [stale, ref])]
        def unknown_like(ref, case):
            with self.subTest(unreadable=case):
                actual, unknown = probes(ref), probes(dict(itemId=str(uuid.uuid4()), revision=1))
                self.assertEqual([(r.status, r.text) for r in actual], [(r.status, r.text) for r in unknown])
                self.assertEqual([r.status for r in actual], [404, 404, 409])
        target = dict(itemId=p2['id'], revision=1)
        self.access('xauthor', [self.uid, prior.uid])
        unknown_like(target, 'policy')
        self.access('xauthor')
        for case, changes in [('institution', "\"institutionId\"='kin-center', \"teleInstitutionId\"=NULL"),
                              ('preliminary', "rs='P', \"preDoc\"='SYNTHETIC-A', \"preReviewer\"='SYNTHETIC-B'")]:
            self.study_update(changes, second.uid)
            try: unknown_like(target, case)
            finally: self.restore_boundary(second.uid, saved)
        self.assertEqual(self.state(), before)
        # T09e: role, tenant and author boundaries keep test_04's codes on a cross-study finding.
        head, command = self.create([x, p], user='xauthor')
        revision_path = self.path+'/'+head['id']+'/revisions'
        edit = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=self.edit_body([x, p], title='t'))
        routes = [('GET', self.path, None), ('POST', self.path, command), ('GET', revision_path, None), ('POST', revision_path, edit)]
        for method, path, body in routes:
            self.call(method, body, 'kdoctor', path, 403)
            self.assertEqual(self.stack.bearer_request(method, path, self.stack.service_token('gateway'), body).status, 403)
            self.call(method, body, 'adminonly', path, 200 if method == 'GET' else 403)
            self.call(method, body, 'tech', path, 200 if method == 'GET' else 403)
        self.call(body=edit, path=revision_path, user='doctor2', status=403)
        self.assertIn(head['id'], self.ids('tech'))
        # T09f: a patient metadata rule matching X and P needs Orthanc tags for both, prepared before any lock.
        rule = dict(patientId=self.fixture.patient_id, modalities=[], dateFrom=None, dateTo=None, studyUids=[])
        self.access('xauthor', rules=[rule])
        ruled, _ = self.create([x, p], user='xauthor', title='규칙 허용')
        self.assertEqual(set(self.ids('xauthor')), {head['id'], ruled['id']})
        self.call(method='GET', user='xauthor', path=self.path+'/'+ruled['id']+'/revisions')
        self.assertEqual(self.call(body=command, user='xauthor'), head)
        self.access('xauthor', rules=[{**rule, 'studyUids': [self.uid]}])
        self.assertEqual(self.ids('xauthor'), [])
        self.call(method='GET', user='xauthor', path=revision_path, status=404)
        ruled_before = self.state()
        self.assertEqual(self.call(body=self.finding_body([x, p]), user='xauthor', status=404)['message'], '연결할 표식이 이 검사에 없습니다')
        self.assertEqual(self.state(), ruled_before)
        self.access('xauthor')
        # T09g: one comparison study per finding for life, even after the head dropped it.
        dropped, _ = self.revise(head, user='xauthor', item=self.edit_body([x], title='X만'))
        dropped_before = self.state()
        for sources in ([x, p2], [p2]):
            refused, _ = self.revise(dropped, user='xauthor', status=409, item=self.edit_body(sources, title='P2 추가'))
            self.assertEqual(refused['code'], 'FINDING_COMPARISON_STUDY')
        # Replacing the comparison study of a head that still links P is refused the same way.
        refused, _ = self.revise(ruled, user='xauthor', status=409, item=self.edit_body([x, p2], title='P를 P2로'))
        self.assertEqual(refused['code'], 'FINDING_COMPARISON_STUDY')
        self.assertEqual(self.state(), dropped_before)
        readded, _ = self.revise(dropped, user='xauthor', item=self.edit_body([x, p], title='P 다시'))
        self.assertEqual((readded['revision'], readded['item']['sources']), (3, head['item']['sources']))

    # ---- TEST-S2-API-10 (S2-B2 T10a-i) -------------------------------------------------------
    def test_10_two_study_lock_order_races_invisible_quota_and_scale(self):
        prior, anchor = self.comparison(), self.study(self.uid, self.slices)
        x = self.item_in(anchor, self.length_item())
        p = self.item_in(prior, self.key_item(0, title='비교', slices=prior.slices))
        lower, higher = psql(f'SELECT uid FROM "StudyState" WHERE uid IN ({literal(self.uid)},{literal(prior.uid)}) ORDER BY uid')
        # T10a: with the lower row held, a write anchored X/P and a mirrored one anchored P/X both wait
        # without holding the higher row (a NOWAIT lock on it succeeds), then both complete without 40P01.
        forward, mirrored = self.locked_request(lower, [('POST', self.path, 'xauthor', self.finding_body([x, p])),
                                                        ('POST', prior.path, 'xauthor', self.finding_body([p, x]))], probe=higher)
        self.assertEqual((forward.status, mirrored.status), (200, 200), forward.text+mirrored.text)
        self.assertEqual([s['studyUid'] for s in forward.body['item']['sources']], [self.uid, prior.uid])
        self.assertEqual((mirrored.body['studyUid'], [s['studyUid'] for s in mirrored.body['item']['sources']]), (prior.uid, [prior.uid, self.uid]))
        # T10b: the higher row held past lock_timeout is a retryable, inert 503.
        before = (self.state(), self.state(prior.uid))
        command = self.finding_body([x, p])
        lock = self.parent_lock(uid=higher)
        try:
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(self.stack.request, 'POST', self.path, 'xauthor', command)
                self.wait_blocked(timeout=30)
                timed_out = future.result(timeout=30)
        finally: self.finish_lock(lock)
        self.assertEqual(timed_out.status, 503, timed_out.text)
        self.assertEqual((self.state(), self.state(prior.uid)), before)
        retried = self.call(body=command, user='xauthor')
        self.assertEqual(self.call(body=command, user='xauthor'), retried)
        # T10c: the prior item moving to revision 2 while the write waits on P's row is seen after the lock.
        before = (self.state(), self.state(prior.uid))
        [stale] = self.locked_request(prior.uid, [('POST', self.path, 'xauthor', self.finding_body([x, p]))],
                                      f'UPDATE "ViewerItem" SET revision=2 WHERE id={literal(p["id"])}::uuid;')
        try:
            self.assertEqual(stale.status, 409, stale.text)
            self.assertEqual((stale.body['code'], stale.body['itemId'], stale.body['headRevision']), ('FINDING_SOURCE_STALE', p['id'], 2))
        finally: psql(f'UPDATE "ViewerItem" SET revision=1 WHERE id={literal(p["id"])}::uuid')
        self.assertEqual((self.state(), self.state(prior.uid)), before)
        # T10d: identical parallel cross-study creates store one row; a ViewerJob on [X, P] and a finding write
        # lock the same rows in the same order and both complete.
        twin = self.finding_body([x, p])
        with ThreadPoolExecutor(2) as pool:
            twins = list(pool.map(lambda _: self.stack.request('POST', self.path, 'xauthor', twin), range(2)))
        self.assertEqual([r.status for r in twins], [200, 200], [r.text for r in twins]); self.assertEqual(twins[0].body, twins[1].body)
        self.assertEqual(psql(f'SELECT count(*) FROM "FindingRevision" WHERE "requestId"={literal(twin["requestId"])}::uuid'), ['1'])
        self.addCleanup(self.clear_jobs, self.uid)
        job, written = self.locked_request(lower, [('POST', '/studies/'+self.uid+'/viewer-jobs', 'doctor', self.job_command([anchor, prior])),
                                                   ('POST', self.path, 'xauthor', self.finding_body([x, p]))])
        self.assertEqual((job.status, written.status), (200, 200), job.text+written.text)
        # T10g: while a new link, a replay and a hide all wait on the study locks, P becomes non-designated RS=P in the
        # holder's own transaction. Each request reads P's committed row under its lock and answers exactly like an
        # unknown item or an absent finding, writing nothing; with P restored the same replay returns its recorded row
        # and the same hide succeeds.
        absent = self.stack.request('GET', self.path+'/'+str(uuid.uuid4())+'/revisions', 'xauthor')
        unknown = self.stack.request('POST', self.path, 'xauthor', self.finding_body([dict(itemId=str(uuid.uuid4()), revision=1)]))
        self.assertEqual((absent.status, unknown.status), (404, 404))
        hide = self.hide_body(forward.body, '경계 변경 중 숨김')
        saved, before = self.boundary(prior.uid), (self.state(), self.state(prior.uid))
        try:
            responses = self.locked_request(prior.uid, [('POST', self.path, 'xauthor', self.finding_body([x, p])), ('POST', self.path, 'xauthor', command),
                                                        ('POST', self.path+'/'+forward.body['id']+'/revisions', 'xauthor', hide)],
                                            f"UPDATE \"StudyState\" SET rs='P', \"preDoc\"='SYNTHETIC-A', \"preReviewer\"='SYNTHETIC-B' WHERE uid={literal(prior.uid)};")
        finally: self.restore_boundary(prior.uid, saved)
        self.assertEqual([(r.status, r.text) for r in responses], [(unknown.status, unknown.text)]+[(absent.status, absent.text)]*2)
        self.assertEqual((self.state(), self.state(prior.uid)), before)
        self.assertEqual(self.call(body=command, user='xauthor'), retried)
        self.assertTrue(self.call(body=hide, path=self.path+'/'+forward.body['id']+'/revisions', user='xauthor')['hidden'])
        # T10h: a create holding the shared study-access lock of its author waits on a study row. The admin restriction
        # of that author is then observed waiting for the exclusive lock of the same key while the committed policy is
        # unchanged. After release the create, authorized before the change, commits first (a response that crosses the
        # change may still be answered 409 STUDY_ACCESS_CHANGED by the interceptor) and the restriction commits after it;
        # from then on the same request and an edit of that finding are an absent finding.
        me = self.call(method='GET', path='/me', user='xauthor')
        key = 'study-access:'+json.dumps([me['institution'], me['sub']], separators=(',', ':'), ensure_ascii=False)
        policy_revision = f'SELECT COALESCE(max(revision), 0) FROM "StudyAccessPolicy" WHERE subject={literal(me["sub"])}'
        committed, before = psql(policy_revision), (self.state(), self.state(prior.uid))
        early, restrict = self.finding_body([x, p]), self.access_request('xauthor', [self.uid])
        def in_flight(holder):
            self.assertEqual(self.advisory_locks(holder, key), '1 0 0 1')
            self.assertEqual(self.holder_rows(holder, policy_revision), committed)
        written, restricted = self.staged(self.parent_lock(uid=lower), [
            ([('POST', self.path, 'xauthor', early)], self.waiting('FROM "StudyState"', 1)),
            ([restrict], self.waiting('pg_advisory_xact_lock(', 1, 'advisory'))], check=in_flight)
        print(f'T10h in-flight create answered {written.status}', flush=True)
        self.assertEqual(restricted.status, 201, restricted.text)
        self.assertTrue(written.status == 200 or (written.status == 409 and written.body.get('code') == 'STUDY_ACCESS_CHANGED'), written.text)
        self.assertEqual(int(psql(policy_revision)[0]), int(committed[0])+1)
        rows = psql(f'''SELECT r."findingId"||' '||r.revision||' '||(SELECT string_agg(s.value->>'studyUid', ',' ORDER BY s.ordinality)
            FROM jsonb_array_elements(r.snapshot->'sources') WITH ORDINALITY s) FROM "FindingRevision" r WHERE r."requestId"={literal(early["requestId"])}::uuid''')
        self.assertEqual(len(rows), 1, rows)
        finding_id, revision, studies = rows[0].split(' ')
        self.assertEqual((revision, studies), ('1', self.uid+','+prior.uid))
        after = self.state()
        self.assertEqual({t: [r for r in before[0][t] if r not in after[t]] for t in after}, {t: [] for t in after})
        self.assertEqual({t: len([r for r in after[t] if r not in before[0][t]]) for t in after},
                         {**{t: 0 for t in after}, 'Finding': 1, 'FindingRevision': 1, 'AuditLog': 1})
        self.assertEqual(self.state(prior.uid), before[1])
        refused = [self.stack.request('POST', self.path, 'xauthor', early),
                   self.stack.request('POST', self.path+'/'+finding_id+'/revisions', 'xauthor', dict(requestId=str(uuid.uuid4()), expectedRevision=1,
                                      action='edit', item=self.edit_body([x], title='제한 뒤 편집')))]
        self.assertEqual([(r.status, r.text) for r in refused], [(absent.status, absent.text)]*2)
        self.assertEqual((self.state(), self.state(prior.uid)), (after, before[1]))
        self.access('xauthor')
        # T10i: the admin restriction holds the exclusive lock while it waits on its own policy row; a hide and a new link
        # authorized under the old policy are then observed waiting for the shared lock. Once the restriction commits
        # they read it under that lock and are refused, writing nothing; lifting it lets the same hide succeed.
        before, target = (self.state(), self.state(prior.uid)), twins[0].body
        hide, late, restrict = self.hide_body(target, '제한 확정 뒤 숨김'), self.finding_body([x, p]), self.access_request('xauthor', [self.uid])
        self.assertEqual((int(psql(policy_revision)[0]), restrict[3]['revision']), (int(committed[0])+2,)*2, 'the policy row to hold must exist')
        policy_row = self.hold(f'SELECT revision FROM "StudyAccessPolicy" WHERE institution={literal(me["institution"])} '
                               f'AND subject={literal(me["sub"])} FOR UPDATE')
        restricted, hidden, created = self.staged(policy_row, [
            ([restrict], self.waiting('"StudyAccessPolicy" WHERE institution=', 1)),
            ([('POST', self.path+'/'+target['id']+'/revisions', 'xauthor', hide), ('POST', self.path, 'xauthor', late)],
             self.waiting('pg_advisory_xact_lock_shared(', 2, 'advisory'))],
            check=lambda holder: self.assertEqual(self.advisory_locks(holder, key), '0 1 2 0'))
        self.assertEqual(restricted.status, 201, restricted.text)
        self.assertEqual([(r.status, r.text) for r in (hidden, created)], [(absent.status, absent.text), (unknown.status, unknown.text)])
        self.assertEqual((self.state(), self.state(prior.uid)), before)
        self.access('xauthor')
        self.assertTrue(self.call(body=hide, path=self.path+'/'+target['id']+'/revisions', user='xauthor')['hidden'])
        # T10e: X filled to the findings limit with rows the caller cannot read. The refusal carries only the
        # code and message; the caller's list still shows only what it may read.
        self.access('xauthor', [self.uid]); self.access('xreader', [self.uid])
        own, _ = self.create([x], user='xauthor', title='읽을 수 있는 소견')
        uid = literal(self.uid)
        def seeded_snapshot(study, size=0):
            return literal(json.dumps(dict(schemaVersion=1, title='SYNTHETIC', text='s'*size, hidden=False, primary=0, sources=[dict(
                itemId=str(uuid.uuid4()), revision=1, studyUid=study, kind='length', seriesUid='2.25.1', sopUid='2.25.2', frame=1,
                frameOfReferenceUid=None, label='', values=None, calculator=None, sourceDigest=None, authorActor='SYNTHETIC')])))
        def unseed():
            psql(f'DELETE FROM "FindingRevision" WHERE "findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid} AND "authorSub"=\'SYNTHETIC\'); '
                 f'DELETE FROM "Finding" WHERE "studyUid"={uid} AND "authorSub"=\'SYNTHETIC\'')
        def usage():
            return [int(v) for v in psql(f'''SELECT (SELECT count(*) FROM "Finding" WHERE "studyUid"={uid}) || ' ' ||
                (SELECT count(*) FROM "FindingRevision" r JOIN "Finding" f ON f.id=r."findingId" WHERE f."studyUid"={uid}) || ' ' ||
                (SELECT COALESCE(sum(r."payloadBytes"),0) FROM "FindingRevision" r JOIN "Finding" f ON f.id=r."findingId" WHERE f."studyUid"={uid})''')[0].split()]
        findings, revisions, used = usage()
        count = 256-findings
        # One seeded finding at the 1000-revision history cap; the others share the lifetime revision budget up to 8 short
        # of it, and every seeded snapshot is sized so the byte budget ends about 20 KiB short: only the finding count refuses.
        budget = 4096-revisions-8-1000
        each, extra = divmod(budget, count-1)
        overhead = max(int(psql(f"SELECT octet_length(convert_to({seeded_snapshot(s)}::jsonb::text,'UTF8'))")[0]) for s in (prior.uid, self.uid))
        size = (16*1024*1024-used-20000)//(1000+budget)-overhead
        self.addCleanup(unseed)
        psql(f'''WITH seeded AS (INSERT INTO "Finding" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt")
            SELECT gen_random_uuid(),{uid},'SYNTHETIC','SYNTHETIC',CASE WHEN n=1 THEN 1000 WHEN n<={1+extra} THEN {each+1} ELSE {each} END,false,
              CASE WHEN n%2=1 THEN {seeded_snapshot(prior.uid, size)}::jsonb ELSE {seeded_snapshot(self.uid, size)}::jsonb END,now()
            FROM generate_series(1,{count}) n RETURNING id,revision,snapshot)
            INSERT INTO "FindingRevision" ("findingId",revision,snapshot,action,reason,actor,"authorSub","requestId",fingerprint,"payloadBytes")
            SELECT s.id,k,s.snapshot,CASE WHEN k=1 THEN 'create' ELSE 'edit' END,'','SYNTHETIC','SYNTHETIC',gen_random_uuid(),repeat('0',64),
              octet_length(convert_to(s.snapshot::text,'UTF8')) FROM seeded s CROSS JOIN LATERAL generate_series(1,s.revision) k''')
        totals = usage()
        self.assertEqual(totals[:2], [256, 4096-8])
        # Study uids may differ by a few digits in length, so rows of the shorter one are a little smaller.
        self.assertGreater(totals[2], 16*1024*1024-64000); self.assertLessEqual(totals[2], 16*1024*1024-20000)
        # Refusals only ever insert, so full Finding/audit rows plus revision totals prove nothing was written.
        seeded_before = self.state(tables=('Finding', 'AuditLog'))
        refused = self.stack.request('POST', self.path, 'xauthor', self.finding_body([x]))
        self.assertEqual((refused.status, refused.body), (409, dict(code='FINDING_STORAGE_LIMIT', message='소견 저장 한도에 도달했습니다')))
        self.assertEqual((self.state(tables=('Finding', 'AuditLog')), usage()), (seeded_before, totals))
        readable = psql(f'''SELECT f.id FROM "Finding" f WHERE f."studyUid"={uid} AND NOT EXISTS (SELECT 1 FROM "FindingRevision" r,
            jsonb_array_elements(r.snapshot->'sources') s WHERE r."findingId"=f.id AND s.value->>'studyUid'<>{uid}) ORDER BY f.id''')
        self.assertIn(own['id'], readable); self.assertGreater(len(readable), 100); self.assertLess(len(readable), 200)
        # T10f: full pages through the limit-filled, byte- and revision-heavy study within the statement timeout.
        def pages(user):
            ids, cursor, seconds = [], None, []
            while True:
                started = time.monotonic()
                response = self.stack.request('GET', self.path+'?includeHidden=true&limit=100'+('&cursor='+cursor if cursor else ''), user)
                seconds.append(round(time.monotonic()-started, 3))
                self.assertEqual(response.status, 200, response.text)
                ids += [i['id'] for i in response.body['items']]; cursor = response.body['nextCursor']
                if cursor is None: return ids, seconds
                self.assertEqual((len(response.body['items']), cursor), (100, ids[-1]))
        for user, expected in (('xauthor', readable), ('xreader', readable),
                               ('doctor', psql(f'SELECT id FROM "Finding" WHERE "studyUid"={uid} ORDER BY id'))):
            ids, seconds = pages(user)
            print(f'T10f list user={user} rows={len(ids)} seconds={seconds}', flush=True)
            self.assertEqual(ids, expected)
        [capped] = psql(f'SELECT id FROM "Finding" WHERE "studyUid"={uid} AND revision=1000')
        for query, first in (('?limit=100', 1), ('?limit=100&cursor=900', 901)):
            started = time.monotonic()
            response = self.stack.request('GET', self.path+'/'+capped+'/revisions'+query, 'doctor')
            print(f'T10f history query={query} seconds={round(time.monotonic()-started, 3)}', flush=True)
            self.assertEqual(response.status, 200, response.text)
            self.assertEqual([r['revision'] for r in response.body['revisions']], list(range(first, first+100)))
        self.call(method='GET', user='xreader', path=self.path+'/'+capped+'/revisions', status=404)

    # ---- S2-L1 saved locations, version 2 records and the schema handshake -------------------------
    def schema_call(self, method, path, user='xauthor', body=None, schema='2'):
        """(status, response X-KIN-Finding-Schema, body) of a request that names (or omits) the record format."""
        headers = {'Accept': 'application/json', 'Authorization': 'Bearer '+self.stack.token(user)}
        if schema is not None: headers['X-KIN-Finding-Schema'] = schema
        data = None
        if body is not None: data = json.dumps(body).encode('utf-8'); headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.stack.api+path, data=data, headers=headers, method=method)
        try:
            with self.stack._open(request) as response:
                return response.status, response.headers.get('X-KIN-Finding-Schema'), json.loads(response.read() or b'null')
        except urllib.error.HTTPError as error:
            return error.code, error.headers.get('X-KIN-Finding-Schema'), json.loads(error.read() or b'null')

    def v2(self, sources, characteristics='', title='위치 소견', text='', primary=0, request_id=None):
        refs = [dict(itemId=s['id'], revision=s['revision']) if 'item' in s else s for s in sources]
        return dict(requestId=request_id or str(uuid.uuid4()), item=dict(schemaVersion=2, title=title, text=text,
                    characteristics=characteristics, sources=refs, primary=primary))

    def saved_job(self, studies, user='doctor'):
        self.addCleanup(self.clear_jobs, studies[0].uid)
        return self.call(body=self.job_command(studies), user=user, path='/studies/'+studies[0].uid+'/viewer-jobs')

    def revise_job(self, study, job, status=200, **changes):
        body = dict(expectedRevision=job['revision'], title=job['title'], description=job['description'], hidden=job['hidden'], reason='')
        body.update(changes)
        return self.call(body=body, user='doctor', path='/studies/'+study.uid+'/viewer-jobs/'+job['id']+'/revisions', status=status)

    def job_copy(self, job, studies, anchor):
        return dict(kind='job', jobId=job['id'], revision=job['revision'], jobStudyUid=anchor, studyUid=studies[1] if len(studies) > 1 else studies[0],
                    studies=studies, snapshotVersion=1, title=job['title'], authorActor=job['authorActor'], mark=None)

    # ---- TEST-S2-API-11 (S2-L1 §2.3, R5, version rule, E1) ----------------------------------------
    def test_11_saved_views_version_two_handshake_version_rule_and_exact_copies(self):
        anchor, prior = self.study(self.uid, self.slices), self.comparison()
        length = self.length_item(); length['baseline']['values'] = [-0.33113281957650276]
        x = self.item_in(anchor, length)
        view = self.saved_job([anchor])
        pair = self.saved_job([anchor, prior])
        original = self.report_rows()
        # A version 2 record with characteristics links a one-study saved view and a two-study one (projection = comparison).
        created = self.v2([x, dict(jobId=view['id'], revision=1), dict(jobId=pair['id'], revision=1)], characteristics='경계 불명확 😀'*3, primary=1)
        status, header, head = self.schema_call('POST', self.path, body=created)
        self.assertEqual((status, header), (200, '2'), head)
        self.assertEqual(head['item']['schemaVersion'], 2); self.assertEqual(head['item']['characteristics'], '경계 불명확 😀'*3)
        self.assertEqual(head['item']['sources'][1:], [self.job_copy(view, [self.uid], self.uid), self.job_copy(pair, [self.uid, prior.uid], self.uid)])
        # E1: the 17-digit copied value is the item row's own text, in the stored revision and in every answer.
        item_text = psql(f'''SELECT snapshot->'baseline'->'values'->>0 FROM "ViewerItem" WHERE id={literal(x['id'])}::uuid''')
        copy_text = psql(f'''SELECT snapshot->'sources'->0->'values'->>0 FROM "FindingRevision" WHERE "findingId"={literal(head['id'])}::uuid''')
        self.assertEqual(copy_text, item_text); self.assertEqual(copy_text, ['-0.33113281957650276'])
        self.assertEqual(repr(head['item']['sources'][0]['values'][0]), copy_text[0])
        # R5: without the request header a page or history holding version 2 is refused whole; with it both are served.
        for path in (self.path+'?includeHidden=true', self.path+'/'+head['id']+'/revisions'):
            status, header, body = self.schema_call('GET', path, schema=None)
            self.assertEqual((status, header, body['code']), (409, '2', 'FINDING_CLIENT_OUTDATED'), path)
            self.assertNotIn('경계', json.dumps(body, ensure_ascii=False))
        status, header, listed = self.schema_call('GET', self.path+'?includeHidden=true')
        self.assertEqual((status, header), (200, '2'))
        self.assertEqual(listed['items'][0]['links'], [dict(itemId=x['id'], linkState='current', headRevision=1, headHidden=False),
            dict(jobId=view['id'], markId=None, linkState='current', headRevision=1, headHidden=False),
            dict(jobId=pair['id'], markId=None, linkState='current', headRevision=1, headHidden=False)])
        self.assertEqual(repr(listed['items'][0]['item']['sources'][0]['values'][0]), copy_text[0])
        status, _, history = self.schema_call('GET', self.path+'/'+head['id']+'/revisions')
        self.assertEqual((status, [r['item'] for r in history['revisions']]), (200, [head['item']]))
        # A study whose pages hold only version 1 records is unchanged for a shipped client, and a service refusal names the format too.
        status, header, empty = self.schema_call('GET', prior.path, schema=None)
        self.assertEqual((status, header, empty['items']), (200, '2', []))
        status, header, _ = self.schema_call('GET', self.path+'/'+str(uuid.uuid4())+'/revisions')
        self.assertEqual((status, header), (404, '2'))
        # Metadata changes: the link reads metadata-changed, then hidden; a stale pair is refused with the Job named.
        renamed = self.revise_job(anchor, view, title='새 제목')
        stale = self.v2([dict(jobId=view['id'], revision=1)])
        status, _, refused = self.schema_call('POST', self.path, body=stale)
        self.assertEqual((status, refused['code'], refused['jobId'], refused['headRevision'], refused['headHidden']), (409, 'FINDING_SOURCE_STALE', view['id'], 2, False))
        links = lambda: self.schema_call('GET', self.path+'?includeHidden=true')[2]['items'][0]['links'][1]
        self.assertEqual((links()['linkState'], links()['headRevision']), ('metadata-changed', 2))
        # A refresh re-copies the title only; the location it names is the frozen one.
        refresh = dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=dict(created['item'], sources=[
            dict(itemId=x['id'], revision=1), dict(jobId=view['id'], revision=2), dict(jobId=pair['id'], revision=1)]))
        status, _, refreshed = self.schema_call('POST', self.path+'/'+head['id']+'/revisions', body=refresh)
        self.assertEqual(status, 200, refreshed)
        self.assertEqual(refreshed['item']['sources'][1], dict(self.job_copy(renamed, [self.uid], self.uid)))
        self.assertEqual(refreshed['item']['sources'][0], head['item']['sources'][0], 'the item copy stays byte-equal')
        hidden_view = self.revise_job(anchor, renamed, hidden=True, reason='숨김 확인')
        self.assertEqual(links()['linkState'], 'hidden')
        status, _, refused = self.schema_call('POST', self.path, body=self.v2([dict(jobId=view['id'], revision=hidden_view['revision'])]))
        self.assertEqual((status, refused['code'], refused['headHidden']), (409, 'FINDING_SOURCE_STALE', True))
        # W1-W4: an unknown Job, one anchored on the comparison study and a point on a version 1 Job.
        elsewhere = self.saved_job([prior])
        unknown = self.schema_call('POST', self.path, body=self.v2([dict(jobId=str(uuid.uuid4()), revision=1)]))
        self.assertEqual((unknown[0], unknown[2]['message']), (404, '연결할 저장 작업이 이 검사에 없습니다'))
        foreign = self.schema_call('POST', self.path, body=self.v2([dict(jobId=elsewhere['id'], revision=1)]))
        self.assertEqual((foreign[0], foreign[2]), (unknown[0], unknown[2]), 'a Job of another anchor is an unknown Job')
        mark = self.schema_call('POST', self.path, body=self.v2([dict(jobId=pair['id'], revision=1, markId=str(uuid.uuid4()))]))
        self.assertEqual((mark[0], mark[2]['code']), (400, 'FINDING_JOB_MARK'))
        # One comparison study for life: a head that names P through a saved view cannot add P2.
        second = self.comparison(label='second')
        p2 = self.item_in(second, self.key_item(0, slices=second.slices))
        status, _, refused = self.schema_call('POST', self.path+'/'+head['id']+'/revisions', body=dict(requestId=str(uuid.uuid4()), expectedRevision=2,
            action='edit', item=dict(refresh['item'], sources=[dict(itemId=x['id'], revision=1), dict(itemId=p2['id'], revision=1)])))
        self.assertEqual((status, refused['code']), (409, 'FINDING_COMPARISON_STUDY'))
        # Version rule: a shipped (version 1) edit or hide of a version 2 record is refused; a version 2 hide keeps the content.
        items_only, v1_create = self.create([x], user='xauthor')
        promoted_request = self.v2([x], characteristics='승격', title=items_only['item']['title'], text=items_only['item']['text'])
        status, _, promoted = self.schema_call('POST', self.path+'/'+items_only['id']+'/revisions', body=dict(promoted_request, expectedRevision=1, action='edit'))
        self.assertEqual((status, promoted['item']['schemaVersion'], promoted['revision']), (200, 2, 2))
        before = self.state()
        self.revise(promoted, 'edit', user='xauthor', status=409, item=self.edit_body([x], title=promoted['item']['title']))
        refused, _ = self.revise(promoted, 'hide', reason='숨김', user='xauthor', status=409)
        self.assertEqual(refused['code'], 'FINDING_SCHEMA_VERSION')
        v2_hide = dict(requestId=str(uuid.uuid4()), expectedRevision=2, action='hide', reason='숨김', item=promoted_request['item'])
        changed = dict(v2_hide, requestId=str(uuid.uuid4()), item=dict(promoted_request['item'], characteristics='바뀜'))
        status, _, refused = self.schema_call('POST', self.path+'/'+items_only['id']+'/revisions', body=changed)
        self.assertEqual((status, refused['code']), (409, 'FINDING_SCHEMA_VERSION'))
        self.assertEqual(self.state(), before)
        status, _, hidden = self.schema_call('POST', self.path+'/'+items_only['id']+'/revisions', body=v2_hide)
        self.assertEqual((status, hidden['hidden'], hidden['item']['characteristics']), (200, True, '승격'))
        # The recorded version 1 create and the version 2 promotion replay as recorded after the record changed again.
        self.assertEqual(self.call(body=v1_create, user='xauthor'), items_only)
        status, _, replayed = self.schema_call('POST', self.path+'/'+items_only['id']+'/revisions', body=dict(promoted_request, expectedRevision=1, action='edit'))
        self.assertEqual((status, replayed), (200, promoted))
        self.assertEqual(self.report_rows(), original)

    # ---- TEST-S2-API-12 (S2-L1 R6 malformed lineage rows, job-hide and revocation races) -------------
    def test_12_malformed_job_copies_are_unreadable_and_races_serialize(self):
        anchor, prior = self.study(self.uid, self.slices), self.comparison()
        x = self.item_in(anchor, self.length_item())
        pair = self.saved_job([anchor, prior])
        good, _ = self.create([x], user='xauthor')
        status, _, linked = self.schema_call('POST', self.path, body=self.v2([x, dict(jobId=pair['id'], revision=1)]))
        self.assertEqual(status, 200, linked)
        copy = linked['item']['sources'][1]
        # R6: rows the service never writes, seeded as a version 2 revision and head. Each is unreadable even to a reader of every study.
        uid, third = literal(self.uid), self.comparison(label='third')
        malformed = {'three studies': dict(studies=[self.uid, prior.uid, third.uid]), 'duplicate': dict(studies=[self.uid, prior.uid, prior.uid]),
                     'empty': dict(studies=[]), 'scalar': dict(studies=self.uid), 'projection is the anchor': dict(studyUid=self.uid),
                     'anchor is the comparison': dict(jobStudyUid=prior.uid), 'reversed': dict(studies=[prior.uid, self.uid]), 'number': dict(studies=[self.uid, 7]),
                     'missing studies': dict(studies=None)}
        seeded = {}
        for name, patch in malformed.items():
            bad = dict(copy, **patch)
            if patch.get('studies', 0) is None: del bad['studies']
            snapshot = literal(json.dumps(dict(schemaVersion=2, title='SYNTHETIC '+name, text='', characteristics='', hidden=False, primary=0, sources=[bad])))
            fid = str(uuid.uuid4()); seeded[name] = fid
            psql(f'''INSERT INTO "Finding" (id,"studyUid","authorSub","authorActor",revision,hidden,snapshot,"updatedAt")
                VALUES ({literal(fid)}::uuid,{uid},'SYNTHETIC','SYNTHETIC',1,false,{snapshot}::jsonb,now())''')
            psql(f'''INSERT INTO "FindingRevision" ("findingId",revision,snapshot,action,reason,actor,"authorSub","requestId",fingerprint,"payloadBytes")
                VALUES ({literal(fid)}::uuid,1,{snapshot}::jsonb,'create','','SYNTHETIC','SYNTHETIC',{literal(str(uuid.uuid4()))}::uuid,{literal('0'*64)},
                octet_length(convert_to({snapshot}::jsonb::text,'UTF8')))''')
        self.addCleanup(lambda: psql(f'''DELETE FROM "FindingRevision" WHERE "findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid} AND "authorSub"='SYNTHETIC');
            DELETE FROM "Finding" WHERE "studyUid"={uid} AND "authorSub"='SYNTHETIC' '''))
        def listed(user):
            status, _, body = self.schema_call('GET', self.path+'?includeHidden=true&limit=100', user=user)
            self.assertEqual(status, 200, body); return {i['id'] for i in body['items']}
        for user in ('doctor', 'xauthor'):
            ids = listed(user)
            self.assertIn(linked['id'], ids); self.assertIn(good['id'], ids)
            for name, fid in seeded.items():
                self.assertNotIn(fid, ids, name)
                status, _, body = self.schema_call('GET', self.path+'/'+fid+'/revisions', user=user)
                self.assertEqual((status, body['message']), (404, '소견이 없습니다'), name)
        # A reader restricted to X loses the finding that names P through its saved view; a well-formed copy stays readable otherwise.
        self.access('xreader', [self.uid])
        self.assertEqual(listed('xreader'), {good['id']})
        self.access('xreader')
        # Job hide racing a link: whichever commits first, the finding never copies a hidden Job.
        view = self.saved_job([anchor])
        link = self.v2([dict(jobId=view['id'], revision=1)])
        hide = dict(expectedRevision=1, title=view['title'], description=view['description'], hidden=True, reason='경합 숨김')
        headers = {'X-KIN-Finding-Schema': '2'}
        before = self.state()
        created, hidden = self.locked_request(self.uid, [('POST', self.path, 'xauthor', link),
                                                         ('POST', '/studies/'+self.uid+'/viewer-jobs/'+view['id']+'/revisions', 'doctor', hide)])
        self.assertEqual(hidden.status, 200, hidden.text)
        if created.status == 200:
            state = self.schema_call('GET', self.path+'?includeHidden=true&limit=100')[2]['items']
            self.assertEqual(next(i for i in state if i['id'] == created.body['id'])['links'][0]['linkState'], 'hidden')
        else:
            self.assertEqual((created.status, created.body['code'], created.body['headHidden']), (409, 'FINDING_SOURCE_STALE', True))
            self.assertEqual(self.state(tables=('Finding', 'FindingRevision')), dict((t, before[t]) for t in ('Finding', 'FindingRevision')))
        print(f'S2-L1 job-hide race: link answered {created.status}', flush=True)
        # Revocation racing a link: P becomes unreadable while the link waits on P's row; the answer is an unknown Job and nothing is written.
        unknown = self.schema_call('POST', self.path, body=self.v2([dict(jobId=str(uuid.uuid4()), revision=1)]))
        saved, before = self.boundary(prior.uid), (self.state(), self.state(prior.uid))
        try:
            [revoked] = self.locked_request(prior.uid, [('POST', self.path, 'xauthor', self.v2([dict(jobId=pair['id'], revision=1)]))],
                f"UPDATE \"StudyState\" SET rs='P', \"preDoc\"='SYNTHETIC-A', \"preReviewer\"='SYNTHETIC-B' WHERE uid={literal(prior.uid)};")
        finally: self.restore_boundary(prior.uid, saved)
        self.assertEqual((revoked.status, revoked.body), (unknown[0], unknown[2]))
        self.assertEqual((self.state(), self.state(prior.uid)), before)

    # ---- TEST-S3-U2a-CITATION-LIVE (contract section 9 items 14, 15 server half, 17, 18, 19, 20, 22) ----
    def links_of(self, finding, user='xauthor'):
        listed = self.call(method='GET', user=user, path=self.path+'?includeHidden=true&limit=100')['items']
        return next(item for item in listed if item['id'] == finding['id'])['links']

    def cite(self, finding, index, text, user='xauthor', status=200, base=0, link=None, revision=None):
        """One PUT that carries the sentence and asks the server to attest it."""
        head = link or self.links_of(finding, user)[index]
        return self.call('PUT', dict(findings=text, conclusion='', recommendation='', baseVersion=base,
            insert=dict(field='findings', findingId=finding['id'], findingRevision=revision or finding['revision'],
                        sourceIndex=index, insertedText=text, expectedLinkState=head['linkState'],
                        expectedHeadRevision=head['headRevision'])), user, '/studies/'+self.uid+'/report', status)

    def citations(self, user='xauthor', status=200):
        return self.call(method='GET', user=user, path='/studies/'+self.uid+'/report/citations', status=status)

    def draft_row(self):
        return psql(f'SELECT to_jsonb(t)::text FROM "ReportDraft" t WHERE uid={literal(self.uid)} ORDER BY author')

    def test_13_citation_attestation_boundaries_and_payload_stability(self):
        """Contract 9 backend gates. The insertion surface is the PUT body, so none of this needs the
        screen: what it needs is a real lineage, a real revocation and the real polling payload."""
        prior, anchor = self.comparison(), self.study(self.uid, self.slices)
        x = self.item_in(anchor, self.length_item())
        p = self.item_in(prior, self.key_item(0, title='P비교'+uuid.uuid4().hex[:6], slices=prior.slices))
        crossed, _ = self.create([x, p], user='xauthor', title='비교 인용')
        text = '우상엽 결절 소견'
        report = '/studies/'+self.uid+'/report'

        # 22 - an insertion touches the draft row and nothing else that holds the record.
        frozen = {t: psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE uid={literal(self.uid)}') for t in ('Report', 'ReportVersion')}
        listed_before = self.stack.request('GET', '/studies', 'xauthor')
        boot_before = self.stack.request('GET', '/bootstrap', 'xauthor')
        answer = self.cite(crossed, 1, text)
        self.assertEqual(sorted(answer['inserted']), ['cid', 'field', 'insertedAt'])
        self.assertNotIn('findings', answer, 'the PUT answer never carries the report body back')
        self.assertEqual({t: psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE uid={literal(self.uid)}') for t in ('Report', 'ReportVersion')}, frozen)

        # 19 - the thirty-second poll and the bootstrap payload are not widened by any of this.
        listed_after = self.stack.request('GET', '/studies', 'xauthor')
        boot_after = self.stack.request('GET', '/bootstrap', 'xauthor')
        for before, after in ((listed_before, listed_after), (boot_before, boot_after)):
            self.assertNotIn('citation', after.text)
            state = lambda response: {k: v for k, v in (response.body.get('states', {}) or {}).get(self.uid, {}).items() if k != 'draft'}
            self.assertEqual(state(after), state(before))
            draft = (after.body.get('states', {}) or {}).get(self.uid, {}).get('draft')
            if draft is not None:
                self.assertEqual(sorted(draft), ['at', 'baseVersion', 'conclusion', 'findings', 'recommendation'])

        # 15 server half - a stale link state is refused and the draft row stays byte-identical.
        rows = self.draft_row()
        stale = dict(self.links_of(crossed, 'xauthor')[1], headRevision=99)
        self.cite(crossed, 1, text, link=stale, status=409)
        self.cite(crossed, 1, text, revision=crossed['revision']+1, status=409)
        self.assertEqual(self.draft_row(), rows)

        # 17 - an old client that knows nothing about citations neither clears nor duplicates them.
        self.call('PUT', dict(findings=text, conclusion='', recommendation='', baseVersion=0), 'xauthor', report)
        mine = self.citations()
        self.assertEqual(len(mine['draft']), 1)
        self.assertEqual(mine['draft'][0]['insertedText'], text)
        self.assertEqual(mine['draft'][0]['sameTextCount'], 1)

        # 14a - hiding the finding does not take the attestation with it; a hidden finding stays
        # readable to its citation (contract 5-12), so the entry is still whole.
        hidden = self.call(body=self.hide_body(crossed, '숨김'), path=self.path+'/'+crossed['id']+'/revisions', user='xauthor')
        self.assertTrue(hidden['hidden'])
        self.assertEqual(self.citations()['draft'][0]['insertedText'], text)

        # 14b - losing access to the comparison study reduces the entry to one neutral state, and the
        # text of a study this reader may no longer see does not come back through this door.
        self.access('xauthor', [self.uid])
        reduced = self.citations()['draft'][0]
        self.assertEqual(sorted(reduced), ['cid', 'field', 'insertedAt', 'insertedBy', 'state'])
        self.assertEqual(reduced['state'], 'source-unavailable')
        self.access('xauthor')
        self.assertEqual(self.citations()['draft'][0]['insertedText'], text)

        # 14c - and the signature is not blocked by any of it: the record can always be finished.
        self.call(path=report+'/commit', body=dict(action='save', baseVersion=0, findings=text, conclusion='', recommendation=''), user='xauthor', status=201)
        versions = self.call(method='GET', path=report+'/versions', user='xauthor')
        self.assertNotIn('citations', json.dumps(versions), 'the history surface is not a citation surface')
        signed = self.citations()
        self.assertEqual(len(signed['head']), 1)
        self.assertEqual(signed['head'][0]['insertedBy'], self.stack.actor('xauthor'))
        self.assertEqual(signed['draft'], [])

        # 18 - a reader restricted to the anchor gets the attestation reduced everywhere, and no
        # surface hands them a comparison identifier or a finding id.
        self.access('xreader', [self.uid])
        theirs = self.citations('xreader')
        self.assertEqual(theirs['head'][0]['state'], 'source-unavailable')
        audit = self.call(method='GET', path='/audit?uid='+self.uid, user='xreader')
        surfaces = json.dumps([theirs, versions, audit], ensure_ascii=False) + self.stack.request('GET', '/studies', 'xreader').text
        for secret in (prior.uid, crossed['id'], p['id'], text, 'sourceIndex', 'findingId', 'insertedText'):
            self.assertNotIn(secret, surfaces, secret)
        self.access('xreader')

        # 20 - two readers, one report: the loser keeps the draft and the attestation, the winner's
        # text is in the history, and nothing had to be retyped.
        self.cite(crossed, 0, '두 번째 줄', base=1, revision=hidden['revision'])
        held = self.citations()['draft']
        self.assertEqual(len(held), 1)
        self.call(path=report+'/commit', body=dict(action='approve', baseVersion=1, findings='다른 판독의의 승인본', conclusion='', recommendation=''), user='doctor', status=201)
        self.call(path=report+'/commit', body=dict(action='save', baseVersion=1, findings='두 번째 줄', conclusion='', recommendation=''), user='xauthor', status=409)
        self.assertEqual(self.citations()['draft'], held, 'the refused signer keeps every byte of their attestation')
        self.assertEqual(self.call(method='GET', path=report+'/versions', user='xauthor')[0]['findings'], '다른 판독의의 승인본')

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'FindingAPI.{n}' for n in FindingAPI.__dict__ if n.startswith('test_')], verbosity=2)
