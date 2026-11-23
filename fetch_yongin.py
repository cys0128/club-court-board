#!/usr/bin/env python3
"""용인 공공체육시설 통합예약의 아르피아 테니스장 4면(장애인 코트 포함) 시간대별 상태를 받아 data/yongin.json 저장.

- 공식 사이트가 로그인 없이 화면에서 쓰는 AJAX 1종만 호출한다(다른 경로 추측 호출 없음, 로그인·쿠키·계정 없음):
  POST https://publicsports.yongin.go.kr/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do
  form: dateVal=YYYYMMDD&resveId=<코트 월별 ID>   → JSON(fcltRceptRsvctmTime[] 등)
- 범위: 평일은 오늘부터 14일, 주말·공휴일은 다음 달 말일까지 전부 × 4면. 한 번에 받지 않고 실행(15분)마다 4일씩(=16건) 가장 오래 확인 안 한 날부터 돌아가며 받는다.
- 코트 ID 는 월마다 다르다. 아직 ID 를 모르는 달(예약 미오픈)은 건너뛰고, 공식 시설 목록(비로그인, 수지구·테니스 필터)에서 PROBE_HOURS 마다 ID 를 찾아 생기면 자동 포함한다(요청 3~4건, 그 실행의 날짜 수를 줄여 16건 안에 맞춤).
  주말·공휴일은 오래됨 점수를 2배로 쳐서 조금 더 자주 받는다. 요청 사이 GAP 초, 실행당 상한 MAX_REQ 건.
- 응답에서 시간대(useTm)·상태(rsvctmStts)만 저장한다. 예약자 관련 필드(frstRegisterNmApply 등)는 읽지도 저장하지도 않는다.
- 차단·오류 징후(HTTP 오류·리다이렉트·JSON 아님·필수 키 없음·빈 응답)가 한 번이라도 나오면 즉시 중단하고
  이전 yongin.json 내용을 그대로 두고 fetch_ok=false 만 표시한다. 재시도·우회 없음.
- 주기: 워크플로 cron 은 15분마다. 직전 시도 후 MIN_MIN 분이 안 지났으면 호출하지 않는다(--force 로 무시).
- 백오프: 차단·오류 징후가 한 번이라도 나오면 backoff.active=true 로 저장 → 다음 실행부터 BACKOFF_MIN(30분) 간격.
  물러난 뒤 연속 BACKOFF_CLEAR 회 성공하면 평소 간격으로 복귀.
"""
import json, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "data" / "yongin.json"
URL = "https://publicsports.yongin.go.kr/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do"
OFFICIAL = "https://publicsports.yongin.go.kr/publicsports/sports/selectFcltyRceptResveListU.do"
KST = timezone(timedelta(hours=9))
GAP = 5            # 요청 사이 초
MAX_REQ = 16       # 실행당 상한(차단 한도 약 25~30건보다 낮게)
DAYS_PER_RUN = 4   # 실행당 날짜 수(4일 × 4면 = 16건)
MIN_MIN = 12       # 평소: 15분 cron 사이 지연·겹친 실행 흡수(직전 시도 후 12분 안이면 건너뜀)
BACKOFF_MIN = 28   # 차단 징후 뒤: 30분 간격(15분 cron 한 번 걸러 실행)
BACKOFF_CLEAR = 3  # 물러난 뒤 연속 성공 3회면 평소 간격으로 복귀
DAYS = 14          # 평일은 오늘부터 14일
PROBE_HOURS = 3    # 새 달 코트 ID 탐색 최소 간격
LIST_URL = "https://publicsports.yongin.go.kr/publicsports/sports/selectFcltyRceptResveListU.do"
PROBE_MAX_PAGES = 4

# 코트 → 월별 resveId (공식 사이트 코트 ID는 월마다 다름. ytcc.info/courts.json 을 참고용으로만 읽어 옮김, 2026-11-23)
# 새 달 ID 를 추가하지 않으면 그 달 날짜는 수집하지 않고 data 의 missing_months 에 표시한다.
COURTS = [
    {"key": "c1", "name": "1코트", "ids": {"2026-11": 14883, "2026-12": 15150}},
    {"key": "c2", "name": "2코트", "ids": {"2026-11": 14884, "2026-12": 15151}},
    {"key": "c3", "name": "3코트", "ids": {"2026-11": 14885, "2026-12": 15152}},
    {"key": "cd", "name": "장애인 코트", "ids": {"2026-11": 14886, "2026-12": 15153}},
]
# 공휴일(주말 외). 대체공휴일 포함. 해마다 갱신 필요.
HOLIDAYS = {"2026-12-25", "2027-01-01", "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",
            "2027-03-01", "2027-05-05", "2027-05-13"}



