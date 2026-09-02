const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildMp4FromAnnexB } = require("./h264-mp4");
const { extractTrack } = require("./cloud-mp4");
const { UBoxLiveStreamManager } = require("./ubox-live-stream");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 48263);
const DEV_SERVER = process.argv.includes("--dev") || process.env.NODE_ENV === "development" || process.env.VITE_DEV === "1";
const UBOX_API = process.env.UBOX_API || "https://portal.ubianet.com";
const APP_NAME = process.env.UBOX_APP_NAME || "UBox";
const APP_VERSION = process.env.UBOX_APP_VERSION || "1.1.363";
const DEFAULT_LANG = process.env.UBOX_LANG || "en";
const DEFAULT_REGION = process.env.UBOX_REGION || "US";
const AUTH_FILE = process.env.UBOX_AUTH_FILE || path.join(__dirname, ".ubox-auth.json");

let savedAuth = loadSavedAuth();
let session = restoreSessionFromSavedAuth();
let viteDevServer = null;
const CAPTURE_DIR = path.join(__dirname, "..", "ubox-stream-re", "smali-dumps", "ubox-smali-dump");
const liveStreams = new UBoxLiveStreamManager({
  dumpDir: path.join(__dirname, "live-dumps"),
  logDir: path.join(__dirname, "live-session-logs"),
});

// Mirrors the app's password hash (LoginViewModel.loginV3 + HttpClient.get_replace_str):
// HMAC-SHA1 with an empty key, Base64, then "+" -> "-", "/" -> "_", "=" -> ",".
function hashPassword(password) {
  const digest = crypto.createHmac("sha1", "").update(password).digest("base64");
  return `${digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ",")}`;
}

function randomToken(length = 30) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  const bytes = crypto.randomBytes(length);
  for (const byte of bytes) token += alphabet[byte % alphabet.length];
  return token;
}

function loadSavedAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch (error) {
    console.warn(`Could not load saved UBox auth file: ${error.message}`);
    return null;
  }
}

function restoreSessionFromSavedAuth() {
  const savedSession = savedAuth?.session;
  if (!savedSession?.token) return null;
  return {
    token: savedSession.token,
    uuid: savedSession.uuid || "",
    account: savedSession.account || savedAuth?.credentials?.account || "",
    lang: savedSession.lang || savedAuth?.credentials?.lang || DEFAULT_LANG,
    region: savedSession.region || savedAuth?.credentials?.region || DEFAULT_REGION,
    loginAt: savedSession.loginAt || savedAuth?.savedAt || new Date().toISOString(),
    restored: true,
  };
}

function saveAuth(credentials, nextSession, extra = {}) {
  savedAuth = {
    version: 1,
    savedAt: new Date().toISOString(),
    credentials,
    session: {
      token: nextSession.token,
      uuid: nextSession.uuid || "",
      account: nextSession.account || credentials.account,
      lang: nextSession.lang || credentials.lang || DEFAULT_LANG,
      region: nextSession.region || credentials.region || DEFAULT_REGION,
      loginAt: nextSession.loginAt,
      tokenValidHours: extra.tokenValidHours || null,
    },
  };
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(savedAuth, null, 2)}\n`, { mode: 0o600 });
}

function clearSavedAuth() {
  savedAuth = null;
  try {
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  } catch (error) {
    console.warn(`Could not clear saved UBox auth file: ${error.message}`);
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

function binary(res, status, body, type) {
  res.writeHead(status, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 512 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function context({ uuid = "", lang = DEFAULT_LANG, region = DEFAULT_REGION } = {}) {
  return [
    `source=app`,
    `app=${encodeURIComponent(APP_NAME)}`,
    `ver=${encodeURIComponent(APP_VERSION)}`,
    `os=android`,
    `osver=15`,
    `uuid=${encodeURIComponent(uuid || "")}`,
    `lang=${encodeURIComponent(lang || DEFAULT_LANG)}`,
    `region=${encodeURIComponent(region || DEFAULT_REGION)}`,
  ].join("&");
}

async function ubiaPost(apiPath, body, options = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": `${APP_NAME}/${APP_VERSION} Windows/10`,
    "x-ubiaapi-callcontext": context(options),
  };
  if (options.token) headers["x-ubia-auth-usertoken"] = options.token;

  let response;
  try {
    response = await fetch(`${UBOX_API}${apiPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const error = new Error(`Could not reach UBox API at ${UBOX_API}`);
    error.status = 502;
    error.response = {
      apiPath,
      cause: {
        message: cause?.message,
        code: cause?.code || cause?.cause?.code,
        errno: cause?.errno || cause?.cause?.errno,
        syscall: cause?.syscall || cause?.cause?.syscall,
        hostname: cause?.hostname || cause?.cause?.hostname,
      },
    };
    throw error;
  }

  const textBody = await response.text();
  let parsed = null;
  try {
    parsed = textBody ? JSON.parse(textBody) : null;
  } catch {
    parsed = { raw: textBody };
  }

  if (!response.ok) {
    const error = new Error(`UBox API returned HTTP ${response.status}`);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }
  return parsed;
}

