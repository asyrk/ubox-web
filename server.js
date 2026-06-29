const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildMp4FromAnnexB } = require("./h264-mp4");
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

function hashPassword(password) {
  const digest = crypto.createHmac("sha1", "").update(password).digest("base64");
  return `${digest.slice(0, -1)},`;
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
