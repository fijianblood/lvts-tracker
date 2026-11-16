// LvTS Truck Tracker — Cloudflare Worker, version 1.0
//
// Phone (OwnTracks app, HTTP mode) -> this Worker -> D1 database -> MCP tools for Claude + a live map page.
//
// SETUP (Cloudflare dashboard, Worker > Settings):
//   Binding  D1 database   name: DB              (tables are created automatically, no SQL to run)
//   Secret   PHONE_PASSWORD                      (the password you type into OwnTracks)
//   Secret   ACCESS_KEY                          (long random text, at least 20 characters;
//                                                 it is part of the Claude connector URL and the map URL)
//   Optional variables: TIMEZONE (default Pacific/Fiji), RETENTION_DAYS (default 365)
//   Optional cron trigger, e.g. "0 15 * * *" (once a day): deletes points older than RETENTION_DAYS.
//
// URLS (replace <worker> with your workers.dev address):
//   https://<worker>/                        setup check (shows what is connected, never shows secrets)
//   https://<worker>/owntracks               OwnTracks "URL" (username: anything, password: PHONE_PASSWORD)
//   https://<worker>/mcp/<ACCESS_KEY>        Claude custom connector URL
//   https://<worker>/map/<ACCESS_KEY>        live map in your browser
//
// MCP: works with the 2026-07-28 protocol (stateless, server/discover) and with older clients
// that use the initialize handshake (2025-11-25, 2025-06-18, 2025-03-26).

const SERVER = { name: "lvts-truck", version: "1.0.0" };
const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const DEFAULT_TIMEZONE = "Pacific/Fiji";
const MOVING_KMH = 8;           // faster than this counts as driving
const REPORT_GAP_SEC = 30 * 60; // no report for this long ends a trip
const MAX_BODY_BYTES = 100000;
const MIN_ACCESS_KEY = 20;
const ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com"];
const USER_AGENT = "LvTS-Truck-Tracker/1.0 (+https://fijianblood.github.io/lvts)";

const INSTRUCTIONS =
  "Truck tracker for LvTS (LomaVata Tech Services). Positions come from the owner's phone running " +
  "the OwnTracks app, so they show where the phone is, which is normally in the truck. Times are local " +
  "time. Use get_truck_location for 'where is the truck', get_trips for drives and distance on a day, " +
  "get_location_history for the raw path, and the place tools to name spots such as Home or Town.";

// ---------------------------------------------------------------- entry points

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return textResponse("Internal error", 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 0) return setupCheck(env);

  if (parts[0] === "owntracks" && parts.length === 1) return handleOwnTracks(request, env);

  if (parts[0] === "mcp") {
    if (parts.length === 2) {
      if (!(await accessKeyOk(env, parts[1]))) return textResponse("Not found", 404);
    } else if (parts.length === 1) {
      const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
      if (!m || !(await accessKeyOk(env, m[1]))) return textResponse("Unauthorized", 401);
    } else {
      return textResponse("Not found", 404);
    }
    return handleMcp(request, env, url);
  }

  if (parts[0] === "map" && parts.length === 2) {
    if (!(await accessKeyOk(env, parts[1]))) return textResponse("Not found", 404);
    return mapPage();
  }

  if (parts[0] === "api" && parts.length === 3 && parts[2] === "track") {
    if (!(await accessKeyOk(env, parts[1]))) return textResponse("Not found", 404);
    return apiTrack(env, url);
  }

  return textResponse("Not found", 404);
}

function setupCheck(env) {
  const key = env.ACCESS_KEY;
  const lines = [
    "LvTS truck tracker is running.",
    "",
    "D1 database (DB): " + (env.DB ? "connected" : "MISSING - add a D1 database binding named DB"),
    "PHONE_PASSWORD secret: " + (env.PHONE_PASSWORD ? "set" : "MISSING"),
    "ACCESS_KEY secret: " +
      (!key ? "MISSING" : key.length < MIN_ACCESS_KEY ? `too short - use at least ${MIN_ACCESS_KEY} characters` : "set"),
    "Time zone: " + tz(env),
  ];
  return textResponse(lines.join("\n"), 200);
}

// ---------------------------------------------------------------- phone (OwnTracks)

async function handleOwnTracks(request, env) {
  if (request.method !== "POST") return textResponse("Method not allowed", 405, { Allow: "POST" });
  if (!env.PHONE_PASSWORD) return textResponse("PHONE_PASSWORD secret is not set", 500);
  if (!(await phonePasswordOk(request, env))) {
    return textResponse("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="truck"' });
  }
  const body = await readBody(request);
  if (body === null) return textResponse("Too large", 413);
  if (!env.DB) return textResponse("D1 database binding DB is missing", 500);

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    // Answer OK so a broken message can't block the phone's upload queue.
    console.warn("OwnTracks sent invalid JSON");
    return jsonResponse([]);
  }
  const db = await getDb(env);
  const list = Array.isArray(msg) ? msg : [msg];
  for (const m of list) {
    if (m && m._type === "location") await savePoint(db, m, request);
  }
  return jsonResponse([]); // OwnTracks expects a JSON array
}

