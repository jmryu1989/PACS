# coding: utf-8
"""TEST-VIEWER-IDENTITY-POSITION API v8 migration and atomic validation."""
import copy
import unittest

from reading_appearance_live import ReadingAppearanceLive


class ReadingAppearancePositionLive(ReadingAppearanceLive):
    def position_body(self, actor='doctor'):
        body = self.mpr_body()
        if actor != 'doctor':
            head = self.get(actor)
            body['expectedOwner'] = head['owner']
            body['revision'] = head['revision']
        body['sizes']['version'] = 8
        body['sizes']['viewer'] = {
            'version': 2,
            'current': dict(size=20, font='mono', color='warm', name=True,
                            date=True, description=False, position='bottom-left'),
            'prior': dict(size=14, font='serif', color='cool', name=False,
                          date=True, description=True, position='top-left'),
        }
        return body

    def test_identity_position_api_01_v7_upgrade_v8_roundtrip_owner_and_old_writer(self):
        old = self.mpr_body()
        self.assertEqual(self.write(old).status, 200)
        new = self.position_body()
        self.assertEqual(new['revision'], 1)
        reply = self.write(new)
        self.assertEqual(reply.status, 200, reply.text)
        self.assertEqual(reply.body['sizes'], new['sizes'])
        saved = self.get()
        self.assertEqual(saved, reply.body)

        old['revision'] = saved['revision']
        self.assertEqual(self.write(old).status, 409)
        self.assertEqual(self.get(), saved)
        self.assertEqual(self.write(new).status, 409)
        self.assertEqual(self.write(new, 'doctor2').status, 409)
        self.assertIsNone(self.get('doctor2')['sizes'])

        other = self.position_body('doctor2')
        other_reply = self.write(other, 'doctor2')
        self.assertEqual(other_reply.status, 200, other_reply.text)
        self.assertEqual(other_reply.body['sizes'], other['sizes'])
        self.assertEqual(self.get(), saved)

    def test_identity_position_api_02_invalid_position_fields_and_versions_are_atomic(self):
        body = self.position_body()
        self.assertEqual(self.write(body).status, 200)
        saved = self.get()
        body['revision'] = saved['revision']
        invalid = []
        for role in ['current', 'prior']:
            for bad in ['', 'center', 'TOP-RIGHT', None, True, 1, [], {}]:
                candidate = copy.deepcopy(body)
                candidate['sizes']['viewer'][role]['position'] = bad
                invalid.append(candidate)
            for mutation in ['missing', 'extra']:
                candidate = copy.deepcopy(body)
                if mutation == 'missing':
                    del candidate['sizes']['viewer'][role]['position']
                else:
                    candidate['sizes']['viewer'][role]['patient'] = 'forbidden'
                invalid.append(candidate)

        viewer_v1 = copy.deepcopy(body)
        viewer_v1['sizes']['viewer']['version'] = 1
        for role in ['current', 'prior']:
            del viewer_v1['sizes']['viewer'][role]['position']
        invalid.append(viewer_v1)
        legacy_shell = copy.deepcopy(body)
        legacy_shell['sizes']['version'] = 7
        invalid.append(legacy_shell)
        wrong_viewer_version = copy.deepcopy(body)
        wrong_viewer_version['sizes']['viewer']['version'] = 3
        invalid.append(wrong_viewer_version)

        for candidate in invalid:
            with self.subTest(viewer=candidate['sizes']['viewer'], version=candidate['sizes']['version']):
                self.assertEqual(self.write(candidate).status, 400)
                self.assertEqual(self.get(), saved)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(
        ReadingAppearancePositionLive(name)
        for name in loader.getTestCaseNames(ReadingAppearancePositionLive)
        if name.startswith('test_identity_position_api_') and name in ReadingAppearancePositionLive.__dict__
    )


if __name__ == '__main__':
    names = [name for name in unittest.defaultTestLoader.getTestCaseNames(ReadingAppearancePositionLive)
             if name.startswith('test_identity_position_api_') and name in ReadingAppearancePositionLive.__dict__]
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.TestSuite(ReadingAppearancePositionLive(name) for name in names))
    raise SystemExit(0 if result.wasSuccessful() else 1)
