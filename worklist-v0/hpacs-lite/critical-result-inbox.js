/*
 * S7-U2a 중요 결과(CVR) 수신 화면 — 계약 S7-U1p §16.2·§16.3(이름·문구·범위), §3.3(수신자 투영), §6.1 route #3·#4·#6,
 * §6.2(목록·cursor·pending), §5.3(ACK의 뜻), §8·§8.1(쓰기 답의 판별), §17(한계 문장).
 * REQ-S7-U2a-RECIPIENT-LIST / REQ-S7-U2a-EXPLICIT-ACK / REQ-S7-U2a-WORDING → RISK-S7-U2a-FALSE-ACK-UI / -STALE / -BADGE-LEAK /
 * -BODY-SUBSTITUTE / RISK-S7-U1p-FALSE-ACK / RISK-S7-U1p-FALSE-UNDELIVERED → TEST-S7-U2a-DOM (tests/critical_result_recipient_dom_test.py).
 *
 * 임상의 홈의 Critical Results 영역(clinician.html)과 판독 화면의 수신 패널(main.html)이 같은 규칙으로 쓴다.
 * - 목록은 서버 GET critical-results?view=received의 답만 그린다. 배지는 응답의 pending이고 행 수로 세지 않는다. stub 행에는
 *   메시지·판 번호·본문이 없고, 그 칸을 다른 route(판독문·미리보기·한 건 읽기)로 채우지 않는다.
 * - ACK는 사람이 한 기록의 Acknowledge를 누른 것 하나뿐이다. 열기·목록 읽기·주기 읽기·시간 경과는 어떤 기록도 바꾸지 않는다.
 *   Acknowledged {time}은 이 요청의 201 봉투, 또는 서버가 읽어 준 acknowledged 상태의 서버 시각으로만 보인다.
 * - 이 요청이 적용됐는지 모르는 답(409 STUDY_ACCESS_CHANGED, code 없는 503, CRITICAL_RESULT_BUSY, 5xx, 답 없음)은 결과를 모르는
 *   시도로 목록과 따로 두고, 같은 requestId·body의 Check Again이나 그 기록의 다시 읽기로만 끝낸다(§8.1 규칙 2~4). 목록에서
 *   사라지거나 stub이 된 것은 적용 여부의 증거가 아니다.
 * - 화면 값의 출처(Astra S7-U2a-PROJ-R-001 F01). 기록마다 세 가지만 둔다.
 *   P = 지금 유효한 수신자 투영 하나(목록 #3 쪽의 행 또는 한 건 읽기 #4의 item) 또는 없음. 기록마다 자리가 하나이고, 그 자리를
 *       정한 요청의 번호를 함께 둔다. 옛 목록 행과 새 읽기를 따로 두면 새 것을 내리는 사건(Refresh 등)이 옛 것으로 돌아가는 길이
 *       된다 — 그래서 옛 모양이 뒤에 남는 곳이 없다.
 *   U = 결과를 기다리거나 모르는 ACK 시도. E = 이 페이지 ACK의 결과(적용됨과 서버 시각, 또는 끝난 줄: 확정 거절·다시 읽어 확인한
 *       종결 상태). U·E는 읽기 권한도 투영도 아니다: 메시지·본문·Source·view·취소 사유를 싣지 않고, 줄과 최소 결과 줄에 쓸 기록
 *       이름 칸(발신자·보낸 시각·검사 신원)만 따로 뽑아 둔다.
 *   행과 줄은 기록마다 한 번 계산한 derive(id)를 함께 쓴다. 상태명·메시지·본문·Source·판·취소 사유·Acknowledge는 P에서만 오고
 *   (취소 사유는 P가 full이고 cancelled일 때만, 행과 줄 모두), E는 수신 확인됨과 서버 시각만 더한다. P가 없고 적용 결과만 있으면
 *   기록 이름과 Acknowledged {time}의 최소 줄이다 — ACK 성공은 지금 본문을 읽어도 된다는 증거가 아니다.
 * - 최신 유효. 요청을 보내는 순간 요청 번호·세션 번호·계정·투영 번호를 고정한다(#3은 필터·cursor 체인·덮는 범위, #4는 기록 id와
 *   아는 검사 UID). 답은 세션·계정·봉투·DTO·대상을 확인한 뒤에만 후보가 되고, 같은 기록의 후보는 요청 번호가 큰 것이 이긴다 —
 *   도착 순서로 정하면 늦게 온 옛 답이 그 뒤에 보낸 요청이 반영한 stub·행 제거·ACK 불가·종결을 되돌린다(전달 revision은 투영의
 *   판이 아니다: 판독 머리가 바뀌어 full이 stub이 되어도 revision은 그대로다). #3과 #4는 같은 규칙으로 서로 견준다. 목록 쪽에
 *   기록이 있으면 그 행이 후보이고, 없는 것은 그 쪽이 기록의 순서 키를 덮고(첫 쪽은 맨 앞부터, More는 앞 쪽의 마지막 행 뒤부터,
 *   다음 쪽이 있으면 이 쪽의 마지막 행까지) 필터가 그 투영의 상태를 담을 때만 투영을 없애는 증거다. 그 기록의 #4 403·404도
 *   그런 증거다. Refresh·필터 바꿈·목록 읽기 실패는 투영 경계다: 모든 P와 목록 소속을 내리고 그 전에 보낸 읽기의 답을 막는다.
 *   더 새 요청이 나가 있다는 것만으로는 마지막 유효 P를 바꾸지 않는다. 계정이 바뀌면(A→B→A 포함) 세션 번호가 올라 그 전의 답은
 *   계정이 같아 보여도 쓰지 않는다.
 * - 최소 증거(PROJ-R-001 F02). U는 귀속(세션 번호·계정·기록 id·검사 UID·route), 원래 requestId·revision·보낸 body 바이트, 요청
 *   번호, sending·checking·unknown 분류와 이 요청의 안내(서버 message·code, "지금 다시 보내면 거절되는 이유")만 둔다. E는 이 요청의
 *   201(applied·replayed)이 준 서버 시각, 또는 끝난 줄의 판정·이 요청의 안내와 서버 상태라는 사실(Cancelled·Superseded, 대체
 *   기록 id)만 둔다. 둘 다 기록 이름 칸 밖의 내용을 싣지 않고 문서 메모리에만 있다. 이 요청 뒤의 새 투영에 진 #4 답(current 아님)은
 *   같은 세션·계정·기록·검사이고 그 기록의 지금 시도에 대한 것일 때 흡수 종결 상태(acknowledged·cancelled·superseded)라는 사실로만
 *   그 시도를 끝낸다 — 본문·사유·Source·view는 옮기지 않는다.
 * - 사건별 무효화(PROJ-R-001 F02 표). 모든 전이는 그 사건의 첫 paint 전에 끝난다.
 *   주기·More 읽기 시작: 마지막 유효 P 그대로(시작만으로 상태·권한을 짐작하지 않는다).
 *   새 유효 #3: 첫 쪽은 목록 소속을 다시 세우고 More는 체인에 잇는다. 기록마다 번호를 견주어 P 전체를 바꾸거나, 덮는 쪽에 없으면
 *     없앤다. U는 목록에 없거나 stub이라는 것만으로 끝나지 않고, 결과를 모르는 시도마다 #4를 한 번 읽는다. E는 그대로다.
 *   같은 기록의 새 유효 #4: 그 기록의 P만 통째로 바꾸고 목록 밖이면 이 보기에서 연다. created·stub이면 U 그대로, 종결이면 §8.1대로 끝낸다.
 *   그 기록의 새 유효 #4 403·404: 목록 행까지 그 기록의 P를 없앤다(번호는 남긴다). U·E 그대로.
 *   #4의 5xx·연결 실패·제한 시간·틀린 봉투나 id: 투영도 종결 증거도 아니다. 마지막 유효 P 그대로, 실패 안내는 그 요청(Open
 *     Replacement)의 것만.
 *   지금 #3의 실패(403·404·cursor 거절·틀린 DTO·제한 시간 포함): 투영 경계. U·E 그대로, Load Failed, 배지에 수 없음.
 *   Refresh: 투영 경계 + 끝난 줄·적용 결과(E)를 내린다. U는 같은 요청 그대로이고, 그 늦은 201은 적용 결과(최소 줄)만 만든다.
 *   Show All·필터 바꿈: 투영 경계. U·E 그대로. 투영 경계는 Open Replacement 실패 안내도 내린다.
 *   일치하는 201(첫 적용·재전송): P·view·Source·본문은 그대로, U를 끝내고 E(서버 시각)를 둔다. P가 created면 상태만 더하고
 *     Acknowledge를 뺀다. P가 적용과 맞지 않는 종결이면 어느 쪽도 지어내지 않고 맞지 않는다는 안내만 둔다.
 *   이전 번호·범위·세션의 늦은 답: P·목록 소속·번호·안내를 바꾸지 않는다(위 흡수 종결 사실만 예외).
 *   로그아웃·401·계정 변경·pagehide: 세션 번호를 올리고 P·U·E·안내·나간 요청을 모두 버린다(늦은 답은 어디에도 쓰지 않는다).
 *   시간 경과·초점·스크롤·패널 접기: 아무것도 바꾸지 않는다. 자동 ACK·Check Again은 없고, POST 제한 시간은 불확실이지 미적용이 아니다.
 * - 서버가 바꾼 표시(full→stub, 행 제거, ACK 불가, 종결)는 초점과 무관하게 바로 그린다. 답이 같은 행만 다시 만들지 않아 초점이
 *   남는다. 초점이 있던 행·줄이 바뀌면 그 머리로, 사라지면 같은 기록의 남은 줄·행 머리로, 그것도 없으면 영역 제목으로 옮기고,
 *   다른 기록의 단추로는 옮기지 않는다.
 * - 세션을 끝내는 것은 호스트 페이지다. 이 파일은 로그아웃·이동·저장소 쓰기를 스스로 시작하지 않는다: 401이면 이 영역을 먼저
 *   끝내고 공통 종료 목록(window.kinOn401)을 부른 뒤 호스트가 준 logout을 부르고, 계정 변경은 같은 목록에 'account-changed'로,
 *   그리고 호스트가 준 onAccountChanged로 알린다.
 * 받은 목록·결과를 모르는 시도·requestId는 이 문서의 메모리에만 둔다 — 로그아웃·계정 전환에서 버린다.
 */
