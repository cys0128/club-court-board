# club-court-board — 서울 공공 테니스장 접수 현황판 (1단계)

서울시 공공서비스예약의 테니스장 **목록**(서비스명·구·이용기간·접수기간·접수상태)을 모아 한 장짜리 웹페이지로 보여 준다.
날짜·시간대별 빈자리는 범위 밖이다(서울시가 직접 호출 차단을 걸어 둔 영역이라 건드리지 않음). 배경: `D:\AI\docs\ideas\club-vacancy-check.md`.

## 구성
- `fetch_courts.py` — 열린데이터광장 OpenAPI 에서 테니스장만 받아 `data/courts.json` 저장 (표준 라이브러리만, 한 번 실행 = 한 번 갱신)
- `web/index.html` — `data/courts.json` 을 읽어 카드로 표시. 필터: 구, 접수중만. 접수 시작이 미래면 "오픈 예정"으로 맨 위
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

## 하지 않는 것 (서울)
서울 쪽은 목록 API 만 쓴다: 상세 HTML 스크래핑, 시간대 슬롯 AJAX 호출, 차단 우회, 로그인·예약 자동화 없음.

## 알림
알림은 만들지 않았다. `courts.json` 의 이전·현재 변화 비교(접수중 전환·신규 등록)로 나중에 붙일 수 있다.

## 용인 탭 — 아르피아 테니스장 (4면: 1·2·3코트 + 장애인 코트)
`fetch_yongin.py` → `data/yongin.json`(저장소엔 커밋하지 않고 배포 산출물로만. `data/yongin-fixture.json` 은 화면 확인용 가짜 빈자리). 배경·조사: `D:\AI\docs\ideas\yongin-court-check.md`.

### 공식 요청 형식 (로그인·쿠키 없이 응답, 2026-11-23 확인)
`POST https://publicsports.yongin.go.kr/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do` form `dateVal=YYYYMMDD&resveId=<코트 월별 ID>` → JSON `fcltRceptRsvctmTime[]`(`useDe`, `useTm` "9:00 ~ 11:00", `rsvctmStts`), `resveTmList`, `lmttApp` 등.
- 코트 ID 는 월마다 다름: 11월 14883·14884·14885·14886(장애인) / 12월 15150~15153. 새 달 ID 는 `fetch_yongin.py` 의 `COURTS` 에 추가(ytcc.info/courts.json 을 참고용으로만 읽음). ID 없는 달은 수집하지 않고 `missing_months` 에 표시.
- 예약자 관련 필드(`frstRegisterNmApply` 등)는 읽지도 저장하지도 않는다. 저장은 시간대·상태만.
- 이 경로 외 다른 경로 호출·로그인·쿠키·헤더 위조 없음. User-Agent 는 `club-court-board/1.0`.

### 빈자리 / 마감 판정
- **빈자리** = 응답의 `resveTmList`(예약 가능 시간 목록, 항목 예: `{timeContent:'13:00 ~ 15:00', ...}`)에 든 시간대. ytcc.info 화면도 이 목록을 "빈자리"로 표시한다. 2026-11-23 평일(11.23~26) 응답에서 항목이 든 것을 실제로 확인(14개 코트·날짜 조합에 빈 시간대 있음).
- **마감** = 그 외 전부. `rsvctmStts` 는 실제 응답에서 `RESVECOMPT`(예약완료) 한 가지만 관측(빈 시간대는 이 필드 자체가 없음). 모르는 값·빈 값은 마감으로 취급.
- 예약 이력 없는 틀(`timeId`=0, 상태 없음)이면서 `resveTmList` 에도 없는 칸(장애인 코트의 1시간 단위 틀들)은 표에서 뺀다.
- `resveTmList` 항목 형식을 못 읽으면 수집을 중단하고 "갱신 실패"로 표시한다(조용히 마감 처리하지 않음).

