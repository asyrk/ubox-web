<script>
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";

  export let screen;
  export let steps;
  export let status;
  export let statusTone;
  export let onLogout;

  $: title = screen === steps.LOGIN ? "Log In" : screen === steps.DEVICES ? "Select Device" : "Live Stream";
  $: statusVariant = statusTone === "danger" ? "destructive" : statusTone === "success" ? "default" : "secondary";
</script>

<header class="topbar">
  <div>
    <p class="eyebrow">UBox Web</p>
    <h1>{title}</h1>
  </div>
  <div class="topbar-actions">
    <Badge variant={statusVariant}>{status}</Badge>
    {#if screen !== steps.LOGIN}
      <Button variant="ghost" onclick={onLogout}>Log Out</Button>
    {/if}
  </div>
</header>
