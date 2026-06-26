import { getContext, setContext } from "svelte";

export const THEMES = {
	light: "",
	dark: ".dark",
};

const CHART_CONTEXT = Symbol("chart-context");

export function setChartContext(context) {
	setContext(CHART_CONTEXT, context);
	return context;
}

export function getChartContext() {
	const context = getContext(CHART_CONTEXT);
	if (!context) {
		throw new Error("Chart components must be used inside <Chart.Container>.");
	}
	return context;
}

