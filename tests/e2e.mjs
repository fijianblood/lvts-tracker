// End-to-end tests for worker.js.
// 1) cp .dev.vars.example .dev.vars   2) npm run dev   3) in another terminal: npm test
// Uses made-up test positions in Suva (two public areas, not anyone's home).
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const KEY = process.env.ACCESS_KEY || "test-access-key-abcdefghijklmnop";
const PASS = process.env.PHONE_PASSWORD || "phone-test-pass-123";

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : "");
  }
};
const now = Math.floor(Date.now() / 1000);
const iso = (sec) => new Date(sec * 1000).toISOString();
const km = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
};

async function phone(body, auth = basic("truck", PASS), qs = "") {
  return fetch(`${BASE}/owntracks${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function legacy(method, params, id = 1, path = `/mcp/${KEY}`, headers = {}) {
  const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (id !== null) msg.id = id;
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(msg),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
async function modern(method, params = {}, headers = null, meta = META) {
  const msg = { jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: meta } };
  const h = headers ?? {
    "MCP-Protocol-Version": meta["io.modelcontextprotocol/protocolVersion"],
    "Mcp-Method": method,
    ...(params.name ? { "Mcp-Name": params.name } : {}),
  };
  const r = await fetch(`${BASE}/mcp/${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...h },
    body: JSON.stringify(msg),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const call = (name, args = {}) => legacy("tools/call", { name, arguments: args });
const data = (res) => JSON.parse(res.body.result.content[0].text);

// ---------- a test day: Depot -> Market -> Depot, with GPS speed (vel) ----------
const DEPOT = { lat: -18.148, lon: 178.456 };
const MARKET = { lat: -18.136, lon: 178.4245 };
const LEG_KM = km(DEPOT, MARKET);
const pts = [];
let t = now - 3 * 3600;
for (; t < now - 3 * 3600 + 1800; t += 60) pts.push({ ...DEPOT, tst: t, acc: 10, batt: 80, bs: 1, conn: "m" });
for (let i = 1; i <= 24; i++, t += 30) {
  pts.push({ lat: DEPOT.lat + ((MARKET.lat - DEPOT.lat) * i) / 24, lon: DEPOT.lon + ((MARKET.lon - DEPOT.lon) * i) / 24, tst: t, acc: 8, vel: 35 + (i % 5), batt: 79 });
}
for (let j = 0; j < 20; j++, t += 120) pts.push({ ...MARKET, tst: t, acc: 12, batt: 78 });
for (let i = 1; i <= 24; i++, t += 30) {
  pts.push({ lat: MARKET.lat + ((DEPOT.lat - MARKET.lat) * i) / 24, lon: MARKET.lon + ((DEPOT.lon - MARKET.lon) * i) / 24, tst: t, acc: 8, vel: 40 + (i % 6), batt: 77 });
}
for (; t < now - 300; t += 120) pts.push({ ...DEPOT, tst: t, acc: 10, batt: 76, bs: 2, conn: "w" });

// ---------- phone endpoint ----------
let r = await phone({ _type: "location", lat: 1, lon: 1, tst: now }, null);
check("phone: no auth -> 401", r.status === 401);
r = await phone({ _type: "location", lat: 1, lon: 1, tst: now }, basic("truck", "wrong"));
check("phone: wrong password -> 401", r.status === 401);
r = await phone("{not json");
check("phone: bad JSON -> 200 []", r.status === 200 && (await r.text()) === "[]");
r = await phone({ _type: "transition", event: "enter", lat: 1, lon: 1, tst: now });
check("phone: non-location message accepted", r.status === 200);

let okCount = 0;
for (const p of pts) {
  const res = await phone({ _type: "location", tid: "JS", ...p });
  if (res.status === 200 && (await res.text()) === "[]") okCount++;
}
check(`phone: ${pts.length} locations accepted`, okCount === pts.length, okCount);
r = await phone({ _type: "location", tid: "JS", ...pts[pts.length - 1] });
check("phone: duplicate accepted silently", r.status === 200);

// 26 hours ago: a drive with NO vel field (speed worked out from positions), sent with ?key=
const y0 = now - 26 * 3600;
const yPts = [];
for (let i = 0; i < 5; i++) yPts.push({ ...DEPOT, tst: y0 + i * 60, acc: 10 });
for (let i = 1; i <= 15; i++) {
  yPts.push({ lat: DEPOT.lat + ((MARKET.lat - DEPOT.lat) * i) / 15, lon: DEPOT.lon + ((MARKET.lon - DEPOT.lon) * i) / 15, tst: y0 + 240 + i * 45, acc: 10 });
}
for (let i = 1; i <= 8; i++) yPts.push({ ...MARKET, tst: y0 + 240 + 15 * 45 + i * 60, acc: 10 });
let qsOk = 0;
for (const p of yPts) {
  const res = await phone({ _type: "location", ...p }, null, `?key=${PASS}`);
  if (res.status === 200) qsOk++;
}
check("phone: ?key= fallback works", qsOk === yPts.length, qsOk);
await phone({ _type: "location", lat: -17.8, lon: 177.4, tst: now - 800 * 86400, acc: 5 }); // for the clean-up test

// ---------- auth on MCP ----------
r = await fetch(`${BASE}/mcp/wrong-key-wrong-key-wrong`, { method: "POST", body: "{}" });
check("mcp: wrong key -> 404", r.status === 404);
r = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
check("mcp: no bearer -> 401", r.status === 401);
let lr = await legacy("ping", null, 3, "/mcp", { Authorization: `Bearer ${KEY}` });
check("mcp: bearer auth works", lr.status === 200 && lr.body.result && Object.keys(lr.body.result).length === 0, lr);
r = await fetch(`${BASE}/mcp/${KEY}`);
check("mcp: GET -> 405", r.status === 405);
r = await fetch(`${BASE}/mcp/${KEY}`, { method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
check("mcp: CORS preflight from claude.ai -> 204", r.status === 204 && r.headers.get("access-control-allow-origin") === "https://claude.ai");
r = await fetch(`${BASE}/mcp/${KEY}`, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
check("mcp: unknown Origin -> 403", r.status === 403);
r = await fetch(`${BASE}/mcp/${KEY}`, { method: "POST", body: "{oops" });
check("mcp: parse error -> 400 -32700", r.status === 400 && (await r.json()).error.code === -32700);

// ---------- MCP with the initialize handshake (2025-11-25 and earlier) ----------
lr = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
check("legacy: initialize echoes 2025-06-18", lr.body.result.protocolVersion === "2025-06-18" && lr.body.result.capabilities.tools, lr.body);
lr = await legacy("initialize", { protocolVersion: "2024-11-05" });
check("legacy: unknown old version -> offers 2025-11-25", lr.body.result.protocolVersion === "2025-11-25");
lr = await legacy("notifications/initialized", null, null);
check("legacy: notification -> 202", lr.status === 202 && lr.body === null);
lr = await legacy("tools/list");
const names = lr.body.result.tools.map((x) => x.name);
check("legacy: tools/list has 6 tools", names.join(",") === "get_truck_location,get_trips,get_location_history,list_places,save_place,delete_place", names);
lr = await legacy("resources/list");
check("legacy: unknown method -> -32601", lr.body.error && lr.body.error.code === -32601);
lr = await call("nope");
check("legacy: unknown tool -> -32602", lr.body.error && lr.body.error.code === -32602, lr.body);

lr = await call("list_places");
check("tool list_places: empty", data(lr).places.length === 0);

lr = await call("save_place", { name: "Depot", radius_m: 150 });
let d = data(lr);
check("tool save_place: uses truck's latest position", d.place.lat === DEPOT.lat && d.place.lon === DEPOT.lon && /Saved/.test(d.summary), d);
lr = await call("save_place", { name: "Market", lat: MARKET.lat, lon: MARKET.lon });
check("tool save_place: explicit coords", /Saved place "Market"/.test(data(lr).summary));
lr = await call("save_place", { name: "market", lat: MARKET.lat, lon: MARKET.lon, radius_m: 200 });
check("tool save_place: same name any case -> update", /Updated place "Market"/.test(data(lr).summary), data(lr));
lr = await call("save_place", { name: "X", lat: 1 });
check("tool save_place: lat without lon -> isError", lr.body.result.isError === true);
lr = await call("save_place", { name: "X", lat: 1, lon: 999 });
check("tool save_place: bad lon -> isError", lr.body.result.isError === true && /lon must be between/.test(lr.body.result.content[0].text));

lr = await call("get_truck_location");
d = data(lr);
console.log("   location:", d.summary);
check("tool get_truck_location: at Depot, not moving, charging", d.at_place === "Depot" && d.moving === false && d.phone.battery_status === "charging" && d.stale === false && d.map_link.includes(String(DEPOT.lat)), d);
check("tool get_truck_location: local time zone", typeof d.time_local === "string" && d.timezone === "Pacific/Fiji");
lr = await call("get_truck_location", { include_address: "maybe" });
check("tool get_truck_location: bad boolean -> isError", lr.body.result.isError === true);

// trips in the last 4 hours (phone sent GPS speed)
lr = await call("get_trips", { from: iso(now - 4 * 3600), to: iso(now) });
d = data(lr);
console.log("   trips:", d.summary, JSON.stringify(d.trips));
check("tool get_trips: 2 trips", d.trip_count === 2, d);
check("tool get_trips: from/to names", d.trips[0]?.from === "Depot" && d.trips[0]?.to === "Market" && d.trips[1]?.from === "Market" && d.trips[1]?.to === "Depot", d.trips);
check(`tool get_trips: distances ~${LEG_KM.toFixed(1)} km each`, d.trips.every((x) => Math.abs(x.distance_km - LEG_KM) < 0.3), d.trips.map((x) => x.distance_km));
check("tool get_trips: about 12 min each", d.trips.every((x) => x.minutes >= 11 && x.minutes <= 14), d.trips.map((x) => x.minutes));
lr = await call("get_trips");
check("tool get_trips: default (today) works", !lr.body.result.isError && typeof data(lr).summary === "string");

// trip 26 hours ago (no vel: speed worked out from positions)
lr = await call("get_trips", { from: iso(y0 - 600), to: iso(y0 + 3600) });
d = data(lr);
console.log("   earlier trip:", d.summary, JSON.stringify(d.trips));
check("tool get_trips: computed-speed drive found (no vel field)", d.trip_count === 1 && d.trips[0].from === "Depot" && d.trips[0].to === "Market" && Math.abs(d.trips[0].distance_km - LEG_KM) < 0.3, d);

lr = await call("get_trips", { date: "2026-02-30" });
check("tool get_trips: impossible date -> isError", lr.body.result.isError === true);
lr = await call("get_trips", { from: "2026-01-01", to: "2026-03-01" });
check("tool get_trips: >31 days -> isError", lr.body.result.isError === true);

lr = await call("get_location_history", { hours: 4, max_points: 20 });
d = data(lr);
console.log("   history:", d.summary);
check("tool get_location_history: thinned to 20 points", d.points.length === 20 && d.total_positions > 20, d.points.length);
check("tool get_location_history: movement ~ two legs", Math.abs(d.approx_km - 2 * LEG_KM) < 0.5, d.approx_km);

lr = await call("list_places");
d = data(lr);
check("tool list_places: 2 places, truck at Depot", d.places.length === 2 && d.truck_at === "Depot", d);
lr = await call("delete_place", { name: "Nowhere" });
check("tool delete_place: missing -> isError", lr.body.result.isError === true);

r = await fetch(`${BASE}/mcp/${KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]),
});
const batch = await r.json();
check("legacy: batch returns 2 responses", Array.isArray(batch) && batch.length === 2 && batch[1].result.tools.length === 6);

// ---------- MCP 2026-07-28 (stateless, headers required) ----------
let mr = await modern("server/discover");
check("modern: server/discover", mr.status === 200 && mr.body.result.resultType === "complete" && mr.body.result.supportedVersions[0] === "2026-07-28" && mr.body.result._meta["io.modelcontextprotocol/serverInfo"].name === "lvts-truck", mr.body);
mr = await modern("tools/list");
check("modern: tools/list with ttlMs/cacheScope", mr.body.result.tools.length === 6 && mr.body.result.ttlMs > 0 && mr.body.result.cacheScope === "private");
mr = await modern("tools/call", { name: "get_truck_location", arguments: { include_address: false } });
check("modern: tools/call works", mr.status === 200 && mr.body.result.resultType === "complete" && data(mr).at_place === "Depot", mr.body);
mr = await modern("tools/call", { name: "list_places", arguments: {} }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "=?base64?" + Buffer.from("list_places").toString("base64") + "?=" });
check("modern: base64 Mcp-Name accepted", mr.status === 200 && !mr.body.error, mr.body);
mr = await modern("tools/list", {}, { "Mcp-Method": "tools/list" });
check("modern: missing MCP-Protocol-Version -> 400 -32020", mr.status === 400 && mr.body.error.code === -32020, mr.body);
mr = await modern("tools/list", {}, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" });
check("modern: Mcp-Method mismatch -> 400 -32020", mr.status === 400 && mr.body.error.code === -32020);
mr = await modern("tools/call", { name: "list_places", arguments: {} }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" });
check("modern: missing Mcp-Name -> 400 -32020", mr.status === 400 && mr.body.error.code === -32020);
mr = await modern("tools/list", {}, { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" }, { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" });
check("modern: unsupported version -> 400 -32022 with list", mr.status === 400 && mr.body.error.code === -32022 && mr.body.error.data.supported.includes("2026-07-28") && mr.body.error.data.requested === "2099-01-01", mr.body);
mr = await modern("ping");
check("modern: removed/unknown method -> 404 -32601", mr.status === 404 && mr.body.error.code === -32601);
mr = await modern("tools/call", { name: "nope", arguments: {} });
check("modern: unknown tool -> 400 -32602", mr.status === 400 && mr.body.error.code === -32602, mr.body);
mr = await modern("tools/call", { name: "delete_place", arguments: { name: "market" } });
check("modern: delete_place (any case)", /Deleted/.test(data(mr).summary));

// ---------- map page & its API ----------
r = await fetch(`${BASE}/map/${KEY}`);
const html = await r.text();
check("map: page served", r.status === 200 && html.includes("leaflet") && r.headers.get("content-security-policy").includes("connect-src 'self'"));
r = await fetch(`${BASE}/map/not-the-key-not-the-key-x`);
check("map: wrong key -> 404", r.status === 404);
r = await fetch(`${BASE}/api/${KEY}/track?hours=24`);
d = await r.json();
check("map api: track JSON", r.status === 200 && d.points.length > 50 && d.latest && d.places.length === 1, { n: d.points.length, places: d.places });

// ---------- daily clean-up (needs wrangler dev --test-scheduled) ----------
const oldRange = { from: iso(now - 801 * 86400), to: iso(now - 799 * 86400) };
lr = await call("get_location_history", oldRange);
check("cleanup: old point exists before cron", data(lr).total_positions === 1, data(lr));
r = await fetch(`${BASE}/__scheduled?cron=0+15+*+*+*`);
console.log("   scheduled ->", r.status, (await r.text()).slice(0, 80));
lr = await call("get_location_history", oldRange);
check("cleanup: old point removed by cron", (data(lr).points || []).length === 0, data(lr));
lr = await call("get_location_history", { hours: 4 });
check("cleanup: recent points kept", data(lr).total_positions > 50);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
