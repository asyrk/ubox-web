const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Kcp } = require("kcpjs/dist/kcp");
const { buildPacket, decodeDatagram, describeMsg, encodeP4P } = require("./p4p-codec");
const { LiveMp4Muxer, extractAnnexB, parseNalUnits } = require("./live-mp4");

const DISCOVERY_SERVERS = [
  "175.178.248.245",
  "121.199.12.37",
  "43.153.110.207",
  "8.208.11.50",
  "43.134.10.68",
  "43.157.31.112",
];

const RELAY_SERVERS = [
  "141.95.7.68",
  "23.160.72.229",
  "79.72.62.201",
  "130.94.90.222",
];

const DEFAULT_STREAM_OPTIONS = {
  enableStartVideoControl: true,
  enableRdtAck: true,
  kcpSkipAfterMs: 2500,
  kcpSkipThrottleMs: 1500,
  relayRenewAfterMs: 15000,
  relayRenewThrottleMs: 10000,
  relayReestablishTimeoutMs: 8000,
  reuseStaleAfterMs: 10000,
  rdtAckIntervalMs: 25,
  rdtAckMinIntervalMs: 20,
  sessionSnapshotMs: 2000,
};

function nowIso() {
  return new Date().toISOString();
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function toFixedAsciiBuffer(value, length) {
  const out = Buffer.alloc(length);
  Buffer.from(String(value || ""), "ascii").copy(out, 0, 0, length);
  return out;
}

function firstValue(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function flattenObject(object, prefix = "", out = {}) {
  if (!object || typeof object !== "object" || Buffer.isBuffer(object)) return out;
  for (const [key, value] of Object.entries(object)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, next, out);
    } else {
      out[next] = value;
    }
  }
  return out;
}

function getDeviceIdentity(device) {
  const flat = flattenObject(device);
  const cloudDeviceType = Number(firstValue(flat, ["device_type", "raw.device_type", "infos.device_type"]) || 0);
  const p4pDeviceType = Number(firstValue(flat, ["devType", "p4pDeviceType", "raw.devType", "raw.p4pDeviceType"]) || 2);
  return {
    uid: firstValue(flat, ["uid", "device_uid", "raw.device_uid", "deviceInfo.device_uid", "info.device_uid"]),
    loginId: firstValue(flat, [
      "loginId",
      "login_id",
      "devLoginID",
      "device_login_id",
      "device_pwd",
      "devicePwd",
      "raw.login_id",
      "raw.loginId",
      "raw.device_login_id",
      "raw.device_loginid",
      "raw.dev_login_id",
      "raw.device_pwd",
      "raw.devicePwd",
      "info.device_pwd",
      "infos.device_pwd",
    ]),
    loginPwd: firstValue(flat, [
      "loginPwd",
      "login_pwd",
      "devLoginPwd",
      "device_login_pwd",
      "device_user",
      "deviceUser",
      "raw.login_pwd",
      "raw.loginPwd",
      "raw.device_login_pwd",
      "raw.device_loginpwd",
      "raw.dev_login_pwd",
      "raw.device_user",
      "raw.deviceUser",
      "info.device_user",
      "infos.device_user",
    ]),
    streamIndex: Number(firstValue(flat, ["streamindex", "streamIndex", "stream_type", "raw.streamindex", "raw.stream_type"]) || 0),
    zoneId: Number(firstValue(flat, ["zoneID", "zoneId", "zoneid", "zone_id", "raw.zoneID", "raw.zoneid", "raw.zone_id"]) || 0),
    channel: Number(firstValue(flat, ["channel", "raw.channel"]) || 0),
    cloudDeviceType,
    deviceType: p4pDeviceType,
    videoSidSeed: Number(firstValue(flat, ["videoSidSeed", "raw.videoSidSeed"]) || 0x0f),
  };
}

function randomIdForUid(uid) {
  const uidBytes = Buffer.from(String(uid || ""), "ascii");
  let value = crypto.randomBytes(4).readUInt32LE(0) & 0xffff0000;
  value += Date.now() & 0xff00;
  for (let i = 0; i < Math.min(4, uidBytes.length); i += 1) value = (value + uidBytes[i]) >>> 0;
  return value >>> 0;
}

function isAnnexB(buf) {
  return buf.includes(Buffer.from([0, 0, 1])) || buf.includes(Buffer.from([0, 0, 0, 1]));
}

function parseKcpSegments(buf) {
  const segments = [];
  let offset = 0;
  while (offset + 24 <= buf.length) {
    const len = buf.readUInt32LE(offset + 20);
    if (offset + 24 + len > buf.length) break;
    segments.push({
      conv: buf.readUInt32LE(offset),
      cmd: buf[offset + 4],
      frg: buf[offset + 5],
      wnd: buf.readUInt16LE(offset + 6),
      ts: buf.readUInt32LE(offset + 8),
      sn: buf.readUInt32LE(offset + 12),
      una: buf.readUInt32LE(offset + 16),
      len,
      data: buf.subarray(offset + 24, offset + 24 + len),
    });
    offset += 24 + len;
  }
  return segments;
}

function parseInnerRecord(buf) {
  if (buf.length < 32) return null;
  const recordLength = buf.readUInt32LE(8);
  const payloadLength = recordLength >= 16 && recordLength + 16 <= buf.length ? recordLength - 16 : Math.max(buf.length - 32, 0);
  const frameInfo = buf.subarray(16, 32);
  const frameMeta = parseFrameInfo(frameInfo);
  const payload = buf.subarray(32, 32 + payloadLength);
  return {
    type: buf.readUInt16LE(0),
    streamByte: buf[3],
    recordLength,
    totalLength: 16 + recordLength,
    frameSeq: buf.readUInt16LE(6),
    crc32: buf.readUInt32LE(12),
    frameInfo,
    frameMeta,
    payload,
  };
}

