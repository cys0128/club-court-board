#!/usr/bin/env python3
"""서울 열린데이터광장 ListPublicReservationSport 에서 테니스장만 받아 data/courts.json 저장.
인증키: 환경변수 SEOUL_API_KEY → 없으면 ~/.secrets/seoul-openapi.env 의 SEOUL_API_KEY → 없으면 'sample'(5건 제한).
목록 API 만 호출한다(상세 HTML·시간대 AJAX 호출 없음). 요청 사이 5초 간격."""
import json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "data" / "courts.json"
BASE = "http://openapi.seoul.go.kr:8088"   # HTTPS 미지원(확인), HTTP 만
SVC = "ListPublicReservationSport"
PAGE = 1000                                # 한 요청 최대 1,000건
KST = timezone(timedelta(hours=9))
KEEP = ["SVCID","SVCNM","SVCSTATNM","MINCLASSNM","AREANM","PLACENM","PAYATNM","USETGTINFO",
        "SVCOPNBGNDT","SVCOPNENDDT","RCPTBGNDT","RCPTENDDT","SVCURL","TELNO","V_MIN","V_MAX",
        "REVSTDDAYNM","REVSTDDAY","X","Y"]

def load_key():
    k = os.environ.get("SEOUL_API_KEY")
    if k: return k.strip()
    p = Path.home() / ".secrets" / "seoul-openapi.env"
    if p.exists():
        for line in p.read_text(encoding="utf-8-sig").splitlines():
            if line.strip().startswith("SEOUL_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"\'')
    return "sample"

def call(key, a, b):
    url = f"{BASE}/{urllib.parse.quote(key)}/json/{SVC}/{a}/{b}/"
    req = urllib.request.Request(url, headers={"User-Agent": "club-court-board/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def main():
    key = load_key(); sample = key == "sample"
    rows, start, total = [], 1, None
    while True:
        end = start + (5 if sample else PAGE) - 1
        if sample: end = 5
        d = call(key, start, end)
        body = d.get(SVC)
        if not body:   # 오류 응답 {"RESULT":{"CODE":..}}
            print("API 오류:", d.get("RESULT") or d, file=sys.stderr); sys.exit(1)
        total = body["list_total_count"]; rows += body.get("row", [])
        if sample or end >= total: break
        start = end + 1; time.sleep(5)
    tennis = []
    for r in rows:
        if r.get("MINCLASSNM") != "테니스장": continue
        c = {k: r.get(k, "").strip() for k in KEEP}
        dt = r.get("DTLCONT", "")   # 안내문 본문: 방식 키워드만 뽑고 본문은 저장 안 함
        c["METHOD"] = "선착순" if "선착순" in dt else ("추첨" if "추첨" in dt else "")
        tennis.append(c)
    out = {"updated_at": datetime.now(KST).isoformat(timespec="seconds"),
           "source": SVC, "sample_key": sample, "total_all_sports": total,
           "fetched": len(rows), "count": len(tennis), "courts": tennis}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장: {OUT} (전체 {len(rows)}건 중 테니스장 {len(tennis)}건, 샘플키={sample})")

if __name__ == "__main__":
    main()
