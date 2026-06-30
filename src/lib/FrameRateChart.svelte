<script>
	import { onDestroy, onMount } from "svelte";
	import uPlot from "uplot";
	import "uplot/dist/uPlot.min.css";

	export let data = [];
	export let unit = "fps";
	export let precision = 0;
	export let xDomain = undefined;
	export let showSecondary = true;

	let chartEl;
	let plot;
	let resizeObserver;
	let lastData = null;
	let lastWidth = 0;
	let lastHeight = 0;
	let lastXMin = null;
	let lastXMax = null;
	let lastYMin = null;
	let lastYMax = null;

	$: maxValue = Math.max(1, ...data.flatMap((row) => (showSecondary ? [row.primary || 0, row.secondary || 0] : [row.primary || 0])));
	$: yDomain = [0, maxValue];
	$: current = data.at(-1) || { primary: 0, secondary: 0 };
	$: primaryValue = Number(current.primary || 0).toFixed(precision);
	$: secondaryValue = Number(current.secondary || 0).toFixed(precision);
	$: plotData = buildPlotData(data);
	$: if (plot && plotData) setPlotData();
	$: if (plot && xDomain && yDomain) setPlotScales();

	function buildPlotData(rows) {
		const plotRows = [
			rows.map((row) => row.at),
			rows.map((row) => row.primary ?? null),
		];
		if (showSecondary) plotRows.push(rows.map((row) => row.secondary ?? null));
		return plotRows;
	}

	function cssVar(name) {
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	}

	function chartColor(name) {
		return cssVar(name) || "currentColor";
	}

	function formatXAxisValue(value) {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) return "";

		if (!xDomain) {
			return data.find((row) => row.at === numericValue)?.label || "";
		}

		const domainEnd = Number(xDomain[1]);
		const agoMs = Math.max(0, domainEnd - numericValue);
		return agoMs < 50 ? "now" : `-${(agoMs / 1000).toFixed(1)}s`;
	}

	function formatYAxisValue(value) {
		return Number(value).toFixed(precision);
	}

	function createOptions(width, height) {
		return {
			width,
			height,
			legend: { show: false },
			cursor: {
				show: false,
				x: false,
				y: false,
				points: { show: false },
				drag: { setScale: false },
			},
			padding: [8, 12, 0, 0],
			scales: {
				x: { time: false, auto: false },
				y: { auto: false, range: () => yDomain },
			},
			axes: [
				{
					space: 46,
					size: 24,
					stroke: chartColor("--muted-foreground"),
					grid: { stroke: chartColor("--border"), width: 1 },
					ticks: { show: false },
					values: (_self, values) => values.map(formatXAxisValue),
				},
				{
					space: 28,
					size: 28,
					stroke: chartColor("--muted-foreground"),
					grid: { stroke: chartColor("--border"), width: 1 },
					ticks: { show: false },
					values: (_self, values) => values.map(formatYAxisValue),
				},
			],
			series: [
				{},
				{
					label: "Primary",
					stroke: chartColor("--chart-1"),
					width: 1.5,
					points: { show: false },
				},
				...(showSecondary
					? [
							{
								label: "Secondary",
								stroke: chartColor("--chart-2"),
								width: 1.5,
								points: { show: false },
							},
						]
					: []),
			],
		};
	}

	function chartSize() {
		const rect = chartEl?.getBoundingClientRect();
		return {
			width: Math.max(160, Math.round(rect?.width || 160)),
			height: Math.max(160, Math.round(rect?.height || 220)),
		};
	}

	function setPlotSize() {
		if (!plot) return;
		const { width, height } = chartSize();
		if (width === lastWidth && height === lastHeight) return;
		lastWidth = width;
		lastHeight = height;
		plot.setSize({ width, height });
	}

	function setPlotData() {
		if (!plot || lastData === data) return;
		lastData = data;
		plot.setData(plotData, false);
	}

	function setPlotScales() {
		if (!plot) return;

		const nextX = xDomain || [plotData[0][0] ?? 0, plotData[0].at(-1) ?? 1];
		const nextY = yDomain;

		plot.batch(() => {
			if (lastXMin !== nextX[0] || lastXMax !== nextX[1]) {
				lastXMin = nextX[0];
				lastXMax = nextX[1];
				plot.setScale("x", { min: nextX[0], max: nextX[1] });
			}

			if (lastYMin !== nextY[0] || lastYMax !== nextY[1]) {
				lastYMin = nextY[0];
				lastYMax = nextY[1];
				plot.setScale("y", { min: nextY[0], max: nextY[1] });
			}
		});
	}

	onMount(() => {
		const { width, height } = chartSize();
		lastWidth = width;
		lastHeight = height;
		plot = new uPlot(createOptions(width, height), plotData, chartEl);
		setPlotData();
		setPlotScales();

		resizeObserver = new ResizeObserver(setPlotSize);
		resizeObserver.observe(chartEl);
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		plot?.destroy();
		plot = null;
	});
</script>

<div class="frame-chart uplot-chart" bind:this={chartEl}></div>

<div class="frame-chart-summary">
	<span><strong>{primaryValue}</strong> primary {unit}</span>
	{#if showSecondary}
		<span><strong>{secondaryValue}</strong> secondary {unit}</span>
	{/if}
</div>
