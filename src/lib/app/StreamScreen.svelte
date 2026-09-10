<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import CameraPane from "./CameraPane.svelte";
  import DeviceStatus from "./DeviceStatus.svelte";
  import DiagnosticsPanel from "./DiagnosticsPanel.svelte";
  import PtzControls from "./PtzControls.svelte";
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
  export let showSecondaryStream = false;
  export let lensZoomReport = null;
  export let streamEstablished = false;
  export let onStartLive;
  export let onStopLive;
  export let onSetStreamIndex;
  export let onToggleDiagnostics;
  export let onClearDiagnostics;
  export let onSetFrameWindow;

  $: liveButtonLabel = streamRunning ? "Stop" : "Start";
  $: liveButtonAction = streamRunning ? onStopLive : onStartLive;

  // PTZ capability from dev_func; shared cameras need the ptz permission.
  $: ptzSupport = selectedDevice?.ptzSupport || "none";
  $: ptzAvailable = ptzSupport !== "none" && selectedDevice?.ptzPermission !== false;
  $: ptzEnabled = streamRunning && ptzAvailable;
</script>

<div class="stream-layout">
  <Card.Root>
    <Card.Header class="panel-head stream-head">
      <div class="stream-title">
        <Card.Title>{selectedDevice?.name || "Camera"}</Card.Title>
        <Card.Description>{selectedDevice?.uid}{selectedDevice?.modelNum ? ` · Model ${selectedDevice.modelNum}` : ""}</Card.Description>
        <DeviceStatus device={selectedDevice} />
      </div>
      <StreamQualitySwitch {streamIndex} {busy} {onSetStreamIndex} />
    </Card.Header>

    <Card.Content>
      <div class={`video-grid ${showSecondaryStream ? "" : "single-camera"}`}>
        <CameraPane title="Live" bind:canvas={cam0Canvas} />
        {#if showSecondaryStream}
          <CameraPane title="Secondary" bind:canvas={cam1Canvas} />
        {/if}
      </div>

      <div class="stream-controls">
        <div class="stream-actions">
          <Button onclick={liveButtonAction} disabled={busy}>{liveButtonLabel}</Button>
        </div>
      </div>

      {#if ptzAvailable || streamRunning}
        <PtzControls
          enabled={ptzEnabled}
          supported={ptzAvailable}
          {streamEstablished}
          {lensZoomReport}
        />
      {/if}
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
    {showSecondaryStream}
    onToggle={onToggleDiagnostics}
    onClear={onClearDiagnostics}
    onSetWindow={onSetFrameWindow}
  />
</div>

<style>
  .stream-title {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
</style>
