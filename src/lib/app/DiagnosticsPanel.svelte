<script>
  import FrameRateChart from "../FrameRateChart.svelte";
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";

  export let open = false;
  export let playbackLog = [];
  export let tokenOutput = "";
  export let frameWindows = [];
  export let frameWindowSeconds;
  export let frameChartData = [];
  export let byteChartData = [];
  export let onToggle;
  export let onClear;
  export let onSetWindow;
</script>

<Card>
  <div class="panel-head">
    <div>
      <h2>Diagnostics</h2>
      <p>{open ? "Live transport metrics and stream event log." : `${playbackLog.length} event${playbackLog.length === 1 ? "" : "s"} logged.`}</p>
    </div>
    <div class="diagnostics-actions">
      {#if open}
        <div class="window-picker" aria-label="Diagnostics chart window">
          {#each frameWindows as seconds}
            <button
              type="button"
              class:active={frameWindowSeconds === seconds}
              on:click={() => onSetWindow(seconds)}
            >
              {seconds}s
            </button>
          {/each}
        </div>
        <Button variant="ghost" onclick={onClear}>Clear</Button>
      {/if}
      <Button variant="secondary" onclick={onToggle}>{open ? "Hide" : "Show"}</Button>
    </div>
  </div>

  {#if open}
    <div class="diagnostics-grid">
      <section class="frame-metrics">
        <div class="frame-metrics-head">
          <div>
            <h3>Transferred Bytes</h3>
            <p>KB per second received by the browser from the live H.264 streams.</p>
          </div>
        </div>
        <FrameRateChart data={byteChartData} unit="KB/s" precision={1} />
      </section>
      <section class="frame-metrics">
        <div class="frame-metrics-head">
          <div>
            <h3>Received Frames</h3>
            <p>Frames per second parsed by the browser from the live H.264 streams.</p>
          </div>
        </div>
        <FrameRateChart data={frameChartData} />
      </section>
    </div>
    <pre class="log">{playbackLog.join("\n")}</pre>
    {#if tokenOutput}
      <pre class="token">{tokenOutput}</pre>
    {/if}
  {/if}
</Card>