function parseFrameInfo(frameInfo) {
  if (!frameInfo || frameInfo.length < 16) return null;
  return {
    codec: frameInfo[0],
    flags: frameInfo[2],
    cam: frameInfo[3],
    online: frameInfo[4],
    timestamp: frameInfo.readUInt32LE(12),
  };
}

function cleanAnnexB(annexB) {
  const parts = [];
  let hasPicture = false;
  for (const nal of parseNalUnits(annexB)) {
    const nri = (nal.data[0] >> 5) & 0x03;
    const isParameterSet = nal.type === 7 || nal.type === 8;
    const isIdrSlice = nal.type === 5 && nri > 0 && nal.data.length > 32;
    const isNonIdrSlice = nal.type === 1 && nri > 0 && nal.data.length > 32;
    if (!isParameterSet && !isIdrSlice && !isNonIdrSlice) continue;
    if (isIdrSlice || isNonIdrSlice) hasPicture = true;
    parts.push(Buffer.from([0, 0, 0, 1]), nal.data);
  }
  return hasPicture && parts.length ? Buffer.concat(parts) : null;
}

function framePacket(frame) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(frame.length, 0);
  return Buffer.concat([header, frame]);
}

function align4(value) {
  return (value + 3) & ~3;
}

function seqDistance(from, to) {
  return (to - from) & 0xffff;
}

function seqMinus(value, amount) {
  return (value - amount) & 0xffff;
}

function seqPlus(value, amount) {
  return (value + amount) & 0xffff;
}

function buildRdtAckPayload({ lastFrameSeq = 0, receivedFrameSeqs = new Set() } = {}) {
  const count = receivedFrameSeqs.size ? Math.min(255, receivedFrameSeqs.size) : 1;
  const startSeq = seqMinus(lastFrameSeq, count - 1);
  const bitmapBytes = Math.ceil(count / 8);
  const ackDataLength = align4(8 + bitmapBytes);
  const ackTlv = Buffer.alloc(4 + ackDataLength);

  ackTlv.writeUInt16LE(1, 0);
  ackTlv.writeUInt16LE(ackDataLength, 2);
  ackTlv.writeUInt16LE(lastFrameSeq & 0xffff, 4);
  ackTlv.writeUInt16LE(startSeq & 0xffff, 8);
  ackTlv[10] = count & 0xff;
  ackTlv[11] = bitmapBytes & 0xff;
  for (let i = 0; i < count; i += 1) {
    const seq = seqPlus(startSeq, i);
    if (receivedFrameSeqs.has(seq)) ackTlv[12 + Math.floor(i / 8)] |= 1 << (i % 8);
  }

  const statsTlv = Buffer.alloc(4 + 16);
  statsTlv.writeUInt16LE(4, 0);
  statsTlv.writeUInt16LE(16, 2);

  const bandwidthTlv = Buffer.alloc(4 + 24);
  bandwidthTlv.writeUInt16LE(5, 0);
  bandwidthTlv.writeUInt16LE(24, 2);
  bandwidthTlv.writeUInt32LE(1024 * 1024, 4);
  bandwidthTlv.writeUInt32LE(1024 * 1024, 8);
  bandwidthTlv.writeUInt16LE(256, 12);
  bandwidthTlv.writeUInt16LE(0, 14);
  bandwidthTlv.writeUInt16LE(0, 16);
  bandwidthTlv.writeUInt16LE(0, 18);
  bandwidthTlv.writeUInt16LE(15, 20);
  bandwidthTlv.writeUInt16LE(15, 22);

  const tlvs = Buffer.concat([ackTlv, statsTlv, bandwidthTlv]);
  const payload = Buffer.alloc(12 + tlvs.length);
  payload[0] = 6;
  payload.writeUInt16LE(tlvs.length, 2);
  payload.writeUInt16LE(0, 4);
  tlvs.copy(payload, 12);
  return payload;
}

