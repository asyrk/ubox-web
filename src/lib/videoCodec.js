function findStartCodeLength(bytes, offset) {
  if (offset + 3 >= bytes.length) return 0;
  if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) return 3;
  if (offset + 4 < bytes.length
    && bytes[offset] === 0
    && bytes[offset + 1] === 0
    && bytes[offset + 2] === 0
    && bytes[offset + 3] === 1) return 4;
  return 0;
}

function scanAnnexBNals(bytes) {
  const nals = [];
  if (!bytes?.length) return nals;
  for (let i = 0; i < bytes.length - 3; i += 1) {
    const startCodeLength = findStartCodeLength(bytes, i);
    if (!startCodeLength) continue;
    const header = bytes[i + startCodeLength];
    if (header === undefined) continue;
    nals.push({
      offset: i,
      header,
      h264Type: header & 0x1f,
      hevcType: (header >> 1) & 0x3f,
    });
    i += startCodeLength - 1;
  }
  return nals;
}

export function detectStreamFormat(bytes) {
  const nals = scanAnnexBNals(bytes);
  if (!nals.length) return null;
  if (nals.some((nal) => nal.h264Type === 7 || nal.h264Type === 8 || nal.h264Type === 5)) return "h264";
  if (nals.some((nal) => [32, 33, 34, 19, 20, 21].includes(nal.hevcType))) return "hevc";
  if (nals[0].h264Type === 0 && nals[0].hevcType === 32) return "hevc";
  return "h264";
}

export function isAnnexBKeyframe(bytes, format = null) {
  const streamFormat = format || detectStreamFormat(bytes);
  const nals = scanAnnexBNals(bytes);
  if (!nals.length) return false;
  if (streamFormat === "hevc") return nals.some((nal) => nal.hevcType >= 19 && nal.hevcType <= 21);
  return nals.some((nal) => nal.h264Type === 5);
}

function buildHevcCodecString(bytes) {
  const nals = scanAnnexBNals(bytes);
  const sps = nals.find((nal) => nal.hevcType === 33);
  if (!sps) return "hvc1.1.6.L93.B0";
  const start = sps.offset + findStartCodeLength(bytes, sps.offset) + 2;
  if (start + 11 >= bytes.length) return "hvc1.1.6.L93.B0";
  const profileSpace = bytes[start] >> 6;
  const tierFlag = (bytes[start] >> 5) & 1;
  const profileIdc = bytes[start] & 0x1f;
  const level = bytes[start + 11] || 0x5d;
  const tier = tierFlag ? "H" : "L";
  const levelString = level.toString(16).toUpperCase().padStart(2, "0");
  return `hvc1.${profileSpace}.${profileIdc}.${tier}${levelString}.B0`;
}

function buildH264CodecString(bytes) {
  const nals = scanAnnexBNals(bytes);
  const sps = nals.find((nal) => nal.h264Type === 7);
  if (!sps) return "avc1.640016";
  const start = sps.offset + findStartCodeLength(bytes, sps.offset);
  if (start + 3 >= bytes.length) return "avc1.640016";
  return `avc1.${[bytes[start + 1], bytes[start + 2], bytes[start + 3]].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function buildWebCodecsCodecString(bytes, format = null) {
  const streamFormat = format || detectStreamFormat(bytes);
  if (streamFormat === "hevc") return buildHevcCodecString(bytes);
  return buildH264CodecString(bytes);
}

export function analyzeAnnexBFrame(bytes) {
  const nals = scanAnnexBNals(bytes);
  const h264Types = nals.map((nal) => nal.h264Type);
  const hevcTypes = nals.map((nal) => nal.hevcType);
  const format = detectStreamFormat(bytes);
  const chunkType = format === "hevc"
    ? (hevcTypes.some((type) => type >= 19 && type <= 21) ? "key" : "delta")
    : (h264Types.includes(5) ? "key" : "delta");
  return { format, h264Types, hevcTypes, chunkType, codec: format ? buildWebCodecsCodecString(bytes, format) : null };
}

export function defaultCodecForFormat(format) {
  return format === "hevc" ? "hvc1.1.6.L93.B0" : "avc1.640016";
}

export function buildDecoderConfig(codec, format) {
  const streamFormat = format || (codec.startsWith("hvc") || codec.startsWith("hev") ? "hevc" : "h264");
  if (streamFormat === "hevc") {
    return {
      codec,
      hevc: { format: "annexb" },
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    };
  }
  return {
    codec,
    avc: { format: "annexb" },
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  };
}

export function codecCandidatesForFrame(bytes, format) {
  const detected = buildWebCodecsCodecString(bytes, format);
  const defaults = format === "hevc"
    ? [detected, "hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"]
    : [detected, "avc1.640016"];
  return [...new Set(defaults.filter(Boolean))];
}
