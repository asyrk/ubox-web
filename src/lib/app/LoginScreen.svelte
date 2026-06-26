<script>
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";
  import Input from "../ui/Input.svelte";

  export let account;
  export let password;
  export let lang;
  export let region;
  export let appName;
  export let deviceType;
  export let busy = false;
  export let onLogin;
</script>

<Card>
  <form class="login-grid" on:submit|preventDefault={onLogin}>
    <Input id="account" label="Account" bind:value={account} autocomplete="username" />
    <Input id="password" label="Password" type="password" bind:value={password} autocomplete="current-password" />
    <Input id="lang" label="Language" bind:value={lang} />
    <Input id="region" label="Region" bind:value={region} />
    <Input id="appName" label="App" bind:value={appName} />
    <Input id="deviceType" label="Device Type" type="number" bind:value={deviceType} />
    <div class="form-actions">
      <Button type="submit" disabled={busy}>Log In</Button>
    </div>
  </form>
</Card>
