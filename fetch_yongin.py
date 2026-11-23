#!/usr/bin/env python3
"""용인 공공체육시설 통합예약의 아르피아 테니스장 4면(장애인 코트 포함) 시간대별 상태를 받아 data/yongin.json 저장.

- 공식 사이트가 로그인 없이 화면에서 쓰는 AJAX 1종만 호출한다(다른 경로 추측 호출 없음, 로그인·쿠키·계정 없음):
  POST https://publicsports.yongin.go.kr/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do
  form: dateVal=YYYYMMDD&resveId=<코트 월별 ID>   → JSON(fcltRceptRsvctmTime[] 등)
- 범위: 오늘부터 14일 중 토·일·공휴일 × 4면. 실행당 상한 MAX_REQ 건, 요청 사이 GAP 초.
- 응답에서 시간대(useTm)·상태(rsvctmStts)만 저장한다. 예약자 관련 필드(frstRegisterNmApply 등)는 읽지도 저장하지도 않는다.
- 차단·오류 징후(HTTP 오류·리다이렉트·JSON 아님·필수 키 없음·빈 응답)가 한 번이라도 나오면 즉시 중단하고
  이전 yongin.json 내용을 그대로 두고 fetch_ok=false 만 표시한다. 재시도·우회 없음.
- 직전 성공 후 MIN_HOURS 시간이 안 지났으면 호출하지 않고 이전 데이터를 유지한다(--force 로 무시).
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
MAX_REQ = 24       # 실행당 상한
MIN_HOURS = 2.75   # 3시간 주기(워크플로는 매시 돌므로 그 사이 실행은 건너뜀)
DAYS = 14

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
            "2027-03-01", "2027-03-02", "2027-05-05", "2027-05-13"}



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


def plan(today):
    days = []
    for i in range(DAYS):
        d = today + timedelta(days=i)
        if d.weekday() >= 5 or d.isoformat() in HOLIDAYS:
            days.append(d)
    reqs, missing = [], set()
    for d in days:
        for c in COURTS:
            rid = c["ids"].get(d.strftime("%Y-%m"))
            if rid is None:
                missing.add(d.strftime("%Y-%m")); continue
            reqs.append((d, c, rid))
    return days, reqs[:MAX_REQ], sorted(missing), len(reqs) > MAX_REQ


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
    if prev and prev.get("updated_at") and not force:
        age = (t - datetime.fromisoformat(prev["updated_at"])).total_seconds() / 3600
        if prev.get("fetch_ok") and age < MIN_HOURS:
            print(f"건너뜀: 직전 갱신 {age:.1f}시간 전(<{MIN_HOURS}h). 요청 0건")
            return 0
    days, reqs, missing, truncated = plan(t.date())
    print(f"계획: 날짜 {len(days)}일 → 요청 {len(reqs)}건(상한 {MAX_REQ}), ID 없는 달 {missing}, 잘림 {truncated}")
    result, stts_seen, n = {}, set(), 0
    try:
        for d, c, rid in reqs:
            if n:
                time.sleep(GAP)
            n += 1
            slots = call(d, rid)
            stts_seen.update(s["stts"] for s in slots)
            result.setdefault(d.isoformat(), {})[c["key"]] = slots
            print(f"[{n}/{len(reqs)}] {d} {c['name']} id={rid}: {len(slots)}칸 {sorted({s['stts'] for s in slots})}")
    except Abort as e:
        print(f"중단({n}번째 요청): {e} → 이전 데이터 유지", file=sys.stderr)
        base = prev or {"updated_at": None, "courts": [{"key": c["key"], "name": c["name"]} for c in COURTS], "days": {}}
        base.update({"fetch_ok": False, "last_error": str(e)[:200], "last_attempt_at": t.isoformat(timespec="seconds"),
                     "last_request_count": n})
        save(base)
        return 0   # 배포는 계속(서울 데이터·이전 용인 데이터 유지)
    save({
        "updated_at": now_kst().isoformat(timespec="seconds"), "fetch_ok": True, "last_error": "",
        "last_attempt_at": t.isoformat(timespec="seconds"), "last_request_count": n,
        "facility": "아르피아 테니스장", "official_url": OFFICIAL,
        "courts": [{"key": c["key"], "name": c["name"]} for c in COURTS],
        "missing_months": missing, "truncated": truncated,
        "stts_seen": sorted(stts_seen), "days": result,
    })
    print(f"저장: {OUT} (요청 {n}건, 상태값 {sorted(stts_seen)})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:      # 예상 못 한 오류도 서울 배포를 막지 않는다
        print(f"예상 밖 오류: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(0)