(function () {
  'use strict';

  // 요청 하나의 제한 시간. 넘으면 멈추고, 쓰기라면 결과를 모르는 답이다.
  const TIMEOUT_MS = 60000;
  // 영역이 보이는 동안 목록을 다시 읽는 주기(계약 §16.3, OQ-5 권장값). 읽기일 뿐 어떤 기록도 바꾸지 않고 알림도 띄우지 않는다.
  const PERIOD_MS = 60000;
  // 호스트의 세션 판정이 수신 가능으로 바뀌었는지 보는 간격. 판독 화면은 이 영역을 부팅(세션 확인·서버 연결)보다 먼저 만들므로
  // 처음 읽기는 판정이 참이 된 뒤에야 할 수 있다. 판정만 부르고 요청은 하지 않는다.
  const WATCH_MS = 1000;
  // 서버 critical-result-policy.ts와 같은 형식: UUID(변형 8~b), 검사 UID, cursor.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const STUDY = /^\d+(?:\.\d+)+$/;
  const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
  const ACTIONS = { save: 'Save', approve: 'Approve', addendum: 'Addendum', preliminary: 'Preliminary', defer: 'Defer' };
  const STATES = { created: 'Pending ACK', acknowledged: 'Acknowledged', cancelled: 'Cancelled', superseded: 'Superseded' };
  const FIELDS = [['findings', 'Findings'], ['conclusion', 'Conclusion'], ['recommendation', 'Recommendation']];
  // 확정 거절로 읽는 409(§8.1 표 넷째 열). STUDY_ACCESS_CHANGED와 모르는 code는 커밋 뒤에도 날 수 있어 여기 없다.
  const REFUSED_409 = new Set(['OWNER_CHANGED', 'REQUEST_ID_REUSED', 'CRITICAL_RESULT_CHANGED', 'CRITICAL_RESULT_ACKNOWLEDGED',
    'CRITICAL_RESULT_CANCELLED', 'CRITICAL_RESULT_SUPERSEDED', 'CRITICAL_RESULT_PENDING_EXISTS', 'CRITICAL_RESULT_SOURCE_MOVED',
    'CRITICAL_RESULT_SOURCE_INVALID', 'CRITICAL_RESULT_SOURCE_CHANGED', 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ']);
  // §4 순서 12~15의 409. 결과를 모르는 시도의 재전송이 받으면 "지금 다시 보내면 거절되는 이유"일 뿐이다 — 잠금 앞에서 늦어진
  // 원래 요청은 그 뒤에 적용될 수 있다(§8.1 규칙 4, SV14). 끝내는 것은 기록 다시 읽기의 종결 상태뿐이다.
  const LATER_409 = new Set(['CRITICAL_RESULT_ACKNOWLEDGED', 'CRITICAL_RESULT_CANCELLED', 'CRITICAL_RESULT_SUPERSEDED',
    'CRITICAL_RESULT_PENDING_EXISTS', 'CRITICAL_RESULT_CHANGED', 'CRITICAL_RESULT_SOURCE_MOVED', 'CRITICAL_RESULT_SOURCE_INVALID',
    'CRITICAL_RESULT_SOURCE_CHANGED', 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ']);

  const TEXT = {
    // 영역 설명: 이 영역이 하는 일과 계약 §17의 L-1·L-2·L-3·L-8(괄호 안 내부 ID만 뺀 문장).
    help: [
      '나에게 온 중요 결과(CVR)입니다. Acknowledge를 누를 때만 서버에 확인이 기록되고, 목록을 열거나 읽거나 시간이 지나는 것은 확인이 아닙니다.',
      '발신자는 수신자가 \'아직 열지 않음\'과 \'열었지만 확인하지 않음\'을 구분할 수 없다. 둘 다 Pending ACK로 보인다.',
      '수신자는 KIN 화면을 열고 있을 때만 알 수 있다(열기·Refresh·열려 있는 동안 주기 갱신). 메일·문자·푸시·전화로 가지 않고, '
        + '미확인이어도 자동으로 다시 알리거나 윗선에 올리지 않는다. 미확인이 이어지면 발신자가 보낸 목록에서 보고 다른 수단으로 직접 연락해야 한다.',
      '서명 전(임시저장·예비 판독·보류) 판독에 대한 중요 결과는 임상의에게 보낼 수 없다 — radiologist 수신자에게만 갈 수 있다. '
        + '보낸 뒤 판독이 추가기재·재승인·판독 취소로 바뀌면 임상의 수신자는 기록이 있다는 것(stub)만 보고 확인할 수 없으며, '
        + '발신자가 새 확정 판으로 대체하거나 취소해야 한다. 발신자가 조치하지 않으면 stub이 확인 대기에 남는다.',
      'ACK는 수신자가 KIN에서 "받았다"고 명시한 기록이며 임상 조치의 증명이 아니다.',
      '이 영역이 보이는 동안 목록을 1분마다 다시 읽습니다. 읽기는 어떤 기록도 바꾸지 않습니다.',
    ],
    loading: '받은 중요 결과를 불러오는 중입니다…',
    failed: '받은 중요 결과를 불러오지 못했습니다.',
    emptyPending: '확인 대기 중인 받은 중요 결과가 없습니다. 목록 조회는 성공했습니다.',
    emptyAll: '받은 중요 결과가 없습니다. 목록 조회는 성공했습니다.',
    ready: (n, more) => `받은 중요 결과 ${n}건을 최신순으로 표시합니다.${more ? ' More로 이어서 읽습니다.' : ''}`,
    badge: 'Pending ACK는 아직 수신 확인하지 않은 받은 중요 결과의 수이며 서버가 센 값입니다. 열어보았는지는 기록하지 않습니다.',
    badgeFailed: '받은 중요 결과를 불러오지 못해 확인 대기 수를 모릅니다.',
    locked: '로그인한 계정이 바뀌었습니다. 이 화면에서는 중요 결과를 더 읽거나 확인하지 않습니다. 화면을 다시 불러오세요.',
    malformed: '서버 응답 형식을 확인할 수 없습니다.',
    otherEnvelope: '다른 계정의 응답을 받았습니다.',
    expired: '세션이 만료되었습니다. 다시 로그인하세요.',
    noResponse: '응답이 없어 요청을 멈췄습니다.',
    noServer: '서버에 연결하지 못했습니다.',
    rejected: '서버가 요청을 거절했습니다.',
    unexpected: status => `서버 답(HTTP ${status})이 이 요청의 저장 결과인지 확인할 수 없습니다.`,
    states: {
      created: '아직 수신 확인하지 않은 중요 결과입니다. Acknowledge를 누를 때만 서버에 확인이 기록됩니다.',
      acknowledged: '서버에 수신 확인이 기록된 전달입니다. 임상 조치를 했다는 기록은 아닙니다.',
      cancelled: '발신자가 취소한 전달입니다. 수신 확인할 수 없습니다.',
      superseded: '발신자가 새 판 또는 새 메시지로 대체한 전달입니다. 수신 확인할 수 없습니다.',
    },
    // 계약 §16.2 stub 행과 판독의 패널의 R3/R4 full 행.
    stub: '판독이 바뀌어 발신자의 대체 또는 취소를 기다립니다. 확인할 수 없습니다.',
    moved: version => `판독이 바뀌었습니다 — 보낸 당시의 판(v${version})입니다`,
    cancelReason: reason => `취소 사유: ${reason}`,
    ackTitle: '이 중요 결과를 받았다고 서버에 기록합니다. 누를 때만 기록되며 임상 조치를 했다는 기록은 아닙니다.',
    sending: '수신 확인을 보내는 중입니다… 서버가 저장했다고 답하기 전에는 확인되었다고 표시하지 않습니다.',
    // 계약 §16.2 ACK 적용 여부 불확실.
    unknown: '확인이 저장되었는지 확인하지 못했습니다. Check Again으로 확인하세요.',
    checking: '같은 요청을 다시 보내 확인하는 중입니다…',
    later: reason => `지금 다시 보내면 거절되는 이유: ${reason}`,
    refused: '서버가 이 수신 확인을 거절했습니다.',
    notApplied: '이 수신 확인은 적용되지 않았습니다.',
    newRequest: '다시 누르면 새 요청으로 보냅니다.',
    serverState: state => `서버의 이 기록은 지금 ${STATES[state] || state} 상태입니다.`,
    replacementFailed: '대체 기록을 열 수 없습니다.',
    // 이 페이지 ACK의 201과, 그 뒤 서버가 읽어 준 이 기록의 종결 상태(cancelled·superseded)가 맞지 않을 때. 계약상 없는 조합이라
    // 어느 쪽도 지어내지 않고 다시 읽기를 권한다.
    mismatch: '이 페이지의 수신 확인 결과와 서버가 지금 보여 준 이 기록의 상태가 맞지 않습니다. Refresh로 다시 확인하세요.',
    codes: {
      CRITICAL_RESULT_INPUT_INVALID: '서버가 요청 형식을 거절했습니다.',
      CRITICAL_RESULT_ROLE_REQUIRED: '이 계정에는 지금 수신 확인할 역할이 없습니다.',
      CLINICIAN_ROUTE_DENIED: '이 계정에는 이 요청이 허용되지 않습니다.',
      INSTITUTION_INVALID: '계정의 기관 설정을 확인할 수 없어 서버가 거절했습니다.',
      INSTITUTION_PENDING: '계정이 아직 승인되지 않아 서버가 거절했습니다.',
      CRITICAL_RESULT_NOT_FOUND: '전달 기록을 찾을 수 없습니다. 접근 조건이 바뀌었을 수 있습니다.',
      OWNER_CHANGED: '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요.',
      REQUEST_ID_REUSED: '같은 요청 ID가 다른 내용에 이미 쓰였습니다. 화면을 다시 불러오세요.',
      CRITICAL_RESULT_CHANGED: '그사이 전달 기록이 바뀌었습니다. 목록을 다시 읽었으니 내용을 확인하세요.',
      CRITICAL_RESULT_ACKNOWLEDGED: '이미 수신 확인된 전달입니다.',
      CRITICAL_RESULT_CANCELLED: '이미 취소된 전달입니다.',
      CRITICAL_RESULT_SUPERSEDED: '이미 새 판으로 대체된 전달입니다.',
      CRITICAL_RESULT_SOURCE_CHANGED: '판독이 바뀌어 이 전달은 확인할 수 없습니다.',
      CRITICAL_RESULT_UNAVAILABLE: '서버가 계정 정보를 확인하지 못해 수신 확인을 기록하지 않았습니다.',
    },
    statuses: { 400: '서버가 입력을 거절했습니다.', 403: '서버가 이 요청을 거절했습니다.', 404: '서버가 대상을 찾지 못했습니다.' },
  };

  const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string';
  const at = value => value === null || (text(value) && !Number.isNaN(new Date(value).getTime()));
  const dash = value => text(value) && value.trim() ? value : '—';

  function time(value) {
    const date = text(value) ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '—';
    const two = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  /** 요청마다 새 UUID v4. randomUUID가 없는 브라우저는 같은 형식을 getRandomValues로 만든다. */
  function newRequestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(part => part.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function describe(error) {
    const parts = [];
    if (error && error.status) parts.push(`HTTP ${error.status}`);
    if (error && error.code) parts.push(error.code);
    const message = error && error.message ? error.message : TEXT.rejected;
    return parts.length ? `${message} (${parts.join(' · ')})` : message;
  }
  const reasonOf = error => (error && own(TEXT.codes, error.code) ? TEXT.codes[error.code] : null)
    || (error && own(TEXT.statuses, String(error.status)) ? TEXT.statuses[error.status] : TEXT.rejected);

  /**
   * 첫 요청의 거절이 확정 거절인가(§8.1 표 넷째 열). 400·403·404는 JSON 본문이 있으면 모두 트랜잭션 전·안의 답이다.
   * 409는 이름이 알려진 코드만, 503은 CRITICAL_RESULT_UNAVAILABLE만이다. 그 밖(409 STUDY_ACCESS_CHANGED, code 없는 503,
   * CRITICAL_RESULT_BUSY, 5xx, JSON이 아닌 답, 모르는 code)은 커밋 뒤에도 날 수 있거나 판별할 수 없어 결과를 모르는 답이다.
   */
  function refused(error) {
    if (!error || !error.json) return false;
    if ([400, 403, 404].includes(error.status)) return true;
    if (error.status === 409) return REFUSED_409.has(error.code);
    return error.status === 503 && error.code === 'CRITICAL_RESULT_UNAVAILABLE';
  }

  /** 응답의 owner가 요청을 보낸 계정인가: 'same' | 'other'(다른 계정의 답) | 'malformed'. */
  function ownerOf(value, sent) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(text)) return 'malformed';
    return JSON.stringify(value) === sent ? 'same' : 'other';
  }

  /**
   * 받은 목록·한 건 읽기의 한 행(§3.3 RecipientFull / RecipientStub). 틀린 칸이 하나라도 있으면 null이다. 그리는 칸만 옮겨
   * 담으므로 응답에 다른 칸이 있어도 화면에 닿지 않는다. stub은 view가 stub인 한 메시지·판·본문을 싣지 않는다.
   */
  function recipientItem(item) {
    if (!isObject(item) || !text(item.id) || !UUID.test(item.id) || !text(item.studyUid) || item.studyUid.length > 64
        || !STUDY.test(item.studyUid) || !own(STATES, item.state) || !(item.revision === 1 || item.revision === 2)
        || !text(item.createdAt) || !at(item.createdAt)
        || !(item.replacedBy === null || (text(item.replacedBy) && UUID.test(item.replacedBy)))
        || !['full', 'stub'].includes(item.view) || !isObject(item.sender) || !text(item.sender.name)
        || !isObject(item.study) || !['uid', 'name', 'id', 'birth', 'date'].every(key => text(item.study[key]))
        || !at(item.acknowledgedAt) || !at(item.cancelledAt) || !at(item.supersededAt)) return null;
    const base = { id: item.id.toLowerCase(), studyUid: item.studyUid, state: item.state, revision: item.revision,
      createdAt: item.createdAt, replacedBy: item.replacedBy && item.replacedBy.toLowerCase(), view: item.view,
      sender: { name: item.sender.name }, study: { name: item.study.name, id: item.study.id, birth: item.study.birth, date: item.study.date },
      acknowledgedAt: item.acknowledgedAt, cancelledAt: item.cancelledAt, supersededAt: item.supersededAt };
    const s = item.source;
    if (item.view === 'stub') {
      if (!isObject(s) || s.current !== false || !['head_moved', 'reset'].includes(s.reason)) return null;
      return { ...base, source: { current: false, reason: s.reason } };
    }
    const b = item.body;
    if (!text(item.message) || !isObject(s) || !Number.isSafeInteger(s.version) || s.version < 1 || !text(s.action)
        || !text(s.author) || !at(s.at) || typeof s.current !== 'boolean'
        || (s.current ? s.reason !== null : !['head_moved', 'reset'].includes(s.reason))
        || !isObject(b) || !FIELDS.every(([key]) => text(b[key])) || !(item.cancelReason === null || text(item.cancelReason))) return null;
    return { ...base, message: item.message,
      source: { version: s.version, action: s.action, author: s.author, at: s.at, current: s.current, reason: s.reason },
      body: { findings: b.findings, conclusion: b.conclusion, recommendation: b.recommendation }, cancelReason: item.cancelReason };
  }

  /** 받은 목록 한 쪽(§6.1 #3, §6.2). 확인 대기 필터의 답에 created가 아닌 행이 있으면 그 답 전체가 틀린 모양이다. */
  function readList(data, filter) {
    if (!isObject(data) || data.view !== 'received' || !Array.isArray(data.items) || data.items.length > 50
        || !(data.nextCursor === null || (text(data.nextCursor) && CURSOR.test(data.nextCursor)))
        || !Number.isSafeInteger(data.pending) || data.pending < 0) return null;
    const items = data.items.map(recipientItem);
    if (items.some(item => !item || (filter === 'pending' && item.state !== 'created'))) return null;
    if (new Set(items.map(item => item.id)).size !== items.length) return null;
    return { items, nextCursor: data.nextCursor, pending: data.pending };
  }

  /**
   * ACK 201의 applied가 이 요청의 적용 결과인가(§3.4). 다른 요청·다른 기록·다른 검사·다른 전이의 봉투는 저장 결과로 세지 않는다 —
   * 그 답만으로는 이 요청이 적용되었는지 모른다.
   */
  function appliedMatches(attempt, data) {
    const a = isObject(data) ? data.applied : null;
    return isObject(a) && typeof data.replayed === 'boolean' && a.requestId === attempt.requestId && a.action === 'ack'
      && a.id === attempt.recordId && a.studyUid === attempt.uid && a.from === 'created' && a.to === 'acknowledged'
      && a.revision === 2 && a.replacement === null && text(a.at) && at(a.at);
  }

  /**
   * mount(options): 호스트 페이지가 한 번 부른다. 영역의 요소는 호스트 마크업에 있고 `${prefix}-…` id로 찾는다.
   *   apiBase    API 주소(같은 출처 /api)
   *   root       영역 요소 id (임상의 홈 critical-results, 판독 화면 cvr-inbox-p)
   *   prefix     영역 안 요소 id의 앞부분
   *   fold       참이면 요약 줄(Show Received/Hide Received)과 접히는 본문이 있는 판독 화면 패널이다
   *   logout()   이 영역의 401에서 로그아웃을 시작한다(공통 종료 목록 뒤)
   *   owner()    [institution, sub] — 모든 응답 봉투의 owner와 대조한다
   *   eligible() 지금 이 세션이 받은 목록을 읽는가(호스트가 세션 종류·서버 연결·역할로 정한다)
   *   onAccountChanged(detail) 이 영역이 알아챈 계정 변경을 호스트의 다른 영역에 알린다(선택)
   * 반환값의 end()는 세션 종료, lock(detail)은 다른 영역이 알아챈 계정 변경이다.
   */
  function mount({ apiBase, root, prefix, fold, logout, owner, eligible, onAccountChanged }) {
    const node = id => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`#${id} is missing`);
      return found;
    };
    const region = node(root), title = node(`${prefix}-title`), badge = node(`${prefix}-badge`);
    const refreshButton = node(`${prefix}-refresh`), allButton = node(`${prefix}-all`), help = node(`${prefix}-help`);
    const statusBox = node(`${prefix}-status`), attemptList = node(`${prefix}-attempts`), list = node(`${prefix}-list`);
    const moreButton = node(`${prefix}-more`);
    const toggle = fold ? node(`${prefix}-toggle`) : null, body = fold ? node(`${prefix}-body`) : null;

    const make = (tag, className, content) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (content !== undefined) element.textContent = content;
      return element;
    };
    const button = (label, onClick, title) => {
      const element = make('button', null, label);
      element.type = 'button';
      if (title) element.title = title;
      element.addEventListener('click', onClick);
      return element;
    };
    // 같은 글자를 다시 쓰지 않는다: 주기 읽기마다 상태 줄이 바뀐 것처럼 읽히지 않게.
    const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
    const setTitle = (element, value) => { if (element.title !== value) element.title = value; };
    const statusText = make('p', 'cvr-inbox-status-text'), statusDetail = make('p', 'cvr-inbox-status-detail');
    statusBox.replaceChildren(statusText, statusDetail);
    help.replaceChildren(...TEXT.help.map(line => make('p', null, line)));

    let ended = false, lock = null, channel = null, timer = null, watch = null, reading = false;
    const inflight = new Set();
    // 요청 식별(파일 머리의 최신 유효). gen은 목록·한 건 읽기·ACK를 보낸 순서다. epoch은 세션 번호로, 호스트의 계정이 바뀌거나
    // 영역이 잠기거나 끝나면 오른다. view는 투영 번호로, 투영 경계(Refresh·필터 바꿈·목록 실패)와 세션 끝에서 오른다.
    let gen = 0, epoch = 0, view = 0;
    // P: 기록 id → { gen, item }. 기록마다 자리 하나다. item이 null이면 지금 투영이 없고, gen은 그렇게 정한 증거(목록 제외·#4
    // 403·404)나 마지막 투영의 요청 번호다 — 이보다 먼저 보낸 요청의 답은 이 기록의 투영이 되지 못한다. item이 있는 자리는 늘
    // 목록 소속이거나 이 보기에서 #4로 연 기록이다.
    const projections = new Map();
    // 목록 소속: 지금 필터의 목록 체인(첫 쪽 + More)에 있는 기록 id(서버 순서). opened: 이 보기에서 #4로 읽어 목록 밖에서도 보이는 기록.
    let listIds = [];
    const opened = new Set();
    // 받은 목록(#3 view=received). 기본 필터는 확인 대기(state=pending을 명시한다 — 서버 기본값은 all이다). Show All은 all이다.
    // ready는 지금 목록이 지금 필터의 성공한 답인가다. listEnd는 지금 체인의 마지막 쪽이 덮는 범위의 끝(다음 쪽이 있을 때 그 쪽
    // 마지막 행의 순서 키)이고, More로 읽는 쪽은 그 뒤부터 덮는다.
    let filter = 'pending', listSeq = 0, listPhase = 'idle', listError = '', ready = false, nextCursor = null, listEnd = null;
    let pending = null, lastPending = null, bodyOpen = false;
    // 나가 있는 한 건 읽기의 요청 번호와, 그 가운데 가장 이른 것보다 뒤에 반영한 목록 쪽(번호·필터·범위·id). 투영 자리가 비어 있는
    // 기록의 늦은 읽기 답이 그 뒤에 보낸 목록 쪽에 졌는지 가리는 데만 쓰고, 나간 읽기가 없으면 비운다.
    const reads = new Set();
    let pages = [];
    // U: 기록 id → 이 페이지의 ACK 시도(sending·checking·unknown). 적용되거나 끝나면 여기서 빠지고 E로 간다.
    const attempts = new Map();
    // E: 기록 id → 이 페이지 ACK의 결과. { kind: 'ack', at } 적용됨(서버 시각) 또는 { kind: 'closed', … } 끝난 줄.
    const outcomes = new Map();
    // 줄의 차례(시도를 시작한 순서). 시도가 끝난 줄로 바뀌어도 같은 자리에 둔다.
    let lineSeq = 0;
    // Open Replacement 읽기가 실패한 행·줄의 안내(그 단추가 있던 기록 id → 문구). 그 요청의 안내이고 기록의 내용이 아니다.
    const openNotes = new Map();
    const rowNodes = new Map(), lineNodes = new Map();

    const who = () => {
      const value = owner();
      return Array.isArray(value) && value.length === 2 && value.every(part => text(part) && part.length > 0) ? JSON.stringify(value) : null;
    };
    // 이 영역이 마지막으로 본 계정(owner()의 JSON). 다른 값을 보면 세션 번호가 오른다.
    let seen = null;
    /**
     * 호스트의 계정을 읽고, 바뀌었으면 세션 경계로 다룬다. 처음 계정이 생기는 것(부팅)은 새 세션의 시작일 뿐이다. 계정이 없어지면
     * 이 세션의 것을 모두 버리고, 다른 계정이 되면 버린 뒤 잠근다 — 이 문서에 이전 계정의 목록·시도가 남거나 이전 계정의 요청이
     * 새 계정으로 나가지 않게. 돌아온 같은 계정(A→B→A)의 옛 답은 세션 번호가 달라 쓰지 않는다.
     */
    function observe() {
      const now = who();
      if (now === seen) return now;
      const before = seen;
      seen = now;
      epoch++;
      if (before !== null && !ended && lock === null) {
        if (now === null) { drop(); paint(); }
        else accountChanged('');
      }
      return now;
    }
    const allowed = () => { const now = observe(); return !ended && lock === null && !!eligible() && now !== null; };
    /** 요청을 보내는 순간의 식별: 요청 번호·세션 번호·계정·투영 번호. 답은 이 값으로만 판정한다. */
    const begin = () => { const sent = observe(); return { gen: ++gen, epoch, sent, view }; };
    /** 이 요청의 답을 받아도 되는가: 영역이 살아 있고 같은 세션·같은 계정이다. */
    const alive = ctx => { const now = observe(); return !ended && lock === null && ctx.epoch === epoch && now === ctx.sent; };
    const ownAttempt = attempt => attempts.get(attempt.recordId) === attempt && alive(attempt);
    const slotGen = id => (projections.has(id) ? projections.get(id).gen : 0);

    // 서버 목록 순서(createdAt, id 내림차순)의 키. order(a, b) < 0이면 a가 앞이다.
    const keyOf = item => ({ at: new Date(item.createdAt).getTime(), id: item.id });
    const order = (a, b) => (b.at - a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    /**
     * 목록 한 쪽이 이 투영을 덮는가: 쪽의 범위(첫 쪽은 맨 앞부터, More 쪽은 앞 쪽의 마지막 행 뒤부터; 다음 쪽이 있으면 이 쪽의
     * 마지막 행까지) 안이고 쪽의 필터가 그 투영의 상태를 담는다. 덮는 쪽에 없으면 서버가 뺐거나 상태가 바뀐 것이다. 범위 밖이거나
     * 필터가 담지 않는 상태(확인 대기 보기의 종결 기록)가 없는 것은 아무것도 말하지 않는다.
     */
    function covers(page, item) {
      if (!page.span || (page.filter !== 'all' && item.state !== 'created')) return false;
      const key = keyOf(item);
      return (page.high === null || order(page.high, key) < 0) && (page.low === null || order(key, page.low) <= 0);
    }

    /**
     * 기록 id의 투영 후보(item, 투영을 없애는 증거면 null)를 요청 번호 mark로 낸다. 그 기록에 대해 이 요청보다 뒤에 보낸 요청의
     * 증거가 이미 있으면 아무것도 바꾸지 않는다. 답에서 온 후보가 투영이 되는 곳은 여기 하나다(그 밖에는 투영 경계가 모두 내리고,
     * 새 첫 쪽에 없는 옛 목록 행이 번호만 남기고 모양을 내려놓을 뿐이다).
     */
    function offer(id, mark, item) {
      if (mark <= slotGen(id)) return false;
      projections.set(id, { gen: mark, item });
      return true;
    }

    /**
     * 투영 경계(Refresh·필터 바꿈·목록 실패·세션 끝): 모든 투영과 목록 소속, 앞 보기의 Open Replacement 실패 안내를 내리고, 그 전에
     * 보낸 읽기의 답이 투영이 되지 못하게 한다. cursor 체인·배지 수·ready도 새 답을 기다린다.
     */
    function boundary() {
      view++;
      projections.clear();
      opened.clear();
      openNotes.clear();
      listIds = [];
      pages = [];
      nextCursor = null;
      listEnd = null;
      pending = null;
      ready = false;
    }

    /**
     * 중요 결과 route 요청(제한 시간 60초). 성공 응답은 HTTP 상태와 함께 돌려주고(쓰기는 201만 적용), 실패는 상태·code·JSON 본문
     * 여부를 싣는다. 연결 실패·제한 시간·세션 종료로 멈춘 요청은 status 0이다 — 쓰기라면 서버가 적용했는지 모르는 답이다. 401은
     * 본문을 기다리지 않고 이 영역부터 끝낸 뒤 로그아웃을 시작한다(expire).
     */
    async function call(method, path, raw) {
      const controller = new AbortController(), stop = setTimeout(() => controller.abort(), TIMEOUT_MS);
      inflight.add(controller);
      try {
        const headers = raw === undefined ? { 'X-KIN-CSRF': '1' } : { 'Content-Type': 'application/json', 'X-KIN-CSRF': '1' };
        const response = await fetch(apiBase + path, { method, signal: controller.signal, headers, body: raw });
        if (response.status === 401) {
          expire();
          throw Object.assign(new Error(TEXT.expired), { kin: true, status: 401, code: null, json: false, body: null });
        }
        const data = await response.json().catch(() => undefined);
        if (!response.ok) {
          throw Object.assign(new Error(isObject(data) && text(data.message) ? data.message : `HTTP ${response.status}`),
            { kin: true, status: response.status, code: isObject(data) && text(data.code) ? data.code : null, json: isObject(data),
              body: isObject(data) ? data : null });
        }
        return { status: response.status, data };
      } catch (error) {
        if (error && error.kin) throw error;
        throw Object.assign(new Error(error && error.name === 'AbortError' ? TEXT.noResponse : TEXT.noServer),
          { kin: true, status: 0, code: null, json: false, body: null });
      } finally {
        clearTimeout(stop);
        inflight.delete(controller);
      }
    }

    // ── 받은 목록 ──

    /** 목록 한 쪽을 읽는다. next면 nextCursor를 바꾸지 않고 돌려준 다음 쪽이다. 늦은 답은 번호·투영 경계·필터·세션으로 버린다. */
    function loadList(next) {
      if (!allowed()) return;
      const cursor = next ? nextCursor : null;
      if (next && !cursor) return;
      // 이 쪽의 식별: 요청 번호·세션·계정·투영 번호, 필터, 덮는 범위의 앞 끝(첫 쪽은 맨 앞, More는 앞 쪽의 마지막 행 뒤).
      const ctx = begin(), seq = ++listSeq, chosen = filter, high = next ? listEnd : null;
      const mine = () => seq === listSeq && ctx.view === view && chosen === filter && alive(ctx);
      listPhase = 'loading';
      paint();
      const query = `view=received&state=${chosen}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      call('GET', `/critical-results?${query}`).then(({ data }) => {
        if (!mine()) return;
        const envelope = ownerOf(data && data.owner, ctx.sent);
        if (envelope === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        const read = envelope === 'same' ? readList(data, chosen) : null;
        if (!read) { failList(TEXT.malformed); return; }
        acceptPage(ctx.gen, { filter: chosen, next, high }, read);
        // 판독 화면 패널의 본문은 확인 대기가 처음 생기거나 늘 때 스스로 열린다. 같은 수가 이어지면 사용자가 닫은 본문을 다시 열지
        // 않는다(재알림 없음, §16.3·§17 L-2). 스스로 닫지 않는다.
        if (lastPending === null ? read.pending > 0 : read.pending > lastPending) bodyOpen = true;
        lastPending = pending = read.pending;
        listPhase = 'ready';
        listError = '';
        ready = true;
        paint();
        // 결과를 모르는 시도는 목록 뒤 그 기록의 한 건 읽기로 다시 확인한다(§8.1 규칙 3 b). 읽기일 뿐 다시 보내지 않는다.
        for (const attempt of attempts.values()) if (attempt.state === 'unknown') confirmByRead(attempt);
      }, error => {
        if (!mine()) return;
        failList(describe(error));
      });
    }

    /**
     * 목록 한 쪽의 답을 투영에 반영한다. 쪽의 행은 그 기록의 투영 후보이고, 쪽이 덮는데 없는 기록의 투영은 이 쪽의 번호로 없앤다
     * (그 기록에 대해 더 뒤에 보낸 요청의 증거가 있으면 둘 다 하지 않는다). 첫 쪽은 목록 소속을 새로 세우고 More는 체인 뒤에
     * 잇는다. 새 첫 쪽에 없는 옛 목록 행은 모양을 남기지 않는다(번호만 남아 더 먼저 보낸 읽기에 진다).
     */
    function acceptPage(mark, { filter: chosen, next, high }, read) {
      const ids = new Set(read.items.map(item => item.id)), last = read.items[read.items.length - 1];
      const page = { gen: mark, filter: chosen, ids, high, low: read.nextCursor && last ? keyOf(last) : null,
        span: !(read.nextCursor && !last) };
      for (const item of read.items) offer(item.id, mark, item);
      for (const [id, slot] of [...projections]) {
        if (!ids.has(id) && slot.item && covers(page, slot.item) && offer(id, mark, null)) opened.delete(id);
      }
      if (next) listIds = listIds.concat(read.items.map(item => item.id).filter(id => !listIds.includes(id)));
      else {
        for (const id of listIds) {
          const slot = projections.get(id);
          if (!ids.has(id) && !opened.has(id) && slot && slot.item) projections.set(id, { gen: slot.gen, item: null });
        }
        listIds = read.items.map(item => item.id);
      }
      nextCursor = read.nextCursor;
      listEnd = page.low;
      if ([...reads].some(sent => sent < page.gen)) pages.push(page);
    }

    /**
     * 읽기 실패는 빈 목록이 아니다: 투영 경계로 모든 행을 내리고 실패와 서버의 문구·code를 보이며 배지에 수를 두지 않는다. 실패
     * 안내 아래에 받은 기록의 본문·Acknowledge·취소 사유가 남지 않는다. 남는 것은 이 페이지의 시도 줄과 ACK 결과의 최소 줄뿐이다.
     */
    function failList(detail) {
      boundary();
      listPhase = 'failed';
      listError = detail;
      bodyOpen = true;
      paint();
    }

    /**
     * #4 한 건을 읽는다. 답이 그 기록의 새 투영이면(같은 투영 번호 안이고 그 기록에 대해 이 요청보다 뒤에 보낸 요청의 증거가 없음)
     * 먼저 그 기록의 자리에 둔다: item이면 그 모양으로 열고(목록 밖이어도 이 보기에서 보인다), 403·404면 그 기록의 투영을 없앤다.
     * 돌려주는 값: { item, current } | { error, current } | null(버린 답: 세션 끝·다른 계정). current가 거짓인 item은 화면에 쓰지
     * 않았다. 그래도 그 상태가 acknowledged·cancelled·superseded면 되돌아가지 않는 상태라 그 기록의 ACK 시도를 끝내는 사실로는
     * 쓸 수 있다 — 상태와 서버 시각·대체 id만이고 메시지·본문·사유는 아니다.
     */
    function readRecord(id, knownUid) {
      const ctx = begin();
      reads.add(ctx.gen);
      const later = () => pages.filter(page => page.gen > ctx.gen);
      const done = answer => {
        reads.delete(ctx.gen);
        const first = Math.min(...reads);
        pages = reads.size ? pages.filter(page => page.gen > first) : [];
        return answer;
      };
      return call('GET', `/critical-results/${encodeURIComponent(id)}`).then(({ data }) => {
        if (!alive(ctx)) return done(null);
        const envelope = ownerOf(data && data.owner, ctx.sent);
        if (envelope === 'other') { accountChanged(TEXT.otherEnvelope); return done(null); }
        const item = envelope === 'same' && isObject(data) ? recipientItem(data.item) : null;
        const fresh = ctx.view === view && ctx.gen > slotGen(id);
        // 요청한 기록(과 아는 검사)이 아닌 답은 그 기록에 대해 아무것도 말하지 않는다.
        if (!item || item.id !== id || (knownUid && item.studyUid !== knownUid)) return done({ error: TEXT.malformed, current: fresh });
        const current = fresh && !later().some(page => page.ids.has(id) || covers(page, item)) && offer(id, ctx.gen, item);
        if (current) opened.add(id);
        return done({ item, current });
      }, error => {
        if (!alive(ctx)) return done(null);
        const current = ctx.view === view && ctx.gen > slotGen(id) && !later().some(page => page.ids.has(id));
        // 403·404는 지금 이 기록을 읽을 수 없다는 서버의 답이다: 목록 행까지 그 기록의 투영을 없앤다. 그 밖의 실패(5xx·답 없음·
        // 제한 시간)는 이 기록에 대해 아무것도 말하지 않아 마지막 유효 투영을 그대로 둔다.
        if (current && (error.status === 403 || error.status === 404)) {
          offer(id, ctx.gen, null);
          opened.delete(id);
        }
        return done({ error: describe(error), current });
      });
    }

    // ── 명시적 ACK(§5.3, §8.1) ──

    /** 시도·결과 줄에 쓰는 기록 이름 칸(P에서 한 번 뽑는다). 메시지·본문·Source·view·사유는 넣지 않는다. */
    const labelOf = item => ({ id: item.id, createdAt: item.createdAt, sender: item.sender.name,
      study: { name: item.study.name, id: item.study.id, birth: item.study.birth, date: item.study.date } });

    function acknowledge(id) {
      if (!allowed()) return;
      const slot = projections.get(id), shown = derive(id);
      if (!slot || !slot.item || !shown.row || shown.row.ack !== 'on') return;
      const item = slot.item, sent = who(), requestId = newRequestId();
      // 이 body 바이트를 그대로 보관한다: Check Again은 같은 requestId·revision을 같은 바이트로 같은 route에 다시 보낸다(§8.1 규칙 3 a).
      const raw = JSON.stringify({ requestId, expectedOwner: JSON.parse(sent), revision: item.revision });
      const attempt = { recordId: item.id, uid: item.studyUid, sent, epoch, path: `/critical-results/${encodeURIComponent(item.id)}/ack`,
        requestId, revision: item.revision, raw, label: labelOf(item), line: ++lineSeq, state: 'sending', gen: 0, retried: false,
        detail: '', later: '' };
      outcomes.delete(item.id);
      openNotes.delete(item.id);
      attempts.set(item.id, attempt);
      transmit(attempt, false);
    }

    function transmit(attempt, retry) {
      attempt.state = retry ? 'checking' : 'sending';
      attempt.gen = ++gen;
      paint();
      call('POST', attempt.path, attempt.raw).then(result => settle(attempt, retry, result, null), error => settle(attempt, retry, null, error));
    }

    /**
     * 한 요청의 답. 버린 시도(로그아웃·계정 전환·새 시도)나 이미 끝난 시도의 늦은 답은 쓰지 않는다. 201이고 봉투가 이 요청의 적용
     * 결과일 때만 적용됨이다. 첫 요청의 확정 거절만 거절이고, 그 밖은 결과를 모르는 답이다. 결과를 모르는 시도의 재전송은 201이
     * 아니면 결과를 모르는 채로 두고 기록을 다시 읽는다(규칙 3·4).
     */
    function settle(attempt, retry, result, error) {
      if (!ownAttempt(attempt) || !['sending', 'checking'].includes(attempt.state)) return;
      if (result) {
        const envelope = ownerOf(result.data && result.data.owner, attempt.sent);
        if (envelope === 'other') { accountChanged(TEXT.otherEnvelope); return; }
        if (result.status === 201 && envelope === 'same' && appliedMatches(attempt, result.data)) {
          applied(attempt, result.data.applied.at);
          return;
        }
        unknown(attempt, retry, TEXT.unexpected(result.status), '');
        return;
      }
      if (error.status === 401) return;
      if (error.status === 409 && error.code === 'OWNER_CHANGED') {
        accountChanged(describe(error));
        return;
      }
      if (!retry && refused(error)) {
        refuse(attempt, error);
        return;
      }
      unknown(attempt, retry, describe(error), retry && error.status === 409 && LATER_409.has(error.code) ? reasonOf(error) : '');
    }

    /** 시도를 끝난 줄(E)로 바꾼다. 줄에는 기록 이름 칸과 이 요청의 판정·안내, 서버 상태라는 사실만 남는다. */
    function close(attempt, fields) {
      attempts.delete(attempt.recordId);
      const outcome = { kind: 'closed', gen: attempt.gen, label: attempt.label, line: attempt.line, reason: '', detail: '', server: null,
        replacedBy: null, notApplied: false, ...fields };
      outcomes.set(attempt.recordId, outcome);
      return outcome;
    }

    /**
     * 첫 요청의 확정 거절. 목록을 다시 읽고, 먼저 적용된 취소는 그 기록을 한 번 읽어 서버 상태를 보인다: 그 읽기가 새 투영이면 행도
     * 그 모양이 되고(취소 사유는 그 투영에서만 온다), 이 줄에는 Cancelled라는 사실만 더한다.
     */
    function refuse(attempt, error) {
      const superseded = error.code === 'CRITICAL_RESULT_SUPERSEDED';
      const next = superseded && error.body && text(error.body.replacedBy) && UUID.test(error.body.replacedBy)
        ? error.body.replacedBy.toLowerCase() : null;
      const outcome = close(attempt, { reason: reasonOf(error), detail: describe(error), server: superseded ? 'superseded' : null,
        replacedBy: next });
      paint();
      loadList(false);
      if (error.code === 'CRITICAL_RESULT_CANCELLED') readRecord(attempt.recordId, attempt.uid).then(answer => {
        if (!answer) return;
        if (answer.item && outcomes.get(attempt.recordId) === outcome && answer.item.state === 'cancelled') outcome.server = 'cancelled';
        paint();
      });
    }

    /**
     * 이 시도가 적용되었다(201 봉투·재전송 영수증의 applied.at, 또는 #4 acknowledged의 서버 시각). 투영은 건드리지 않고 결과만
     * 남긴다: 기록 이름 칸과 Acknowledged {at}. 메시지·본문·Source는 여기에 없다.
     */
    function applied(attempt, at) {
      attempts.delete(attempt.recordId);
      outcomes.set(attempt.recordId, { kind: 'ack', at, label: attempt.label, line: attempt.line });
      paint();
      loadList(false);
    }

    function unknown(attempt, retry, detail, later) {
      Object.assign(attempt, { state: 'unknown', detail, later, retried: attempt.retried || retry });
      bodyOpen = true;
      paint();
      if (retry) confirmByRead(attempt);
    }

    /**
     * 규칙 3 (b)·4: 대상 기록을 다시 읽는다. 그 답은 readRecord가 먼저 투영으로 반영하고(stub이면 본문이 바로 빠지고, 종결이면
     * 그 상태가 되어 Acknowledge가 다시 생기지 않는다), 시도의 끝은 따로 판정한다: acknowledged면 적용 증거(그 서버 시각),
     * cancelled·superseded면 이 ACK는 앞으로도 적용될 수 없어 그 서버 상태로 끝난다. 그 판정에는 새 투영에 진 답(current 아님)도
     * 쓴다 — 흡수 상태는 되돌아가지 않는다 — 다만 상태·서버 시각·대체 id만이다. 아직 created이거나 읽지 못하면(404·거절·실패)
     * 결과를 모르는 채로 같은 requestId·body를 보관한다.
     */
    function confirmByRead(attempt) {
      readRecord(attempt.recordId, attempt.uid).then(answer => {
        if (!answer) return;
        const item = answer.item;
        if (item && ownAttempt(attempt) && attempt.state === 'unknown') {
          if (item.state === 'acknowledged') { applied(attempt, item.acknowledgedAt); return; }
          if (item.state === 'cancelled' || item.state === 'superseded') {
            close(attempt, { reason: TEXT.serverState(item.state), server: item.state, notApplied: true,
              replacedBy: item.state === 'superseded' ? item.replacedBy : null });
          }
        }
        paint();
      });
    }

    function check(recordId) {
      const attempt = attempts.get(recordId);
      if (!attempt || !allowed() || attempt.state !== 'unknown' || !ownAttempt(attempt)) return;
      transmit(attempt, true);
    }

    /**
     * Open Replacement: 대체 기록을 한 건 읽어 목록 밖 행으로 연다. 읽기일 뿐 아무것도 보내지 않는다. 그 답이 뒤에 보낸 요청의
     * 증거에 졌으면(current 아님) 행도 실패 안내도 그리지 않는다 — 그 사이 목록이 보인 stub·제거, 같은 기록의 새 읽기, Refresh·
     * 필터 바꿈이 이긴다.
     */
    function openReplacement(from, id) {
      if (!allowed()) return;
      const origin = document.activeElement;
      openNotes.delete(from);
      readRecord(id).then(answer => {
        if (!answer || !answer.current) return;
        if (!answer.item) {
          openNotes.set(from, `${TEXT.replacementFailed}\n${answer.error}`);
          paint();
          return;
        }
        paint();
        const entry = rowNodes.get(answer.item.id);
        const active = document.activeElement;
        if (entry && (active === origin || active === document.body || !region.contains(active))) {
          const head = entry.element.querySelector('[tabindex="-1"]');
          if (head) head.focus();
        }
      });
    }

    // ── 그리기 ──

    const identity = study => `Patient: ${dash(study.name)} · ID ${dash(study.id)} · Birth ${dash(study.birth)} · Study Date ${dash(study.date)}`;
    const sourceText = source => `Source: v${source.version} · ${ACTIONS[source.action] || source.action} · ${source.author} · ${time(source.at)}`;
    const labelText = label => `${dash(label.study.name)} · ${dash(label.study.id)} · Sent ${time(label.createdAt)}`;

    /**
     * Acknowledge: 'on'(누를 수 있음) | 'busy'(보내는 중) | 'off'(없음). P가 full·created·current이고 세션이 살아 있으며 이 기록에
     * 결과를 모르는 시도·적용 결과·종결 사실이 없을 때만 누를 수 있다. 보내는 중에는 그 조건이 그대로일 때만 누를 수 없는 단추를
     * 둔다. 확정 거절 뒤에는 그 POST보다 뒤에 보낸 읽기의 P가 다시 ACK 가능한 모양일 때만 새 요청을 받는다(G-04).
     */
    function ackOf(p, mark, attempt, outcome) {
      if (!p || p.state !== 'created' || p.view !== 'full' || p.source.current !== true || lock !== null || ended) return 'off';
      if (attempt) return attempt.state === 'sending' ? 'busy' : 'off';
      if (!outcome) return 'on';
      return outcome.kind === 'closed' && !outcome.server && mark > outcome.gen ? 'on' : 'off';
    }

    /**
     * 한 기록이 보일 모든 것(파일 머리의 화면 값 출처). 행은 P에서, 적용 결과(E)는 수신 확인됨과 서버 시각만 더하고, P가 없으면
     * 최소 결과 줄이다. 줄은 시도(U)나 끝난 줄(E)이고, 취소 사유는 행과 같은 P에서 같은 조건(full·cancelled)으로만 가져온다.
     * 행과 줄은 이 값 하나를 함께 쓴다.
     */
    function derive(id) {
      const slot = projections.get(id), p = slot ? slot.item : null, mark = slot ? slot.gen : 0;
      const attempt = attempts.get(id) || null, outcome = outcomes.get(id) || null;
      const reason = p && p.view === 'full' && p.state === 'cancelled' && p.cancelReason ? p.cancelReason : null;
      const ack = ackOf(p, mark, attempt, outcome), note = openNotes.get(id) || '';
      const done = outcome && outcome.kind === 'ack' ? outcome : null;
      let row = null, key = null, line = null;
      if (p) { row = projectionRow(p, done, reason, ack, note); key = keyOf(p); }
      else if (done) { row = resultRow(id, done, note); key = keyOf(done.label); }
      if (attempt && attempt.state !== 'sending') line = attemptLine(id, attempt, note);
      else if (outcome && outcome.kind === 'closed') line = closedLine(id, outcome, reason, ack, note);
      return { row, key, line, seq: (attempt || outcome || { line: 0 }).line };
    }

    /**
     * P로 그리는 행. 적용 결과가 있으면 created 투영의 상태만 Acknowledged {at}으로 바꾸고 모양(full·stub)은 그대로 둔다. P가 적용과
     * 맞지 않는 종결(cancelled·superseded)이면 P대로 그리고 맞지 않는다는 안내만 더한다 — ACK 가능한 모양도 수신 확인도 지어내지 않는다.
     */
    function projectionRow(p, done, reason, ack, note) {
      const item = done && p.state === 'created' ? { ...p, state: 'acknowledged', acknowledgedAt: done.at } : p;
      const conflict = !!done && item.state !== 'acknowledged';
      const full = item.view === 'full', changed = item.state === 'created' && !(full && item.source.current);
      const head = item.state === 'acknowledged' ? `Acknowledged ${time(item.acknowledgedAt)}` : changed ? 'Source Changed' : STATES[item.state];
      const notes = [];
      if (full && !item.source.current) notes.push(TEXT.moved(item.source.version));
      else if (!full && item.state === 'created') notes.push(TEXT.stub);
      return {
        key: item.id, state: changed ? 'changed' : item.state, head,
        headTitle: changed ? (full ? TEXT.moved(item.source.version) : TEXT.stub) : TEXT.states[item.state],
        notes, message: full ? item.message : null, meta: [`From ${item.sender.name} · Sent ${time(item.createdAt)}`, identity(item.study)],
        source: full ? sourceText(item.source) : null,
        body: full ? FIELDS.map(([key, name]) => [name, item.body[key]]) : null,
        after: [reason ? TEXT.cancelReason(reason) : '', ack === 'busy' ? TEXT.sending : '', conflict ? TEXT.mismatch : '', note].filter(Boolean),
        ack, replacement: item.state === 'superseded' && item.replacedBy ? item.replacedBy : null,
      };
    }

    /** P가 없는 적용 결과: 기록 이름 칸과 Acknowledged {at}만. */
    function resultRow(id, done, note) {
      const label = done.label;
      return {
        key: id, state: 'acknowledged', head: `Acknowledged ${time(done.at)}`, headTitle: TEXT.states.acknowledged, notes: [],
        message: null, meta: [`From ${label.sender} · Sent ${time(label.createdAt)}`, identity(label.study)], source: null, body: null,
        after: [note].filter(Boolean), ack: 'off', replacement: null,
      };
    }

    /** 결과를 모르는 시도(checking·unknown)의 줄: P의 유무·모양과 무관하게 같은 요청이 끝날 때까지 남는다. */
    function attemptLine(id, attempt, note) {
      return {
        key: id, state: attempt.state, word: 'Acknowledgement status unknown', label: labelText(attempt.label),
        text: attempt.state === 'checking' ? TEXT.checking : TEXT.unknown,
        detail: [attempt.later ? TEXT.later(attempt.later) : '', attempt.detail, note].filter(Boolean).join('\n'),
        check: true, checking: attempt.state === 'checking', replacement: null,
      };
    }

    /** 끝난 줄(확정 거절·다시 읽어 확인한 종결 상태). 취소 사유는 행과 같은 P의 조건으로만 온다. */
    function closedLine(id, outcome, reason, ack, note) {
      return {
        key: id, state: 'rejected', word: outcome.server ? STATES[outcome.server] : '', label: labelText(outcome.label),
        text: [outcome.notApplied ? TEXT.notApplied : TEXT.refused, outcome.reason, ack === 'on' ? TEXT.newRequest : ''].filter(Boolean).join(' '),
        detail: [outcome.detail, outcome.server === 'cancelled' && reason ? TEXT.cancelReason(reason) : '', note].filter(Boolean).join('\n'),
        check: false, checking: false,
        replacement: outcome.server === 'superseded' && outcome.replacedBy ? outcome.replacedBy : null,
      };
    }

    function buildRow(model) {
      const row = make('li', 'cvr-inbox-row');
      row.dataset.id = model.key;
      row.dataset.state = model.state;
      // 행 머리: 이 기록의 지금 상태. 초점을 옮길 안전한 자리이고 눌러도 아무 일이 없다.
      const head = make('p', 'cvr-inbox-head');
      head.tabIndex = -1;
      const state = make('span', 'cvr-inbox-state', model.head);
      state.dataset.state = model.state;
      head.title = model.headTitle;
      head.append(state);
      row.append(head);
      for (const note of model.notes) row.append(make('p', 'cvr-inbox-note', note));
      if (model.message !== null) row.append(make('p', 'cvr-inbox-message', model.message));
      for (const line of model.meta) row.append(make('p', 'cvr-inbox-meta', line));
      if (model.source !== null) row.append(make('p', 'cvr-inbox-meta', model.source));
      if (model.body !== null) {
        const box = make('div', 'cvr-inbox-report');
        for (const [name, value] of model.body) box.append(make('p', 'cvr-inbox-field', name), make('p', 'cvr-inbox-value', value));
        row.append(box);
      }
      for (const note of model.after) row.append(make('p', 'cvr-inbox-note', note));
      const actions = make('div', 'cvr-inbox-actions');
      if (model.ack !== 'off') {
        const ack = button('Acknowledge', () => acknowledge(model.key), TEXT.ackTitle);
        ack.disabled = model.ack === 'busy';
        actions.append(ack);
      }
      if (model.replacement) actions.append(button('Open Replacement', () => openReplacement(model.key, model.replacement)));
      if (actions.childElementCount) row.append(actions);
      return row;
    }

    function buildLine(model) {
      const line = make('li', 'cvr-inbox-line');
      line.dataset.record = model.key;
      line.dataset.state = model.state;
      const head = make('p', 'cvr-inbox-head');
      head.tabIndex = -1;
      if (model.word) {
        const word = make('span', 'cvr-inbox-state', model.word);
        word.dataset.state = model.state === 'rejected' ? model.word.toLowerCase() : model.state;
        head.append(word, document.createTextNode(' · '));
      }
      head.append(make('span', 'cvr-inbox-label', model.label));
      line.append(head, make('p', 'cvr-inbox-text', model.text));
      if (model.detail) line.append(make('p', 'cvr-inbox-detail', model.detail));
      const actions = make('div', 'cvr-inbox-actions');
      if (model.check) {
        const again = button('Check Again', () => check(model.key));
        again.disabled = model.checking;
        actions.append(again);
      }
      if (model.replacement) actions.append(button('Open Replacement', () => openReplacement(model.key, model.replacement)));
      if (actions.childElementCount) line.append(actions);
      return line;
    }

    /**
     * 모델이 같은 요소는 그대로 두고, 바뀐 요소는 제자리에서 바꾸고, 없어진 요소는 뺀다. 초점이 있던 요소가 바뀌면 새 요소의
     * 머리로, 없어지면 그 기록 id를 { lost }로 알린다. 남는 요소는 옮기지 않는다(서버 순서라 상대 순서가 그대로다).
     */
    function reconcile(container, nodes, models, build, active) {
      let lost = null, moveTo = null;
      const wanted = new Set(models.map(model => model.key));
      for (const [key, entry] of nodes) {
        if (wanted.has(key)) continue;
        if (entry.element.contains(active)) lost = key;
        entry.element.remove();
        nodes.delete(key);
      }
      const order = [];
      for (const model of models) {
        const sig = JSON.stringify(model);
        let entry = nodes.get(model.key);
        if (!entry || entry.sig !== sig) {
          const element = build(model);
          if (entry) {
            if (entry.element.contains(active)) moveTo = element.querySelector('[tabindex="-1"]');
            entry.element.replaceWith(element);
          }
          entry = { element, sig };
          nodes.set(model.key, entry);
        }
        order.push(entry.element);
      }
      let anchor = null;
      for (const element of order) {
        const expected = anchor ? anchor.nextSibling : container.firstChild;
        if (element !== expected) container.insertBefore(element, expected);
        anchor = element;
      }
      return { lost, moveTo };
    }

    function paint() {
      if (ended) return;
      const show = !!eligible();
      region.hidden = !show;
      if (!show) return;
      region.dataset.state = lock !== null ? 'locked' : listPhase;
      const active = document.activeElement;
      // 배지: 서버 pending. 읽기가 실패하면 수가 없다(0으로 보이지 않는다).
      setText(badge, lock !== null ? 'Locked' : pending !== null ? `Pending ACK ${pending}` : listPhase === 'failed' ? 'Load Failed' : 'Loading');
      badge.dataset.state = lock !== null ? 'locked' : pending !== null ? 'ready' : listPhase;
      setTitle(badge, lock !== null ? TEXT.locked : pending === null && listPhase === 'failed' ? TEXT.badgeFailed : TEXT.badge);
      let line, detail = '';
      if (lock !== null) { line = lock.text; detail = lock.detail; }
      else if (listPhase === 'failed') { line = TEXT.failed; detail = listError; }
      else if (!ready) line = TEXT.loading;
      else if (!listIds.length) line = filter === 'pending' ? TEXT.emptyPending : TEXT.emptyAll;
      else line = TEXT.ready(listIds.length, !!nextCursor);
      statusBox.dataset.state = lock !== null ? 'locked' : listPhase === 'failed' ? 'failed' : !ready ? 'loading' : listIds.length ? 'ready' : 'empty';
      setText(statusText, line);
      setText(statusDetail, detail);
      statusDetail.hidden = !detail;
      allButton.setAttribute('aria-pressed', String(filter === 'all'));
      allButton.disabled = refreshButton.disabled = lock !== null;
      if (fold) {
        setText(toggle, bodyOpen ? 'Hide Received' : 'Show Received');
        toggle.setAttribute('aria-expanded', String(bodyOpen));
        body.hidden = !bodyOpen;
      }
      // 기록마다 한 번 계산한 값을 행과 줄이 함께 쓴다.
      const derived = lock !== null ? [] : [...new Set([...projections.keys(), ...attempts.keys(), ...outcomes.keys()])].map(derive);
      const rowModels = derived.filter(item => item.row).sort((a, b) => order(a.key, b.key)).map(item => item.row);
      const lineModels = derived.filter(item => item.line).sort((a, b) => a.seq - b.seq).map(item => item.line);
      const rows = reconcile(list, rowNodes, rowModels, buildRow, active);
      const lines = reconcile(attemptList, lineNodes, lineModels, buildLine, active);
      attemptList.hidden = lineModels.length === 0;
      const moreGone = !ready || !nextCursor || lock !== null;
      const moreLost = moreGone && !moreButton.hidden && moreButton.contains(active);
      moreButton.hidden = moreGone;
      // 초점이 있던 행·줄이 없어졌으면 같은 기록의 남은 줄·행 머리로, 그것도 없으면 영역 제목으로 간다.
      const headOf = (nodes, key) => (key !== null && nodes.has(key) ? nodes.get(key).element.querySelector('[tabindex="-1"]') : null);
      const target = rows.moveTo || lines.moveTo || headOf(lineNodes, rows.lost) || headOf(rowNodes, lines.lost);
      if (target) target.focus();
      else if (rows.lost !== null || lines.lost !== null || moreLost) title.focus();
    }

    // ── 세션 경계 ──

    function abortAll() {
      for (const controller of inflight) controller.abort();
      inflight.clear();
    }

    /** 이 세션의 것을 모두 버린다: 나간 요청, 투영·목록, 시도, 결과, 안내. 그 뒤 도착하는 이 세션의 답은 어디에도 쓰지 않는다. */
    function drop() {
      abortAll();
      listSeq++;
      epoch++;
      attempts.clear();
      outcomes.clear();
      boundary();
    }

    /** 다른 계정의 봉투·OWNER_CHANGED: 이 영역을 잠그고 결과를 모르는 시도·목록을 버린다(원래 계정의 requestId를 새 계정으로 보내지 않는다). */
    function lockArea(detail) {
      if (ended || lock !== null) return;
      lock = { text: TEXT.locked, detail: detail || '' };
      drop();
      paint();
    }

    /** 이 영역이 알아챈 계정 변경은 이 영역만의 일이 아니다: 공통 종료 목록과 호스트에 알린다. */
    function accountChanged(detail) {
      if (ended || lock !== null) return;
      lockArea(detail);
      (window.kinOn401 || []).forEach(done => { try { done('account-changed', detail); } catch (_) {} });
      if (typeof onAccountChanged === 'function') { try { onAccountChanged(detail); } catch (_) {} }
    }

    /**
     * 세션이 끝났다(로그아웃·다른 탭·401·문서 떠남). 나간 요청을 멈추고 목록·시도를 버리며 늦은 답은 어디에도 그리지 않는다.
     * 방송·storage·pagehide·호스트가 겹쳐 여러 번 불러도 한 번만 끝낸다. 공통 목록이 'account-changed'로 부르면 잠근다.
     */
    function end(reason, detail) {
      if (reason === 'account-changed') { lockArea(detail); return; }
      if (ended) return;
      drop();
      ended = true;
      clearInterval(timer);
      clearInterval(watch);
      list.replaceChildren();
      attemptList.replaceChildren();
      rowNodes.clear();
      lineNodes.clear();
      region.hidden = true;
      if (channel) channel.close();
    }

    /** 이 영역 요청의 401. 로그아웃 POST의 완료·지연과 무관하게 이 영역부터 끝내고, 공통 목록을 부른 뒤 호스트의 logout을 부른다. */
    function expire() {
      if (ended) return;
      end();
      (window.kinOn401 || []).forEach(done => { try { done(); } catch (_) {} });
      try { Promise.resolve(logout()).catch(() => {}); } catch (_) {}
    }

    /** 호스트의 판정이 수신 가능으로 바뀌면 첫 쪽을 읽고, 바뀌지 않으면 아무것도 하지 않는다. */
    function sync() {
      if (ended) return;
      const now = allowed();
      if (now === reading) return;
      reading = now;
      if (now) loadList(false);
      else paint();
    }

    refreshButton.addEventListener('click', () => {
      if (!allowed()) return;
      // Refresh는 투영 경계다: 첫 paint 전에 모든 투영·목록 소속과 끝난 줄·ACK 결과를 내리고, 누르기 전에 보낸 읽기의 답은 늦게
      // 와도 투영이 되지 못한다. 결과를 기다리거나 모르는 시도는 같은 요청 그대로 끝날 때까지 남는다.
      outcomes.clear();
      boundary();
      loadList(false);
    });
    allButton.addEventListener('click', () => {
      if (!allowed()) return;
      // 필터를 바꾸면 새 보기다: 목록과 한 건 읽기의 투영을 내리고 바꾸기 전에 보낸 읽기의 답을 막는다. ACK 결과의 최소 줄과
      // 시도 줄은 Refresh까지 남는다.
      filter = filter === 'pending' ? 'all' : 'pending';
      boundary();
      loadList(false);
    });
    moreButton.addEventListener('click', () => { if (listPhase !== 'loading') loadList(true); });
    if (fold) toggle.addEventListener('click', () => {
      if (ended) return;
      bodyOpen = !bodyOpen;
      paint();
    });
    // 문서가 보이고 영역이 서 있는 동안만 다시 읽는다. 읽기는 어떤 기록도 바꾸지 않고(ACK·재알림이 아니다) 알림도 띄우지 않는다.
    timer = setInterval(() => {
      if (allowed() && !region.hidden && document.visibilityState === 'visible' && listPhase !== 'loading') loadList(false);
    }, PERIOD_MS);
    watch = setInterval(sync, WATCH_MS);
    try {
      channel = new BroadcastChannel('kin-session');
      channel.onmessage = event => { if (event.data && event.data.type === 'session-ended') end(); };
    } catch (_) {}
    window.addEventListener('storage', event => { if (event.key === 'kin-session-ended') end(); });
    window.addEventListener('pagehide', () => end());
    (window.kinOn401 = window.kinOn401 || []).push(end);
    paint();
    sync();
    return { end, lock: detail => lockArea(detail) };
  }

  window.KinCriticalResultInbox = Object.freeze({ mount });
})();
