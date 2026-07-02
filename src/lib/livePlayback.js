import {
  analyzeAnnexBFrame,
  codecCandidatesForFrame,
} from "./videoCodec.js";

const PLAYOUT_FPS = 12;
const PLAYOUT_FRAME_MS = 1000 / PLAYOUT_FPS;
const CHUNK_DURATION_US = Math.round(1_000_000 / 15);
const DECODE_AHEAD_TARGET = 24;
const MAX_ENCODED_QUEUE = 75;
const MAX_DISPLAY_QUEUE = 36;
const MERGE_FRAGMENT_MAX_BYTES = 512;
const MAX_DECODER_QUEUE = 10;

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function clearCanvas(canvas) {
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
}

export function createLivePlaybackController({ log, setCaptureStatus, recordFrame, recordBytes }) {
  const playbacks = new Set();

  function stop() {
    for (const playback of playbacks) {
      playback.abort?.abort();
      if (playback.pumpTimer) window.cancelAnimationFrame(playback.pumpTimer);
      if (playback.displayTimer) window.clearInterval(playback.displayTimer);
      for (const frame of playback.displayQueue || []) {
        try { frame.close(); } catch { /* ignore */ }
      }
      try {
        if (playback.decoder?.state !== "closed") playback.decoder.close();
      } catch (error) {
        log("stream", "decoder-close-error", { message: error.message });
      }
    }
    playbacks.clear();
  }

  async function startCanvas(canvas, track = "primary", name = track) {
    if (!canvas) {
      log(name, "canvas-missing", { track });
      return;
    }
    if (!("VideoDecoder" in window) || !("EncodedVideoChunk" in window)) {
      throw new Error("This browser does not expose WebCodecs VideoDecoder.");
    }

    const abort = new AbortController();
    const encodedQueue = [];
    const displayQueue = [];
    const playback = {
      abort,
      decoder: null,
      pumpTimer: null,
      displayTimer: null,
      displayQueue,
      track,
    };
    playbacks.add(playback);
    clearCanvas(canvas);

    const context = canvas.getContext("2d");
    let decodedFrames = 0;
    let displayedFrames = 0;
    let skippedFrames = 0;
    let droppedEncodedFrames = 0;
    let droppedDisplayFrames = 0;
    let receivedFrames = 0;
    let lastPaintedAt = 0;
    let decodeTimestamp = 0;
    let decoder = null;
    let streamFormat = null;
    let configuringDecoder = false;
    let hasDisplayedFrame = false;

    log(name, "h264-fetch-start", { track, decodeAhead: DECODE_AHEAD_TARGET, displayFps: PLAYOUT_FPS });
    const response = await fetch(`/api/stream/live.h264?track=${encodeURIComponent(track)}&t=${Date.now()}`, {
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Live H.264 request failed: ${response.status}`);
    log(name, "h264-client-opened", { track, status: response.status });

    const reader = response.body.getReader();
    let pending = new Uint8Array();

    function clearDisplayQueue() {
      for (const frame of displayQueue) {
        try { frame.close(); } catch { /* ignore */ }
      }
      displayQueue.length = 0;
    }

    function resetDecoder(reason) {
      decodeTimestamp = 0;
      try {
        if (decoder && decoder.state !== "closed") decoder.close();
      } catch {
        // ignore close errors during reset
      }
      decoder = null;
      playback.decoder = null;
      clearDisplayQueue();
      log(name, "decoder-reset", { track, reason, encoded: encodedQueue.length });
    }

    function trimEncodedQueue() {
      while (encodedQueue.length > MAX_ENCODED_QUEUE) {
        const nextKey = encodedQueue.findIndex((item, index) => index > 0 && item.chunkType === "key");
        const dropCount = nextKey > 0 ? nextKey : 1;
        encodedQueue.splice(0, dropCount);
        droppedEncodedFrames += dropCount;
      }
    }

    function trimDisplayQueue() {
      while (displayQueue.length > MAX_DISPLAY_QUEUE) {
        const dropped = displayQueue.shift();
        try { dropped.close(); } catch { /* ignore */ }
        droppedDisplayFrames += 1;
      }
    }

    function mergeIntoPrevious(frame, analysis) {
      const previous = encodedQueue[encodedQueue.length - 1];
      const merged = concatBytes([previous.frame, frame]);
      const mergedAnalysis = analyzeAnnexBFrame(merged);
      encodedQueue[encodedQueue.length - 1] = {
        frame: merged,
        chunkType: mergedAnalysis.chunkType === "key" ? "key" : previous.chunkType,
        format: mergedAnalysis.format || previous.format,
      };
    }

    function appendEncodedFrame(frame, analysis) {
      const previous = encodedQueue[encodedQueue.length - 1];
      const isSmallFragment = frame.byteLength < MERGE_FRAGMENT_MAX_BYTES;
      if (previous && isSmallFragment && (analysis.chunkType !== "key" || previous.chunkType === "key")) {
        mergeIntoPrevious(frame, analysis);
        return;
      }
      encodedQueue.push({
        frame,
        chunkType: analysis.chunkType,
        format: analysis.format,
      });
      trimEncodedQueue();
    }

    function paintFrame(frame) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      hasDisplayedFrame = true;
      displayedFrames += 1;
      lastPaintedAt = performance.now();
    }

    function startDisplayLoop() {
      if (playback.displayTimer) return;
      playback.displayTimer = window.setInterval(() => {
        if (!displayQueue.length) return;

        const frame = displayQueue.shift();
        try {
          paintFrame(frame);
          if (displayedFrames <= 5 || displayedFrames % 30 === 0) {
            setCaptureStatus(
              `Live: ${displayedFrames} frame(s), ${displayQueue.length} queued, ${encodedQueue.length} decoding.`,
            );
            log(name, "webcodecs-frame-displayed", {
              track,
              displayed: displayedFrames,
              decoded: decodedFrames,
              queued: displayQueue.length,
              encoded: encodedQueue.length,
            });
          }
        } finally {
          frame.close();
        }
      }, PLAYOUT_FRAME_MS);
    }

    function pumpDecode(force = false) {
      if (!decoder || decoder.state !== "configured") return;

      const firstKey = encodedQueue.findIndex((item) => item.chunkType === "key");
      if (firstKey > 0) {
        encodedQueue.splice(0, firstKey);
        droppedEncodedFrames += firstKey;
      }

      while (
        encodedQueue.length > 0
        && displayQueue.length < DECODE_AHEAD_TARGET
        && (force || decoder.decodeQueueSize < MAX_DECODER_QUEUE)
      ) {
        const item = encodedQueue.shift();
        try {
          decoder.decode(new EncodedVideoChunk({
            type: item.chunkType,
            timestamp: decodeTimestamp,
            duration: CHUNK_DURATION_US,
            data: item.frame,
          }));
          decodeTimestamp += CHUNK_DURATION_US;
          force = false;
        } catch (error) {
          skippedFrames += 1;
          if (item.chunkType === "key") {
            resetDecoder(error.message);
            configureDecoder(item.frame, item.format || streamFormat).catch(() => {});
            break;
          }
          log(name, "webcodecs-decode-skipped", {
            track,
            message: error.message,
            chunkType: item.chunkType,
            bytes: item.frame.byteLength,
            skipped: skippedFrames,
          });
        }
      }
    }

    function schedulePump() {
      playback.pumpTimer = window.requestAnimationFrame(() => {
        pumpDecode(false);
        schedulePump();
      });
    }

    async function configureDecoder(keyframe, format) {
      if (decoder || configuringDecoder || !keyframe?.byteLength || !format) return;
      configuringDecoder = true;
      try {
        const candidates = codecCandidatesForFrame(keyframe, format);
        let configured = false;
        let lastError = null;

        for (const codec of candidates) {
          const config = format === "hevc"
            ? { codec, hevc: { format: "annexb" }, hardwareAcceleration: "prefer-hardware", optimizeForLatency: false }
            : { codec, avc: { format: "annexb" }, hardwareAcceleration: "prefer-hardware", optimizeForLatency: false };

          const support = await VideoDecoder.isConfigSupported(config).catch((error) => ({
            supported: false,
            error,
          }));
          if (!support.supported) {
            lastError = support.error;
            continue;
          }

          streamFormat = format;
          decoder = new VideoDecoder({
            output(frame) {
              decodedFrames += 1;
              displayQueue.push(frame);
              trimDisplayQueue();
              startDisplayLoop();

              // Show the first decoded frame immediately so the canvas is not black.
              if (!hasDisplayedFrame) {
                const first = displayQueue.shift();
                try {
                  paintFrame(first);
                } finally {
                  first.close();
                }
              }

              pumpDecode(true);
            },
            error(error) {
              log(name, "webcodecs-error", { track, message: error.message, format: streamFormat });
              resetDecoder(error.message);
              const nextKey = encodedQueue.findIndex((item) => item.chunkType === "key");
              if (nextKey >= 0) {
                configureDecoder(encodedQueue[nextKey].frame, streamFormat || format).catch(() => {});
              }
            },
          });
          playback.decoder = decoder;
          decoder.configure(support.config || config);
          configured = true;
          log(name, "decoder-configured", {
            track,
            codec,
            format,
            encoded: encodedQueue.length,
            decodeAhead: DECODE_AHEAD_TARGET,
          });
          break;
        }

        if (!configured) {
          throw new Error(lastError?.message || `Browser rejected ${format.toUpperCase()} decoder configs.`);
        }
        pumpDecode(true);
      } finally {
        configuringDecoder = false;
      }
    }

    schedulePump();

    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        recordBytes(track, value.byteLength);
        pending = concatBytes([pending, value]);

        while (pending.byteLength >= 4) {
          const length = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(0);
          if (!length || pending.byteLength < 4 + length) break;
          const frame = pending.slice(4, 4 + length);
          pending = pending.slice(4 + length);
          receivedFrames += 1;
          recordFrame(track);

          const analysis = analyzeAnnexBFrame(frame);
          if (analysis.format && !streamFormat) streamFormat = analysis.format;
          appendEncodedFrame(frame, analysis);

          if (!decoder && analysis.chunkType === "key" && analysis.format) {
            configureDecoder(
              encodedQueue[encodedQueue.length - 1]?.frame || frame,
              analysis.format,
            ).catch((error) => {
              if (error.name === "AbortError") return;
              setCaptureStatus(error.message);
              log(name, "decoder-start-error", { track, message: error.message });
            });
          } else {
            pumpDecode(true);
          }

          if (receivedFrames <= 5 || receivedFrames % 60 === 0) {
            log(name, "webcodecs-frame-buffered", {
              track,
              received: receivedFrames,
              encoded: encodedQueue.length,
              queued: displayQueue.length,
              droppedEncoded: droppedEncodedFrames,
              skipped: skippedFrames,
              bytes: frame.byteLength,
              chunkType: analysis.chunkType,
              format: analysis.format || streamFormat,
              decodeQueue: decoder?.decodeQueueSize,
              msSincePaint: lastPaintedAt ? Math.round(performance.now() - lastPaintedAt) : null,
            });
          }
        }
      }
    })().catch((error) => {
      if (error.name === "AbortError") return;
      log(name, "webcodecs-reader-error", { track, message: error.message });
      setCaptureStatus(error.message);
    });
  }

  return { startCanvas, stop, clearCanvas };
}
