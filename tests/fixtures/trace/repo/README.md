# Trace fixture

추적표 생성기의 고정 입력이다. 제품 요구가 아니다.

REQ-FX-ALPHA → RISK-FX-ALPHA-LOSS → TEST-FX-ALPHA: 기본 화살표 줄.
REQ-FX-BETA/GAMMA → RISK-FX-B1 / RISK-FX-B2 (주석) → TEST-FX-BETA
REQ-FX-FILE -> RISK-FX-FILE -> `fx_file_test.cjs`: 시험 id 대신 파일 이름.
REQ-FX-DELTA → RISK-FX-DELTA → **FX-DELTA-NAME**: 시험 id도 파일도 아닌 비정형 줄.

REQ-FX-RUNNER → RISK-FX-RUNNER → TEST-FX-RUNNER: 실행기 표로만 도는 시험.
REQ-FX-IDLE → RISK-FX-IDLE → TEST-FX-IDLE: 어느 workflow도 부르지 않는 실행기 profile의 시험.

REQ-FX-ORPHAN은 아직 시험이 없다.
REQ-FX-SHORT / FX-CASE-LABEL remains open: 축약 표기, 사례 이름으로 id를 만들지 않는다.
