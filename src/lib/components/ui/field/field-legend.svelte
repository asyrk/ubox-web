<script>
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		variant = "legend",
		children,
		...restProps
	} = $props();
</script>

<legend
	bind:this={ref}
	data-slot="field-legend"
	data-variant={variant}
	class={cn("mb-3 font-semibold uppercase data-[variant=label]:text-xs data-[variant=legend]:text-xs", className)}
	{...restProps}
>
	{@render children?.()}
</legend>