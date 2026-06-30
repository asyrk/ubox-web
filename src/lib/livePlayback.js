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

function nalTypes(annexB) {
  const types = [];
  for (let i = 0; i < annexB.byteLength - 4; i += 1) {
    let start = 0;
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) start = 3;
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1) start = 4;
    if (!start) continue;
    const header = annexB[i + start];
    if (header !== undefined) types.push(header & 31);
    i += start;
  }
  return types;
}

export function clearCanvas(canvas) {
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
}

export function createLivePlaybackController({ api, log, setCaptureStatus, recordFrame, recordBytes }) {
  const playbacks = new Set();

  function stop() {
    for (const playback of playbacks) {
      playback.abort?.abort();
      if (playback.timer) window.clearInterval(playback.timer);
      try {
        if (playback.decoder?.state !== "closed") playback.decoder.close();
      } catch (error) {
        log("stream", "decoder-close-error", { message: error.message });
      }
    }
    playbacks.clear();
  }

  async function waitForH264Codec(signal, { attempts = 8, intervalMs = 250, name = "stream", track = "primary" } = {}) {
    log(name, "codec-wait-start", { track, attempts, intervalMs });
    for (let i = 0; i < attempts; i += 1) {
      if (signal?.aborted) throw new DOMException("Live playback was stopped.", "AbortError");
      const reply = await api("/api/stream/status");
      const codec = reply?.session?.mp4Codec;
      if (codec) {
        log(name, "codec-wait-found", { track, codec, attempt: i + 1 });
        return codec;
      }
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }
    log(name, "codec-wait-timeout", { track, fallback: "avc1.640016" });
    return "avc1.640016";
  }

  async function startCanvas(canvas, track = "primary", name = track) {
    if (!canvas) {
      log(name, "canvas-missing", { track });
      return;
    }
    if (!("VideoDecoder" in window) || !("EncodedVideoChunk" in window)) {
      log(name, "webcodecs-missing", {
        track,
        hasVideoDecoder: "VideoDecoder" in window,
        hasEncodedVideoChunk: "EncodedVideoChunk" in window,
      });
      throw new Error("This browser does not expose WebCodecs VideoDecoder.");
    }

    const abort = new AbortController();
    const playback = { abort, decoder: null, timer: null, track };
    playbacks.add(playback);
    clearCanvas(canvas);

    const context = canvas.getContext("2d");

    let decodedFrames = 0;
    let lastPaintedAt = 0;
    const bufferedFrames = [];
    let receivedFrames = 0;
    let droppedBufferedFrames = 0;
    let playbackStarted = false;
    const targetBufferFrames = 12;
    const maxBufferFrames = 45;
    const frameIntervalMs = 1000 / 15;

    log(name, "h264-fetch-start", { track });
    const response = await fetch(`/api/stream/live.h264?track=${encodeURIComponent(track)}&t=${Date.now()}`, {
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Live H.264 request failed: ${response.status}`);
    log(name, "h264-client-opened", {
      track,
      status: response.status,
      contentType: response.headers.get("content-type"),
    });

    const reader = response.body.getReader();
    let pending = new Uint8Array();
    let timestamp = 0;
    const duration = Math.round(1_000_000 / 15);
    let decoder = null;

    async function configureDecoder() {
      const codec = await waitForH264Codec(abort.signal, { name, track });
      const config = {
        codec,
        avc: { format: "annexb" },
        hardwareAcceleration: "prefer-hardware",
        optimizeForLatency: true,
      };
      log(name, "decoder-config-start", { track, codec, buffered: bufferedFrames.length });
      const support = await VideoDecoder.isConfigSupported(config).catch((error) => ({
        supported: false,
        error,
      }));
      if (!support.supported) {
        log(name, "decoder-config-failed", {
          track,
          codec,
          message: support.error?.message || "unsupported config",
          buffered: bufferedFrames.length,
        });
        throw new Error(`Browser rejected raw H.264 decoder config ${codec}.`);
      }

      decoder = new VideoDecoder({
        output(frame) {
          try {
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
              log(name, "webcodecs-size", {
                track,
                width: frame.displayWidth,
                height: frame.displayHeight,
              });
            }
            context.drawImage(frame, 0, 0, canvas.width, canvas.height);
            decodedFrames += 1;
            lastPaintedAt = performance.now();
            if (decodedFrames <= 5 || decodedFrames % 30 === 0) {
              setCaptureStatus(`Live WebCodecs: ${track} ${decodedFrames} frame(s) decoded.`);
              log(name, "webcodecs-frame-decoded", { track, frames: decodedFrames });
            }
          } finally {
            frame.close();
          }
        },
        error(error) {
          setCaptureStatus(error.message);
          log(name, "webcodecs-error", { track, message: error.message });
        },
      });
      playback.decoder = decoder;
      decoder.configure(support.config || config);
      log(name, "decoder-configured", { track, codec, buffered: bufferedFrames.length });
      pumpBufferedFrame();
    }

    function dropOldBufferedFrames() {
      while (bufferedFrames.length > maxBufferFrames) {
        const nextKey = bufferedFrames.findIndex((item, index) => index > 0 && item.chunkType === "key");
        const dropCount = nextKey > 0 ? nextKey : 1;
        bufferedFrames.splice(0, dropCount);
        droppedBufferedFrames += dropCount;
      }
    }

    function pumpBufferedFrame() {
      if (!decoder || decoder.state !== "configured") return;
      if (!playbackStarted) {
        const firstKey = bufferedFrames.findIndex((item) => item.chunkType === "key");
        if (firstKey < 0) return;
        if (firstKey > 0) {
          bufferedFrames.splice(0, firstKey);
          droppedBufferedFrames += firstKey;
        }
        if (bufferedFrames.length < targetBufferFrames) return;
        if (!bufferedFrames.length) return;
        playbackStarted = true;
        log(name, "webcodecs-buffer-ready", { track, buffered: bufferedFrames.length, dropped: droppedBufferedFrames });
      }
      if (decoder.decodeQueueSize > 4 || !bufferedFrames.length) return;
      const item = bufferedFrames.shift();
      try {
        decoder.decode(new EncodedVideoChunk({
          type: item.chunkType,
          timestamp,
          duration,
          data: item.frame,
        }));
        timestamp += duration;
      } catch (error) {
        playbackStarted = false;
        const nextKey = bufferedFrames.findIndex((frame) => frame.chunkType === "key");
        if (nextKey > 0) bufferedFrames.splice(0, nextKey);
        if (nextKey < 0 && bufferedFrames.length > maxBufferFrames) {
          bufferedFrames.splice(0, bufferedFrames.length - maxBufferFrames);
        }
        log(name, "webcodecs-decode-skipped", { track, message: error.message, buffered: bufferedFrames.length });
      }
    }

    playback.timer = window.setInterval(pumpBufferedFrame, frameIntervalMs);
    configureDecoder().catch((error) => {
      if (error.name === "AbortError") return;
      setCaptureStatus(error.message);
      log(name, "decoder-start-error", { track, message: error.message, buffered: bufferedFrames.length });
    });

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
          const types = nalTypes(frame);
          const chunkType = types.includes(5) ? "key" : "delta";
          bufferedFrames.push({ frame, chunkType, types });
          dropOldBufferedFrames();
          pumpBufferedFrame();
          if (receivedFrames <= 5 || receivedFrames % 30 === 0) {
            log(name, "webcodecs-frame-buffered", {
              track,
              received: receivedFrames,
              buffered: bufferedFrames.length,
              dropped: droppedBufferedFrames,
              bytes: frame.byteLength,
              chunkType,
              queue: decoder?.decodeQueueSize,
              types: types.join(","),
              msSincePaint: lastPaintedAt ? Math.round(performance.now() - lastPaintedAt) : null,
            });
          }
          if (!decoder && (receivedFrames <= 5 || receivedFrames % 30 === 0)) {
            log(name, "frames-buffered-before-decoder", { track, received: receivedFrames, buffered: bufferedFrames.length });
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
