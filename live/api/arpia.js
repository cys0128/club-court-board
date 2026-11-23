// GET /api/arpia?date=YYYYMMDD — 아르피아 테니스장 4면의 시간대 상태를 공식 사이트에서 "누르는 순간" 조회해 돌려준다.
// 열린 프록시가 되지 않게: 날짜(오늘~다음 달 말일)와 아르피아 4면 resveId(공개 data/yongin.json 의 ids)만 허용한다.
// 공식 사이트 호출은 이 함수가 만드는 POST 1종뿐. 재시도 없음. 오류·비정상 응답이면 즉시 실패하고 60초간 공식 호출을 쉰다.
// 응답에는 시간대·상태만 담는다(예약자 필드는 읽지도 않음).
const OFFICIAL = "https://publicsports.yongin.go.kr/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do";
const IDS_URL = "https://yschoi128.github.io/club-court-board/data/yongin.json";
const ALLOW_ORIGINS = ["https://yschoi128.github.io", "http://127.0.0.1:18911", "http://localhost:18911"];
const COURTS = [
  { key: "c1", name: "1코트" }, { key: "c2", name: "2코트" },
  { key: "c3", name: "3코트" }, { key: "cd", name: "장애인 코트" },
];
// 시드(공개 ID). yongin.json 의 ids 가 있으면 그쪽이 덮는다.
const SEED = {
  "2026-11": { c1: 14883, c2: 14884, c3: 14885, cd: 14886 },
  "2026-12": { c1: 15150, c2: 15151, c3: 15152, cd: 15153 },
};
const GAP_MS = 1000;            // 건 사이 1초
const LIMIT_PER_MIN = 12;       // 인스턴스 기준 분당 공식 요청 상한
const MEM_TTL = 60 * 1000;      // 같은 날짜 메모리 캐시
const COOLDOWN = 60 * 1000;     // 실패 뒤 공식 호출 쉼
const TM_RE = /(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/;

const memCache = new Map();     // date -> {t, body}
const inflight = new Map();     // date -> Promise
let stamps = [];                // 공식 요청 시각들
let blockedUntil = 0;
let idsCache = { t: 0, ids: SEED };

class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000);

function allowedRange() {
  const n = kst();
  const y = n.getUTCFullYear(), m = n.getUTCMonth();
  const today = Date.UTC(y, m, n.getUTCDate());
  const end = Date.UTC(y, m + 2, 0);            // 다음 달 말일
  return [today, end];
}
function parseDate(s) {
  if (!/^\d{8}$/.test(s || "")) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  const t = Date.UTC(y, mo - 1, d);
  const c = new Date(t);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) return null;
  const [a, b] = allowedRange();
  return t >= a && t <= b ? { y, mo } : null;
}

async function getIds() {
  if (Date.now() - idsCache.t < 5 * 60 * 1000) return idsCache.ids;
  const ids = {};
  for (const [k, v] of Object.entries(SEED)) ids[k] = { ...v };
  try {
    const r = await fetch(IDS_URL, { headers: { "User-Agent": "club-court-live/1.0" }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const j = await r.json();
      for (const [mo, kv] of Object.entries(j.ids || {})) {
        if (!/^\d{4}-\d{2}$/.test(mo)) continue;
        ids[mo] = { ...(ids[mo] || {}) };
        for (const c of COURTS) { const v = Number(kv[c.key]); if (Number.isInteger(v) && v > 0) ids[mo][c.key] = v; }
      }
    }
  } catch (e) { /* 시드 사용 */ }
  idsCache = { t: Date.now(), ids };
  return ids;
}

function parseSlots(j) {
  if (!j || typeof j !== "object" || !Array.isArray(j.fcltRceptRsvctmTime)) throw new Fail(502, "공식 응답 형식 이상");
  const avail = new Set();
  for (const a of j.resveTmList || []) {
    const txt = typeof a === "string" ? a : a && typeof a === "object" ? `${a.useTm || ""} ${a.timeContent || ""}` : "";
    const m = TM_RE.exec(txt);
    if (!m) throw new Fail(502, "공식 응답 형식 이상");
    avail.add(m[1].padStart(5, "0") + "|" + m[2].padStart(5, "0"));
  }
  const slots = [], seen = new Set();
  for (const s of j.fcltRceptRsvctmTime) {
    const m = TM_RE.exec(String(s.useTm || ""));
    if (!m) throw new Fail(502, "공식 응답 형식 이상");
    const key = m[1].padStart(5, "0") + "|" + m[2].padStart(5, "0");
    if (!s.rsvctmId && !avail.has(key)) continue;       // 예약 이력 없는 틀 제외(수집기와 동일 규칙)
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ s: key.slice(0, 5), e: key.slice(6), stts: String(s.rsvctmStts || ""), open: avail.has(key) });
  }
  for (const key of [...avail].sort()) if (!seen.has(key)) slots.push({ s: key.slice(0, 5), e: key.slice(6), stts: "", open: true });
  slots.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  return slots;
}

