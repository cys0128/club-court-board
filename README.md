# club-court-board — 서울 공공 테니스장 접수 현황판 (1단계)

서울시 공공서비스예약의 테니스장 **목록**(서비스명·구·이용기간·접수기간·접수상태)을 모아 한 장짜리 웹페이지로 보여 준다.
날짜·시간대별 빈자리는 범위 밖이다(서울시가 직접 호출 차단을 걸어 둔 영역이라 건드리지 않음). 배경: `D:\AI\docs\ideas\club-vacancy-check.md`.

## 구성
- `fetch_courts.py` — 열린데이터광장 OpenAPI 에서 테니스장만 받아 `data/courts.json` 저장 (표준 라이브러리만, 한 번 실행 = 한 번 갱신)
- `index.html` — `data/courts.json` 을 읽어 카드로 표시. 필터: 구, 접수중만. 접수 시작이 미래면 "오픈 예정"으로 맨 위
- `data/fixture.json` — 화면 확인용 가짜 데이터(오픈 예정·마감 섞음). `index.html?data=data/fixture.json` 으로 연다
- `screens/` — 검증 캡처

## API 명세 (원문 https://data.seoul.go.kr/dataList/OA-2266/S/1/datasetView.do 및 실제 호출로 확인, 2026-11-23)
- 서비스명 `ListPublicReservationSport`, 요청 URL `http://openapi.seoul.go.kr:8088/{KEY}/json/ListPublicReservationSport/{시작}/{끝}/`
- **HTTP 전용**(HTTPS 는 빈 응답). 한 요청 최대 1,000건 → 스크립트는 1,000건씩 페이징(요청 사이 5초). 전체 약 650건이라 현재는 1회로 끝남
- 샘플키 `sample` 은 한 번에 최대 5건(6건 이상 요청 시 ERROR-335) — 동작 확인용
- 호출 한도: 명세 페이지에서 일 호출 한도 수치는 **확인하지 못함**. 1시간 1회(하루 24회 × 1요청)면 부담 없는 수준
- 이용허락범위 제한 없음, 갱신 주기 비정기(자료 변경 시)

### 쓰는 필드 / 안 쓰는 필드
- 쓴 것: `SVCID, SVCNM, SVCSTATNM, MINCLASSNM(테니스장 필터), AREANM(구), PLACENM, PAYATNM, USETGTINFO, SVCOPNBGNDT/SVCOPNENDDT(이용기간), RCPTBGNDT/RCPTENDDT(접수기간), SVCURL(예약 상세 링크), TELNO, V_MIN/V_MAX(운영시간), REVSTDDAYNM/REVSTDDAY, X/Y`(JSON 저장까지. 화면에는 앞의 것만 표시)
- 평일/주말: 전용 필드가 없어 **서비스명의 "(평일)"·"(주말)" 글자로 추정**
- 선착순: 전용 필드가 없어 안내문 `DTLCONT` 에 "선착순"이 들어 있는지로 추정(`METHOD`). 본문은 저장하지 않음. 샘플 4건에서는 해당 없음이라 실제 키로 확인 필요
- 못 쓴 것: `GUBUN, MAXCLASSNM, IMGURL, DTLCONT 본문, REVSTDDAYNM 등`(화면 불필요). 시간대 슬롯 데이터는 API 에 없음
- 접수 상태는 API 의 `SVCSTATNM` 에 접수기간 날짜 비교를 더해 화면에서 판정(미래=오픈 예정, 지남=마감)

## 인증키
1. https://data.seoul.go.kr 가입·로그인 → 상단 "OPEN API" → "인증키 신청" (일반 인증키, 사용 URL 은 localhost 등 아무거나) → 즉시 발급
2. 키를 `~/.secrets/seoul-openapi.env` 한 줄로 저장 (파일·커밋에 하드코딩 금지):
   ```
   SEOUL_API_KEY=발급받은키
   ```
   (또는 환경변수 `SEOUL_API_KEY`). 키가 없으면 `sample` 로 동작하고 화면에 샘플 안내가 뜬다.

## 공개 URL (GitHub Pages)
https://yschoi128.github.io/club-court-board/

- GitHub Actions(`.github/workflows/pages.yml`)가 매시 정각(UTC cron `0 * * * *`)과 수동 실행(workflow_dispatch)·master 푸시 때 `fetch_courts.py` 를 돌려 `data/courts.json` 을 만들고 Pages 로 배포한다. courts.json 은 배포 산출물로만 들어가며 저장소에 커밋하지 않는다.
- 키 넣는 방법: `gh secret set SEOUL_API_KEY -R yschoi128/club-court-board` (프롬프트에 키 붙여넣기). 없으면 sample 로 동작한다.
- 수동 실행: `gh workflow run pages.yml -R yschoi128/club-court-board`

## 실행
```
python fetch_courts.py                 # data/courts.json 갱신
python -m http.server 18911            # 후 http://127.0.0.1:18911/index.html (fetch 때문에 file:// 불가)
```

## 주기 갱신 (등록하지 않음, 방법만)
1시간마다 `python D:\AI\club-court-board\fetch_courts.py` 를 실행하면 된다. Windows 작업 스케줄러 예:
`schtasks /Create /SC HOURLY /TN court-board /TR "python D:\AI\club-court-board\fetch_courts.py"`

## 하지 않는 것
상세 HTML 스크래핑, 시간대 슬롯 AJAX 호출, 차단 우회, 로그인·예약 자동화. 목록 API 만 쓴다.

## 알림
알림은 만들지 않았다. `courts.json` 의 이전·현재 변화 비교(접수중 전환·신규 등록)로 나중에 붙일 수 있다.
