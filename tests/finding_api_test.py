"""TEST-S2-API-01..06 (REQ-S2-RECORD/PROVENANCE/FRESHNESS/BOUNDARY/IDEMPOTENT/PRESERVE).

Real Nest/Prisma, Keycloak and Orthanc with an owned synthetic CT. Direct SQL touches only this
run's study identities for lock, fault and limit setup; every write effect is compared through
the persisted rows. No clinical fixture is used.
"""
from __future__ import annotations
import io, json, re, subprocess, sys, time, unittest, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from pydicom import dcmread
from invariants_live import ROOT, psql
from viewer_api_test import ViewerStack, literal
sys.path.insert(0, str(ROOT/'tests/e2e'))
from viewer_precision_fixture import synthetic_ct

FINDING_TABLES = ('Finding', 'FindingRevision')

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

    def length_item(self, index=0, extent=20.0, label='길이'):
        ds = self.slices[index]; ipp = [float(x) for x in ds.ImagePositionPatient]
        return dict(schemaVersion=1, kind='length', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
                    frameOfReferenceUid=str(ds.FrameOfReferenceUID), label=label,
                    points=[[ipp[0]+10, ipp[1]+10, ipp[2]], [ipp[0]+10+extent, ipp[1]+10, ipp[2]]],
                    viewPlaneNormal=[0, 0, 1], viewUp=[0, 1, 0], baseline=dict(calculator='kin-native-manual-v1', values=[extent]))

    def key_item(self, index=1, title='키 <script>'):
        ds = self.slices[index]
        return dict(schemaVersion=1, kind='key', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, title=title, description='')

    def item(self, item, user='doctor', status=200):
        return self.call(body=dict(requestId=str(uuid.uuid4()), item=item), user=user, path=self.items_path, status=status)

    def revise_item(self, head, action='edit', item=None, reason=None, user='doctor', status=200):
        snapshot = {k: v for k, v in head['item'].items() if k not in ('hidden', 'sourceDigest')} if item is None else item
        command = dict(requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action=action, item=snapshot)
        if reason is not None: command['reason'] = reason
        return self.call(body=command, path=self.items_path+'/'+head['id']+'/revisions', user=user, status=status)

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

    def snapshot(self, tables=FINDING_TABLES+('ViewerItem', 'ViewerRevision', 'ViewerRequest', 'ViewerStorageBudget', 'AuditLog')):
        uid = literal(self.uid)
        where = {'Finding': f'"studyUid"={uid}', 'FindingRevision': f'"findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid})',
                 'ViewerItem': f'"studyUid"={uid}', 'ViewerRevision': f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})',
                 'ViewerRequest': f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})', 'ViewerStorageBudget': f'"studyUid"={uid}',
                 'AuditLog': f'target={uid}'}
        return {t: psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE {where[t]} ORDER BY to_jsonb(t)::text COLLATE "C"') for t in tables}

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

    def study_update(self, changes):
        assert self.uid in self.stack.active
        psql(f'UPDATE "StudyState" SET {changes} WHERE uid={literal(self.uid)}')

    def parent_lock(self, inside=None):
        # Same shape as viewer_api_test.parent_lock; `inside` runs while the parent row is locked.
        assert self.uid in self.stack.active
        process = subprocess.Popen(['docker', 'exec', '-i', 'kin-db', 'psql', '-XqAt', '-U', 'kin', '-d', 'kin', '-v', 'ON_ERROR_STOP=1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        process.stdin.write("BEGIN; SET LOCAL statement_timeout='8s'; "+f'SELECT uid FROM "StudyState" WHERE uid={literal(self.uid)} FOR UPDATE'+"; SELECT 'LOCKED';\n"); process.stdin.flush()
        while process.stdout.readline().strip() != 'LOCKED':
            if process.poll() is not None: raise RuntimeError('Parent lock setup failed')
        return process

    def wait_blocked(self):
        deadline = time.monotonic()+2
        while time.monotonic() < deadline:
            query = "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM \"StudyState\"%' AND pid<>pg_backend_pid()"
            if int(psql(query)[0]) > 0: return
            time.sleep(.03)
        self.fail('API did not observably wait on the parent lock')

    def finish_lock(self, process, sql=''):
        process.stdin.write(sql+' COMMIT;\n'); process.stdin.flush()
        try: process.communicate(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.communicate(); raise
        self.assertEqual(process.returncode, 0, 'Parent lock transaction failed')

    def expected_copy(self, head):
        item = head['item']
        return dict(itemId=head['id'], revision=head['revision'], studyUid=self.uid, kind=item['kind'], seriesUid=item['seriesUid'], sopUid=item['sopUid'],
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
        self.create([foreign], status=404)
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

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'FindingAPI.{n}' for n in FindingAPI.__dict__ if n.startswith('test_')], verbosity=2)