import re
TM_RE = re.compile(r"(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})")


class Abort(Exception):
    pass


def now_kst():
    return datetime.now(KST)


def load_prev():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def is_weekend(d):
    return d.weekday() >= 5 or d.isoformat() in HOLIDAYS


def month_end_next(today):
    y, m = today.year + (today.month == 12), (today.month % 12) + 1      # 다음 달
    ny, nm = y + (m == 12), (m % 12) + 1
    return date(ny, nm, 1) - timedelta(days=1)


def window_days(today):
    end = month_end_next(today)
    out, d = [], today
    while d <= end:
        if (d - today).days < DAYS or is_weekend(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def plan(today, checked, now, ids, max_req):
    """창 안에서 가장 오래 확인 안 한 날부터(주말·공휴일 2배 가중) DAYS_PER_RUN 일 × 코트. ids = {월: {코트키: id}}"""
    window = window_days(today)
    def score(d):
        c = checked.get(d.isoformat())
        age = float("inf") if not c else (now - datetime.fromisoformat(c)).total_seconds() / 3600
        return (age * (2 if is_weekend(d) else 1), -d.toordinal())   # 동점이면 가까운 날 먼저
    missing, usable = set(), []
    for d in window:
        if not ids.get(d.strftime("%Y-%m")):
            missing.add(d.strftime("%Y-%m")); continue
        usable.append(d)
    n_days = max(0, min(DAYS_PER_RUN, max_req // len(COURTS)))
    picked = sorted(sorted(usable, key=score, reverse=True)[:n_days])
    reqs = []
    for d in picked:
        for c in COURTS:
            rid = ids[d.strftime("%Y-%m")].get(c["key"])
            if rid is None:
                continue
            reqs.append((d, c, rid))
    return window, picked, reqs[:max_req], sorted(missing)


COURT_RE = re.compile(r"아르피아\s*테니스장\s*\((.*?)\)\s*_\s*(\d{1,2})월")
KEY_OF = {"1코트": "c1", "2코트": "c2", "3코트": "c3", "장애인코트": "cd"}
ITEM_RE = re.compile(r'reserve_title">\s*(.*?)<div class="reserve_position">.*?이용기간 : (\d{4})-(\d{2})-\d{2}.*?resveId=(\d+)', re.S)


def _get(url, data=None):
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers={"User-Agent": "club-court-board/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status != 200:
                raise Abort(f"목록 HTTP {r.status}")
            body = r.read().decode("utf-8", "replace")
    except Abort:
        raise
    except Exception as e:
        raise Abort(f"목록 {type(e).__name__}: {str(e)[:100]}")
    if "reserve_box_item" not in body:
        raise Abort("목록 형식 이상")
    return body


def discover_ids():
    """공식 시설 목록(비로그인 공개 화면, 수지구·테니스 필터)에서 아르피아 코트의 월별 resveId 를 찾는다. 요청 ≤ PROBE_MAX_PAGES 건."""
    found, n = {}, 0
    q = "key=&pageUnit=8&checkSearchMonthNow=false&searchFcltyGu=BALCGU&searchFcltyFieldNm=ITEM_01"
    for page in range(1, PROBE_MAX_PAGES + 1):
        if n:
            time.sleep(GAP)
        n += 1
        body = _get(LIST_URL + "?key=&searchResveType=", b"searchFcltyGu=BALCGU&searchFcltyFieldNm=ITEM_01") if page == 1             else _get(f"{LIST_URL}?{q}&pageIndex={page}")
        hit = False
        for title, yy, mm, rid in ITEM_RE.findall(body):
            m = COURT_RE.search(title)
            if not m:
                continue
            key = KEY_OF.get(m.group(1).replace(" ", ""))
            if key:
                found.setdefault(f"{yy}-{mm}", {})[key] = int(rid); hit = True
        if page > 1 and not hit:
            break          # 아르피아 목록 구간을 지났음
        if "pageIndex=" + str(page + 1) not in body:
            break
    return found, n


def call(d, rid):
    body = urllib.parse.urlencode({"dateVal": d.strftime("%Y%m%d"), "resveId": rid}).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={
        "User-Agent": "club-court-board/1.0", "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status != 200 or r.geturl() != URL:
                raise Abort(f"HTTP {r.status} / URL {r.geturl()[:80]}")
            if "json" not in (r.headers.get("Content-Type") or ""):
                raise Abort(f"JSON 아님: {r.headers.get('Content-Type')}")
            raw = r.read()
    except Abort:
        raise
    except Exception as e:  # 403/429/타임아웃 등
        raise Abort(f"{type(e).__name__}: {str(e)[:100]}")
    if not raw.strip():
        raise Abort("빈 응답")
    try:
        j = json.loads(raw.decode("utf-8"))
    except Exception:
        raise Abort("JSON 파싱 실패")
    if not isinstance(j, dict) or not isinstance(j.get("fcltRceptRsvctmTime"), list):
        raise Abort("fcltRceptRsvctmTime 없음")
    # 빈자리 판정: 공식 응답의 resveTmList(예약 가능 시간 목록 — ytcc.info 화면도 이 목록을 '빈자리'로 표시)에 든 시간대만 빈자리.
    # 지금까지 관측한 resveTmList 는 항상 빈 배열이라 항목 형식은 미확인 → 못 읽으면 중단해 눈에 띄게 한다(조용히 마감 처리하지 않음).
    avail = set()
    for raw_a in j.get("resveTmList") or []:
        txt = raw_a if isinstance(raw_a, str) else " ".join(str(raw_a.get(k, "")) for k in ("useTm", "timeContent")) if isinstance(raw_a, dict) else ""
        m = TM_RE.search(txt)
        if not m:
            raise Abort("resveTmList 항목 형식 미확인")
        avail.add((m.group(1).zfill(5), m.group(2).zfill(5)))
    slots, seen = [], set()
    for s in j["fcltRceptRsvctmTime"]:      # 시간대·상태만 꺼낸다(예약자 필드는 읽지 않음)
        m = TM_RE.search(str(s.get("useTm", "")))
        if not m:
            raise Abort("useTm 형식 이상")
        key = (m.group(1).zfill(5), m.group(2).zfill(5))
        st = str(s.get("rsvctmStts", ""))
        if not s.get("rsvctmId") and key not in avail:
            continue      # 예약 이력 없는 틀(timeId=0)이면서 가능 목록에도 없음 → 제공 시간대 아님으로 보고 표시 안 함
        if key in seen:
            continue
        seen.add(key)
        slots.append({"s": key[0], "e": key[1], "stts": st, "open": key in avail})
    for key in sorted(avail - seen):        # 가능 목록에만 있는 시간대
        slots.append({"s": key[0], "e": key[1], "stts": "", "open": True})
    slots.sort(key=lambda x: x["s"])
    return slots


def save(obj):
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    force = "--force" in sys.argv
    prev = load_prev()
    t = now_kst()
    bo = dict((prev or {}).get("backoff") or {})
    if prev and prev.get("last_attempt_at") and not force:
        age_min = (t - datetime.fromisoformat(prev["last_attempt_at"])).total_seconds() / 60
        need = BACKOFF_MIN if bo.get("active") else MIN_MIN
        if age_min < need:
            print(f"건너뜀: 직전 시도 {age_min:.0f}분 전(<{need}분{', 백오프 중' if bo.get('active') else ''}). 요청 0건")
            return 0
    checked_prev = dict((prev or {}).get("checked") or {})
    if prev and prev.get("updated_at"):   # 날짜별 시각이 없던 옛 형식 데이터는 전체 갱신 시각으로 대신함
        for dd in (prev.get("days") or {}):
            checked_prev.setdefault(dd, prev["updated_at"])
    ids = {}
    for c in COURTS:                      # 코드에 적어 둔 ID + 이전에 찾아 둔 ID
        for mo, rid in c["ids"].items():
            ids.setdefault(mo, {})[c["key"]] = rid
    for mo, kv in ((prev or {}).get("ids") or {}).items():
        ids.setdefault(mo, {}).update({k: int(v) for k, v in kv.items()})
    probe_at = (prev or {}).get("id_probe_at")
    need_months = {d.strftime("%Y-%m") for d in window_days(t.date())}
    incomplete = [mo for mo in sorted(need_months) if len(ids.get(mo, {})) < len(COURTS)]
    result, stts_seen, n, probed = {}, set(), 0, False
    try:
        if incomplete and (force or not probe_at or (t - datetime.fromisoformat(probe_at)).total_seconds() >= PROBE_HOURS * 3600):
            found, pn = discover_ids()      # 공식 시설 목록에서 새 달 ID 탐색
            n += pn; probed = True
            for mo, kv in found.items():
                ids.setdefault(mo, {}).update(kv)
            print(f"ID 탐색 {pn}건: {{ {', '.join(f'{m}:{len(v)}면' for m, v in sorted(found.items()))} }} (없는 달 {[m for m in incomplete if len(ids.get(m, {})) < len(COURTS)]})")
            time.sleep(GAP)
        window, picked, reqs, missing = plan(t.date(), checked_prev, t, ids, MAX_REQ - n)
        truncated = False
        print(f"계획: 이번 날짜 {[d.isoformat() for d in picked]} → 요청 {len(reqs)}건(상한 {MAX_REQ}, 탐색 {n}건 포함), ID 없는 달 {missing}")
        n0 = n
        for d, c, rid in reqs:
            if n:
                time.sleep(GAP)
            n += 1
            slots = call(d, rid)
            stts_seen.update(s["stts"] for s in slots)
            result.setdefault(d.isoformat(), {})[c["key"]] = slots
            print(f"[{n - n0}/{len(reqs)}] {d} {c['name']} id={rid}: {len(slots)}칸 {sorted({s['stts'] for s in slots})}")
    except Abort as e:
        print(f"중단({n}번째 요청): {e} → 이전 데이터 유지", file=sys.stderr)
        base = prev or {"updated_at": None, "courts": [{"key": c["key"], "name": c["name"]} for c in COURTS], "days": {}}
        base.update({"backoff": {"active": True, "since": bo.get("since") or t.isoformat(timespec="seconds"), "ok_streak": 0},
                     "fetch_ok": False, "last_error": str(e)[:200], "last_attempt_at": t.isoformat(timespec="seconds"),
                     "last_request_count": n})
        save(base)
        return 0   # 배포는 계속(서울 데이터·이전 용인 데이터 유지)
    done = now_kst().isoformat(timespec="seconds")
    keep = {d.isoformat() for d in window}
    days_all = {d: v for d, v in ((prev or {}).get("days") or {}).items() if d in keep}   # 이번에 안 받은 날은 이전 값 유지
    days_all.update(result)
    checked = {d: c for d, c in checked_prev.items() if d in keep}
    checked.update({d: done for d in result})
    if bo.get("active"):
        streak = int(bo.get("ok_streak", 0)) + 1
        bo = {"active": False} if streak >= BACKOFF_CLEAR else {"active": True, "since": bo.get("since"), "ok_streak": streak}
    save({
        "backoff": bo,
        "updated_at": done, "fetch_ok": True, "last_error": "",
        "last_attempt_at": t.isoformat(timespec="seconds"), "last_request_count": n,
        "facility": "아르피아 테니스장", "official_url": OFFICIAL,
        "courts": [{"key": c["key"], "name": c["name"]} for c in COURTS],
        "missing_months": missing, "ids": ids, "id_probe_at": t.isoformat(timespec="seconds") if probed else probe_at,
        "stts_seen": sorted(set((prev or {}).get("stts_seen") or []) | stts_seen),
        "weekend": sorted(d for d in days_all if is_weekend(date.fromisoformat(d))),
        "checked": checked, "days": dict(sorted(days_all.items())),
    })
    print(f"저장: {OUT} (요청 {n}건, 상태값 {sorted(stts_seen)})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:      # 예상 못 한 오류도 서울 배포를 막지 않는다
        print(f"예상 밖 오류: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(0)
