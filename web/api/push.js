// /api/push — 코트 빈자리 웹 푸시(구독 저장·해지·테스트 + GitHub Actions 확인 작업용 관리 경로).
// 저장소: Upstash Redis(REST, env KV_REST_API_URL/TOKEN). 키는 모두 "ccb:" 접두사(같은 DB 를 다른 프로젝트와 나눠 씀).
// 개인정보 없음: 기기별 Web Push 구독(endpoint·키)과 고른 조건(날짜·시간대·코트·서울 즐겨찾기 키)만 저장한다.
//
// 공개(브라우저):  GET  ?op=key                → { publicKey }
//                  GET  ?op=state              → 확인 작업이 받은 날짜별 시간표(코트판 표시용, 60초 캐시)
//                  POST {op:'sub', sub, yongin:{dates,times,courts}, seoul:{on,favs}} → 저장(같은 기기면 덮어씀)
//                  POST {op:'get'|'unsub'|'test', endpoint}
// 관리(Actions, Authorization: Bearer PUSH_ADMIN_SECRET):
//                  GET  ?op=plan               → { dates(구독된 날짜 합집합), checked, meta }
//                  POST {op:'report', results:{날짜:{코트:[slot]}}, meta} → 상태 저장, '새로 빈 자리'만 구독자에게 1회 푸시, 서울 접수 시작 확인
const webpush = require("web-push");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ADMIN = process.env.PUSH_ADMIN_SECRET || "";
const P = "ccb:";
const MAX_SUBS = 300, MAX_DATES = 20, MAX_TIMES = 12, MAX_FAVS = 50;
const COURTS = { c1: "1코트", c2: "2코트", c3: "3코트", cd: "장애인 코트" };
const OFFV = "https://publicsports.yongin.go.kr/publicsports/sports/selectFcltyRceptResveViewU.do?resveId=";
const SITE = "https://club-court-board.vercel.app";
const PUSH_HOST = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
const ALLOW_ORIGINS = ["http://127.0.0.1:18911", "http://localhost:18911"];
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