class UBoxLiveStreamManager {
  constructor({ dumpDir, logDir, defaultOptions = {} }) {
    this.dumpDir = dumpDir;
    this.logDir = logDir || path.join(dumpDir, "..", "live-session-logs");
    this.defaultOptions = { ...DEFAULT_STREAM_OPTIONS, ...defaultOptions };
    this.session = null;
    this.events = [];
    this.sseClients = new Set();
    this.sessionLogFile = "";
    this.sessionLogBuffer = [];
    this.sessionLogTimer = null;
    this.restartPromise = null;
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  status() {
    return {
      active: Boolean(this.session),
      dumpDir: this.dumpDir,
      logDir: this.logDir,
      eventCount: this.events.length,
      session: this.session?.summary() || null,
    };
  }

  recentEvents(limit = 120) {
    return this.events.slice(-limit);
  }

  addSseClient(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.status())}\n\n`);
    for (const event of this.recentEvents(30)) {
      res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
    }
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }

  addMp4Client(res) {
    if (!this.session) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Live decoder is not running." }));
      return;
    }
    this.session.addMp4Client(res);
  }

  addH264Client(res, track = "primary") {
    if (!this.session) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Live decoder is not running." }));
      return;
    }
    this.session.addH264Client(res, track);
  }

  emit(event, detail = {}) {
    const row = {
      at: nowIso(),
      event,
      sessionId: detail.sessionId || this.session?.sessionId || undefined,
      ...detail,
    };
    this.events.push(row);
    this.events = this.events.slice(-500);
    this.writeSessionLog(row);
    for (const client of this.sseClients) {
      client.write(`event: log\ndata: ${JSON.stringify(row)}\n\n`);
    }
    return row;
  }

  openSessionLog(session) {
    this.closeSessionLog();
    fs.mkdirSync(this.logDir, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilePart(session.identity.uid)}-${session.randomId}.jsonl`;
    const file = path.join(this.logDir, fileName);
    session.logFile = file;
    this.sessionLogFile = file;
    this.sessionLogBuffer = [];
    this.sessionLogTimer = setInterval(() => this.flushSessionLog(), 250);
    this.writeSessionLog({
      at: nowIso(),
      event: "session-log-opened",
      sessionId: session.sessionId,
      uid: session.identity.uid,
      dumpFile: session.dumpFile,
      logFile: file,
      options: session.options,
      identity: {
        uid: session.identity.uid,
        loginIdPresent: Boolean(session.identity.loginId),
        loginPwdPresent: Boolean(session.identity.loginPwd),
        streamIndex: session.identity.streamIndex,
        zoneId: session.identity.zoneId,
        channel: session.identity.channel,
        cloudDeviceType: session.identity.cloudDeviceType,
        deviceType: session.identity.deviceType,
        videoSidSeed: session.identity.videoSidSeed,
      },
    });
  }

  writeSessionLog(row) {
    if (!this.sessionLogFile) return;
    this.sessionLogBuffer.push(`${JSON.stringify(row)}\n`);
    if (this.sessionLogBuffer.length >= 100) this.flushSessionLog();
  }

  flushSessionLog() {
    if (!this.sessionLogFile || !this.sessionLogBuffer.length) return;
    const chunk = this.sessionLogBuffer.join("");
    this.sessionLogBuffer = [];
    try {
      fs.appendFileSync(this.sessionLogFile, chunk);
    } catch {
      // Logging must never break live stream handling.
    }
  }

  closeSessionLog() {
    if (this.sessionLogTimer) clearInterval(this.sessionLogTimer);
    this.sessionLogTimer = null;
    this.flushSessionLog();
    this.sessionLogFile = "";
  }

  restartSession(session, reason, detail = {}) {
    if (this.session !== session || this.restartPromise) return;
    this.restartPromise = (async () => {
      this.emit("session-auto-restart", { sessionId: session.sessionId, reason, ...detail, previous: session.summary() });
      await this.stop();
      await this.start(session.identity, { ...session.options, forceRestart: true });
    })()
      .catch((error) => this.emit("session-auto-restart-error", { sessionId: session.sessionId, reason, message: error.message }))
      .finally(() => {
        this.restartPromise = null;
      });
  }

  async start(device, options = {}) {
    const sessionOptions = { ...this.defaultOptions, ...options };
    const identity = getDeviceIdentity(device);
    if (!identity.uid) {
      const error = new Error("Selected device does not include a UID.");
      error.status = 400;
      throw error;
    }
    const reusable =
      this.session &&
      this.session.identity.uid === identity.uid &&
      !sessionOptions.forceRestart &&
      !this.session.isStaleForReuse(sessionOptions);
    if (reusable) {
      this.emit("session-reused", this.session.summary());
      this.session.sendStartVideoControl();
      return this.status();
    }
    if (this.session && this.session.identity.uid === identity.uid) {
      this.emit("session-restart", {
        reason: sessionOptions.forceRestart ? "forced" : "stale-session",
        previous: this.session.summary(),
      });
    }
    await this.stop();
    fs.mkdirSync(this.dumpDir, { recursive: true });
    this.session = new UBoxLiveStreamSession({
      identity,
      manager: this,
      dumpFile: path.join(this.dumpDir, `${identity.uid}-${Date.now()}.h264`),
      options: sessionOptions,
    });
    this.openSessionLog(this.session);
    await this.session.start();
    return this.status();
  }

  async stop() {
    if (!this.session) return;
    const old = this.session;
    this.session = null;
    await old.stop();
    this.emit("session-stopped", { sessionId: old.sessionId, ...old.summary() });
    this.closeSessionLog();
  }

  decodePacket(hex) {
    const raw = Buffer.from(String(hex || "").replace(/[^a-fA-F0-9]/g, ""), "hex");
    const decoded = decodeDatagram(raw);
    if (!decoded.header) return { ok: false, bytes: raw.length };
    return {
      ok: true,
      bytes: raw.length,
      encrypted: decoded.encrypted,
      header: decoded.header,
      message: describeMsg(decoded.header.msg),
      prefix: decoded.clear.subarray(0, Math.min(decoded.clear.length, 96)).toString("hex"),
    };
  }
}

class UBoxLiveStreamSession {
  constructor({ identity, manager, dumpFile, options }) {
    this.identity = identity;
    this.manager = manager;
    this.dumpFile = dumpFile;
    this.options = options;
    this.socket = dgram.createSocket("udp4");
    this.randomId = randomIdForUid(identity.uid);
    this.sessionId = `${Date.now()}-${safeFilePart(identity.uid)}-${this.randomId}`;
    this.logFile = "";
    this.sid = 0;
    this.remoteSid = 0;
    this.videoSid = 0;
    this.channel = identity.channel || 0;
    this.relayEstablished = false;
    this.lastH264At = 0;
    this.lastKcpInputAt = 0;
    this.lastKcpMessageAt = 0;
    this.lastVideoKickAt = 0;
    this.lastRelayRenewAt = 0;
    this.relayPendingSince = Date.now();
    this.kcp = null;
    this.kcpConv = null;
    this.lastKcpHeader = null;
    this.kcpStateEvents = 0;
    this.kcpUna = null;
    this.kcpReceivedSns = new Set();
    this.lastKcpSkipAt = 0;
    this.lastRdtAckAt = 0;
    this.lastStartVideoKcpAt = 0;
    this.rdtAckState = {
      lastFrameSeq: 0,
      hasFrame: false,
      receivedFrameSeqs: new Set(),
    };
    this.muxer = new LiveMp4Muxer({ fps: Number(options.fps || 15) });
    this.mp4Clients = new Set();
    this.mp4Backlog = [];
    this.h264Tracks = new Map([
      ["primary", { clients: new Set(), backlog: [], frames: 0 }],
      ["secondary", { clients: new Set(), backlog: [], frames: 0 }],
    ]);
    this.counters = {
      rx: 0,
      tx: 0,
      decoded: 0,
      kcpSegments: 0,
      kcpMessages: 0,
      videoFrames: 0,
      annexBFrames: 0,
      bytesWritten: 0,
      mp4Clients: 0,
      mp4Fragments: 0,
      h264Clients: 0,
      h264Frames: 0,
      kcpGapDrops: 0,
      kcpInputErrors: 0,
      kcpOutputPackets: 0,
      rdtAckPackets: 0,
      videoKicks: 0,
      relayRenews: 0,
    };
    this.startedAt = nowIso();
  }

