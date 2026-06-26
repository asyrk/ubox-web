<script>
  import Badge from "../ui/Badge.svelte";
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";

  export let devices = [];
  export let busy = false;
  export let onRefresh;
  export let onSelect;
</script>

<Card>
  <div class="panel-head">
    <div>
      <h2>Cameras</h2>
      <p>{devices.length ? "Choose the device to open the stream view." : "No cameras returned by the UBox account."}</p>
    </div>
    <Button variant="secondary" disabled={busy} onclick={onRefresh}>Refresh</Button>
  </div>
  <div class="device-list">
    {#each devices as device}
      <button class="device-row" type="button" on:click={() => onSelect(device)}>
        <span>
          <strong>{device.name || "Camera"}</strong>
          <small>{device.uid}</small>
        </span>
        <Badge tone={device.owner ? "success" : "neutral"}>{device.owner ? "Owner" : "Shared"}</Badge>
      </button>
    {/each}
  </div>
</Card>
