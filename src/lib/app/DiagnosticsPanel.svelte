<script>
  import FrameRateChart from "../FrameRateChart.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as ToggleGroup from "$lib/components/ui/toggle-group/index.js";

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

<Card.Root>
  <Card.Header class="panel-head">
    <div>
      <Card.Title>Diagnostics</Card.Title>
      <Card.Description>{open ? "Live transport metrics and stream event log." : `${playbackLog.length} event${playbackLog.length === 1 ? "" : "s"} logged.`}</Card.Description>
    </div>
    <div class="diagnostics-actions">
      {#if open}
        <ToggleGroup.Root
          type="single"
          value={String(frameWindowSeconds)}
          variant="outline"
          size="sm"
          aria-label="Diagnostics chart window"
        >
          {#each frameWindows as seconds}
            <ToggleGroup.Item value={String(seconds)} onclick={() => onSetWindow(seconds)}>
              {seconds}s
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
        <Button variant="ghost" onclick={onClear}>Clear</Button>
      {/if}
      <Button variant="secondary" onclick={onToggle}>{open ? "Hide" : "Show"}</Button>
    </div>
  </Card.Header>

  {#if open}
    <Card.Content>
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
    </Card.Content>
  {/if}
</Card.Root>