  summary() {
    return {
      uid: this.identity.uid,
      loginIdPresent: Boolean(this.identity.loginId),
      loginPwdPresent: Boolean(this.identity.loginPwd),
      randomId: this.randomId,
      sid: this.sid,
      remoteSid: this.remoteSid,
      videoSid: this.videoSid,
      channel: this.channel,
      dumpFile: this.dumpFile,
      logFile: this.logFile,
      mp4Ready: Boolean(this.muxer.initSegment),
      mp4Codec: this.muxer.codec,
      mp4Backlog: this.mp4Backlog.length,
      h264Backlog: this.h264Tracks.get("primary").backlog.length,
      h264Tracks: Object.fromEntries([...this.h264Tracks.entries()].map(([track, state]) => [
        track,
        {
          clients: state.clients.size,
          backlog: state.backlog.length,
          frames: state.frames,
        },
      ])),
      counters: this.counters,
      kcpState: this.kcp
        ? {
            conv: this.kcpConv,
            rcvNxt: this.kcp.rcv_nxt,
            rcvQueue: this.kcp.rcv_queue.length,
            rcvBuf: this.kcp.rcv_buf.length,
            peekSize: this.kcp.peekSize(),
            sndUna: this.kcp.snd_una,
            sndNxt: this.kcp.snd_nxt,
            lastKcpInputAgoMs: this.lastKcpInputAt ? Date.now() - this.lastKcpInputAt : null,
            lastKcpMessageAgoMs: this.lastKcpMessageAt ? Date.now() - this.lastKcpMessageAt : null,
            lastH264AgoMs: this.lastH264At ? Date.now() - this.lastH264At : null,
          }
        : null,
      startedAt: this.startedAt,
    };
  }

  isStaleForReuse(options = this.options) {
    const now = Date.now();
    const startedAt = Date.parse(this.startedAt);
    const ageMs = Number.isFinite(startedAt) ? now - startedAt : 0;
    const staleAfterMs = Number(options.reuseStaleAfterMs || 10000);
    if (ageMs < staleAfterMs) return false;
    const videoQuietMs = this.lastH264At ? now - this.lastH264At : ageMs;
    const transportQuietMs = this.lastKcpInputAt ? now - this.lastKcpInputAt : ageMs;
    return videoQuietMs > staleAfterMs || transportQuietMs > staleAfterMs * 2;
  }