async function phonePasswordOk(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (m) {
    let decoded;
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
    } catch {
      return false;
    }
    const i = decoded.indexOf(":");
    return safeEqual(i >= 0 ? decoded.slice(i + 1) : "", env.PHONE_PASSWORD);
  }
  // Fallback for apps without Basic auth: /owntracks?key=PHONE_PASSWORD
  const k = new URL(request.url).searchParams.get("key");
  return k ? safeEqual(k, env.PHONE_PASSWORD) : false;
}

async function savePoint(db, m, request) {
  const lat = num(m.lat);
  const lon = num(m.lon);
  const tst = num(m.tst);
  const now = nowSec();
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  if (tst === null || tst < 1e9 || tst > now + 86400) return;
  const tid =
    (typeof m.tid === "string" && m.tid.slice(0, 8)) || (request.headers.get("X-Limit-D") || "").slice(0, 32) || null;
  await db
    .prepare(
      "INSERT OR IGNORE INTO points (tst,lat,lon,acc,alt,vel,cog,batt,bs,conn,trig,tid,received) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      Math.round(tst), lat, lon, num(m.acc), num(m.alt), num(m.vel), num(m.cog), int(m.batt), int(m.bs),
      typeof m.conn === "string" ? m.conn.slice(0, 2) : null,
      typeof m.t === "string" ? m.t.slice(0, 2) : null,
      tid, now
    )
    .run();
}

// ---------------------------------------------------------------- MCP

async function handleMcp(request, env, url) {
  const origin = request.headers.get("Origin");
  if (origin && !originAllowed(origin, url)) {
    return jsonResponse({ jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } }, 403);
  }
  const cors = origin
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Content-Type", Vary: "Origin" }
    : {};

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST") return textResponse("Method not allowed", 405, { ...cors, Allow: "POST, OPTIONS" });

  const body = await readBody(request);
  if (body === null) return jsonResponse(rpcErrorBody(null, -32600, "Request too large"), 413, cors);
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return jsonResponse(rpcErrorBody(null, -32700, "Parse error"), 400, cors);
  }

  // JSON-RPC batches only existed in the 2025-03-26 protocol.
  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) {
      const r = await handleLegacy(m, env);
      if (r.body) out.push(r.body);
    }
    return out.length ? jsonResponse(out, 200, cors) : new Response(null, { status: 202, headers: cors });
  }

  const meta = msg && msg.params && msg.params._meta;
  const modernVersion = meta && meta["io.modelcontextprotocol/protocolVersion"];
  const r =
    modernVersion !== undefined && msg.method !== "initialize"
      ? await handleModern(msg, request, env)
      : await handleLegacy(msg, env);

  if (!r.body) return new Response(null, { status: 202, headers: cors });
  return jsonResponse(r.body, r.status || 200, cors);
}

// 2026-07-28: every request carries its version in _meta, plus required headers.
async function handleModern(msg, request, env) {
  if (typeof msg.method !== "string" || msg.jsonrpc !== "2.0") {
    return { status: 400, body: rpcErrorBody(msg.id ?? null, -32600, "Invalid request") };
  }
  const id = msg.id;
  const isNotification = !("id" in msg);
  const version = msg.params._meta["io.modelcontextprotocol/protocolVersion"];

  if (!MODERN_VERSIONS.includes(version)) {
    return {
      status: 400,
      body: rpcErrorBody(id ?? null, -32022, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: version }),
    };
  }

  const headerVersion = request.headers.get("MCP-Protocol-Version");
  if (headerVersion !== version) {
    return headerMismatch(id, headerVersion === null
      ? "MCP-Protocol-Version header is missing"
      : `MCP-Protocol-Version header '${headerVersion}' does not match body value '${version}'`);
  }
  if (isNotification) return {};

  const headerMethod = request.headers.get("Mcp-Method");
  if (headerMethod !== msg.method) {
    return headerMismatch(id, headerMethod === null
      ? "Mcp-Method header is missing"
      : `Mcp-Method header '${headerMethod}' does not match body value '${msg.method}'`);
  }
  if (["tools/call", "resources/read", "prompts/get"].includes(msg.method)) {
    const bodyName = msg.method === "resources/read" ? msg.params.uri : msg.params.name;
    const raw = request.headers.get("Mcp-Name");
    const headerName = decodeHeaderValue(raw);
    if (headerName !== bodyName) {
      return headerMismatch(id, raw === null
        ? "Mcp-Name header is missing"
        : `Mcp-Name header '${headerName}' does not match body value '${bodyName}'`);
    }
  }

  const serverMeta = { "io.modelcontextprotocol/serverInfo": SERVER };
  try {
    switch (msg.method) {
      case "server/discover":
        return ok(id, {
          resultType: "complete",
          supportedVersions: ALL_VERSIONS,
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          ttlMs: 3600000,
          cacheScope: "private",
          _meta: serverMeta,
        });
      case "tools/list":
        return ok(id, { resultType: "complete", tools: TOOLS, ttlMs: 3600000, cacheScope: "private", _meta: serverMeta });
      case "tools/call":
        return ok(id, { resultType: "complete", ...(await callTool(msg.params, env)), _meta: serverMeta });
      default:
        return { status: 404, body: rpcErrorBody(id, -32601, `Method not found: ${msg.method}`) };
    }
  } catch (e) {
    if (e instanceof RpcError) return { status: 400, body: rpcErrorBody(id, e.code, e.message) };
    throw e;
  }
}