async function callOfficial(date, rid) {
  stamps.push(Date.now());
  let r;
  try {
    r = await fetch(OFFICIAL, {
      method: "POST", redirect: "manual",
      headers: { "User-Agent": "club-court-live/1.0", "Content-Type": "application/x-www-form-urlencoded" },
      body: `dateVal=${date}&resveId=${rid}`, signal: AbortSignal.timeout(10000),
    });
  } catch (e) { throw new Fail(502, "공식 사이트 연결 실패"); }
  if (r.status !== 200) throw new Fail(502, `공식 사이트 응답 ${r.status}`);
  if (!(r.headers.get("content-type") || "").includes("json")) throw new Fail(502, "공식 응답이 JSON 아님");
  const txt = await r.text();
  if (!txt.trim()) throw new Fail(502, "공식 응답 비어 있음");
  let j; try { j = JSON.parse(txt); } catch (e) { throw new Fail(502, "공식 응답 파싱 실패"); }
  return parseSlots(j);
}

async function fetchDay(date, ym) {
  const ids = (await getIds())[ym];
  if (!ids) throw new Fail(404, "그 달 예약이 아직 열리지 않았습니다");
  const todo = COURTS.filter((c) => ids[c.key]);
  if (!todo.length) throw new Fail(404, "그 달 예약이 아직 열리지 않았습니다");
  const now = Date.now();
  if (now < blockedUntil) throw new Fail(503, "잠시 후 다시 시도해 주세요");
  stamps = stamps.filter((t) => now - t < 60000);
  if (stamps.length + todo.length > LIMIT_PER_MIN) throw new Fail(429, "잠시 후 다시 시도해 주세요");
  const courts = [];
  try {
    for (let i = 0; i < todo.length; i++) {
      if (i) await sleep(GAP_MS);
      courts.push({ key: todo[i].key, name: todo[i].name, slots: await callOfficial(date, ids[todo[i].key]) });
    }
  } catch (e) { blockedUntil = Date.now() + COOLDOWN; throw e; }   // 재시도 없음, 60초 쉼
  return { date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, fetchedAt: new Date().toISOString(), courts };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOW_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  const send = (code, obj, cache) => {
    res.setHeader("Cache-Control", cache || "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(code).send(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Methods", "GET"); return res.status(204).end(); }
  if (req.method !== "GET") return send(405, { error: "GET 만 지원합니다" });
  const q = req.query || {};
  const extra = Object.keys(q).filter((k) => k !== "date");
  if (extra.length) return send(400, { error: "허용되지 않는 파라미터" });
  const date = typeof q.date === "string" ? q.date : "";
  const p = parseDate(date);
  if (!p) return send(400, { error: "date 는 오늘부터 다음 달 말일 사이의 YYYYMMDD 만 허용됩니다" });
  const ym = `${p.y}-${String(p.mo).padStart(2, "0")}`;
  const hit = memCache.get(date);
  if (hit && Date.now() - hit.t < MEM_TTL) return send(200, { ...hit.body, cached: true }, "public, s-maxage=60, stale-while-revalidate=60");
  try {
    let pr = inflight.get(date);
    if (!pr) { pr = fetchDay(date, ym).finally(() => inflight.delete(date)); inflight.set(date, pr); }
    const body = await pr;
    memCache.set(date, { t: Date.now(), body });
    if (memCache.size > 40) memCache.delete(memCache.keys().next().value);
    return send(200, body, "public, s-maxage=60, stale-while-revalidate=60");
  } catch (e) {
    const st = e instanceof Fail ? e.status : 502;
    return send(st, { error: e instanceof Fail ? e.message : "조회 실패" });
  }
};
