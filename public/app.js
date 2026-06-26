const state = {
  devices: [],
  selected: null,
  token: null,
};

const els = {
  status: document.querySelector("#status"),
  loginForm: document.querySelector("#loginForm"),
  logoutBtn: document.querySelector("#logoutBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  devices: document.querySelector("#devices"),
  selectedDevice: document.querySelector("#selectedDevice"),
  tokenBtn: document.querySelector("#tokenBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  tokenOutput: document.querySelector("#tokenOutput"),
  cam0Video: document.querySelector("#cam0Video"),
  cam1Video: document.querySelector("#cam1Video"),
  cam0Hint: document.querySelector("#cam0Hint"),
  cam1Hint: document.querySelector("#cam1Hint"),
  manualStream: document.querySelector("#manualStream"),
  manualBtn: document.querySelector("#manualBtn"),
  captureRefreshBtn: document.querySelector("#captureRefreshBtn"),
  playBothBtn: document.querySelector("#playBothBtn"),
  playCam0Btn: document.querySelector("#playCam0Btn"),
  playCam1Btn: document.querySelector("#playCam1Btn"),
  clearLogBtn: document.querySelector("#clearLogBtn"),
  captureStatus: document.querySelector("#captureStatus"),
  playbackLog: document.querySelector("#playbackLog"),
};

const videoByName = {
  cam0: null,
  cam1: null,
};

const hintByName = {
  cam0: null,
  cam1: null,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error || `Request failed: ${response.status}`;
    const error = new Error(message);
    error.data = data;
    throw error;
  }
  return data;
}

function setStatus(message, cls = "") {
  els.status.className = cls;
  els.status.textContent = message;
}

function showError(error) {
  setStatus(error.message, "error");
  els.tokenOutput.textContent = JSON.stringify(error.data || { error: error.message }, null, 2);
  logPlayback("app", "error", { message: error.message, data: error.data });
}

function flattenDevices(reply) {
  const data = reply?.data || {};
  const fromItems = (data.items || []).map((item) => ({
    uid: item.device_uid,
    name: item.device_name || item.ps_name || item.device_uid,
    owner: item.is_owner,
    source: "items",
    raw: item,
  }));
  const fromInfos = (data.infos || []).map((info) => ({
    uid: info.device_uid,
    name: info.device_name || info.ps_name || info.device_uid,
    owner: info.is_owner,
    source: "infos",
    raw: info,
  }));

  const merged = new Map();
  for (const device of [...fromItems, ...fromInfos]) {
    if (!device.uid) continue;
    merged.set(device.uid, { ...(merged.get(device.uid) || {}), ...device });
  }
  return [...merged.values()];
}

function renderDevices() {
  els.devices.innerHTML = "";
  if (!state.devices.length) {
    els.devices.className = "devices empty";
    els.devices.textContent = "No cameras returned by the UBox account.";
    return;
  }

  els.devices.className = "devices";
  for (const device of state.devices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `device${state.selected?.uid === device.uid ? " active" : ""}`;
    btn.innerHTML = `
      <strong></strong>
      <span></span>
      <span></span>
    `;
    btn.querySelector("strong").textContent = device.name || "Camera";
    btn.querySelectorAll("span")[0].textContent = device.uid;
    btn.querySelectorAll("span")[1].textContent = device.owner ? "Owner" : "Shared";
    btn.addEventListener("click", () => selectDevice(device));
    els.devices.appendChild(btn);
  }
}

function selectDevice(device) {
  state.selected = device;
  state.token = null;
  els.selectedDevice.textContent = device.name || device.uid;
  els.tokenBtn.disabled = false;
  els.copyBtn.disabled = true;
  els.tokenOutput.textContent = "";
  els.cam0Hint.textContent = "Captured stream not loaded.";
  els.cam1Hint.textContent = "Captured stream not loaded.";
  renderDevices();
}

async function refreshDevices() {
  setStatus("Loading cameras...");
  const reply = await api("/api/devices");
  state.devices = flattenDevices(reply);
  state.selected = null;
  state.token = null;
  els.tokenBtn.disabled = true;
  els.copyBtn.disabled = true;
  els.selectedDevice.textContent = "No camera selected";
  els.cam0Hint.textContent = "Captured stream not loaded.";
  els.cam1Hint.textContent = "Captured stream not loaded.";
  renderDevices();
  setStatus(`Loaded ${state.devices.length} camera${state.devices.length === 1 ? "" : "s"}.`, "ok");
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Logging in...");
  els.tokenOutput.textContent = "";
  try {
    const payload = {
      account: document.querySelector("#account").value.trim(),
      password: document.querySelector("#password").value,
      lang: document.querySelector("#lang").value.trim() || "en",
      region: document.querySelector("#region").value.trim() || "US",
      app: document.querySelector("#appName").value.trim() || "UBox",
      device_type: Number(document.querySelector("#deviceType").value || 1),
    };
    const reply = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setStatus(`Logged in as ${reply.account || payload.account}.`, "ok");
    els.logoutBtn.hidden = false;
    els.refreshBtn.disabled = false;
    await refreshDevices();
  } catch (error) {
    showError(error);
  }
});