let vapidReady = false;
function vapid() {
  if (!vapidReady) {
    webpush.setVapidDetails("https://club-court-board.vercel.app", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
}

async function kv(cmds) {            // Upstash REST pipeline: [[cmd...],...] → [result,...]
  const r = await fetch(KV_URL + "/pipeline", {
    method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("저장소 응답 " + r.status);
  const j = await r.json();
  return j.map((x) => { if (x.error) throw new Error("저장소 오류"); return x.result; });
}
const kv1 = async (...cmd) => (await kv([cmd]))[0];

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstIso = () => kstNow().toISOString().slice(0, 19) + "+09:00";
function todayStr() { return kstNow().toISOString().slice(0, 10); }
function rangeEnd() { const n = kstNow(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 2, 0)).toISOString().slice(0, 10); }
function dlabel(s) { const d = new Date(s + "T00:00:00Z"); return `${s.slice(5, 7)}.${s.slice(8, 10)}(${DOW[d.getUTCDay()]})`; }
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Buffer.from(b).toString("hex").slice(0, 32);
}

class Bad extends Error { constructor(st, m) { super(m); this.st = st; } }

function checkEndpoint(ep) {
  let u; try { u = new URL(String(ep || "")); } catch (e) { throw new Bad(400, "구독 정보가 올바르지 않습니다"); }
  if (u.protocol !== "https:" || !PUSH_HOST.test(u.hostname) || String(ep).length > 1000) throw new Bad(400, "지원하지 않는 알림 서비스입니다");
  return String(ep);
}
function cleanSub(sub) {
  if (!sub || typeof sub !== "object" || !sub.keys) throw new Bad(400, "구독 정보가 올바르지 않습니다");
  const endpoint = checkEndpoint(sub.endpoint);
  const p256dh = String(sub.keys.p256dh || ""), auth = String(sub.keys.auth || "");
  if (!/^[A-Za-z0-9_\-=]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_\-=]{8,100}$/.test(auth)) throw new Bad(400, "구독 키가 올바르지 않습니다");
  return { endpoint, keys: { p256dh, auth } };
}
function cleanCond(y, s) {
  const t0 = todayStr(), t1 = rangeEnd();
  const dates = [...new Set((Array.isArray(y && y.dates) ? y.dates : []).map(String))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= t0 && d <= t1).sort().slice(0, MAX_DATES);
  const times = [...new Set((Array.isArray(y && y.times) ? y.times : []).map(String))].filter((x) => /^\d{2}:\d{2}$/.test(x)).sort().slice(0, MAX_TIMES);
  const courts = [...new Set((Array.isArray(y && y.courts) ? y.courts : []).map(String))].filter((c) => COURTS[c]);
  const favs = [...new Set((Array.isArray(s && s.favs) ? s.favs : []).map(String))].filter((k) => k.length <= 200).slice(0, MAX_FAVS);
  return { yongin: { dates, times, courts: courts.length === 4 ? [] : courts }, seoul: { on: !!(s && s.on) && favs.length > 0, favs } };
}

async function loadSub(id) { const v = await kv1("GET", P + "sub:" + id); return v ? JSON.parse(v) : null; }
async function saveSub(o) { await kv([["SET", P + "sub:" + o.id, JSON.stringify(o)], ["SADD", P + "subs", o.id]]); }
async function delSub(id) { await kv([["DEL", P + "sub:" + id], ["SREM", P + "subs", id]]); }
async function allSubs() {
  const ids = (await kv1("SMEMBERS", P + "subs")) || [];
  if (!ids.length) return [];
  const vals = await kv1("MGET", ...ids.map((i) => P + "sub:" + i));
  const out = [];
  ids.forEach((id, i) => { if (vals[i]) { try { out.push(JSON.parse(vals[i])); } catch (e) {} } else out.push({ id, _gone: true }); });
  return out;
}

// 푸시 1건. 404/410 이면 구독이 사라진 것 → 'gone'
async function push(sub, payload, ttl) {
  vapid();
  try {
    await webpush.sendNotification(sub.sub, JSON.stringify(payload), { TTL: ttl || 3600, urgency: "high", timeout: 8000 });
    return "ok";
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return "gone";
    return "fail";
  }
}

// 서울 즐겨찾기 키(화면 web/index.html 의 favKey 와 같은 규칙)
const WTOK = "(?:평일|주말|공휴일|휴일|토|일)";
const WRE = new RegExp("\\(\\s*" + WTOK + "(?:\\s*[\\/,·]\\s*" + WTOK + ")*\\s*\\)", "g");
function favKey(c) {
  const n = String(c.SVCNM || "").replace(WRE, "").replace(/-?\s*\d{4}년\s*/g, "").replace(/[\s\-_·]+/g, "").toLowerCase();
  return String(c.PLACENM || "").replace(/\s+/g, "") + "|" + n;
}
function seoulOpen(c, now) {           // 화면의 state()==='open' 과 같은 판정(KST 벽시계 기준)
  const pm = (s) => { const m = String(s || "").match(/(\d+)-(\d+)-(\d+)[ T](\d+):(\d+)/); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null; };
  const b = pm(c.RCPTBGNDT), e = pm(c.RCPTENDDT);
  if (b && now < b) return false; if (e && now > e) return false;
  return !/마감|종료|중지/.test(String(c.SVCSTATNM || ""));
}

async function seoulCheck(subs, log) {
  const on = subs.filter((s) => !s._gone && s.seoul && s.seoul.on && (s.seoul.favs || []).length);
  const [at, prevRaw] = await kv([["GET", P + "seoul:at"], ["GET", P + "seoul:open"]]);
  if (at && Date.now() - Number(at) < 55 * 60 * 1000) return;           // 1시간에 1번(서울 함수도 1시간 캐시)
  if (!on.length) { await kv([["DEL", P + "seoul:open"]]); return; }      // 아무도 안 받으면 기준도 비움(켜는 순간 기준부터 다시)
  let j;
  try {
    const r = await fetch(SITE + "/api/seoul", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { log.push("서울 " + r.status); return; }
    j = await r.json();
  } catch (e) { log.push("서울 실패"); return; }
  const now = kstNow().getTime();
  const courts = (j.courts || []).filter((c) => c.SVCID);
  const open = courts.filter((c) => seoulOpen(c, now)).map((c) => c.SVCID);
  await kv([["SET", P + "seoul:at", String(Date.now())], ["SET", P + "seoul:open", JSON.stringify(open)]]);
  if (prevRaw == null) { log.push("서울 기준 저장 " + open.length); return; }  // 첫 확인은 기준만(이미 접수중인 곳은 알리지 않음)
  const prev = new Set(JSON.parse(prevRaw));
  const fresh = courts.filter((c) => open.includes(c.SVCID) && !prev.has(c.SVCID));
  for (const s of on) {
    const fav = new Set(s.seoul.favs), sent = new Set(s.sent || []);
    const hit = fresh.filter((c) => fav.has(favKey(c)) && !sent.has("s|" + c.SVCID));
    if (!hit.length) continue;
    hit.forEach((c) => sent.add("s|" + c.SVCID));
    const c0 = hit[0];
    const url = /^https:\/\/yeyak\.seoul\.go\.kr\//.test(c0.SVCURL || "") ? c0.SVCURL : SITE + "/";
    const r = await push(s, {
      title: "서울 즐겨찾기 코트 접수 시작",
      body: hit.slice(0, 3).map((c) => `${c.PLACENM || ""} ${c.SVCNM || ""}`.trim()).join("\n") + (hit.length > 3 ? `\n외 ${hit.length - 3}곳` : ""),
      url, tag: "seoul-" + c0.SVCID,
    });
    if (r === "gone") { await delSub(s.id); continue; }
    s.sent = [...sent].slice(-400);
    await saveSub(s);
    log.push(`서울 ${s.id.slice(0, 6)} ${hit.length}곳 ${r}`);
  }
}

async function report(body) {
  const results = body && typeof body.results === "object" && body.results ? body.results : {};
  const meta = body && typeof body.meta === "object" && body.meta ? body.meta : null;
  const now = kstIso(), t0 = todayStr(), log = [];
  const cmds = [];
  for (const [d, cs] of Object.entries(results)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || typeof cs !== "object") continue;
    cmds.push(["HSET", P + "days", d, JSON.stringify(cs)], ["HSET", P + "checked", d, now]);
  }
  if (meta) cmds.push(["SET", P + "meta", JSON.stringify(meta)]);
  // 지난 날짜 정리
  const oldDays = ((await kv1("HKEYS", P + "checked")) || []).filter((d) => d < t0);
  if (oldDays.length) cmds.push(["HDEL", P + "days", ...oldDays], ["HDEL", P + "checked", ...oldDays]);
  if (cmds.length) await kv(cmds);

  const ids = (meta && meta.ids) || {};
  const nowHM = kstNow().toISOString().slice(11, 16);
  const subs = await allSubs();
  let sent = 0;
  for (const s of subs) {
    if (s._gone) { await kv([["SREM", P + "subs", s.id]]); continue; }
    const y = s.yongin || {}, dates = (y.dates || []).filter((d) => d >= t0);
    const times = new Set(y.times || []), courts = new Set(y.courts || []);
    const sset = new Set((s.sent || []).filter((k) => k.startsWith("s|") || k.slice(0, 10) >= t0));
    const news = [];
    for (const d of dates) {
      const cs = results[d]; if (!cs) continue;
      for (const [ck, slots] of Object.entries(cs)) {
        if (!COURTS[ck] || !Array.isArray(slots)) continue;
        for (const sl of slots) {
          const k = `${d}|${ck}|${sl.s}`;
          if (!sl.open) { sset.delete(k); continue; }               // 마감되면 기록을 지워, 다시 비면 또 알린다
          if (courts.size && !courts.has(ck)) continue;
          if (times.size && !times.has(sl.s)) continue;
          if (d === t0 && sl.s <= nowHM) continue;                   // 이미 시작한 시간대
          if (sset.has(k)) continue;                                 // 같은 자리 반복 알림 금지
          sset.add(k); news.push({ d, ck, s: sl.s, e: sl.e });
        }
      }
    }
    const changed = news.length || dates.length !== (y.dates || []).length || sset.size !== (s.sent || []).length;
    if (news.length) {
      news.sort((a, b) => (a.d + a.s < b.d + b.s ? -1 : 1));
      const byDT = new Map();
      for (const n of news) { const k = n.d + " " + n.s; if (!byDT.has(k)) byDT.set(k, { ...n, c: [] }); byDT.get(k).c.push(COURTS[n.ck]); }
      const rows = [...byDT.values()];
      const f = rows[0], rid = (ids[f.d.slice(0, 7)] || {})[f.ck];
      const r = await push(s, {
        title: `아르피아 빈자리 ${dlabel(f.d)}${rows.length > 1 ? ` 외 ${rows.length - 1}` : ""}`,
        body: rows.slice(0, 4).map((x) => `${dlabel(x.d)} ${x.s}~${x.e} ${x.c.join(", ")}`).join("\n") + (rows.length > 4 ? `\n외 ${rows.length - 4}건` : ""),
        url: `${SITE}/?d=${f.d}#yongin`, book: rid ? OFFV + rid : "", tag: "arpia-" + f.d,
      }, 1800);
      if (r === "gone") { await delSub(s.id); continue; }
      if (r !== "ok") { news.forEach((n) => sset.delete(`${n.d}|${n.ck}|${n.s}`)); }   // 실패하면 다음 확인 때 다시
      else sent++;
      log.push(`용인 ${s.id.slice(0, 6)} ${news.length}칸 ${r}`);
    }
    if (changed) {
      s.yongin = { ...y, dates };
      s.sent = [...sset].slice(-400);
      await saveSub(s);
    }
  }
  try { await seoulCheck(await allSubs(), log); } catch (e) { log.push("서울 확인 오류"); }
  return { ok: true, subs: subs.length, pushed: sent, log };
}

async function plan() {
  const t0 = todayStr(), t1 = rangeEnd();
  const subs = await allSubs();
  const dates = new Set();
  let seoul = 0;
  for (const s of subs) {
    if (s._gone) continue;
    for (const d of (s.yongin && s.yongin.dates) || []) if (d >= t0 && d <= t1) dates.add(d);
    if (s.seoul && s.seoul.on) seoul++;
  }
  const [checked, meta] = await kv([["HGETALL", P + "checked"], ["GET", P + "meta"]]);
  const ck = {};
  for (let i = 0; i + 1 < (checked || []).length; i += 2) ck[checked[i]] = checked[i + 1];
  return { now: kstIso(), subs: subs.length, seoul_subs: seoul, dates: [...dates].sort(), checked: ck, meta: meta ? JSON.parse(meta) : {} };
}

async function state() {
  const [days, checked] = await kv([["HGETALL", P + "days"], ["HGETALL", P + "checked"]]);
  const out = { days: {}, checked: {} }, t0 = todayStr();
  for (let i = 0; i + 1 < (days || []).length; i += 2) if (days[i] >= t0) { try { out.days[days[i]] = JSON.parse(days[i + 1]); } catch (e) {} }
  for (let i = 0; i + 1 < (checked || []).length; i += 2) if (checked[i] >= t0) out.checked[checked[i]] = checked[i + 1];
  return out;
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return null; } }
  return null;
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
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (!KV_URL || !KV_TOKEN) return send(503, { error: "알림 저장소가 준비되지 않았습니다" });
  const isAdmin = ADMIN && (req.headers.authorization || "") === "Bearer " + ADMIN;
  try {
    if (req.method === "GET") {
      const op = (req.query || {}).op;
      if (op === "key") return send(200, { publicKey: process.env.VAPID_PUBLIC_KEY || "" }, "public, max-age=3600");
      if (op === "state") return send(200, await state(), "public, s-maxage=60, stale-while-revalidate=60");
      if (op === "plan") { if (!isAdmin) return send(401, { error: "권한 없음" }); return send(200, await plan()); }
      return send(400, { error: "알 수 없는 요청" });
    }
    if (req.method !== "POST") return send(405, { error: "GET·POST 만 지원합니다" });
    const b = readBody(req);
    if (!b || typeof b.op !== "string") return send(400, { error: "요청 형식 오류" });
    if (b.op === "report") { if (!isAdmin) return send(401, { error: "권한 없음" }); return send(200, await report(b)); }
    if (b.op === "sub") {
      const sub = cleanSub(b.sub);
      const cond = cleanCond(b.yongin, b.seoul);
      if (!cond.yongin.dates.length && !cond.seoul.on) throw new Bad(400, "날짜를 하나 이상 고르거나 서울 접수 알림을 켜 주세요");
      const id = await sha(sub.endpoint);
      const old = await loadSub(id);
      if (!old && ((await kv1("SCARD", P + "subs")) || 0) >= MAX_SUBS) throw new Bad(429, "구독이 너무 많습니다");
      // 지금 이미 빈 것으로 확인된 칸은 '새로 빈 자리'가 아니므로 미리 기록(구독 직후 쏟아지는 알림 방지). 아직 확인 안 한 날짜는 첫 확인 때 알린다.
      const sent = new Set((old && old.sent) || []);
      if (!old || JSON.stringify((old.yongin || {}).dates) !== JSON.stringify(cond.yongin.dates)) {
        const known = cond.yongin.dates.length ? await kv1("HMGET", P + "days", ...cond.yongin.dates) : [];
        cond.yongin.dates.forEach((d, i) => {
          if (!known[i] || (old && ((old.yongin || {}).dates || []).includes(d))) return;
          try { for (const [ck, sl] of Object.entries(JSON.parse(known[i]))) for (const x of sl || []) if (x.open) sent.add(`${d}|${ck}|${x.s}`); } catch (e) {}
        });
      }
      const o = { id, sub, ...cond, sent: [...sent].slice(-400), created: (old && old.created) || kstIso(), updated: kstIso() };
      await saveSub(o);
      return send(200, { ok: true, id, yongin: o.yongin, seoul: o.seoul });
    }
    if (b.op === "get" || b.op === "unsub" || b.op === "test") {
      const id = await sha(checkEndpoint(b.endpoint));
      const o = await loadSub(id);
      if (b.op === "unsub") { await delSub(id); return send(200, { ok: true }); }
      if (!o) return send(404, { error: "이 기기는 구독하지 않았습니다" });
      if (b.op === "get") return send(200, { ok: true, yongin: o.yongin, seoul: o.seoul });
      const ok = await kv1("SET", P + "test:" + id, "1", "NX", "EX", "20");
      if (!ok) return send(429, { error: "20초 뒤에 다시 눌러 주세요" });
      const r = await push(o, { title: "코트판 테스트 알림", body: "이 기기로 빈자리 알림이 옵니다. 누르면 코트판이 열립니다.", url: SITE + "/#yongin", tag: "test" }, 300);
      if (r === "gone") { await delSub(id); return send(410, { error: "구독이 만료되었습니다. 다시 신청해 주세요" }); }
      return send(r === "ok" ? 200 : 502, r === "ok" ? { ok: true } : { error: "알림 서비스 전송 실패" });
    }
    return send(400, { error: "알 수 없는 요청" });
  } catch (e) {
    if (e instanceof Bad) return send(e.st, { error: e.message });
    return send(500, { error: "처리 실패" });
  }
};