> **2026-11-23 변경: 용인 백그라운드 15분 수집(GitHub Actions)을 중단했다.** 아래 "수집 규칙"은 `fetch_yongin.py` 가 하던 방식(참고·재가동용)이고, 지금은 화면을 열 때 공식 사이트에서 가져온다(맨 아래 "접속할 때 가져오기"). `data/yongin.json` 은 지우지 않고 마지막 저장본(`data/yongin-saved.json` 사본 포함)으로 남기며, 워크플로가 그대로 다시 올린다.

### 수집 규칙 (평일 2주 + 주말·공휴일은 다음 달 말일까지, × 4면)
- 범위: 평일은 오늘부터 14일, 주말·공휴일은 **다음 달 말일까지 전부**(2026-11-23 기준 12-27까지 21일 = 평일 10 + 주말·공휴일 11, 12-25 포함). 한 번에 받으면 차단 한도(약 25~30건)를 넘으므로 나눠 받는다.
- (중단됨) 워크플로 cron 은 **15분마다**였다. 실행당 **4일 × 4면 = 16건**(상한 16), 건 사이 5초(약 1분 20초). 시간당 약 64건.
- 날짜 선택: 가장 오래 확인 안 한 4일부터, 주말·공휴일은 오래됨 점수 2배. 시뮬레이션(21일 기준): **주말·공휴일은 최대 약 45분, 평일은 최대 약 1시간 45분** 간격으로 갱신. 날짜가 늘면(다음 달 말이 멀어지면 최대 약 40일) 주기가 길어진다. 날짜별 확인 시각은 `checked`, 화면 날짜 옆에 "n시간 전 확인".
- **코트 ID 자동 탐색**: ID 를 모르는 달(예약 미오픈)은 건너뛰고 `missing_months` 에 넣어 화면에 "N월 예약 아직 안 열림"을 표시한다. 그런 달이 창 안에 있으면 3시간마다 공식 시설 목록(비로그인 공개 화면, 수지구·테니스 필터: POST 1쪽 + GET 2~3쪽, 제목 `아르피아 테니스장(1코트)_12월` 파싱)에서 ID 를 찾아 `ids` 에 저장 → 생기면 자동 포함. 탐색은 3~4건이며 그 실행의 날짜 수를 줄여 16건 안에 맞춘다. 파서는 11·12월 실제 ID 8개와 일치함을 확인.
- 직전 시도 후 12분 안이면 건너뜀(push·수동 실행 겹침 흡수, 요청 0건).
- **차단·오류 징후**(HTTP 오류·리다이렉트·JSON 아님·필수 키 없음·빈 응답·형식 이상, 목록 탐색 포함) 시 즉시 중단 → 이전 값 유지(워크플로가 배포된 이전 `yongin.json` 을 먼저 내려받음), 화면 "갱신 실패" 표시, `backoff.active=true`.
- **백오프**: 한 번이라도 걸리면 다음 실행부터 30분 간격. 이후 연속 3회 성공하면 평소(15분)로 복귀. 재시도·우회 없음.
- 서울 수집은 건드리지 않는다. 서울은 매시 정각 실행(분<15)·수동·push 때만 돌고, 그 외 실행은 배포된 이전 `courts.json` 을 유지해서 올린다.
- 공휴일은 `HOLIDAYS` 에 직접 관리(해마다 갱신).

