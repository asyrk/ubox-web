import { clsx, } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
	return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any

const RELATIVE_UNITS = [
	["year", 31536000],
	["month", 2592000],
	["day", 86400],
	["hour", 3600],
	["minute", 60],
];

// Human-friendly "3 hours ago" from a unix (seconds) timestamp.
export function formatRelativeUtc(utcSeconds) {
	if (!utcSeconds) return null;
	const deltaSeconds = Math.round(Date.now() / 1000 - utcSeconds);
	if (deltaSeconds < 45) return "just now";
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, secondsPerUnit] of RELATIVE_UNITS) {
		if (Math.abs(deltaSeconds) >= secondsPerUnit || unit === "minute") {
			return formatter.format(-Math.round(deltaSeconds / secondsPerUnit), unit);
		}
	}
	return "just now";
}