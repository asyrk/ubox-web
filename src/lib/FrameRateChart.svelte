<script>
	import * as Chart from "$lib/components/ui/chart/index.js";
	import { LineChart } from "layerchart";

	export let data = [];
	export let unit = "fps";
	export let precision = 0;

	$: maxValue = Math.max(1, ...data.flatMap((row) => [row.primary || 0, row.secondary || 0]));
	$: yDomain = [0, maxValue];
	$: current = data.at(-1) || { primary: 0, secondary: 0 };
	$: primaryValue = Number(current.primary || 0).toFixed(precision);
	$: secondaryValue = Number(current.secondary || 0).toFixed(precision);

	const chartConfig = {
		primary: {
			label: "Primary",
			color: "var(--chart-1)",
		},
		secondary: {
			label: "Secondary",
			color: "var(--chart-2)",
		},
	};

	const series = [
		{
			key: "primary",
			label: chartConfig.primary.label,
			color: chartConfig.primary.color,
		},
		{
			key: "secondary",
			label: chartConfig.secondary.label,
			color: chartConfig.secondary.color,
		},
	];
</script>

<Chart.Container config={chartConfig} class="frame-chart">
	<LineChart
		{data}
		x="at"
		axis="xy"
		series={series}
		{yDomain}
		tooltipContext={false}
		padding={{ top: 8, right: 12, bottom: 20, left: 28 }}
		props={{
			xAxis: {
				format: (value) => data.find((row) => row.at === value)?.label || "",
			},
			yAxis: {
				ticks: 4,
			},
		}}
	/>
</Chart.Container>

<div class="frame-chart-summary">
	<span><strong>{primaryValue}</strong> primary {unit}</span>
	<span><strong>{secondaryValue}</strong> secondary {unit}</span>
</div>