## 배포 구조 (2026-11-23 변경)
- **화면+실시간 함수 = Vercel 프로젝트 `club-court-board`** (`web/`): https://club-court-board.vercel.app/ . `web/index.html`(화면), `web/api/arpia.js`(실시간 조회), `web/vercel.json`(리전 hnd1). 배포: `cd web && vercel deploy --prod --yes --name club-court-board`(이 PC 의 개인 Vercel 계정, 시크릿 없음). 화면이 바뀔 때만 배포하면 된다(Hobby 하루 100회 제한).
- **수집 = GitHub Actions**(15분·서울 1시간)가 `data/courts.json`·`data/yongin.json` 을 GitHub Pages 에 올린다. Vercel 화면은 그 JSON 을 `https://yschoi128.github.io/club-court-board/data/...` 에서 읽는다(GitHub Pages 는 CORS `*`). 그래서 수집 때마다 Vercel 을 재배포하지 않는다.
- **GitHub Pages 의 `index.html`** 은 새 주소 안내 배너 + 3초 자동 이동(`https://club-court-board.vercel.app/`). 데이터 보관용으로만 계속 쓴다.
- 화면 시험: `python -m http.server 18911 --directory web` 후 `http://127.0.0.1:18911/?ydata=data/yongin-fixture.json#yongin` (시험용 데이터는 `web/data/`).

## 용인 "지금 확인" — 실시간 조회 함수 (web/api/arpia.js)
수집(15분)과 별개로, 화면에서 사람이 **지금 확인** 버튼을 누를 때만 공식 사이트를 그 날짜 1일치(4면=4건) 조회한다.
- 같은 출처 `GET /api/arpia?date=YYYYMMDD`. 리전 **hnd1**(ytcc 의 icn1 과 IP 분리), Node 24.
- 열린 프록시 방지: `date` 하나만 허용(다른 파라미터 400), 오늘~다음 달 말일만, 아르피아 4면 resveId(공개 `data/yongin.json` 의 `ids` + 시드)만 호출. 다른 resveId·경로 호출 불가.
- 공식 요청 4건은 건 사이 1초. 응답은 시간대·상태만(예약자 필드 제외). 캐시 `s-maxage=60, stale-while-revalidate=60` + 인스턴스 메모리 60초 → 같은 날짜는 1분 안에 공식 재조회 안 함.
- 전역 제한: 인스턴스 기준 분당 공식 요청 12건 초과 시 429. 공식 오류·비정상 응답이면 즉시 실패(재시도 없음) + 60초간 공식 호출 중단(503). 화면은 기존 데이터를 유지하고 안내만 띄운다.
- CORS: 같은 출처 호출이라 불필요(로컬 시험 `127.0.0.1:18911` 만 허용). 화면은 자동 호출하지 않는다.

## 날씨 (Open-Meteo)
- `web/index.html` 이 브라우저에서 `https://api.open-meteo.com/v1/forecast` 를 직접 호출(키 없음·CORS 허용). hourly `temperature_2m,precipitation_probability,weather_code,wind_speed_10m`, daily 요약, `forecast_days=16`, `timezone=Asia/Seoul`, 풍속 m/s. 서버 경유·공식 예약 사이트 호출과 무관.
- 좌표(상수 `PLACES`): 용인=아르피아 근방(죽전동) 37.3238, 127.1118 / 서울=서울시청 근방 37.5665, 126.9780. 격자 예보라 수 km 오차는 무의미.
- 용인 탭: 날짜 제목 옆 아이콘+최고/최저+강수확률, 시간표 칸·"다음 빈자리"에는 그 2시간대의 강수확률 ≥40% 면 우산, 풍속 ≥8m/s 면 바람 표시(16일 밖 날짜는 표시 없음). 서울 탭: 오늘~7일 한 줄 띠.
- 페이지 열 때 1회, 5분 자동 갱신·새로 고침 버튼은 30분 브라우저 캐시(localStorage `wx2:*`) 안이면 재사용, 버튼은 강제 재호출. 실패하면 날씨만 조용히 숨김.
- 출처 표기 "Weather data by Open-Meteo.com"(CC BY 4.0) 를 페이지 하단에 둔다.

