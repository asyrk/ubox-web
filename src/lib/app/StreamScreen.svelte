<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import CameraPane from "./CameraPane.svelte";
  import DiagnosticsPanel from "./DiagnosticsPanel.svelte";
  import StreamQualitySwitch from "./StreamQualitySwitch.svelte";

  export let selectedDevice;
  export let busy = false;
  export let captureStatus;
  export let cam0Canvas;
  export let cam1Canvas;
  export let diagnosticsOpen;
  export let playbackLog;
  export let tokenOutput;
  export let frameWindows;
  export let frameWindowSeconds;
  export let frameChartData;
  export let byteChartData;
  export let streamIndex = 0;
  export let onChangeDevice;
  export let onStartLive;
  export let onStopLive;
  export let onGetFeedToken;
  export let onSetStreamIndex;
  export let onToggleDiagnostics;
  export let onClearDiagnostics;
  export let onSetFrameWindow;
</script>

<div class="stream-layout">
  <Card.Root>
    <Card.Header class="panel-head">
      <div>
        <Card.Title>{selectedDevice?.name || "Camera"}</Card.Title>
        <Card.Description>{selectedDevice?.uid}</Card.Description>
      </div>
      <Button variant="ghost" onclick={onChangeDevice}>Change Device</Button>
    </Card.Header>

    <Card.Content>
      <div class="video-grid">
        <CameraPane title="Live" bind:canvas={cam0Canvas} />
        <CameraPane title="Secondary" bind:canvas={cam1Canvas} />
      </div>

      <div class="stream-controls">
        <StreamQualitySwitch {streamIndex} {busy} {onSetStreamIndex} />
        <div class="stream-actions">
          <Button onclick={onStartLive} disabled={busy}>Start Live Stream</Button>
          <Button variant="secondary" onclick={onStopLive} disabled={busy}>Stop Live Stream</Button>
          <Button variant="ghost" onclick={onGetFeedToken}>Get Feed Token</Button>
        </div>
      </div>
      <p class="capture-status">{captureStatus}</p>
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
    onToggle={onToggleDiagnostics}
    onClear={onClearDiagnostics}
    onSetWindow={onSetFrameWindow}
  />
</div>
