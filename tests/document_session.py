"""실제 문서의 쿠키 요청을 같은 문서가 확인한 세션에 결속한다."""
from urllib.parse import urljoin, urlsplit


def session_headers(session, headers=None):
    """부트스트랩에서 보존한 식별값만 사용하며 새 /me로 세션을 갈아타지 않는다."""
    if not isinstance(session, str) or not session:
        raise AssertionError("요청을 시작한 문서의 세션 식별값이 필요합니다")
    supplied = dict(headers or {})
    if any(key.lower() in ("x-kin-session", "cookie", "authorization") for key in supplied):
        raise AssertionError("문서의 세션·쿠키·인증을 외부 헤더로 대체할 수 없습니다")
    return {**supplied, "X-KIN-Session": session}


def document_request(page, method, url, **options):
    """라우트 변형 밖 서버 대조용. 쿠키와 결속값을 반드시 같은 Page에서 가져온다.

    오래된 문서의 식별값을 현재 쿠키의 /me로 갱신하지 않는다. 그런 요청은
    서버의 AUTH_SESSION_MISMATCH를 그대로 돌려주어야 한다. CSRF도 자동 추가하지
    않아 호출자의 CSRF 거절 시험을 유지한다.
    """
    target = urljoin(page.url, url)
    origin = urlsplit(page.url)
    destination = urlsplit(target)
    if (origin.scheme, origin.netloc) != (destination.scheme, destination.netloc):
        raise AssertionError("문서와 다른 출처에 세션 결속값을 보내지 않습니다")
    headers = session_headers(page.evaluate("KinWorkContext.session()"), options.pop("headers", None))
    # 리다이렉트로 다른 출처에 결속값이 전달되는 것도 허용하지 않는다.
    if options.get("max_redirects", 0) != 0:
        raise AssertionError("문서 대조 요청은 리다이렉트를 따라가지 않습니다")
    return page.request.fetch(target, method=method, headers=headers, **{**options, "max_redirects": 0})