## 용인 "접속할 때 가져오기" (2026-11-23)
- 워크플로: cron `0 * * * *`(서울 OpenAPI 1시간 수집만). 용인 단계 없음 — 배포된 `yongin.json`(없으면 `data/yongin-saved.json`)을 마지막 저장본으로 다시 올릴 뿐.
- 화면(`web/index.html`)이 열리면(탭 무관) 아르피아부터 공식 조회를 시작한다. 코트 목록은 `FACILITIES` 우선순위 배열 — 다른 용인 코트가 생기면 뒤에 추가해 ①② 뒤에 같은 방식으로 이어 받는다.
  1. ① 가까운 4날짜(오늘 이후 첫 주말·공휴일 2일 + 오늘·내일, 모자라면 다음 주말로 채움) — 날짜 사이 1.5초.
  2. ② 나머지: 주말·공휴일(다음 달 말까지) → 평일 2주 — 날짜 사이 4초. 탭이 숨겨지면 멈추고 다시 보이면 이어서(`visibilitychange`).
  3. 429·오류면 즉시 멈추고 "잠시 후 새로 고침" 안내. 자동 재시도 없음. 아직 못 받은 날짜는 흐리게 "n시간 전 저장본".
  4. 새로 고침 버튼은 ①부터 다시(서버 10분 캐시 안이면 공식 요청 0). 예약 미오픈 달(404)은 건너뜀.
- 함수 `/api/arpia`: 캐시 `s-maxage=600, stale-while-revalidate=600` + 인스턴스 메모리 10분(같은 날짜는 10분에 1번만 공식 호출), 4면 순차(1초), 오류 시 즉시 실패·60초 쉼, 분당 공식 요청 상한 **20건**(첫 접속 ①의 16건이 들어가도록 12→20).
- 접속 1회당 공식 요청 상한: 아래 보고 참고(한 인스턴스 분당 20건 상한 때문에 ② 는 상한에서 429 로 멈춘다).

## 서울도 "열 때 가져오기" (2026-11-23)
- **GitHub Actions 예약(스케줄) 제거.** 워크플로는 수동 실행·master 푸시 때만 돌며 GitHub Pages(이동 안내 + 마지막 저장본 `data/courts.json`·`data/yongin.json`)를 올릴 뿐, 서울·용인을 받지 않는다(서울 `SEOUL_API_KEY` GitHub secret 도 더는 쓰지 않음).
- `GET /api/seoul`(`web/api/seoul.js`, Vercel): 서울 열린데이터 ListPublicReservationSport(HTTP 전용)에서 테니스장만 받아 `courts.json` 과 같은 형식으로 반환. 캐시 `s-maxage=3600, stale-while-revalidate=3600`(+ 인스턴스 메모리 1시간). 인증키는 Vercel 환경변수 `SEOUL_API_KEY`(production, 시크릿으로 저장 — 코드·로그·응답·커밋에 없음). 키 교체: `cd web && printf '%s' "<키>" | vercel env add SEOUL_API_KEY production --sensitive --yes` 후 재배포.
- 화면: 서울 탭은 `/api/seoul` 을 읽고, 실패하면 GitHub Pages 의 마지막 `courts.json` 을 흐리게(저장본) 표시. 문구 "서울 데이터는 열 때 가져옵니다(최대 1시간 저장)".
- `data/courts.json` 은 이제 저장소에 커밋된 마지막 저장본(2026-11-23 16:20, 318곳)이다.

### ② 범위 조정 (2026-11-23, 사용자 결정)
- ② 는 **주말·공휴일만**(다음 달 말까지), ① 이 끝난 **30초 뒤부터 30초에 한 날짜씩**. 평일은 ② 에서 빼고 날짜별 '지금 확인' 버튼으로만(저장본 흐리게 + 버튼 강조 표시). 진행은 "주말·공휴일 n/m 받는 중".
- 분당 상한 20건(함수) 안에 들도록: ① 16건 → 30초 뒤 첫 ② 날짜 4건(1분 창 안에서 합계 20건) → 이후 30초마다 4건(분당 8건). 탭 숨김 시 멈춤, 429·오류 즉시 중단, 자동 재시도 없음은 그대로.

