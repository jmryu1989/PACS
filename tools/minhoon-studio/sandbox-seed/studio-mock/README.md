# studio-mock — 스튜디오 모의 API의 합성 자료

이 폴더는 민훈 스튜디오에서만 쓴다. 제품 코드가 아니며 제품에 들어가지 않는다. 바꾸기 Claude가 고칠 수 있다.
변경은 화면 코드와 같은 커밋에 들어가므로 되돌리기도 함께 된다.

## dataset.json — 합성 환자·검사
- `patients[]`: `key`, `id`, `name`(영문 대문자), `birth`(YYYY-MM-DD), `sex`.
- `studies[]`: `n`(고유 번호 → 검사 UID `2.25.20261027` + 4자리), `patient`(patients의 key), `daysAgo`(오늘 KST 기준), `modality`, `desc`,
  `image`(영상 표본 키: `A872279/1901-01-13`, `A872279/1901-01-12`, `TCGA-CW-5580/1992-06-01`, `TCGA-CW-5580/1992-02-25`,
  `MSB-04030/1963-12-12`, `MSB-04030/1961-01-30`, `A223238/1901-01-09`, `CMMD/D1-0860`, `CMB-CRC/MSB-06489`), `acc`, `ward`,
  `rs`(W/T/P/A/H), `ss`(Verified/Unverified), `em`(N/E), `institution`, `tele`, `holder`(다른 판독의가 잠금 중), `holdReason`,
  `preDoc`/`preReviewer`(`REVIEWER`는 "지금 스튜디오를 쓰는 사람"), `report`(findings/conclusion/recommendation/author, author `SELF` = 스튜디오 사용자),
  `clinical`(reason/history → Clinical Context의 DICOM Request Tags).
- 같은 환자의 검사는 Related Exam·Prior Reports에 함께 나온다. 같은 환자에게 같은 영상 표본을 두 번 쓰지 않는다.
- 이 파일이 바뀌면 모의 상태(초안·판독 진행)가 이 파일 기준으로 다시 만들어진다.

## routes.json — 새 기능 시안의 가짜 응답
```json
{ "routes": [
  { "method": "GET", "path": "/api/studies/:uid/preload", "status": 200,
    "body": { "uid": ":uid", "state": "Queued", "progress": 0 },
    "note": "Preload 시안: 진행률은 가짜(고정값)" }
] }
```
- 기본 모의 응답보다 먼저 맞춘다(같은 경로면 이것이 이긴다). `:이름`은 경로 값으로 바뀐다.
- 응답은 고정값이다. 저장·상태 변화가 필요한 시안이면 무엇이 가짜인지 답에 분명히 적는다.
- 없는 경로는 501 `STUDIO_NOT_SUPPORTED`로 답한다(빈 200을 주지 않는다).

## 검사
- `node --test studio-mock/check.test.js` 가 두 파일의 형식을 확인한다.