// 2025-11-25 and earlier: initialize handshake, then plain requests.
async function handleLegacy(msg, env) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return { status: 400, body: rpcErrorBody(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid request") };
  }
  if (!("id" in msg)) return {}; // notifications, e.g. notifications/initialized
  const id = msg.id;
  try {
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params && msg.params.protocolVersion;
        return ok(id, {
          protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...SERVER, title: "LvTS Truck Tracker" },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call":
        return ok(id, await callTool(msg.params, env));
      default:
        return { status: 200, body: rpcErrorBody(id, -32601, `Method not found: ${msg.method}`) };
    }
  } catch (e) {
    if (e instanceof RpcError) return { status: 200, body: rpcErrorBody(id, e.code, e.message) };
    throw e;
  }
}

function ok(id, result) {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}
function headerMismatch(id, message) {
  return { status: 400, body: rpcErrorBody(id ?? null, -32020, "Header mismatch: " + message) };
}
function rpcErrorBody(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}
function decodeHeaderValue(v) {
  if (v === null) return null;
  const m = v.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
function originAllowed(origin, url) {
  return origin === url.origin || ALLOWED_ORIGINS.includes(origin);
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "get_truck_location",
    title: "Where is the truck",
    description:
      "Latest known position of the truck (from the owner's phone): local time, how long ago, Google Maps link, " +
      "speed, whether it is moving, phone battery, saved place it is at or nearest to, and the street address when available.",
    inputSchema: {
      type: "object",
      properties: {
        include_address: { type: "boolean", description: "Look up the street address from OpenStreetMap. Default true." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_trips",
    title: "Trips and distance",
    description:
      "Drives for one local day (default today) or a time range: each trip's start and end time, from and to place, " +
      "distance in km, minutes driving and top speed, plus totals for the period.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Local date as YYYY-MM-DD. Default: today." },
        from: { type: "string", description: "Start of a custom range (YYYY-MM-DDTHH:MM local time, or full ISO 8601). Use instead of date." },
        to: { type: "string", description: "End of a custom range. Default: now." },
        stop_minutes: { type: "integer", minimum: 2, maximum: 60, description: "Minutes standing still before a trip counts as ended. Default 5." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_location_history",
    title: "Location history",
    description:
      "Recorded positions over a period (default the last 24 hours), evenly thinned to max_points, with time, " +
      "coordinates, speed and saved-place name, plus the approximate distance covered.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", minimum: 1, maximum: 744, description: "How many hours back from now. Default 24." },
        date: { type: "string", description: "A whole local day as YYYY-MM-DD, instead of hours." },
        from: { type: "string", description: "Start of a custom range (YYYY-MM-DDTHH:MM local time, or full ISO 8601)." },
        to: { type: "string", description: "End of a custom range. Default: now." },
        max_points: { type: "integer", minimum: 10, maximum: 500, description: "Most points to return. Default 150." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_places",
    title: "Saved places",
    description: "Saved places (like Home or Town) with their radius, and whether the truck is at one of them now.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "save_place",
    title: "Save a place",
    description:
      "Save or update a named place so trips and locations show its name. Without lat and lon it uses the truck's " +
      "latest position. Only use when the owner asks to save or change a place.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 60, description: "Place name, e.g. Home, Town, Nausori." },
        lat: { type: "number", minimum: -90, maximum: 90, description: "Latitude. Omit to use the truck's latest position." },
        lon: { type: "number", minimum: -180, maximum: 180, description: "Longitude. Omit to use the truck's latest position." },
        radius_m: { type: "number", minimum: 30, maximum: 5000, description: "How close counts as 'at' this place, in metres. Default 150." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delete_place",
    title: "Delete a place",
    description: "Delete a saved place by name. Only use when the owner asks.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 60, description: "Name of the place to delete." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const HANDLERS = {
  get_truck_location: getTruckLocation,
  get_trips: getTrips,
  get_location_history: getLocationHistory,
  list_places: listPlaces,
  save_place: savePlace,
  delete_place: deletePlace,
};

async function callTool(params, env) {
  const name = params && params.name;
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  try {
    const data = await handler(args, env);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (e) {
    if (e instanceof UserError) return { content: [{ type: "text", text: e.message }], isError: true };
    console.error(e && e.stack ? e.stack : e);
    return { content: [{ type: "text", text: "The tracker hit an internal error. Check the Worker's logs in Cloudflare." }], isError: true };
  }
}

async function getTruckLocation(args, env) {
  const includeAddress = boolArg(args.include_address, "include_address", true);
  const db = await getDb(env);
  const zone = tz(env);
  const p = await db.prepare("SELECT * FROM points ORDER BY tst DESC LIMIT 1").first();
  if (!p) {
    return {
      status: "no_data",
      summary: "No location has been received from the phone yet. In OwnTracks, check that Mode is HTTP and the URL ends with /owntracks.",
    };
  }
  const prev = await db.prepare("SELECT * FROM points WHERE tst < ? ORDER BY tst DESC LIMIT 1").bind(p.tst).first();
  const ageSec = Math.max(0, nowSec() - p.tst);
  const speed = speedOf(prev, p);
  const fresh = ageSec <= 600;
  const moving = speed !== null && speed >= MOVING_KMH;
  const places = await loadPlaces(db);
  const at = placeAt(places, p);
  const near = at ? null : nearestPlace(places, p);
  const address = includeAddress ? await reverseGeocode(db, p.lat, p.lon) : null;
  const stale = ageSec > 3 * 3600;

  const where = at ? `at ${at.name}` : address ? `near ${shortAddress(address)}` : `at ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  const s = [`The truck was ${where}, ${humanAge(ageSec)} (${fmtLocal(p.tst, zone)}).`];
  if (speed === null) s.push("Speed unknown.");
  else if (moving) s.push(`${fresh ? "Moving" : "It was moving"} at about ${Math.round(speed)} km/h${fresh ? "" : " when last reported"}.`);
  else s.push("Not moving when last reported.");
  if (near) s.push(`${near.distance_km} km from ${near.name}.`);
  if (p.batt !== null) s.push(`Phone battery ${p.batt}%${p.bs === 2 ? " (charging)" : ""}.`);
  if (stale) s.push("This is more than 3 hours old: the phone may be off, out of signal, or OwnTracks may be paused.");

  return {
    summary: s.join(" "),
    time_local: fmtLocal(p.tst, zone),
    time_utc: new Date(p.tst * 1000).toISOString(),
    age: humanAge(ageSec),
    age_seconds: ageSec,
    lat: p.lat,
    lon: p.lon,
    accuracy_m: p.acc,
    map_link: `https://www.google.com/maps?q=${p.lat},${p.lon}`,
    address,
    address_source: address ? "OpenStreetMap (Nominatim)" : null,
    at_place: at ? at.name : null,
    nearest_place: near,
    speed_kmh: speed === null ? null : Math.round(speed),
    heading_deg: p.cog,
    moving: moving && fresh,
    stale,
    phone: {
      battery_pct: p.batt,
      battery_status: BATTERY_STATUS[p.bs] || null,
      connection: CONNECTION[p.conn] || null,
    },
    timezone: zone,
  };
}

async function getTrips(args, env) {
  const zone = tz(env);
  const range = resolveRange(args, zone, "today");
  const stopMin = intArg(args.stop_minutes, "stop_minutes", 2, 60, 5);
  const db = await getDb(env);
  const rows = (
    await db.prepare("SELECT tst,lat,lon,acc,vel FROM points WHERE tst >= ? AND tst < ? ORDER BY tst").bind(range.from, range.to).all()
  ).results;
  if (rows.length === 0) {
    return { period: range.label, summary: `No locations were recorded for ${range.label}.`, trip_count: 0, trips: [] };
  }
  const places = await loadPlaces(db);
  const trips = buildTrips(rows, stopMin * 60, nowSec());
  const label = (p) => {
    const at = placeAt(places, p);
    return at ? at.name : `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  };
  const out = trips.map((t, i) => {
    const minutes = Math.max(1, Math.round((t.end.tst - t.start.tst) / 60));
    return {
      trip: i + 1,
      start_local: fmtTime(t.start.tst, zone),
      end_local: t.in_progress ? null : fmtTime(t.end.tst, zone),
      in_progress: t.in_progress,
      from: label(t.start),
      to: t.in_progress ? null : label(t.end),
      distance_km: round1(t.distance_km),
      minutes,
      avg_speed_kmh: Math.round(t.distance_km / (minutes / 60)),
      max_speed_kmh: Math.round(t.max_speed),
    };
  });
  const totalKm = round1(trips.reduce((a, t) => a + t.distance_km, 0));
  const totalMin = out.reduce((a, t) => a + t.minutes, 0);
  const summary =
    out.length === 0
      ? `No drives found for ${range.label} (${rows.length} positions recorded, all standing still).`
      : `${out.length} trip${out.length === 1 ? "" : "s"} for ${range.label}: ${totalKm} km, about ${totalMin} minutes driving.` +
        (out.some((t) => t.in_progress) ? " The last trip is still going." : "");
  return {
    period: range.label,
    summary,
    trip_count: out.length,
    total_km: totalKm,
    driving_minutes: totalMin,
    positions_recorded: rows.length,
    trips: out,
    note: places.length ? undefined : "Tip: save places like Home with save_place so trips show names instead of coordinates.",
    timezone: zone,
  };
}

async function getLocationHistory(args, env) {
  const zone = tz(env);
  const range = resolveRange(args, zone, "24h");
  const maxPoints = intArg(args.max_points, "max_points", 10, 500, 150);
  const db = await getDb(env);
  const rows = (
    await db.prepare("SELECT tst,lat,lon,acc,vel,batt FROM points WHERE tst >= ? AND tst < ? ORDER BY tst").bind(range.from, range.to).all()
  ).results;
  if (rows.length === 0) {
    return { period: range.label, summary: `No locations were recorded for ${range.label}.`, points: [] };
  }
  const places = await loadPlaces(db);
  let km = 0;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i - 1].acc ?? 0) <= 100 && (rows[i].acc ?? 0) <= 100) km += haversineKm(rows[i - 1], rows[i]);
  }
  const sample = downsample(rows, maxPoints);
  return {
    period: range.label,
    summary:
      `${rows.length} positions for ${range.label}, about ${round1(km)} km of movement` +
      (sample.length < rows.length ? `; showing ${sample.length} evenly spaced.` : "."),
    total_positions: rows.length,
    approx_km: round1(km),
    points: sample.map((p) => {
      const at = placeAt(places, p);
      return {
        time_local: fmtLocal(p.tst, zone),
        lat: p.lat,
        lon: p.lon,
        speed_kmh: p.vel,
        accuracy_m: p.acc,
        place: at ? at.name : undefined,
      };
    }),
    timezone: zone,
  };
}

async function listPlaces(args, env) {
  const db = await getDb(env);
  const places = await loadPlaces(db);
  const latest = await db.prepare("SELECT lat,lon FROM points ORDER BY tst DESC LIMIT 1").first();
  const at = latest ? placeAt(places, latest) : null;
  return {
    summary: places.length
      ? `${places.length} saved place${places.length === 1 ? "" : "s"}.` + (at ? ` The truck is at ${at.name}.` : "")
      : "No saved places yet. Use save_place, e.g. while the truck is parked at home.",
    places: places.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, radius_m: p.radius_m })),
    truck_at: at ? at.name : null,
  };
}

async function savePlace(args, env) {
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 60) throw new UserError("name is required (1 to 60 characters).");
  let lat = numArg(args.lat, "lat", -90, 90);
  let lon = numArg(args.lon, "lon", -180, 180);
  const radius = numArg(args.radius_m, "radius_m", 30, 5000) ?? 150;
  if ((lat === undefined) !== (lon === undefined)) throw new UserError("Give both lat and lon, or neither to use the truck's position.");
  const db = await getDb(env);
  let source = "given coordinates";
  if (lat === undefined) {
    const latest = await db.prepare("SELECT lat,lon,tst FROM points ORDER BY tst DESC LIMIT 1").first();
    if (!latest) throw new UserError("No truck position yet, so give lat and lon.");
    lat = latest.lat;
    lon = latest.lon;
    source = `the truck's position from ${humanAge(Math.max(0, nowSec() - latest.tst))}`;
  }
  const existed = await db.prepare("SELECT name FROM places WHERE name = ?").bind(name).first();
  await db
    .prepare(
      "INSERT INTO places (name,lat,lon,radius_m,created) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(name) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, radius_m=excluded.radius_m"
    )
    .bind(name, lat, lon, radius, nowSec())
    .run();
  return {
    summary: `${existed ? "Updated" : "Saved"} place "${existed ? existed.name : name}" using ${source}, radius ${radius} m.`,
    place: { name: existed ? existed.name : name, lat, lon, radius_m: radius },
  };
}

async function deletePlace(args, env) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) throw new UserError("name is required.");
  const db = await getDb(env);
  const res = await db.prepare("DELETE FROM places WHERE name = ?").bind(name).run();
  if (!res.meta || !res.meta.changes) throw new UserError(`There is no saved place called "${name}".`);
  return { summary: `Deleted place "${name}".` };
}

// ---------------------------------------------------------------- map page

async function apiTrack(env, url) {
  const db = await getDb(env);
  const zone = tz(env);
  const hoursRaw = Number(url.searchParams.get("hours") || 24);
  const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 744) : 24;
  const from = nowSec() - Math.round(hours * 3600);
  const rows = (await db.prepare("SELECT tst,lat,lon FROM points WHERE tst >= ? ORDER BY tst").bind(from).all()).results;
  const latest = await db.prepare("SELECT tst,lat,lon,vel,batt FROM points ORDER BY tst DESC LIMIT 1").first();
  const places = await loadPlaces(db);
  return jsonResponse({
    hours,
    latest: latest
      ? { ...latest, time_local: fmtLocal(latest.tst, zone), age: humanAge(Math.max(0, nowSec() - latest.tst)) }
      : null,
    points: downsample(rows, 3000).map((p) => [p.lat, p.lon]),
    places: places.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, radius_m: p.radius_m })),
  });
}

