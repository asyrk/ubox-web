<script>
  export let title;
  export let canvas;
</script>

<section class="camera-pane">
  <div class="camera-title">{title}</div>
  <canvas class="live-canvas" bind:this={canvas}></canvas>
</section>
