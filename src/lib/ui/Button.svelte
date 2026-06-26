<script>
  export let type = "button";
  export let variant = "default";
  export let disabled = false;
  export let onclick = undefined;
</script>

<button class="button {variant}" {type} {disabled} on:click={onclick}>
  <slot />
</button>
