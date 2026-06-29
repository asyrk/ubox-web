<script>
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="field-label"
	class={cn("gap-2 text-xs leading-normal font-semibold uppercase group-data-[disabled=true]/field:opacity-50 in-data-[slot=field-label]:font-semibold flex w-fit items-center leading-snug", className)}
	{...restProps}
>
	{@render children?.()}
</div>