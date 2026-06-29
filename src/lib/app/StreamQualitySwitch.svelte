<script>
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";

  export let streamIndex = 0;
  export let busy = false;
  export let onSetStreamIndex;

  $: isHd = Number(streamIndex) === 1;

  function handleCheckedChange(checked) {
    onSetStreamIndex?.(checked ? 1 : 0);
  }
</script>

<div class="quality-switch">
  <Label id="stream-quality-label" for="stream-quality">HD</Label>
  <Switch
    id="stream-quality"
    checked={isHd}
    disabled={busy}
    aria-labelledby="stream-quality-label"
    onCheckedChange={handleCheckedChange}
  />
</div>
