# coding: utf-8
"""TEST-VIEWER-IDENTITY-FIELDS API v9 roundtrip and atomic validation."""
import copy
import unittest

from reading_appearance_position_live import ReadingAppearancePositionLive


POSITIONS = ('top-left', 'top-right', 'bottom-left', 'bottom-right')


class ReadingAppearanceFieldsLive(ReadingAppearancePositionLive):
    def fields_body(self):
        body = self.position_body()
        body['sizes']['version'] = 9
        body['sizes']['viewer']['version'] = 3
        for role in ('current', 'prior'):
            profile = body['sizes']['viewer'][role]
            profile['fieldPositions'] = dict(name='top-left', date='bottom-left', description='bottom-right')
            override = copy.deepcopy(profile)
            override.pop('overrides', None)
            override['position'] = 'bottom-right'
            profile['overrides'] = {'CT': override}
        return body

    def test_identity_fields_api_01_v8_upgrade_v9_exact_roundtrip_and_old_writer(self):
        old = self.position_body()
        self.assertEqual(self.write(old).status, 200)
        body = self.fields_body()
        body['revision'] = 1
        reply = self.write(body)
        self.assertEqual(reply.status, 200, reply.text)
        self.assertEqual(body['sizes'], reply.body['sizes'])
        old['revision'] = reply.body['revision']
        self.assertEqual(self.write(old).status, 409)
        self.assertEqual(reply.body, self.get())

    def test_identity_fields_api_02_unknown_partial_oversize_and_cross_version_are_atomic(self):
        body = self.fields_body()
        self.assertEqual(self.write(body).status, 200)
        saved = self.get()
        invalid = []
        for mutate in ('unknown-modality', 'partial-position', 'extra-profile', 'wrong-corner'):
            candidate = copy.deepcopy(body)
            profile = candidate['sizes']['viewer']['current']
            if mutate == 'unknown-modality': profile['overrides']['ct'] = profile['overrides'].pop('CT')
            elif mutate == 'partial-position': del profile['overrides']['CT']['fieldPositions']['date']
            elif mutate == 'extra-profile': profile['overrides']['CT']['clinical'] = True
            else: profile['fieldPositions']['name'] = 'center'
            invalid.append(candidate)
        oversized = copy.deepcopy(body)
        for modality in ('MR','CR','DX','US','MG','XA','RF','PT','NM','OT'):
            oversized['sizes']['viewer']['current']['overrides'][modality] = copy.deepcopy(oversized['sizes']['viewer']['current']['overrides']['CT'])
        oversized['sizes']['viewer']['current']['overrides']['ZZ'] = copy.deepcopy(oversized['sizes']['viewer']['current']['overrides']['CT'])
        invalid.append(oversized)
        wrong_shell = copy.deepcopy(body);wrong_shell['sizes']['version'] = 8;invalid.append(wrong_shell)
        wrong_viewer = copy.deepcopy(body);wrong_viewer['sizes']['viewer']['version'] = 2;invalid.append(wrong_viewer)
        for candidate in invalid:
            candidate['revision'] = saved['revision']
            with self.subTest(candidate=candidate['sizes']['viewer']):
                self.assertEqual(self.write(candidate).status, 400)
                self.assertEqual(saved, self.get())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReadingAppearanceFieldsLive(name) for name in loader.getTestCaseNames(ReadingAppearanceFieldsLive)
                              if name.startswith('test_identity_fields_api_') and name in ReadingAppearanceFieldsLive.__dict__)


if __name__ == '__main__':
    names = [name for name in unittest.defaultTestLoader.getTestCaseNames(ReadingAppearanceFieldsLive)
             if name.startswith('test_identity_fields_api_') and name in ReadingAppearanceFieldsLive.__dict__]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ReadingAppearanceFieldsLive(name) for name in names))
    raise SystemExit(0 if result.wasSuccessful() else 1)