els.logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  state.devices = [];
  state.selected = null;
  state.token = null;
  els.logoutBtn.hidden = true;
  els.refreshBtn.disabled = true;
  els.tokenBtn.disabled = true;
  els.copyBtn.disabled = true;
  els.devices.className = "devices empty";
  els.devices.textContent = "Log in to load cameras.";
  els.selectedDevice.textContent = "No camera selected";
  els.tokenOutput.textContent = "";
  setStatus("Not connected");
});

els.refreshBtn.addEventListener("click", () => {
  refreshDevices().catch(showError);
});

els.tokenBtn.addEventListener("click", async () => {
  if (!state.selected) return;
  setStatus("Requesting live-feed token...");
  try {
    const reply = await api("/api/webrtc-token", {
      method: "POST",
      body: JSON.stringify({ uid: state.selected.uid }),
    });
    state.token = reply;
    els.tokenOutput.textContent = JSON.stringify(reply, null, 2);
    els.copyBtn.disabled = false;
    els.cam0Hint.textContent = "";
    els.cam1Hint.textContent = "";
    logPlayback("api", "token acquired", {
      uid: state.selected.uid,
      note: "The APK uses a proprietary P4P/video layer after this point.",
    });
    setStatus("Feed token acquired.", "ok");
  } catch (error) {
    showError(error);
  }
});

els.copyBtn.addEventListener("click", async () => {
  if (!state.token) return;
  await navigator.clipboard.writeText(JSON.stringify(state.token, null, 2));
  setStatus("Token JSON copied.", "ok");
});

els.manualBtn.addEventListener("click", () => {
  const value = els.manualStream.value.trim();
  if (!value) return;

  if (value.startsWith("http://") || value.startsWith("https://")) {
    els.cam0Video.src = value;
    els.cam0Hint.textContent = "";
    els.cam0Video.play().catch(() => {
      els.cam0Hint.textContent = "The browser could not play that stream URL.";
    });
    return;
  }

  if (value.startsWith("rtsp://")) {
    els.cam0Hint.textContent =
      "Browsers cannot play RTSP directly. Open this URL in VLC or ffplay if your camera exposes RTSP.";
    els.tokenOutput.textContent = value;
  }
});

function logPlayback(camera, event, detail = {}) {
  const row = {
    at: new Date().toLocaleTimeString(),
    camera,
    event,
    ...detail,
  };
  const line = JSON.stringify(row);
  const existing = els.playbackLog.textContent ? `${els.playbackLog.textContent}\n` : "";
  const lines = `${existing}${line}`.split("\n").slice(-160);
  els.playbackLog.textContent = lines.join("\n");
  els.playbackLog.scrollTop = els.playbackLog.scrollHeight;
}

function videoSnapshot(video) {
  const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
  const error = video.error
    ? {
        code: video.error.code,
        message: video.error.message || "",
      }
    : null;
  return {
    t: Number(video.currentTime.toFixed(3)),
    ready: video.readyState,
    network: video.networkState,
    paused: video.paused,
    ended: video.ended,
    width: video.videoWidth,
    height: video.videoHeight,
    dropped: quality?.droppedVideoFrames,
    total: quality?.totalVideoFrames,
    error,
  };
}

