"""권한 거절을 인증/세션 계층의 거절로 잘못 통과시키지 않는다."""


def permission_denied(case, response):
    case.assertEqual(response.status, 403)
    headers = {key.lower(): value for key, value in response.headers.items()}
    case.assertNotIn('x-kin-auth-code', headers, 'A session refusal cannot prove study permission denial')
    if 'json' in headers.get('content-type', '') and callable(getattr(response, 'json', None)):
        body = response.json()
    elif hasattr(response, 'body') and not callable(response.body):
        body = response.body
    else:
        body = None
    case.assertFalse(isinstance(body, dict) and str(body.get('code', '')).startswith('AUTH_'),
                     'A coded authentication refusal cannot prove study permission denial')
