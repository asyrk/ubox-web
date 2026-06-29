<script>
  import { onMount } from "svelte";
  import AppHeader from "./lib/app/AppHeader.svelte";
  import DeviceSelection from "./lib/app/DeviceSelection.svelte";
  import LoginScreen from "./lib/app/LoginScreen.svelte";
  import StreamScreen from "./lib/app/StreamScreen.svelte";
  import { api, flattenDevices } from "./lib/api.js";
  import { clearCanvas, createLivePlaybackController } from "./lib/livePlayback.js";
  import {
    FRAME_WINDOWS,
    buildByteChartData,
    buildFrameChartData,
    trimSamples,
  } from "./lib/streamMetrics.js";

  const MAX_DIAGNOSTIC_LINES = 1000;

  const STEPS = {
    LOGIN: "login",
    DEVICES: "devices",
    STREAM: "stream",
  };

  let screen = STEPS.LOGIN;
  let busy = false;
  let status = "Not connected";
  let statusTone = "neutral";
  let devices = [];
  let selectedDevice = null;
  let tokenOutput = "";
  let captureStatus = "Live stream decoder not started.";
  let playbackLog = [];
  let diagnosticsOpen = false;
  let frameWindowSeconds = 10;
  let frameSamples = [];
  let byteSamples = [];
  let frameChartNow = Date.now();
  let frameChartData = [];
  let byteChartData = [];
  let streamEvents = null;
  let liveServerActive = false;

  let account = "";
  let password = "";
  let lang = "en";
  let region = "US";
  let appName = "UBox";
  let deviceType = 1;

  let cam0Canvas;
  let cam1Canvas;

  function setStatus(message, tone = "neutral") {
    status = message;
    statusTone = tone;
  }

  function setCaptureStatus(message) {
    captureStatus = message;
  }

  function log(camera, event, detail = {}) {
    const row = {
      at: new Date().toLocaleTimeString(),
      camera,
      event,
      ...detail,
    };
    playbackLog = [...playbackLog, JSON.stringify(row)].slice(-MAX_DIAGNOSTIC_LINES);
  }

  function recordReceivedFrame(track) {
    const now = Date.now();
    frameSamples = [...trimSamples(frameSamples, now), { at: now, track }];
    frameChartNow = now;
  }

  function recordTransferredBytes(track, bytes) {
    const now = Date.now();
    byteSamples = [...trimSamples(byteSamples, now), { at: now, track, bytes }];
    frameChartNow = now;
  }

  const livePlayback = createLivePlaybackController({
    api,
    log,
    setCaptureStatus,
    recordFrame: recordReceivedFrame,
    recordBytes: recordTransferredBytes,
  });

  function resetStreamMetrics() {
    frameSamples = [];
    byteSamples = [];
    frameChartNow = Date.now();
  }

  function setFrameWindow(seconds) {
    frameWindowSeconds = seconds;
    frameChartNow = Date.now();
  }

  function clearCanvases() {
    clearCanvas(cam0Canvas);
    clearCanvas(cam1Canvas);
  }

  function connectStreamEvents() {
    if (streamEvents) return;
    streamEvents = new EventSource("/api/stream/events");

    streamEvents.addEventListener("log", (event) => {
      try {
        const detail = JSON.parse(event.data);
        log("stream", detail.event || "event", detail);
        if (detail.event === "relay-stream-rsp") {
          captureStatus = `Relay stream opened: sid ${detail.sid}, channel ${detail.channel}.`;
        }
        if (detail.event === "h264-frame") {
          captureStatus = `Live H.264: ${detail.backlog || 0} frame(s) buffered, ${detail.clients || 0} client(s).`;
        }
        if (detail.event === "mp4-fragment") {
          captureStatus = `Live MP4: ${detail.codec || "codec pending"}, ${detail.clients || 0} client(s), last fragment ${detail.bytes} bytes.`;
        }
      } catch {
        log("stream", "event", { raw: event.data });
      }
    });

    streamEvents.addEventListener("snapshot", (event) => {
      try {
        log("stream", "snapshot", JSON.parse(event.data));
      } catch {
        log("stream", "snapshot", { raw: event.data });
      }
    });

    streamEvents.addEventListener("error", () => {
      log("stream", "events-error");
      streamEvents?.close();
      streamEvents = null;
    });
  }

  function disconnectStreamEvents() {
    streamEvents?.close();
    streamEvents = null;
  }

  function stopLiveServerOnUnload() {
    if (!liveServerActive) return;
    liveServerActive = false;
    livePlayback.stop();
    disconnectStreamEvents();

    const body = "{}";
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/stream/stop", new Blob([body], { type: "application/json" }));
      return;
    }

    fetch("/api/stream/stop", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  }

  async function login() {
    busy = true;
    tokenOutput = "";
    setStatus("Logging in...");
    try {
      const reply = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          account,
          password,
          lang,
          region,
          app: appName,
          device_type: Number(deviceType || 1),
        }),
      });
      setStatus(`Logged in as ${reply.account || account}.`, "success");
      await loadDevices();
      screen = STEPS.DEVICES;
    } catch (error) {
      setStatus(error.message, "danger");
      tokenOutput = JSON.stringify(error.data || { error: error.message }, null, 2);
      log("app", "login-error", { message: error.message });
    } finally {
      busy = false;
    }
  }

  async function logout() {
    if (liveServerActive) {
      try {
        await api("/api/stream/stop", { method: "POST", body: "{}" });
      } catch (error) {
        log("stream", "logout-stop-error", { message: error.message });
      }
    }

    liveServerActive = false;
    livePlayback.stop();
    disconnectStreamEvents();
    await api("/api/logout", { method: "POST", body: "{}" });

    screen = STEPS.LOGIN;
    devices = [];
    selectedDevice = null;
    tokenOutput = "";
    playbackLog = [];
    resetStreamMetrics();
    setStatus("Not connected");
  }

  async function loadDevices() {
    busy = true;
    setStatus("Loading cameras...");
    try {
      const reply = await api("/api/devices");
      devices = flattenDevices(reply);
      setStatus(`Loaded ${devices.length} camera${devices.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      setStatus(error.message, "danger");
      log("app", "devices-error", { message: error.message });
    } finally {
      busy = false;
    }
  }

  function selectDevice(device) {
    selectedDevice = device;
    screen = STEPS.STREAM;
    tokenOutput = "";
    captureStatus = "Live stream decoder not started.";
    clearCanvases();
  }

  async function getFeedToken() {
    if (!selectedDevice) return;
    busy = true;
    setStatus("Requesting live-feed token...");
    try {
      const reply = await api("/api/webrtc-token", {
        method: "POST",
        body: JSON.stringify({ uid: selectedDevice.uid }),
      });
      tokenOutput = JSON.stringify(reply, null, 2);
      setStatus("Feed token acquired.", "success");
      log("api", "token-acquired", { uid: selectedDevice.uid });
    } catch (error) {
      setStatus(error.message, "danger");
      tokenOutput = JSON.stringify(error.data || { error: error.message }, null, 2);
      log("api", "token-error", { message: error.message });
    } finally {
      busy = false;
    }
  }

  async function startLiveDecode() {
    if (!selectedDevice) return;
    busy = true;
    connectStreamEvents();
    resetStreamMetrics();
    setStatus("Starting live stream decoder...");

    try {
      const reply = await api("/api/stream/start", {
        method: "POST",
        body: JSON.stringify({ device: selectedDevice }),
      });
      liveServerActive = true;
      captureStatus = "Live decoder started. Waiting for the camera stream...";
      setStatus("Live stream requested.", "success");
      log("stream", "start-reply", reply);
      livePlayback.stop();
      startCanvasPlayback(cam0Canvas, "primary", "cam0");
      startCanvasPlayback(cam1Canvas, "secondary", "cam1");
    } catch (error) {
      setStatus(error.message, "danger");
      log("stream", "start-error", { message: error.message, data: error.data });
    } finally {
      busy = false;
    }
  }

  function startCanvasPlayback(canvas, track, name) {
    livePlayback.startCanvas(canvas, track, name).catch((error) => {
      if (error.name === "AbortError") return;
      setStatus(error.message, "danger");
      captureStatus = error.message;
      log(name, "playback-start-error", { message: error.message });
    });
  }

  async function stopLiveDecode() {
    busy = true;
    setStatus("Stopping live stream decoder...");
    try {
      const reply = await api("/api/stream/stop", { method: "POST", body: "{}" });
      liveServerActive = false;
      livePlayback.stop();
      clearCanvases();
      captureStatus = "Live stream decoder stopped.";
      setStatus("Live decoder stopped.", "success");
      log("stream", "stop-reply", reply);
    } catch (error) {
      setStatus(error.message, "danger");
      log("stream", "stop-error", { message: error.message });
    } finally {
      disconnectStreamEvents();
      busy = false;
    }
  }

  async function changeDevice() {
    if (liveServerActive) {
      try {
        await stopLiveDecode();
      } catch (error) {
        log("stream", "change-device-stop-error", { message: error.message });
      }
    }
    screen = STEPS.DEVICES;
  }

  onMount(() => {
    const unload = () => stopLiveServerOnUnload();
    const chartTimer = window.setInterval(() => {
      frameChartNow = Date.now();
      frameSamples = trimSamples(frameSamples, frameChartNow);
      byteSamples = trimSamples(byteSamples, frameChartNow);
    }, 100);

    window.addEventListener("pagehide", unload);
    window.addEventListener("beforeunload", unload);

    (async () => {
      try {
        const reply = await api("/api/status");
        if (reply.loggedIn) {
          setStatus(`Logged in as ${reply.account}.`, "success");
          await loadDevices();
          screen = STEPS.DEVICES;
        }
      } catch {
        setStatus("Not connected");
      }
    })();

    return () => {
      window.removeEventListener("pagehide", unload);
      window.removeEventListener("beforeunload", unload);
      window.clearInterval(chartTimer);
      stopLiveServerOnUnload();
    };
  });

  $: frameChartData = buildFrameChartData(frameSamples, frameWindowSeconds, frameChartNow);
  $: byteChartData = buildByteChartData(byteSamples, frameWindowSeconds, frameChartNow);
</script>

<main class="app-shell">
  <AppHeader {screen} steps={STEPS} {status} {statusTone} onLogout={logout} />

  {#if screen === STEPS.LOGIN}
    <LoginScreen
      bind:account
      bind:password
      bind:lang
      bind:region
      bind:appName
      bind:deviceType
      {busy}
      onLogin={login}
    />
  {:else if screen === STEPS.DEVICES}
    <DeviceSelection {devices} {busy} onRefresh={loadDevices} onSelect={selectDevice} />
  {:else}
    <StreamScreen
      {selectedDevice}
      {busy}
      {captureStatus}
      bind:cam0Canvas
      bind:cam1Canvas
      {diagnosticsOpen}
      {playbackLog}
      {tokenOutput}
      frameWindows={FRAME_WINDOWS}
      {frameWindowSeconds}
      {frameChartData}
      {byteChartData}
      onChangeDevice={changeDevice}
      onStartLive={startLiveDecode}
      onStopLive={stopLiveDecode}
      onGetFeedToken={getFeedToken}
      onToggleDiagnostics={() => (diagnosticsOpen = !diagnosticsOpen)}
      onClearDiagnostics={() => (playbackLog = [])}
      onSetFrameWindow={setFrameWindow}
    />
  {/if}
</main>
