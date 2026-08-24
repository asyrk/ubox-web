<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import { api } from "$lib/api.js";

  // Camera PTZ controls. Command values mirror the decompiled Android app:
  //   - AdvancedSettings.setPtzLevel(direction, speed): 12-byte payload,
  //     direction byte at [5] (1=up, 2=down, 3=right, 6=left, 0=stop),
  //     [6]=8, speed byte at [10]; IO command 4097.
  //   - AdvancedSettings.setLensZoom(zoom): u32 LE zoom in a 20-byte payload;
  //     IO command 8480. The app sends 10..usAfLensZoomMax in steps of 10
  //     (slider tick = zoom/10 - 1). usAfLensZoomMax defaults to 120 when the
  //     device reports none.
  //   - AdvancedSettings.getLensZoom(): empty 20-byte payload; IO command 8482.
  //     The camera answers 8483 with the current zoom (u32 LE), which the
  //     backend forwards to the browser as a "lens-zoom-rsp" SSE event.
  // Hold behavior mirrors PtzFragmentNew.ptzOnTouchListener: move is sent on
  // touch-down and repeated every 300 ms while held; on release, a touch
  // shorter than 1000 ms stops after a 500 ms delay, a longer one stops
  // immediately.

  export let enabled = false;
  export let supported = true; // device function bitmask reports PTZ capability
  export let streamEstablished = false; // relay-stream-rsp seen over SSE
  export let lensZoomReport = null; // { zoom, at } from the backend SSE stream

  const DIRECTIONS = { up: 1, down: 2, left: 6, right: 3 };
  const DIRECTION_ORDER = ["up", "left", "right", "down"];
  const SPEED_OPTIONS = [
    { value: 1, label: "Low" },
    { value: 2, label: "Medium" },
    { value: 3, label: "High" },
  ];
  const ZOOM_MIN = 10;
  const ZOOM_MAX = 120; // decompiled default usAfLensZoomMax
  const ZOOM_TICKS = (ZOOM_MAX - ZOOM_MIN) / 10; // 11
  const PTZ_INTERVAL_MS = 300; // ptzInterval
  const TAP_MS = 1000; // short-touch threshold
  const STOP_DELAY_MS = 500; // delayed stop after a short touch

  let speed = 1;
  let zoomTick = 0; // 0..11 -> lens value 10..120
  let holdTimer = null;
  let stopTimer = null;
  let holdStartedAt = 0;
  let activeDirection = null;
  let feedback = "";
  let feedbackTone = "neutral";
  let requestZoomAt = 0; // guards the slider against echo of its own commands

  $: zoomValue = ZOOM_MIN + zoomTick * 10;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function setFeedback(message, tone = "neutral") {
    feedback = message;
    feedbackTone = tone;
  }

  function clearTimers() {
    if (holdTimer) {
      clearInterval(holdTimer);
      holdTimer = null;
    }
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  // Keep the panel readable: never surface a bare HTTP status like "409" -
  // map it to what it actually means (relay/session not established yet).
  function friendlyError(message) {
    const text = String(message || "");
    if (/409|still connecting|not ready/i.test(text)) {
      return "Camera control is not ready yet. Wait for the live stream to connect.";
    }
    return text;
  }

  async function sendPtz(body, { silent = false } = {}) {
    if (!enabled) return null;
    try {
      const reply = await api("/api/stream/ptz", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!reply.ok && !silent) {
        setFeedback(friendlyError(reply.error), "danger");
      }
      return reply;
    } catch (error) {
      if (!silent) {
        setFeedback(friendlyError(error.message), "danger");
      }
      return null;
    }
  }

  function sendMove(direction) {
    sendPtz({ action: "move", direction, speed });
  }

  function sendStop() {
    sendPtz({ action: "stop", speed });
  }

  function onDirectionDown(direction) {
    if (!enabled || activeDirection) return;
    clearTimers();
    activeDirection = direction;
    holdStartedAt = Date.now();
    sendMove(direction);
    holdTimer = setInterval(() => sendMove(direction), PTZ_INTERVAL_MS);
  }

  function onDirectionUp() {
    if (!activeDirection) return;
    clearTimers();
    const heldMs = Date.now() - holdStartedAt;
    const direction = activeDirection;
    activeDirection = null;
    if (heldMs < TAP_MS) {
      stopTimer = setTimeout(() => sendStop(), STOP_DELAY_MS);
    } else {
      sendStop();
    }
    if (feedbackTone === "neutral") setFeedback(`Stopped ${direction}.`);
  }

  function onDirectionCancel() {
    onDirectionUp();
  }

  function setSpeed(nextSpeed) {
    speed = nextSpeed;
    // The app re-sends a stop command with the new speed level so the camera
    // applies it to the next move (PtzFragmentNew speed dialog onClick).
    sendPtz({ action: "stop", speed });
  }

  function setZoomFromTick(nextTick, { send = true } = {}) {
    zoomTick = clamp(Math.round(nextTick), 0, ZOOM_TICKS);
    if (send) sendZoom();
  }

  function sendZoom() {
    sendPtz({ action: "zoom", zoom: zoomValue });
  }

  function zoomStep(step) {
    if (!enabled) return;
    setZoomFromTick(zoomTick + step);
  }

  function requestZoom() {
    if (!enabled) return;
    // Background sync: keep it quiet - a failure just means the relay is not
    // up yet; the slider still syncs once the stream is established.
    sendPtz({ action: "zoom-get" }, { silent: true });
  }

  function onZoomSliderInput(event) {
    zoomTick = clamp(Math.round(Number(event.target.value)), 0, ZOOM_TICKS);
  }

  function onZoomSliderChange() {
    sendZoom();
  }

  // Sync the slider when the camera reports its zoom (SSE lens-zoom-rsp).
  $: if (lensZoomReport && lensZoomReport.at !== requestZoomAt && Number.isFinite(lensZoomReport.zoom)) {
    requestZoomAt = lensZoomReport.at;
    const reportedZoom = clamp(Math.round(lensZoomReport.zoom), ZOOM_MIN, ZOOM_MAX);
    zoomTick = Math.round(reportedZoom / 10) - 1;
  }

  // The app reads the lens zoom only once the live view is up; mirror that by
  // waiting for the relay-stream-rsp SSE event instead of the start request.
  $: if (enabled && supported && streamEstablished) requestZoom();
</script>

{#if supported}
  <section class="ptz-panel" aria-label="Camera controls">
  {#if enabled && !streamEstablished}
    <div class="ptz-connecting">Waiting for the camera stream to connect before controls are active…</div>
  {/if}
  <div class="ptz-group">
    <div class="ptz-title">Move</div>
    <div class="ptz-pad">
      {#each DIRECTION_ORDER as direction}
        <button
          type="button"
          class="ptz-dir"
          class:active={activeDirection === direction}
          disabled={!enabled}
          aria-label={`Move ${direction}`}
          onpointerdown={() => onDirectionDown(direction)}
          onpointerup={onDirectionUp}
          onpointerleave={onDirectionUp}
          onpointercancel={onDirectionCancel}
        >
          {direction === "up" ? "▲" : direction === "down" ? "▼" : direction === "left" ? "◀" : "▶"}
        </button>
      {/each}
      <button
        type="button"
        class="ptz-dir ptz-stop"
        disabled={!enabled}
        aria-label="Stop movement"
        onclick={() => {
          clearTimers();
          activeDirection = null;
          sendStop();
        }}
      >
        ■
      </button>
    </div>
    <div class="ptz-hint">Hold to move, release to stop.</div>
  </div>

  <div class="ptz-group">
    <div class="ptz-title">Speed</div>
    <div class="ptz-speeds">
      {#each SPEED_OPTIONS as option}
        <Button
          variant={speed === option.value ? "default" : "outline"}
          size="sm"
          disabled={!enabled}
          onclick={() => setSpeed(option.value)}
        >
          {option.label}
        </Button>
      {/each}
    </div>
  </div>

  <div class="ptz-group ptz-zoom-group">
    <div class="ptz-title">Zoom</div>
    <div class="ptz-zoom-row">
      <Button variant="outline" size="sm" disabled={!enabled || zoomTick <= 0} onclick={() => zoomStep(-1)} aria-label="Zoom out">
        −
      </Button>
      <input
        type="range"
        min="0"
        max={ZOOM_TICKS}
        step="1"
        value={zoomTick}
        disabled={!enabled}
        class="ptz-zoom-slider"
        aria-label="Lens zoom level"
        oninput={onZoomSliderInput}
        onchange={onZoomSliderChange}
      />
      <Button variant="outline" size="sm" disabled={!enabled || zoomTick >= ZOOM_TICKS} onclick={() => zoomStep(1)} aria-label="Zoom in">
        +
      </Button>
    </div>
    <div class="ptz-zoom-meta">
      <span>{zoomValue / 10}x</span>
    </div>
  </div>

  {#if feedback}
    <div class="ptz-feedback" class:danger={feedbackTone === "danger"}>{feedback}</div>
  {/if}
  </section>
{:else}
  <div class="ptz-unsupported">
    This camera does not report PTZ support (device function bits 18/2), so camera
    movement and zoom controls are hidden.
  </div>
{/if}

<style>
  .ptz-panel {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 22px;
    margin-top: 14px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--background) 96%, var(--muted));
  }

  .ptz-group {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .ptz-title {
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ptz-pad {
    display: grid;
    grid-template-columns: repeat(3, 44px);
    grid-template-rows: repeat(3, 36px);
    gap: 4px;
  }

  .ptz-dir {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--foreground);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    user-select: none;
    touch-action: none;
    transition: background 120ms ease;
  }

  .ptz-dir:hover:not(:disabled) {
    background: var(--accent);
  }

  .ptz-dir.active {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .ptz-dir:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ptz-dir:nth-child(1) {
    grid-column: 2;
    grid-row: 1;
  }

  .ptz-dir:nth-child(2) {
    grid-column: 1;
    grid-row: 2;
  }

  .ptz-dir:nth-child(3) {
    grid-column: 3;
    grid-row: 2;
  }

  .ptz-dir:nth-child(4) {
    grid-column: 2;
    grid-row: 3;
  }

  .ptz-stop {
    grid-column: 2;
    grid-row: 2;
  }

  .ptz-speeds {
    display: inline-flex;
    gap: 6px;
  }

  .ptz-zoom-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .ptz-zoom-slider {
    width: 180px;
    accent-color: var(--primary);
  }

  .ptz-zoom-slider:disabled {
    opacity: 0.4;
  }

  .ptz-zoom-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 240px;
    color: var(--foreground);
    font-size: 13px;
    font-weight: 700;
  }

  .ptz-hint {
    color: var(--muted-foreground);
    font-size: 11px;
    max-width: 260px;
  }

  .ptz-feedback {
    width: 100%;
    color: var(--foreground);
    font-size: 12px;
  }

  .ptz-feedback.danger {
    color: var(--destructive);
  }

  .ptz-unsupported {
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.5;
  }

  .ptz-connecting {
    width: 100%;
    color: var(--muted-foreground);
    font-size: 12px;
  }
</style>
