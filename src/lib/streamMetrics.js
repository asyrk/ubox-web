export const FRAME_WINDOWS = [5, 10, 20, 30];
export const CHART_BUCKET_MS = 100;
export const MAX_FRAME_WINDOW_MS = Math.max(...FRAME_WINDOWS) * 1000;

export function trimSamples(samples, now = Date.now()) {
  return samples.filter((sample) => now - sample.at <= MAX_FRAME_WINDOW_MS + 1000);
}

function buildBuckets(seconds, now) {
  const end = Math.floor(now / CHART_BUCKET_MS) * CHART_BUCKET_MS;
  const start = end - seconds * 1000 + CHART_BUCKET_MS;
  const buckets = new Map();

  for (let at = start; at <= end; at += CHART_BUCKET_MS) {
    const agoMs = end - at;
    buckets.set(at, {
      at,
      label: agoMs ? `-${(agoMs / 1000).toFixed(1)}s` : "now",
      primary: 0,
      secondary: 0,
    });
  }

  return { buckets, start, end };
}

export function buildFrameChartData(samples, seconds, now) {
  const { buckets, start, end } = buildBuckets(seconds, now);

  for (const sample of samples) {
    if (sample.at < start || sample.at > end + CHART_BUCKET_MS - 1) continue;
    const bucket = buckets.get(Math.floor(sample.at / CHART_BUCKET_MS) * CHART_BUCKET_MS);
    if (!bucket) continue;
    if (sample.track === "secondary") bucket.secondary += 1;
    else bucket.primary += 1;
  }

  return [...buckets.values()].map((row) => ({
    ...row,
    primary: row.primary * (1000 / CHART_BUCKET_MS),
    secondary: row.secondary * (1000 / CHART_BUCKET_MS),
  }));
}

export function buildByteChartData(samples, seconds, now) {
  const { buckets, start, end } = buildBuckets(seconds, now);

  for (const sample of samples) {
    if (sample.at < start || sample.at > end + CHART_BUCKET_MS - 1) continue;
    const bucket = buckets.get(Math.floor(sample.at / CHART_BUCKET_MS) * CHART_BUCKET_MS);
    if (!bucket) continue;
    if (sample.track === "secondary") bucket.secondary += sample.bytes / 1024;
    else bucket.primary += sample.bytes / 1024;
  }

  return [...buckets.values()].map((row) => ({
    ...row,
    primary: Math.round(row.primary * (1000 / CHART_BUCKET_MS) * 10) / 10,
    secondary: Math.round(row.secondary * (1000 / CHART_BUCKET_MS) * 10) / 10,
  }));
}
