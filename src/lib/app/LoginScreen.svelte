<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  export let account;
  export let password;
  export let lang;
  export let region;
  export let appName;
  export let deviceType;
  export let busy = false;
  export let onLogin;

  const fields = [
    { id: "account", label: "Account", autocomplete: "username" },
    { id: "password", label: "Password", type: "password", autocomplete: "current-password" },
    { id: "lang", label: "Language" },
    { id: "region", label: "Region" },
    { id: "appName", label: "App" },
    { id: "deviceType", label: "Device Type", type: "number" },
  ];
</script>

<Card.Root>
  <Card.Content>
    <form class="login-grid" on:submit|preventDefault={onLogin}>
      <Field.Group class="contents">
        {#each fields as field}
          <Field.Field>
            <Field.Label for={field.id}>{field.label}</Field.Label>
            {#if field.id === "account"}
              <Input id={field.id} bind:value={account} autocomplete={field.autocomplete} />
            {:else if field.id === "password"}
              <Input id={field.id} type={field.type} bind:value={password} autocomplete={field.autocomplete} />
            {:else if field.id === "lang"}
              <Input id={field.id} bind:value={lang} />
            {:else if field.id === "region"}
              <Input id={field.id} bind:value={region} />
            {:else if field.id === "appName"}
              <Input id={field.id} bind:value={appName} />
            {:else}
              <Input id={field.id} type={field.type} bind:value={deviceType} />
            {/if}
          </Field.Field>
        {/each}
      </Field.Group>
      <div class="form-actions">
        <Button type="submit" disabled={busy}>Log In</Button>
      </div>
    </form>
  </Card.Content>
</Card.Root>
