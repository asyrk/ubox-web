<script>
  import Badge from "../ui/Badge.svelte";
  import Button from "../ui/Button.svelte";

  export let screen;
  export let steps;
  export let status;
  export let statusTone;
  export let onLogout;

  $: title = screen === steps.LOGIN ? "Log In" : screen === steps.DEVICES ? "Select Device" : "Live Stream";
</script>

<header class="topbar">
  <div>
    <p class="eyebrow">UBox Web</p>
    <h1>{title}</h1>
  </div>
  <div class="topbar-actions">
    <Badge tone={statusTone}>{status}</Badge>
    {#if screen !== steps.LOGIN}
      <Button variant="ghost" onclick={onLogout}>Log Out</Button>
    {/if}
  </div>
</header>
