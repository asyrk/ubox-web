<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import CameraPane from "./CameraPane.svelte";
  import DiagnosticsPanel from "./DiagnosticsPanel.svelte";
  import StreamQualitySwitch from "./StreamQualitySwitch.svelte";

  export let selectedDevice;
  export let busy = false;
  export let streamRunning = false;
  export let cam0Canvas;
  export let cam1Canvas;
  export let diagnosticsOpen;
  export let playbackLog;
  export let tokenOutput;
  export let frameWindows;
  export let frameWindowSeconds;
  export let frameChartData;
  export let byteChartData;
  export let chartXDomain;
  export let streamIndex = 0;
  export let onStartLive;
  export let onStopLive;
  export let onSetStreamIndex;
  export let onToggleDiagnostics;
  export let onClearDiagnostics;
  export let onSetFrameWindow;

  $: liveButtonLabel = streamRunning ? "Stop" : "Start";
  $: liveButtonAction = streamRunning ? onStopLive : onStartLive;
</script>

<div class="stream-layout">
  <Card.Root>
    <Card.Header class="panel-head stream-head">
      <div>
        <Card.Title>{selectedDevice?.name || "Camera"}</Card.Title>
        <Card.Description>{selectedDevice?.uid}</Card.Description>
      </div>
      <StreamQualitySwitch {streamIndex} {busy} {onSetStreamIndex} />
    </Card.Header>

    <Card.Content>
      <div class="video-grid">
        <CameraPane title="Live" bind:canvas={cam0Canvas} />
        <CameraPane title="Secondary" bind:canvas={cam1Canvas} />
      </div>

      <div class="stream-controls">
        <div class="stream-actions">
          <Button onclick={liveButtonAction} disabled={busy}>{liveButtonLabel}</Button>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <DiagnosticsPanel
    open={diagnosticsOpen}
    {playbackLog}
    {tokenOutput}
    {frameWindows}
    {frameWindowSeconds}
    {frameChartData}
    {byteChartData}
    {chartXDomain}
    onToggle={onToggleDiagnostics}
    onClear={onClearDiagnostics}
    onSetWindow={onSetFrameWindow}
  />
</div>