## 서울 즐겨찾기 (2026-11-23)
- 서울 카드·마감 표 행마다 별 버튼(44px, aria-label·aria-pressed). 저장은 브라우저 `localStorage`(`fav1`, 기기별, 실패해도 동작). 즐겨찾기 키 = `장소명|코트명`(괄호 안 평일/주말·연도 표기 제외 정규화) → 같은 코트의 평일·주말 서비스가 함께 즐겨찾기된다.
- 맨 위 "보기" 칩 [전체|즐겨찾기(n)] — 즐겨찾기가 1개 이상이면 기본 선택. 즐겨찾기한 코트는 목록 맨 위 "즐겨찾기" 구역에 고정(전체 보기에서도). 첫 방문(0개)에는 "자주 가는 코트에 별을 눌러 두면 위에 모아 보여요" 한 줄. 용인 탭은 그대로.

## 빈자리 알림(웹 푸시) + 날짜로 찾기 (2026-11-25)
- **날짜로 찾기**(용인 탭): 오늘~다음 달 말일 달력. 누르면 평일이라도 그 자리에서 `/api/arpia`(기존 '지금 확인'과 같은 요청·서버 상한) 조회 후 그 날짜를 펼침. 빈자리 확인된 날은 점 표시.
- **알림 받기**(탭 맨 위 상자): 날짜(최대 20일, 평일 포함)·시간대(선택)·코트(선택)·서울 즐겨찾기 접수 시작(선택)을 골라 신청. 기기별 Web Push 구독+조건만 저장(이름·전화 없음). 변경 저장·해지·테스트 알림(그 기기에만, 20초에 1번) 버튼. 아이폰은 홈 화면 추가 후(iOS 16.4+) 안내, PC 크롬·엣지·사파리 한 줄 안내. `web/sw.js`(푸시 표시·누르면 `/?d=날짜#yongin`, 버튼 '용인 예약 사이트'), `web/manifest.webmanifest`, 아이콘 png.
- **서버** `web/api/push.js`: Upstash Redis(마켓플레이스 `uo2-pvp` 를 이 프로젝트에도 연결, 키 접두사 `ccb:`). 공개 op: key·state·sub·get·unsub·test. 관리 op(헤더 `Authorization: Bearer PUSH_ADMIN_SECRET`): plan(구독 날짜 합집합·확인 시각·meta), report(결과 저장 → 구독자별 '새로 빈 자리'만 푸시, 같은 자리는 마감됐다 다시 빌 때까지 반복 안 함, 신청 순간 이미 빈 것으로 알려진 칸은 알리지 않음, 만료 구독 자동 삭제). 서울: report 때 1시간에 1번 `/api/seoul` 을 읽어 직전보다 새로 '접수중'이 된 즐겨찾기 코트만 1회 알림(첫 확인은 기준만).
- **확인 작업** `.github/workflows/notify.yml` → `python3 fetch_yongin.py --notify`: cron `*/15 22,23,0-13 * * *`(KST 07:00~22:59, 밤 23~7시 쉼). 구독 날짜만, 가장 오래 확인 안 한 날부터 실행당 4일×4면=16건 상한, 건 사이 5초, 차단 징후 즉시 중단→백오프 30분(연속 3회 성공 시 복귀), 직전 시도 12분 안이면 건너뜀, ID 없는 달은 3시간마다 목록 탐색. 구독 날짜가 없으면 용인 요청 0건. 결과는 코트판에도 반영(`op=state`, 'n분 전 확인').
- 시크릿: Vercel env `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY`·`PUSH_ADMIN_SECRET`·`KV_REST_API_*`(연결로 자동), GitHub secret `PUSH_ADMIN_SECRET`. 로컬 사본 `~/.secrets/club-court-push.env`. 코드·커밋에 없음.
- 수동 실행: `gh workflow run notify.yml -R yschoi128/club-court-board -f force=true`