function mapPage() {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="origin">
<title>Truck Map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  #map { position: absolute; inset: 0; }
  .bar { position: absolute; z-index: 1000; top: 10px; left: 56px; right: 10px; display: flex; flex-wrap: wrap;
         gap: 8px 12px; align-items: center; background: #fff; color: #111; border-radius: 10px;
         padding: 8px 12px; box-shadow: 0 2px 10px rgba(0,0,0,.25); font-size: 14px; }
  .bar strong { color: #0b6e4f; }
  select, button { font: inherit; padding: 2px 6px; }
</style>
</head><body>
<div id="map"></div>
<div class="bar">
  <strong>Truck</strong>
  <span id="info">Loading...</span>
  <select id="hours" aria-label="Time range">
    <option value="6">Last 6 hours</option>
    <option value="24" selected>Last 24 hours</option>
    <option value="72">Last 3 days</option>
    <option value="168">Last 7 days</option>
  </select>
  <button id="centre" type="button">Centre</button>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
  const key = location.pathname.split("/")[2];
  const info = document.getElementById("info");
  const hoursSel = document.getElementById("hours");
  const map = L.map("map").setView([-18.14, 178.44], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  const pathLayer = L.layerGroup().addTo(map);
  const placeLayer = L.layerGroup().addTo(map);
  let latestLatLng = null, firstLoad = true;

  async function load() {
    try {
      const res = await fetch("/api/" + encodeURIComponent(key) + "/track?hours=" + hoursSel.value, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      pathLayer.clearLayers();
      placeLayer.clearLayers();
      for (const p of d.places) {
        L.circle([p.lat, p.lon], { radius: p.radius_m, color: "#0b6e4f", weight: 1, fillOpacity: 0.08 })
          .bindTooltip(document.createTextNode(p.name)).addTo(placeLayer);
      }
      if (d.points.length > 1) L.polyline(d.points, { color: "#1565c0", weight: 4, opacity: 0.8 }).addTo(pathLayer);
      if (d.latest) {
        latestLatLng = [d.latest.lat, d.latest.lon];
        L.circleMarker(latestLatLng, { radius: 9, color: "#fff", weight: 3, fillColor: "#d84315", fillOpacity: 1 }).addTo(pathLayer);
        let text = "Last seen " + d.latest.age + " (" + d.latest.time_local + ")";
        if (d.latest.vel) text += ", " + Math.round(d.latest.vel) + " km/h";
        if (d.latest.batt != null) text += ", battery " + d.latest.batt + "%";
        info.textContent = text;
        if (firstLoad) map.setView(latestLatLng, 15);
      } else {
        info.textContent = "No location received yet.";
      }
      firstLoad = false;
    } catch (e) {
      info.textContent = "Could not load: " + e.message;
    }
  }
  hoursSel.addEventListener("change", load);
  document.getElementById("centre").addEventListener("click", () => { if (latestLatLng) map.setView(latestLatLng, 16); });
  load();
  setInterval(load, 60000);
</script>
</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "origin",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'none'; script-src https://cdnjs.cloudflare.com 'unsafe-inline'; " +
        "style-src https://cdnjs.cloudflare.com 'unsafe-inline'; img-src https://tile.openstreetmap.org data:; connect-src 'self'",
    },
  });
}

