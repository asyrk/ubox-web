<script>
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";

  export let devices = [];
  export let busy = false;
  export let onRefresh;
  export let onSelect;
</script>

<Card.Root>
  <Card.Header class="panel-head">
    <div>
      <Card.Title>Cameras</Card.Title>
      <Card.Description>{devices.length ? "Choose the device to open the stream view." : "No cameras returned by the UBox account."}</Card.Description>
    </div>
    <Button variant="secondary" disabled={busy} onclick={onRefresh}>Refresh</Button>
  </Card.Header>
  <Card.Content class="device-list">
    {#each devices as device}
      <Button class="device-row" variant="outline" type="button" onclick={() => onSelect(device)}>
        <span>
          <strong>{device.name || "Camera"}</strong>
          <small>{device.uid}</small>
        </span>
        <Badge variant={device.owner ? "default" : "secondary"}>{device.owner ? "Owner" : "Shared"}</Badge>
      </Button>
    {/each}
  </Card.Content>
</Card.Root>
