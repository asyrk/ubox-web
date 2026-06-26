<script>
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";
  import CameraPane from "./CameraPane.svelte";
  import DiagnosticsPanel from "./DiagnosticsPanel.svelte";

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
  export let onChangeDevice;
  export let onStartLive;
  export let onStopLive;
  export let onGetFeedToken;
  export let onToggleDiagnostics;
  export let onClearDiagnostics;
  export let onSetFrameWindow;
</script>

<div class="stream-layout">
  <Card>
    <div class="panel-head">
      <div>
        <h2>{selectedDevice?.name || "Camera"}</h2>
        <p>{selectedDevice?.uid}</p>
      </div>
      <Button variant="ghost" onclick={onChangeDevice}>Change Device</Button>
    </div>

    <div class="video-grid">
      <CameraPane title="Live" bind:canvas={cam0Canvas} />
      <CameraPane title="Secondary" bind:canvas={cam1Canvas} />
    </div>

    <div class="stream-actions">
      <Button onclick={onStartLive} disabled={busy}>Start Live Stream</Button>
      <Button variant="secondary" onclick={onStopLive} disabled={busy}>Stop Live Stream</Button>
      <Button variant="ghost" onclick={onGetFeedToken}>Get Feed Token</Button>
    </div>
    <p class="capture-status">{captureStatus}</p>
  </Card>

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