// ---------------------------------------------------------------- database

let schemaReady = false;

async function getDb(env) {
  if (!env.DB) throw new UserError("Setup problem: the Worker has no D1 database binding named DB.");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS points (id INTEGER PRIMARY KEY AUTOINCREMENT, tst INTEGER NOT NULL, " +
          "lat REAL NOT NULL, lon REAL NOT NULL, acc REAL, alt REAL, vel REAL, cog REAL, batt INTEGER, bs INTEGER, " +
          "conn TEXT, trig TEXT, tid TEXT, received INTEGER NOT NULL, UNIQUE (tst, lat, lon))"
      ),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_points_tst ON points (tst)"),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS places (name TEXT PRIMARY KEY COLLATE NOCASE, lat REAL NOT NULL, " +
          "lon REAL NOT NULL, radius_m REAL NOT NULL DEFAULT 150, created INTEGER NOT NULL)"
      ),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS geocache (k TEXT PRIMARY KEY, address TEXT NOT NULL, created INTEGER NOT NULL)"),
    ]);
    schemaReady = true;
  }
  return env.DB;
}

async function loadPlaces(db) {
  return (await db.prepare("SELECT name,lat,lon,radius_m FROM places ORDER BY name").all()).results;
}

async function cleanup(env) {
  if (!env.DB) return;
  const db = await getDb(env);
  const days = Math.min(Math.max(parseInt(env.RETENTION_DAYS || "365", 10) || 365, 7), 3650);
  const now = nowSec();
  const res = await db.prepare("DELETE FROM points WHERE tst < ?").bind(now - days * 86400).run();
  await db.prepare("DELETE FROM geocache WHERE created < ?").bind(now - 30 * 86400).run();
  console.log(`cleanup: removed ${res.meta ? res.meta.changes : 0} points older than ${days} days`);
}