  async start() {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.off("error", onError);
        resolve();
      };
      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(0);
    });

    this.socket.on("message", (raw, rinfo) => this.handleDatagram(raw, rinfo));
    this.socket.on("error", (error) => this.manager.emit("udp-error", { message: error.message }));
    this.manager.emit("session-started", this.summary());
    this.sendDiscovery();
    this.relayTimer = setInterval(() => this.sendRelayWakeup(), 1000);
    this.aliveTimer = setInterval(() => this.sendAlive(), 1000);
    if (this.options.enableRdtAck) {
      this.rdtAckTimer = setInterval(() => this.sendRdtVideoAck("timer"), Number(this.options.rdtAckIntervalMs || 25));
    }
    this.snapshotTimer = setInterval(() => {
      this.manager.emit("session-snapshot", this.summary());
    }, Number(this.options.sessionSnapshotMs || 2000));
    this.videoWatchdogTimer = setInterval(() => this.checkVideoWatchdog(), 2000);
    this.kcpTimer = setInterval(() => this.updateKcp(), 20);
  }

  async stop() {
    clearInterval(this.relayTimer);
    clearInterval(this.aliveTimer);
    clearInterval(this.rdtAckTimer);
    clearInterval(this.snapshotTimer);
    clearInterval(this.videoWatchdogTimer);
    clearInterval(this.kcpTimer);
    for (const client of this.mp4Clients) client.res.end();
    this.mp4Clients.clear();
    for (const state of this.h264Tracks.values()) {
      for (const client of state.clients) client.res.end();
      state.clients.clear();
    }
    await new Promise((resolve) => this.socket.close(resolve));
  }

  addMp4Client(res) {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const client = { res, initSent: false };
    this.mp4Clients.add(client);
    this.counters.mp4Clients = this.mp4Clients.size;
    if (this.muxer.initSegment) {
      res.write(this.muxer.initSegment);
      client.initSent = true;
      for (const fragment of this.mp4Backlog) res.write(fragment);
    }
    this.manager.emit("mp4-client-connected", { clients: this.mp4Clients.size, codec: this.muxer.codec, backlog: this.mp4Backlog.length });
    res.on("close", () => {
      this.mp4Clients.delete(client);
      this.counters.mp4Clients = this.mp4Clients.size;
      this.manager.emit("mp4-client-disconnected", { clients: this.mp4Clients.size });
    });
  }

  h264Track(track) {
    return this.h264Tracks.get(track) || this.h264Tracks.get("primary");
  }

  updateH264ClientCounter() {
    this.counters.h264Clients = [...this.h264Tracks.values()].reduce((sum, state) => sum + state.clients.size, 0);
  }

  addH264Client(res, track = "primary") {
    const state = this.h264Track(track);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-stream-format": "uint32be-length-prefixed-annexb-h264",
      "x-stream-track": track,
    });
    const client = { res, track };
    state.clients.add(client);
    this.updateH264ClientCounter();
    for (const frame of state.backlog) res.write(framePacket(frame));
    this.manager.emit("h264-client-connected", { track, clients: state.clients.size, backlog: state.backlog.length });
    res.on("close", () => {
      state.clients.delete(client);
      this.updateH264ClientCounter();
      this.manager.emit("h264-client-disconnected", { track, clients: state.clients.size });
    });
  }

  send(address, port, clearPacket, encrypted = true) {
    const packet = encrypted ? encodeP4P(clearPacket) : clearPacket;
    this.socket.send(packet, port, address);
    this.counters.tx += 1;
  }

  sendDiscovery() {
    const payload = Buffer.alloc(44);
    toFixedAsciiBuffer(this.identity.uid, 20).copy(payload, 4);
    const packet = buildPacket({ msg: 0x1051, payload, msgLen: 0x28 });
    for (const host of DISCOVERY_SERVERS) this.send(host, 10240, packet, true);
    this.manager.emit("p4p-query-sent", { uid: this.identity.uid, servers: DISCOVERY_SERVERS.length });
  }

  sendRelayWakeup() {
    if (this.relayEstablished) return;
    if (!this.relayPendingSince) this.relayPendingSince = Date.now();
    const payload = Buffer.alloc(44);
    payload[0] = 1;
    payload[1] = 1;
    toFixedAsciiBuffer(this.identity.uid, 20).copy(payload, 4);
    const packet = buildPacket({ msg: 0x1201, payload, msgLen: 0x24 });
    for (const host of RELAY_SERVERS) this.send(host, 20001, packet, true);
    this.manager.emit("relay-wakeup-sent", { servers: RELAY_SERVERS.length });
  }

  sendRelayStreamRequest(address, port) {
    if (this.relayEstablished) return;
    const payload = Buffer.alloc(108);
    payload[0] = 1;
    payload[3] = this.identity.deviceType || 2;
    payload[12] = 0x0a;
    payload[14] = 0x02;
    payload[15] = 0x0f;
    payload.writeUInt32LE(crypto.randomBytes(4).readUInt32LE(0) & 0xffff, 16);
    toFixedAsciiBuffer(this.identity.uid, 20).copy(payload, 24);
    toFixedAsciiBuffer(this.identity.loginId, 16).copy(payload, 44);
    payload[66] = this.identity.videoSidSeed & 0xff;
    payload.writeUInt32LE(this.randomId, 72);
    toFixedAsciiBuffer(this.identity.loginPwd || "admin", 20).copy(payload, 76);
    payload[92] = 9;
    payload[95] = 1;
    payload.writeUInt32LE(this.identity.zoneId || 0, 100);
    const packet = buildPacket({ msg: 0x1205, payload, msgLen: 0x24 });
    this.send(address, port, packet, true);
    this.manager.emit("relay-stream-req-sent", {
      to: `${address}:${port}`,
      loginIdPresent: Boolean(this.identity.loginId),
      loginPwdPresent: Boolean(this.identity.loginPwd),
      p4pDeviceType: this.identity.deviceType,
      cloudDeviceType: this.identity.cloudDeviceType,
      videoSidSeed: this.identity.videoSidSeed,
      prefix: payload.subarray(0, 108).toString("hex"),
    });
  }

  sendAlive() {
    if (!this.relayPeer) return;
    const payload = Buffer.alloc(20);
    const aliveSid = Number.isFinite(this.videoSid) ? this.videoSid : this.sid;
    payload[0] = aliveSid & 0xff;
    payload[1] = this.channel & 0xff;
    payload.writeUInt32LE(this.randomId, 4);
    const packet = buildPacket({
      msg: 0x1405,
      payload,
      sidOrChannel: aliveSid & 0xffff,
      msgLen: 0x24,
      seqOrParam: this.remoteSid || this.channel,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
  }

  checkVideoWatchdog() {
    const now = Date.now();
    if (!this.relayEstablished || !this.relayPeer) {
      const pendingMs = this.relayPendingSince ? now - this.relayPendingSince : now - Date.parse(this.startedAt);
      const timeoutMs = Number(this.options.relayReestablishTimeoutMs || 8000);
      if (pendingMs > timeoutMs) {
        this.manager.emit("relay-reestablish-timeout", {
          sessionId: this.sessionId,
          pendingMs,
          timeoutMs,
          relay: Boolean(this.relayPeer),
          sid: this.sid,
          remoteSid: this.remoteSid,
          videoSid: this.videoSid,
        });
        this.manager.restartSession(this, "relay-reestablish-timeout", { pendingMs, timeoutMs });
      }
      return;
    }
    const quietMs = this.lastH264At ? now - this.lastH264At : now - Date.parse(this.startedAt);
    const transportQuietMs = this.lastKcpInputAt ? now - this.lastKcpInputAt : Infinity;
    if (quietMs < 5000 || now - this.lastVideoKickAt < 5000) return;
    this.lastVideoKickAt = now;
    this.counters.videoKicks += 1;
    const skipped = this.maybeRecoverKcpStall("watchdog");
    this.manager.emit("video-watchdog-kick", {
      quietMs,
      transportQuietMs,
      skipped,
      kicks: this.counters.videoKicks,
      sid: this.sid,
      remoteSid: this.remoteSid,
      videoSid: this.videoSid,
    });
    const relayRenewAfterMs = Number(this.options.relayRenewAfterMs || 15000);
    const relayRenewThrottleMs = Number(this.options.relayRenewThrottleMs || 10000);
    if (transportQuietMs > relayRenewAfterMs && now - this.lastRelayRenewAt > relayRenewThrottleMs) {
      this.renewRelay(transportQuietMs);
      return;
    }
    this.sendStartVideoControl();
  }

  renewRelay(quietMs) {
    this.lastRelayRenewAt = Date.now();
    this.counters.relayRenews += 1;
    this.manager.emit("relay-renew", {
      quietMs,
      renews: this.counters.relayRenews,
      oldSid: this.sid,
      oldRemoteSid: this.remoteSid,
      oldVideoSid: this.videoSid,
    });
    this.relayEstablished = false;
    this.relayPeer = null;
    this.relayPendingSince = Date.now();
    this.sid = 0;
    this.remoteSid = 0;
    this.videoSid = 0;
    this.resetKcp();
    this.kcpUna = null;
    this.kcpReceivedSns = new Set();
    this.lastKcpSkipAt = 0;
    this.lastStartVideoKcpAt = 0;
    this.sendRelayWakeup();
  }

  sendStartVideoControl() {
    if (!this.options.enableStartVideoControl) {
      this.manager.emit("start-video-skipped", { reason: "disabled-pcap-match" });
      return;
    }
    if (!this.relayPeer || !this.remoteSid) {
      this.manager.emit("start-video-skipped", {
        relay: Boolean(this.relayPeer),
        sid: this.sid,
        remoteSid: this.remoteSid,
      });
      return;
    }
    const payload = Buffer.alloc(16);
    payload[0] = 9;
    payload[1] = 0;
    payload[2] = this.identity.streamIndex & 0xff;
    payload[3] = 1;
    if (this.kcp) {
      this.sendStartVideoKcp(payload, "control");
      return;
    }
    const packet = buildPacket({
      msg: 0x1407,
      payload,
      sidOrChannel: this.sid & 0xffff,
      msgLen: 0x24,
      seqOrParam: this.remoteSid & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.manager.emit("start-video-sent", {
      to: `${this.relayPeer.address}:${this.relayPeer.port}`,
      sid: this.sid,
      remoteSid: this.remoteSid,
      videoSid: this.videoSid,
      channel: this.channel,
      streamIndex: this.identity.streamIndex,
    });
  }

  sendStartVideoKcp(payload, reason = "start") {
    if (!this.kcp) return false;
    const record = Buffer.alloc(16 + payload.length);
    record.writeUInt16LE(1, 0);
    record[2] = this.channel & 0xff;
    record[3] = 0;
    record.writeUInt16LE(0, 4);
    record.writeUInt16LE(0, 6);
    record.writeUInt32LE(payload.length, 8);
    record.writeUInt32LE(0, 12);
    payload.copy(record, 16);
    const ret = this.kcp.send(record);
    this.kcp.flush(false);
    this.lastStartVideoKcpAt = Date.now();
    this.manager.emit("start-video-kcp-sent", {
      reason,
      ret,
      bytes: record.length,
      sid: this.sid,
      remoteSid: this.remoteSid,
      conv: this.kcpConv,
      streamIndex: this.identity.streamIndex,
    });
    return ret >= 0;
  }

  observeVideoRecord(record) {
    if (!this.options.enableRdtAck) return;
    if (!record || !Number.isFinite(record.frameSeq)) return;
    const seq = record.frameSeq & 0xffff;
    this.rdtAckState.lastFrameSeq = seq;
    this.rdtAckState.hasFrame = true;
    this.rdtAckState.receivedFrameSeqs.add(seq);

    const floor = seqMinus(seq, 254);
    this.rdtAckState.receivedFrameSeqs = new Set(
      [...this.rdtAckState.receivedFrameSeqs].filter((value) => seqDistance(floor, value) <= 254),
    );
    if (Date.now() - this.lastRdtAckAt >= Number(this.options.rdtAckMinIntervalMs || 20)) {
      this.sendRdtVideoAck("frame");
    }
  }

  sendRdtVideoAck(reason = "timer") {
    if (!this.relayEstablished || !this.relayPeer || !this.sid || !this.remoteSid) return false;
    if (!this.rdtAckState.hasFrame) return false;
    const payload = buildRdtAckPayload(this.rdtAckState);
    const packet = buildPacket({
      msg: 0x1403,
      payload,
      sidOrChannel: this.sid & 0xffff,
      msgLen: 0x24,
      seqOrParam: this.remoteSid & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.lastRdtAckAt = Date.now();
    this.counters.rdtAckPackets += 1;
    if (this.counters.rdtAckPackets <= 5 || this.counters.rdtAckPackets % 100 === 0) {
      this.manager.emit("rdt-video-ack-sent", {
        reason,
        packets: this.counters.rdtAckPackets,
        lastFrameSeq: this.rdtAckState.lastFrameSeq,
        received: this.rdtAckState.receivedFrameSeqs.size,
        bytes: payload.length,
        prefix: payload.subarray(0, 48).toString("hex"),
      });
    }
    return true;
  }

  handleDatagram(raw, rinfo) {
    this.counters.rx += 1;
    const decoded = decodeDatagram(raw);
    if (!decoded.header) {
      this.manager.emit("udp-undecoded", { from: `${rinfo.address}:${rinfo.port}`, bytes: raw.length });
      return;
    }
    this.counters.decoded += 1;
    const { clear, header } = decoded;
    const payload = clear.subarray(16, 16 + Math.min(header.length, clear.length - 16));
    this.manager.emit("p4p-packet", {
      from: `${rinfo.address}:${rinfo.port}`,
      encrypted: decoded.encrypted,
      msg: `0x${header.msg.toString(16)}`,
      name: describeMsg(header.msg),
      len: header.length,
      msgLen: header.msgLen,
      sidOrChannel: header.sidOrChannel,
    });

    if (header.msg === 0x1202) {
      if (this.relayEstablished) return;
      this.relayPeer = { address: rinfo.address, port: rinfo.port };
      this.sendRelayStreamRequest(rinfo.address, rinfo.port);
    } else if (header.msg === 0x1206) {
      if (this.relayEstablished) return;
      this.relayPeer = { address: rinfo.address, port: rinfo.port };
      this.videoSid = payload[54] || this.videoSid;
      this.sid = payload.length > 55 ? payload[55] : this.sid;
      this.remoteSid = payload.length >= 60 ? payload.readUInt16LE(58) : this.remoteSid;
      this.channel = this.identity.channel || 0;
      this.relayEstablished = true;
      this.relayPendingSince = null;
      this.manager.emit("relay-stream-rsp", {
        sid: this.sid,
        remoteSid: this.remoteSid,
        videoSid: this.videoSid,
        channel: this.channel,
        prefix: payload.subarray(0, 80).toString("hex"),
      });
      this.sendStartVideoControl();
    } else if (header.msg === 0x1406 || header.msg === 0x140a) {
      if (header.msg === 0x140a && header.sidOrChannel && header.sidOrChannel !== this.remoteSid) {
        const previous = this.remoteSid;
        this.remoteSid = header.sidOrChannel;
        this.manager.emit("remote-sid-learned", { previous, remoteSid: this.remoteSid, msg: `0x${header.msg.toString(16)}` });
      }
      if (header.seqOrParam && header.seqOrParam !== this.videoSid) {
        const previous = this.videoSid;
        this.videoSid = header.seqOrParam;
        this.manager.emit("video-sid-learned", { previous, videoSid: this.videoSid, msg: `0x${header.msg.toString(16)}` });
      }
      if (header.msg === 0x140a) {
        const kcpBytes = clear.subarray(16, 16 + header.length);
        this.handleKcpDatagram(kcpBytes, header, rinfo);
      }
    } else if (header.msg === 0x1409) {
      const kcpBytes = clear.subarray(16, 16 + header.length);
      this.handleKcpDatagram(kcpBytes, header, rinfo);
    }
  }

  handleKcpDatagram(kcpBytes, header, rinfo) {
    const segments = parseKcpSegments(kcpBytes);
    if (!segments.length) {
      this.manager.emit("kcp-unparsed", { from: `${rinfo.address}:${rinfo.port}`, bytes: kcpBytes.length, prefix: kcpBytes.subarray(0, 48).toString("hex") });
      return;
    }
    this.counters.kcpSegments += segments.length;
    const dataSegments = [];
    for (const segment of segments) {
      this.manager.emit("kcp-segment", {
        conv: segment.conv,
        cmd: `0x${segment.cmd.toString(16)}`,
        frg: segment.frg,
        sn: segment.sn,
        una: segment.una,
        len: segment.len,
        p4pKind: header.kind,
      });
      if (segment.cmd === 0x51) dataSegments.push(segment);
    }
    if (!this.ensureKcp(segments[0].conv)) return;
    this.lastKcpHeader = header;
    this.lastKcpInputAt = Date.now();
    if (!this.lastStartVideoKcpAt && this.options.enableStartVideoControl) this.sendStartVideoControl();
    const beforeQueue = this.kcp.rcv_queue.length;
    const result = this.kcp.input(kcpBytes, true, true);
    if (typeof result === "number" && result < 0) {
      this.counters.kcpInputErrors += 1;
      this.manager.emit("kcp-input-error", {
        code: result,
        conv: this.kcpConv,
        bytes: kcpBytes.length,
        errors: this.counters.kcpInputErrors,
        prefix: kcpBytes.subarray(0, 48).toString("hex"),
      });
      return;
    }
    if (dataSegments.length) {
      this.trackKcpReceipt(dataSegments.map((segment) => segment.sn));
    }
    this.drainKcpMessages();
    if (this.kcp.rcv_queue.length !== beforeQueue || dataSegments.length) {
      this.kcpStateEvents += 1;
      if (this.kcpStateEvents <= 5 || this.kcpStateEvents % 100 === 0) {
        this.manager.emit("kcp-state", {
          conv: this.kcpConv,
          rcvNxt: this.kcp.rcv_nxt,
          rcvQueue: this.kcp.rcv_queue.length,
          rcvBuf: this.kcp.rcv_buf.length,
          sndUna: this.kcp.snd_una,
          sndNxt: this.kcp.snd_nxt,
        });
      }
    }
  }

  resetKcp() {
    if (this.kcp) this.kcp.release();
    this.kcp = null;
    this.kcpConv = null;
    this.lastKcpHeader = null;
    this.kcpStateEvents = 0;
  }

  ensureKcp(conv) {
    if (!Number.isFinite(conv)) return false;
    if (this.kcp && this.kcpConv === conv) return true;
    if (this.kcp && this.kcpConv !== conv) {
      this.manager.emit("kcp-conv-changed", { previous: this.kcpConv, next: conv });
      this.resetKcp();
    }
    this.kcpConv = conv;
    this.kcp = new Kcp(conv, { session: this });
    this.kcp.setNoDelay(1, 10, 0, 0);
    this.kcp.setWndSize(128, 256);
    this.kcp.setOutput((data, size) => this.sendKcpOutput(data, size));
    this.manager.emit("kcp-created", { conv, sndWnd: this.kcp.snd_wnd, rcvWnd: this.kcp.rcv_wnd, mtu: this.kcp.mtu });
    return true;
  }

  trackKcpReceipt(sns) {
    for (const sn of sns) this.kcpReceivedSns.add(sn);
    const minSn = Math.min(...sns);
    if (this.kcpUna === null || minSn < this.kcpUna) this.kcpUna = minSn;
    while (this.kcpReceivedSns.has(this.kcpUna)) {
      this.kcpReceivedSns.delete(this.kcpUna);
      this.kcpUna += 1;
    }
    if (this.kcpReceivedSns.size > 2048) {
      const floor = (this.kcpUna || 0) - 1;
      this.kcpReceivedSns = new Set([...this.kcpReceivedSns].filter((value) => value > floor).slice(-1024));
    }
  }

  sendKcpOutput(data, size) {
    if (!this.relayPeer || !size) return;
    const payload = Buffer.from(data.subarray(0, size));
    const header = this.lastKcpHeader;
    const packet = buildPacket({
      msg: 0x1409,
      payload,
      sidOrChannel: this.sid & 0xffff,
      msgLen: 0x24,
      seqOrParam: this.remoteSid || this.videoSid || header?.sidOrChannel || this.channel,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.counters.kcpOutputPackets += 1;
    if (this.counters.kcpOutputPackets <= 5 || this.counters.kcpOutputPackets % 50 === 0) {
      this.manager.emit("kcp-output-sent", { bytes: payload.length, packets: this.counters.kcpOutputPackets, prefix: payload.subarray(0, 24).toString("hex") });
    }
  }

  promoteKcpReceiveBuffer() {
    if (!this.kcp) return 0;
    let count = 0;
    for (const segment of this.kcp.rcv_buf) {
      if (segment.sn !== this.kcp.rcv_nxt || this.kcp.rcv_queue.length + count >= this.kcp.rcv_wnd) break;
      this.kcp.rcv_nxt += 1;
      count += 1;
    }
    if (count > 0) {
      this.kcp.rcv_queue.push(...this.kcp.rcv_buf.slice(0, count));
      this.kcp.rcv_buf.splice(0, count);
    }
    return count;
  }

  forceKcpLiveSkip(reason) {
    if (!this.kcp) return false;
    let droppedQueued = 0;
    let skippedSequences = 0;

    if (this.kcp.peekSize() < 0 && this.kcp.rcv_queue.length > 0) {
      do {
        const [segment] = this.kcp.rcv_queue.splice(0, 1);
        droppedQueued += 1;
        if (segment?.frg === 0) break;
      } while (this.kcp.rcv_queue.length > 0);
    }

    if (this.kcp.rcv_queue.length === 0 && this.kcp.rcv_buf.length > 0) {
      const next = this.kcp.rcv_buf[0].sn;
      if (next > this.kcp.rcv_nxt) {
        skippedSequences = next - this.kcp.rcv_nxt;
        this.kcp.rcv_nxt = next;
      }
      this.promoteKcpReceiveBuffer();
    }

    if (!droppedQueued && !skippedSequences) return false;
    this.counters.kcpGapDrops += 1;
    this.manager.emit("kcp-live-skip", {
      reason,
      drops: this.counters.kcpGapDrops,
      droppedQueued,
      skippedSequences,
      rcvNxt: this.kcp.rcv_nxt,
      rcvQueue: this.kcp.rcv_queue.length,
      rcvBuf: this.kcp.rcv_buf.length,
    });
    this.drainKcpMessages();
    return true;
  }

  maybeRecoverKcpStall(reason) {
    if (!this.kcp) return false;
    const now = Date.now();
    if (now - this.lastKcpSkipAt < Number(this.options.kcpSkipThrottleMs || 1500)) return false;
    const messageQuietMs = this.lastKcpMessageAt ? now - this.lastKcpMessageAt : Infinity;
    if (messageQuietMs < Number(this.options.kcpSkipAfterMs || 2500)) return false;
    if (!this.kcp.rcv_queue.length && !this.kcp.rcv_buf.length) return false;
    this.lastKcpSkipAt = now;
    return this.forceKcpLiveSkip(reason);
  }

  updateKcp() {
    if (!this.kcp) return;
    this.kcp.update();
    this.drainKcpMessages();
    this.maybeRecoverKcpStall("timer");
  }

  drainKcpMessages() {
    if (!this.kcp) return;
    for (;;) {
      const size = this.kcp.peekSize();
      if (size <= 0) return;
      const out = Buffer.alloc(size);
      const read = this.kcp.recv(out);
      if (read <= 0) return;
      this.handleKcpMessage(out.subarray(0, read));
    }
  }

  handleKcpMessage(message) {
    this.counters.kcpMessages += 1;
    this.lastKcpMessageAt = Date.now();
    const record = parseInnerRecord(message);
    if (!record) {
      this.manager.emit("kcp-message", { bytes: message.length, parsed: false });
      return;
    }
    const isVideo = record.type === 0x11 || record.type === 0x14;
    this.manager.emit("inner-record", {
      type: `0x${record.type.toString(16)}`,
      streamByte: record.streamByte,
      recordLength: record.recordLength,
      payloadBytes: record.payload.length,
      frameSeq: record.frameSeq,
      video: isVideo,
      annexB: isAnnexB(record.payload),
      frameMeta: record.frameMeta,
      frameInfoPrefix: record.frameInfo.subarray(0, 16).toString("hex"),
      prefix: record.payload.subarray(0, 16).toString("hex"),
    });
    if (isVideo) {
      this.observeVideoRecord(record);
      this.counters.videoFrames += 1;
      const annexB = extractAnnexB(record.payload);
      if (annexB) {
        fs.appendFileSync(this.dumpFile, annexB);
        this.counters.annexBFrames += 1;
        this.counters.bytesWritten += annexB.length;
        const clean = cleanAnnexB(annexB);
        if (clean) {
          const track = record.frameMeta?.cam === 1 || record.streamByte === 4 ? "secondary" : "primary";
          this.broadcastH264(clean, track);
          if (track === "primary") this.broadcastMp4(clean);
        }
      }
    }
  }

  broadcastH264(annexB, track = "primary") {
    this.lastH264At = Date.now();
    const state = this.h264Track(track);
    state.backlog.push(annexB);
    state.backlog = state.backlog.slice(-120);
    const packet = framePacket(annexB);
    for (const client of [...state.clients]) {
      try {
        client.res.write(packet);
      } catch {
        state.clients.delete(client);
      }
    }
    this.updateH264ClientCounter();
    this.counters.h264Frames += 1;
    state.frames += 1;
    if (this.counters.h264Frames <= 5 || this.counters.h264Frames % 30 === 0) {
      this.manager.emit("h264-frame", { track, bytes: annexB.length, clients: state.clients.size, backlog: state.backlog.length });
    }
  }

  broadcastMp4(annexB) {
    const muxed = this.muxer.pushAnnexB(annexB);
    if (!muxed) return;
    this.mp4Backlog.push(muxed.fragment);
    this.mp4Backlog = this.mp4Backlog.slice(-120);
    for (const client of [...this.mp4Clients]) {
      try {
        if (!client.initSent) {
          client.res.write(muxed.init);
          client.initSent = true;
        }
        client.res.write(muxed.fragment);
      } catch {
        this.mp4Clients.delete(client);
      }
    }
    this.counters.mp4Clients = this.mp4Clients.size;
    this.counters.mp4Fragments += 1;
    this.manager.emit("mp4-fragment", {
      bytes: muxed.fragment.length,
      codec: muxed.codec,
      keyframe: muxed.keyframe,
      clients: this.mp4Clients.size,
    });
  }
}

module.exports = {
  UBoxLiveStreamManager,
  getDeviceIdentity,
  parseInnerRecord,
  parseKcpSegments,
};