// Cloud-video API calls mirror the decompiled app (NewApiHttpClient):
//   POST /api/user/event_calendar      - days with recordings for a month
//   POST /api/user/cloud_list          - recordings for a time range
//   POST /api/user/get_cloud_video_url - signed playback URL
async function cloudPost(apiPath, body, options = {}) {
  const current = await requireSession();
  return ubiaPost(apiPath, { token: current.token, ...body }, {
    token: current.token,
    uuid: current.uuid,
    lang: current.lang,
    region: current.region,
    ...options,
  });
}

// Mirrors LiveCloudListViewModel.getCloudSaveList normalization:
//   status 1 -> image only; status 4 -> /hdp video path; else /video .mp4
//   fileName = last path segment; duration = segment[3]; recordTime = date+time.
function normalizeCloudVideo(item) {
  const img = item?.img || "";
  let fileCloudPath = item?.status === 1 ? img : img.replace("/jpg", "/video").replace(".jpg", ".mp4");
  if (item?.status === 4) fileCloudPath = img.replace("/jpg", "/hdp");
  const fileName = fileCloudPath.split("/").pop() || "";
  const parts = fileName.split("_");
  const duration = parts.length > 3 ? Number(parts[3]) || 0 : 0;
  const provider = item?.cp === 1 ? "1_amazon" : item?.cp === 2 ? "2_tencent" : "0_aliyun";
  let recordTime = null;
  if (parts.length >= 2 && parts[0].length === 8 && parts[1].length === 6) {
    recordTime = `${parts[0].slice(0, 4)}-${parts[0].slice(4, 6)}-${parts[0].slice(6, 8)} ${parts[1].slice(0, 2)}:${parts[1].slice(2, 4)}:${parts[1].slice(4, 6)}`;
  }
  return {
    id: item?.id,
    uuid: item?.uuid,
    uid: item?.device_uid,
    type: item?.type,
    status: item?.status,
    cp: item?.cp,
    provider,
    img,
    fileCloudPath,
    fileName,
    duration,
    recordTime,
    eventTime: item?.event_time,
    bucketName: item?.bucket_name,
    endpoint: item?.end_point,
    cloud: item?.cloud,
    realname: item?.realname,
    cloudImageUrl: item?.cloud_image_url || null,
    cloudHdImageUrl: item?.cloud_hd_image_url || null,
    aiFlag: item?.ai_flag,
    aiFlagString: item?.ai_flag_string,
  };
}

function buildLoginPayload(auth) {
  return {
    account: auth.account,
    password: auth.passwordHash,
    app: (auth.app || "ubox").toLowerCase(),
    app_version: auth.app_version || APP_VERSION,
    brand: auth.brand || "samsung",
    device_token: auth.device_token || randomToken(30),
    device_type: Number(auth.device_type || 1),
    hw_token: auth.hw_token || "",
    lang: auth.lang || DEFAULT_LANG,
    push_channel_tokens: [],
    regid_jg: "",
    regid_vivo: "",
    regid_xm: "",
  };
}

async function loginToUbox(auth) {
  const lang = auth.lang || DEFAULT_LANG;
  const region = auth.region || DEFAULT_REGION;
  const loginPayload = buildLoginPayload({ ...auth, lang });
  const reply = await ubiaPost("/api/v3/login", loginPayload, {
    lang,
    region,
  });
  const data = reply?.data || {};
  const token = data.Token || data.token;
  if (!token) {
    const error = new Error(reply?.msg || "Login failed.");
    error.status = 401;
    error.response = reply;
    throw error;
  }
  const nextSession = {
    token,
    uuid: data.uuid || "",
    account: data.account || auth.account,
    lang,
    region,
    loginAt: new Date().toISOString(),
  };
  return { reply, data, session: nextSession, tokenValidHours: data.token_valid_hours || null };
}

async function refreshSessionFromSavedAuth() {
  const credentials = savedAuth?.credentials;
  if (!credentials?.account || !credentials?.passwordHash) return null;
  const result = await loginToUbox(credentials);
  session = result.session;
  saveAuth(credentials, session, { tokenValidHours: result.tokenValidHours });
  return session;
}