async function reverseGeocode(db, lat, lon) {
  const k = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = await db.prepare("SELECT address FROM geocache WHERE k = ?").bind(k).first();
  if (cached) return cached.address;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=en&lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const address = j && typeof j.display_name === "string" ? j.display_name : null;
    if (address) {
      await db.prepare("INSERT OR REPLACE INTO geocache (k,address,created) VALUES (?,?,?)").bind(k, address, nowSec()).run();
    }
    return address;
  } catch {
    return null; // address is optional; never fail the tool because of it
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- trips & geometry

// Splits positions into drives. A drive starts when speed reaches MOVING_KMH and ends after
// stopSec standing still, or when the phone stops reporting for a while.
function buildTrips(rows, stopSec, nowS) {
  const pts = rows.filter((p) => p.acc === null || p.acc <= 200);
  const trips = [];
  let cur = null;
  let prev = null;

  const finish = (inProgress) => {
    const end = cur.stillIdx !== null ? cur.stillIdx : cur.pts.length - 1;
    const used = cur.pts.slice(0, end + 1);
    let km = 0;
    for (let i = 1; i < used.length; i++) {
      if ((used[i - 1].acc ?? 0) <= 100 && (used[i].acc ?? 0) <= 100) km += haversineKm(used[i - 1], used[i]);
    }
    if (km >= 0.3 || inProgress) {
      trips.push({ start: used[0], end: used[used.length - 1], distance_km: km, max_speed: cur.maxSpeed, in_progress: inProgress });
    }
    cur = null;
  };

  for (const p of pts) {
    if (cur && prev) {
      const gap = p.tst - prev.tst;
      const gapKmh = gap > 0 ? haversineKm(prev, p) / (gap / 3600) : 0;
      // Phone went quiet: either a long silence, or a shorter one where the truck clearly didn't move.
      if (gap > REPORT_GAP_SEC || (gap >= stopSec && gapKmh < MOVING_KMH / 2)) finish(false);
    }
    const speed = speedOf(prev, p);
    const moving = speed !== null && speed >= MOVING_KMH;
    if (moving) {
      if (!cur) {
        const startFromPrev = prev && p.tst - prev.tst <= stopSec;
        cur = { pts: startFromPrev ? [prev] : [], stillIdx: null, lastMove: p.tst, maxSpeed: 0 };
      }
      cur.pts.push(p);
      cur.stillIdx = null;
      cur.lastMove = p.tst;
      cur.maxSpeed = Math.max(cur.maxSpeed, speed);
    } else if (cur) {
      cur.pts.push(p);
      if (cur.stillIdx === null) cur.stillIdx = cur.pts.length - 1;
      if (p.tst - cur.lastMove >= stopSec) finish(false);
    }
    prev = p;
  }
  if (cur) finish(nowS - cur.lastMove < stopSec);
  return trips;
}

// Speed in km/h: the phone's own GPS speed if it sent one, otherwise worked out from the previous point.
// OwnTracks leaves out "vel" when it is zero.
function speedOf(prev, p) {
  if (p.vel !== null && p.vel !== undefined) return p.vel;
  if (!prev) return null;
  const dt = p.tst - prev.tst;
  if (dt < 30 || dt > 900) return null;
  const accA = prev.acc ?? 0;
  const accB = p.acc ?? 0;
  if (accA > 100 || accB > 100) return null;
  const km = haversineKm(prev, p);
  if (km * 1000 <= Math.max(accA + accB, 30)) return 0; // within GPS noise
  return km / (dt / 3600);
}

function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function placeAt(places, p) {
  let best = null;
  for (const pl of places) {
    const m = haversineKm(pl, p) * 1000;
    if (m <= pl.radius_m && (!best || m < best.m)) best = { name: pl.name, m };
  }
  return best;
}

function nearestPlace(places, p) {
  let best = null;
  for (const pl of places) {
    const km = haversineKm(pl, p);
    if (!best || km < best.km) best = { name: pl.name, km };
  }
  return best ? { name: best.name, distance_km: round1(best.km) } : null;
}

function downsample(arr, n) {
  if (arr.length <= n) return arr;
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
}

// ---------------------------------------------------------------- time

function tz(env) {
  const zone = env.TIMEZONE || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function fmtLocal(tstSec, zone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(tstSec * 1000));
}

function fmtTime(tstSec, zone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(tstSec * 1000));
}

