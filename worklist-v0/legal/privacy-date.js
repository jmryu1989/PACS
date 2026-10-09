(function () {
  'use strict';
  // This static page has no server-time API. Use the client clock and an explicit
  // KST instant, independent of the browser's time zone. The HTML explains both
  // periods if scripting is unavailable.
  var effective = Date.parse('2026-11-01T00:00:00+09:00');
  var timer;
  function render() {
    clearTimeout(timer);
    var now = Date.now();
    var amended = now >= effective;
    var values = {
      subject: amended ? '접속한 자(정보주체 제외)' : '개인정보취급자',
      period: amended ? '제8조①② 개정 문언: 2026-11-01부터 적용' : '제8조①② 종전 문언: 2026-10-31까지 적용',
      review: amended
        ? '접속기록은 내부 관리계획에서 정한 주기와 방법에 따라 점검하고, 다운로드 사유 확인 등 필요한 조치를 합니다.'
        : '접속기록은 월 1회 이상 점검하고, 다운로드가 발견되면 내부 관리계획에서 정한 바에 따라 그 사유를 확인합니다.'
    };
    Object.keys(values).forEach(function (key) {
      document.querySelectorAll('[data-access-record="' + key + '"]').forEach(function (node) {
        node.textContent = values[key];
      });
    });
    // Also update a page left open over the legal boundary, including a restored tab.
    if (now < effective) timer = setTimeout(render, Math.min(effective - now, 86400000));
  }
  window.addEventListener('pageshow', render);
  document.addEventListener('visibilitychange', render);
  render();
}());