async function requireSession() {
  if (!session?.token) {
    session = restoreSessionFromSavedAuth();
  }
  if (!session?.token) {
    try {
      await refreshSessionFromSavedAuth();
    } catch (cause) {
      const error = new Error(cause?.message || "Not logged in");
      error.status = 401;
      error.response = cause?.response;
      throw error;
    }
  }
  if (!session?.token) {
    const error = new Error("Not logged in");
    error.status = 401;
    throw error;
  }
  return session;
}

function staticRoot() {
  const dist = path.join(__dirname, "dist");
  return fs.existsSync(path.join(dist, "index.html")) ? dist : path.join(__dirname, "public");
}

function staticFile(reqPath) {
  const root = staticRoot();
  const safePath = reqPath === "/" ? "/index.html" : reqPath;
  const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  return {
    root,
    file: path.join(root, normalized),
  };
}

function staticContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
  }[ext] || "application/octet-stream";
}

function capturePath(name) {
  const allowed = new Map([
    ["raw", "callback-video-data.h26x"],
    ["cam0", fs.existsSync(path.join(CAPTURE_DIR, "cam0-refined.h264")) ? "cam0-refined.h264" : "cam0.h264"],
    ["cam1", fs.existsSync(path.join(CAPTURE_DIR, "cam1-refined.h264")) ? "cam1-refined.h264" : "cam1.h264"],
  ]);
  const file = allowed.get(name);
  if (!file) return null;
  return path.join(CAPTURE_DIR, file);
}