function zonedParts(ms, zone) {
  const out = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms))) {
    out[part.type] = part.value;
  }
  return { y: +out.year, m: +out.month, d: +out.day, h: +out.hour % 24, mi: +out.minute, s: +out.second };
}

function offsetMs(ms, zone) {
  const p = zonedParts(ms, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

function zonedToUtcMs(y, m, d, h, mi, s, zone) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off1 = offsetMs(guess, zone);
  let t = guess - off1;
  const off2 = offsetMs(t, zone);
  if (off2 !== off1) t = guess - off2;
  return t;
}

function localDate(ms, zone) {
  const p = zonedParts(ms, zone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function dayRange(dateStr, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new UserError("date must look like YYYY-MM-DD.");
  const y = +m[1], mo = +m[2], d = +m[3];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new UserError(`${dateStr} is not a real date.`);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return {
    from: Math.floor(zonedToUtcMs(y, mo, d, 0, 0, 0, zone) / 1000),
    to: Math.floor(zonedToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, zone) / 1000),
  };
}

// Local times without a zone ("2026-11-16T08:00") are read as local time in the tracker's zone.
function parseTime(s, zone, name) {
  if (typeof s !== "string" || !s.trim()) throw new UserError(`${name} must be a date/time string.`);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (m) return Math.floor(zonedToUtcMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), zone) / 1000);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new UserError(`${name} is not a date/time I can read: ${s}`);
  return Math.floor(ms / 1000);
}

