<script>
  export let id;
  export let label;
  export let type = "text";
  export let value = "";
  export let placeholder = "";
  export let autocomplete = "";
</script>

<label class="field" for={id}>
  <span>{label}</span>
  <input {id} {type} bind:value {placeholder} {autocomplete} />
</label>
