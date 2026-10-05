"""U5S-REQ-08 → U5S-RISK-SESSION → 문서 대조 helper의 세션 불일치 보존."""
import unittest

from test_worklist import WorklistE2E
from document_session import document_request


class DocumentSessionE2E(WorklistE2E):
    def test_binding_stays_with_its_document_when_cookie_is_replaced(self):
        first = self.login('doctor')
        second = self.login('doctor2')
        binding = first.evaluate('KinWorkContext.session()')
        self.assertNotEqual(binding, second.evaluate('KinWorkContext.session()'))
        for page, actor in [(first, 'doctor'), (second, 'doctor2')]:
            answer = document_request(page, 'GET', self.stack.api + '/me')
            self.assertEqual(answer.status, 200)
            self.assertEqual(answer.json()['actor'], self.stack.actor(actor))
        # 배경 목록 갱신이 문서를 먼저 닫지 않게 한다. helper의 APIRequestContext는
        # 이 page route를 지나지 않으므로 실제 서버의 불일치 응답을 관찰한다.
        first.route('**/api/**', lambda route: route.abort())
        replacement = next(c for c in second.context.cookies() if c['name'] == 'kin_sid')
        first.context.add_cookies([replacement])
        answer = document_request(first, 'GET', self.stack.api + '/studies')
        self.assertEqual(answer.status, 409)
        self.assertEqual(answer.json()['code'], 'AUTH_SESSION_MISMATCH')
        self.assertEqual(first.evaluate('KinWorkContext.session()'), binding)
        own = document_request(second, 'GET', self.stack.api + '/studies')
        self.assertEqual(own.status, 200)
        for headers in [{'X-KIN-Session': binding}, {'Cookie': 'kin_sid=foreign'},
                        {'Authorization': 'Bearer foreign'}]:
            with self.assertRaises(AssertionError):
                document_request(first, 'GET', self.stack.api + '/studies', headers=headers)
        with self.assertRaises(AssertionError):
            document_request(first, 'GET', 'https://foreign.invalid/api/studies')


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromNames([
        'test_binding_stays_with_its_document_when_cookie_is_replaced'], DocumentSessionE2E)


if __name__ == '__main__':
    unittest.main(verbosity=2)