function resolveRange(args, zone, fallback) {
  const now = nowSec();
  const today = localDate(Date.now(), zone);
  let from, to, label;
  if (args.from !== undefined || args.to !== undefined) {
    to = args.to !== undefined ? parseTime(args.to, zone, "to") : now;
    from = args.from !== undefined ? parseTime(args.from, zone, "from") : to - 86400;
    if (from >= to) throw new UserError("from must be before to.");
    label = `${fmtLocal(from, zone)} to ${fmtLocal(to, zone)}`;
  } else if (args.date !== undefined) {
    ({ from, to } = dayRange(String(args.date), zone));
    label = args.date === today ? `today (${args.date})` : String(args.date);
  } else if (args.hours !== undefined || fallback === "24h") {
    const hours = numArg(args.hours, "hours", 1, 744) ?? 24;
    to = now;
    from = now - Math.round(hours * 3600);
    label = `the last ${hours} hour${hours === 1 ? "" : "s"}`;
  } else {
    ({ from, to } = dayRange(today, zone));
    label = `today (${today})`;
  }
  if (to - from > 31 * 86400) throw new UserError("Please ask for 31 days or less at a time.");
  return { from, to, label };
}

function humanAge(sec) {
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const rem = min % 60;
    return `${h} hour${h === 1 ? "" : "s"}${rem ? ` ${rem} min` : ""} ago`;
  }
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

// ---------------------------------------------------------------- small helpers

class UserError extends Error {}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BATTERY_STATUS = { 0: "unknown", 1: "unplugged", 2: "charging", 3: "full" };
const CONNECTION = { w: "wifi", m: "mobile data", o: "offline" };

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function shortAddress(a) {
  return a.split(",").slice(0, 3).map((s) => s.trim()).join(", ");
}
function num(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}
function numArg(v, name, min, max) {
  if (v === undefined || v === null) return undefined;
  const n = num(v);
  if (n === null) throw new UserError(`${name} must be a number.`);
  if (n < min || n > max) throw new UserError(`${name} must be between ${min} and ${max}.`);
  return n;
}
function intArg(v, name, min, max, dflt) {
  const n = numArg(v, name, min, max);
  return n === undefined ? dflt : Math.round(n);
}
function boolArg(v, name, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw new UserError(`${name} must be true or false.`);
}

async function accessKeyOk(env, given) {
  if (!env.ACCESS_KEY || env.ACCESS_KEY.length < MIN_ACCESS_KEY) return false;
  let decoded = given;
  try {
    decoded = decodeURIComponent(given);
  } catch {}
  return safeEqual(decoded, env.ACCESS_KEY);
}

async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function readBody(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return text.length > MAX_BODY_BYTES ? null : text;
}

function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function textResponse(text, status, extra = {}) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}