function serveVite(req, res) {
  return new Promise((resolve) => {
    res.once("finish", resolve);
    viteDevServer.middlewares(req, res, (error) => {
      if (error) {
        viteDevServer.ssrFixStacktrace(error);
        if (!res.headersSent) {
          json(res, 500, {
            error: error.message,
            stack: error.stack,
          });
        } else {
          res.end();
        }
      } else if (!res.headersSent) {
        text(res, 404, "Not found");
      }
      resolve();
    });
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname.startsWith("/api/status")) {
      return json(res, 200, {
        loggedIn: Boolean(session?.token),
        account: session?.account || null,
        uuid: session?.uuid || null,
        apiHost: UBOX_API,
        remembered: Boolean(savedAuth?.credentials?.account),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      if (!body.account || !body.password) {
        return json(res, 400, { error: "Account and password are required." });
      }

      const credentials = {
        account: body.account,
        passwordHash: body.password_hashed ? body.password : hashPassword(body.password),
        app: (body.app || "ubox").toLowerCase(),
        app_version: body.app_version || APP_VERSION,
        brand: body.brand || "samsung",
        device_token: body.device_token || randomToken(30),
        device_type: Number(body.device_type || 1),
        hw_token: body.hw_token || "",
        lang: body.lang || DEFAULT_LANG,
        region: body.region || DEFAULT_REGION,
      };

      const result = await loginToUbox(credentials);
      session = result.session;
      saveAuth(credentials, session, { tokenValidHours: result.tokenValidHours });

      return json(res, 200, {
        ok: true,
        account: session.account,
        uuid: session.uuid,
        tokenValidHours: result.tokenValidHours,
        remembered: true,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      session = null;
      clearSavedAuth();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/devices") {
      const current = await requireSession();
      const reply = await ubiaPost("/api/v2/user/device_list", {}, {
        token: current.token,
        uuid: current.uuid,
        lang: current.lang,
        region: current.region,
      });
      return json(res, 200, reply);
    }

    if (req.method === "POST" && url.pathname === "/api/webrtc-token") {
      const current = await requireSession();
      const body = await readBody(req);
      if (!body.uid) return json(res, 400, { error: "uid is required." });
      const reply = await ubiaPost(
        "/api/user/qry/device/get_webrtc_token",
        { uid: body.uid },
        {
          token: current.token,
          uuid: current.uuid,
          lang: current.lang,
          region: current.region,
        },
      );
      return json(res, 200, reply);
    }

    if (req.method === "POST" && url.pathname === "/api/probe-rtsp") {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: "url is required." });
      return json(res, 200, {
        ok: true,
        note: "RTSP playback is a client-side/manual step. Use this URL with VLC/ffplay if your camera exposes RTSP.",
        url: body.url,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/stream/status") {
      await requireSession();
      return json(res, 200, {
        ...liveStreams.status(),
        events: liveStreams.recentEvents(80),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/stream/events") {
      await requireSession();
      return liveStreams.addSseClient(res);
    }

    if (req.method === "GET" && url.pathname === "/api/stream/live.mp4") {
      await requireSession();
      return liveStreams.addMp4Client(res);
    }

    if (req.method === "GET" && url.pathname === "/api/stream/live.h264") {
      await requireSession();
      return liveStreams.addH264Client(res, url.searchParams.get("track") || "primary");
    }

    if (req.method === "POST" && url.pathname === "/api/stream/start") {
      await requireSession();
      const body = await readBody(req);
      if (!body.device && !body.uid) return json(res, 400, { error: "device or uid is required." });
      const requestedStreamIndex = body.streamIndex ?? body.options?.streamIndex;
      const device = {
        ...(body.device || { uid: body.uid, ...body }),
        ...(requestedStreamIndex !== undefined ? { streamIndex: requestedStreamIndex } : {}),
      };
      const options = {
        ...(body.options || {}),
        // Optional device view password. The relay validates it in the 0x1205
        // request (-2005 CLI_WRONG_VIEWACCPWD) and the session falls back to
        // the Ubia factory defaults "iotCam31"/"admin" when it is absent.
        ...(body.viewPassword !== undefined &&
        body.viewPassword !== null &&
        String(body.viewPassword).trim() !== ""
          ? { viewPassword: String(body.viewPassword).trim() }
          : {}),
        ...(requestedStreamIndex !== undefined ? { streamIndex: requestedStreamIndex } : {}),
      };
      const status = await liveStreams.start(device, options);
      return json(res, 200, status);
    }

    if (req.method === "POST" && url.pathname === "/api/stream/stop") {
      await requireSession();
      await liveStreams.stop();
      return json(res, 200, liveStreams.status());
    }

    if (req.method === "POST" && url.pathname === "/api/stream/ptz") {
      await requireSession();
      const body = await readBody(req);
      const result = liveStreams.sendPtzCommand(body);
      return json(res, result.ok ? 200 : 409, result);
    }

    // Cloud video: days with recordings for a month (app: user/event_calendar).
    if (req.method === "POST" && url.pathname === "/api/cloud/calendar") {
      const body = await readBody(req);
      if (!body.uid || !body.month) return json(res, 400, { error: "uid and month (YYYY-MM) are required." });
      const reply = await cloudPost("/api/user/event_calendar", {
        date: body.month,
        device_uid: body.uid,
        time_diff: Number(body.time_diff) || 0,
      });
      return json(res, 200, reply);
    }

    // Cloud video: recordings for a day range (app: user/cloud_list).
    if (req.method === "POST" && url.pathname === "/api/cloud/list") {
      const body = await readBody(req);
      if (!body.uid || !Number.isFinite(Number(body.start)) || !Number.isFinite(Number(body.end))) {
        return json(res, 400, { error: "uid, start and end (unix seconds) are required." });
      }
      const page = Math.max(1, Number(body.page) || 1);
      const reply = await cloudPost("/api/user/cloud_list", {
        device_uid: [body.uid],
        timestamp: [Number(body.start), Number(body.end)],
        page,
        time_revised: true,
        summer_time: Boolean(body.summer_time),
        time_diff: Number(body.time_diff) || 0,
      });
      const data = reply?.data || {};
      const videos = (data.list || []).filter((item) => [1, 2, 3, 4, 6].includes(item?.status)).map(normalizeCloudVideo);
      return json(res, 200, {
        code: reply?.code,
        msg: reply?.msg,
        count: data.count || null,
        cloud: data.cloud,
        service: data.service,
        videos,
      });
    }

    // Cloud video: signed playback URL (app: user/get_cloud_video_url).
    if (req.method === "POST" && url.pathname === "/api/cloud/url") {
      const body = await readBody(req);
      if (!body.uid || !body.image) return json(res, 400, { error: "uid and image are required." });
      const reply = await cloudPost("/api/user/get_cloud_video_url", {
        bucket_name: body.bucketName || "",
        cloud_provider: body.provider || "0_aliyun",
        cloud_provider_int: Number(body.cp) || 0,
        endpoint: body.endpoint || "",
        guid: body.uuid || "",
        image: body.image,
        uid: body.uid,
      });
      return json(res, 200, reply);
    }

    // Cloud video: download proxy (streams the signed URL to the browser).
    if (req.method === "GET" && url.pathname === "/api/cloud/download") {
      await requireSession();
      const target = url.searchParams.get("url") || "";
      const name = url.searchParams.get("name") || "cloud-video.mp4";
      if (!/^https?:\/\//.test(target)) return json(res, 400, { error: "invalid url" });
      let upstream;
      try {
        upstream = await fetch(target);
      } catch {
        return json(res, 502, { error: "Could not reach the cloud storage URL." });
      }
      if (!upstream.ok || !upstream.body) {
        return json(res, 502, { error: `Cloud storage returned HTTP ${upstream.status}.` });
      }
      const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_") || "cloud-video.mp4";
      res.writeHead(200, {
        "content-type": upstream.headers.get("content-type") || "application/octet-stream",
        "content-length": upstream.headers.get("content-length"),
        "content-disposition": `attachment; filename="${safeName}"`,
      });
      const { Readable } = require("stream");
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    }

    // Cloud video: single-track demux (two-sensor files carry two video
    // tracks; browsers only play the first). With `name` it downloads.
    if (req.method === "GET" && url.pathname === "/api/cloud/track") {
      await requireSession();
      const target = url.searchParams.get("url") || "";
      const track = Number(url.searchParams.get("track")) || 1;
      const name = url.searchParams.get("name") || "";
      if (!/^https?:\/\//.test(target)) return json(res, 400, { error: "invalid url" });
      if (track !== 1 && track !== 2) return json(res, 400, { error: "track must be 1 or 2" });
      let upstream;
      try {
        upstream = await fetch(target);
      } catch {
        return json(res, 502, { error: "Could not reach the cloud storage URL." });
      }
      if (!upstream.ok) return json(res, 502, { error: `Cloud storage returned HTTP ${upstream.status}.` });
      const source = Buffer.from(await upstream.arrayBuffer());
      let out;
      try {
        out = extractTrack(source, track);
      } catch (error) {
        return json(res, 422, { error: `Could not extract track ${track}: ${error.message}` });
      }
      const headers = {
        "content-type": "video/mp4",
        "content-length": out.length,
      };
      if (name) {
        const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_") || "cloud-video.mp4";
        headers["content-disposition"] = `attachment; filename="${safeName}"`;
      }
      res.writeHead(200, headers);
      res.end(out);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stream/decode-packet") {
      await requireSession();
      const body = await readBody(req);
      if (!body.hex) return json(res, 400, { error: "hex is required." });
      return json(res, 200, liveStreams.decodePacket(body.hex));
    }

    if (req.method === "GET" && url.pathname === "/api/capture/status") {
      const files = ["raw", "cam0", "cam1"].map((name) => {
        const file = capturePath(name);
        const exists = Boolean(file && fs.existsSync(file));
        return {
          name,
          exists,
          bytes: exists ? fs.statSync(file).size : 0,
        };
      });
      return json(res, 200, { captureDir: CAPTURE_DIR, files });
    }

    if (req.method === "GET" && url.pathname.startsWith("/capture/") && url.pathname.endsWith(".mp4")) {
      const name = path.basename(url.pathname, ".mp4");
      const file = capturePath(name);
      if (!file || !fs.existsSync(file)) return json(res, 404, { error: `No captured stream file for ${name}.` });
      const fps = Number(url.searchParams.get("fps") || 15);
      const { buffer } = buildMp4FromAnnexB(file, fps);
      return binary(res, 200, buffer, "video/mp4");
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/capture/") && url.pathname.endsWith("/meta")) {
      const name = url.pathname.split("/")[3];
      const file = capturePath(name);
      if (!file || !fs.existsSync(file)) return json(res, 404, { error: `No captured stream file for ${name}.` });
      const fps = Number(url.searchParams.get("fps") || 15);
      const { meta } = buildMp4FromAnnexB(file, fps);
      return json(res, 200, { name, file, ...meta });
    }

    if (req.method === "GET" && viteDevServer) {
      return serveVite(req, res);
    }

    if (req.method === "GET") {
      const { root, file } = staticFile(url.pathname);
      if (!file.startsWith(root)) {
        return text(res, 403, "Forbidden");
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return text(res, 404, "Not found");
      }
      return text(res, 200, fs.readFileSync(file), staticContentType(file));
    }

    return text(res, 405, "Method not allowed");
  } catch (error) {
    return json(res, error.status || 500, {
      error: error.message,
      response: error.response,
    });
  }
}

const server = http.createServer(route);

async function start() {
  if (DEV_SERVER) {
    const { createServer } = await import("vite");
    viteDevServer = await createServer({
      root: __dirname,
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: { server },
      },
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`UBox Web running at http://${HOST}:${PORT}`);
    if (DEV_SERVER) console.log("Vite HMR is enabled.");
    console.log(`Saved login state is stored locally at ${AUTH_FILE}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