function createFrameDiagnostics(name, video) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = 32;
  canvas.height = 18;
  let running = false;
  let lastLuma = null;
  let lastPresentedFrames = 0;
  let quietFrames = 0;

  function sample(now, metadata = {}) {
    if (!running) return;

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let luma = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        luma += pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      }
      luma = Math.round(luma / (pixels.length / 4));

      const lumaDelta = lastLuma === null ? 0 : Math.abs(luma - lastLuma);
      const frameGap =
        metadata.presentedFrames && lastPresentedFrames
          ? metadata.presentedFrames - lastPresentedFrames
          : 1;
      quietFrames += 1;

      if (luma < 8 || lumaDelta > 55 || frameGap > 2 || quietFrames >= 75) {
        logPlayback(name, "frame-sample", {
          t: Number(video.currentTime.toFixed(3)),
          luma,
          lumaDelta,
          frameGap,
          presentedFrames: metadata.presentedFrames,
          expectedDisplayTime: metadata.expectedDisplayTime
            ? Math.round(metadata.expectedDisplayTime)
            : undefined,
        });
        quietFrames = 0;
      }

      lastLuma = luma;
      lastPresentedFrames = metadata.presentedFrames || lastPresentedFrames;
    } catch (error) {
      logPlayback(name, "frame-sample-error", { message: error.message });
      running = false;
      return;
    }

    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(sample);
    } else {
      window.setTimeout(() => sample(performance.now(), {}), 500);
    }
  }

  return {
    start() {
      if (running || !context) return;
      running = true;
      lastLuma = null;
      lastPresentedFrames = 0;
      quietFrames = 0;
      logPlayback(name, "diagnostics-start", videoSnapshot(video));
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(sample);
      } else {
        window.setTimeout(() => sample(performance.now(), {}), 500);
      }
    },
    stop(reason) {
      if (!running) return;
      running = false;
      logPlayback(name, "diagnostics-stop", { reason, ...videoSnapshot(video) });
    },
  };
}

function attachVideoLogging(name, video) {
  const diagnostics = createFrameDiagnostics(name, video);
  const events = [
    "loadstart",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "playing",
    "waiting",
    "stalled",
    "suspend",
    "pause",
    "ended",
    "error",
    "resize",
  ];
  for (const eventName of events) {
    video.addEventListener(eventName, () => logPlayback(name, eventName, videoSnapshot(video)));
  }
  video.addEventListener("playing", () => diagnostics.start());
  for (const eventName of ["pause", "ended", "error"]) {
    video.addEventListener(eventName, () => diagnostics.stop(eventName));
  }
  let lastWholeSecond = -1;
  video.addEventListener("timeupdate", () => {
    const second = Math.floor(video.currentTime);
    if (second !== lastWholeSecond) {
      lastWholeSecond = second;
      logPlayback(name, "timeupdate", videoSnapshot(video));
    }
  });
}

async function refreshCaptureStatus() {
  const reply = await api("/api/capture/status");
  const cam0 = reply.files.find((file) => file.name === "cam0");
  const cam1 = reply.files.find((file) => file.name === "cam1");
  els.playCam0Btn.disabled = !cam0?.exists;
  els.playCam1Btn.disabled = !cam1?.exists;
  els.playBothBtn.disabled = !cam0?.exists && !cam1?.exists;
  const parts = reply.files.map((file) => `${file.name}: ${file.exists ? `${Math.round(file.bytes / 1024)} KB` : "missing"}`);
  els.captureStatus.textContent = parts.join(" | ");
  logPlayback("capture", "status", { files: reply.files });
  return reply;
}

async function playCaptured(name) {
  const video = videoByName[name];
  const hint = hintByName[name];
  if (!video || !hint) return;

  const meta = await api(`/api/capture/${name}/meta`);
  logPlayback(name, "meta", meta);
  hint.textContent = "";
  video.src = `/capture/${name}.mp4?t=${Date.now()}`;
  video.load();
  try {
    await video.play();
    setStatus(`Playing captured ${name} stream.`, "ok");
  } catch (error) {
    hint.textContent = "The browser could not play the captured MP4 stream.";
    showError(error);
  }
}

els.captureRefreshBtn.addEventListener("click", () => {
  refreshCaptureStatus().catch(showError);
});

els.playBothBtn.addEventListener("click", () => {
  Promise.allSettled([playCaptured("cam0"), playCaptured("cam1")]).catch(showError);
});

els.playCam0Btn.addEventListener("click", () => {
  playCaptured("cam0").catch(showError);
});

els.playCam1Btn.addEventListener("click", () => {
  playCaptured("cam1").catch(showError);
});

els.clearLogBtn.addEventListener("click", () => {
  els.playbackLog.textContent = "";
});

videoByName.cam0 = els.cam0Video;
videoByName.cam1 = els.cam1Video;
hintByName.cam0 = els.cam0Hint;
hintByName.cam1 = els.cam1Hint;
attachVideoLogging("cam0", els.cam0Video);
attachVideoLogging("cam1", els.cam1Video);

api("/api/status")
  .then((status) => {
    if (status.loggedIn) {
      els.logoutBtn.hidden = false;
      els.refreshBtn.disabled = false;
      setStatus(`Logged in as ${status.account}.`, "ok");
      refreshDevices().catch(showError);
    }
  })
  .catch(() => {});

refreshCaptureStatus().catch(() => {});
