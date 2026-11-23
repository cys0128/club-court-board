// GET /api/seoul — 서울 열린데이터광장 ListPublicReservationSport 에서 테니스장만 받아 courts.json 과 같은 형식으로 반환한다.
// 인증키는 Vercel 환경변수 SEOUL_API_KEY (코드·로그·응답에 절대 노출하지 않는다). 서울 OpenAPI 는 HTTP 전용이라 http 로 호출한다.
// 화면을 열 때만 호출되고, 응답은 CDN 에 1시간 캐시된다(s-maxage=3600, stale-while-revalidate=3600).
const BASE = "http://openapi.seoul.go.kr:8088";
const SVC = "ListPublicReservationSport";
const KEEP = ["SVCID", "SVCNM", "SVCSTATNM", "MINCLASSNM", "AREANM", "PLACENM", "PAYATNM", "USETGTINFO",
  "SVCOPNBGNDT", "SVCOPNENDDT", "RCPTBGNDT", "RCPTENDDT", "SVCURL", "TELNO", "V_MIN", "V_MAX",
  "REVSTDDAYNM", "REVSTDDAY", "X", "Y"];
const MEM_TTL = 3600 * 1000;
let mem = null;   // {t, body}

function kst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + "+09:00";
}

async function build(key) {
  const url = `${BASE}/${encodeURIComponent(key)}/json/${SVC}/1/1000/`;
  let r;
  try { r = await fetch(url, { headers: { "User-Agent": "club-court-board/1.0" }, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error("서울 OpenAPI 연결 실패"); }
  if (r.status !== 200) throw new Error(`서울 OpenAPI 응답 ${r.status}`);
  let d;
  try { d = JSON.parse(await r.text()); } catch (e) { throw new Error("서울 OpenAPI 응답 형식 이상"); }
  const body = d && d[SVC];
  if (!body || !Array.isArray(body.row)) throw new Error("서울 OpenAPI 오류 응답");
  const courts = [];
  for (const row of body.row) {
    if (row.MINCLASSNM !== "테니스장") continue;
    const c = {};
    for (const k of KEEP) c[k] = String(row[k] == null ? "" : row[k]).trim();
    const dt = String(row.DTLCONT || "");
    c.METHOD = dt.includes("선착순") ? "선착순" : dt.includes("추첨") ? "추첨" : "";
    courts.push(c);
  }
  return {
    updated_at: kst(), source: SVC, sample_key: false,
    total_all_sports: body.list_total_count, fetched: body.row.length, count: courts.length, courts,
  };
}

module.exports = async (req, res) => {
  const send = (code, obj, cache) => {
    res.setHeader("Cache-Control", cache || "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(code).send(JSON.stringify(obj));
  };
  if (req.method !== "GET") return send(405, { error: "GET 만 지원합니다" });
  const key = process.env.SEOUL_API_KEY;
  if (!key) return send(503, { error: "서울 데이터 설정이 없습니다" });
  const CACHE = "public, s-maxage=3600, stale-while-revalidate=3600";
  if (mem && Date.now() - mem.t < MEM_TTL) return send(200, mem.body, CACHE);
  try {
    const body = await build(key);
    mem = { t: Date.now(), body };
    return send(200, body, CACHE);
  } catch (e) {
    // 메시지에 URL·키가 들어가지 않도록 고정 문구만 반환
    return send(502, { error: String(e && e.message || "조회 실패").replace(key, "***") });
  }
};
