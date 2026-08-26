// Minimal MP4 track extractor for cloud recordings. Two-sensor cameras
// record one mp4 with two 640x360 avc1 video tracks plus one audio track;
// browsers only play the first video track, so the backend demuxes a
// single-track mp4 on demand (mirrors the app's split playback).
const { Buffer } = require("buffer");

function fourcc(buf, offset) {
  return buf.toString("latin1", offset, offset + 4);
}

function parseBoxes(buf, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    const type = fourcc(buf, offset + 4);
    if (size < 8) break;
    const boxEnd = size === 0 ? end : size === 1 ? offset + 8 + Number(buf.readBigUInt64BE(offset + 8)) : offset + size;
    if (boxEnd > end) break;
    boxes.push({ type, start: offset, size: boxEnd - offset });
    offset = boxEnd;
  }
  return boxes;
}

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(8 + payload.length, 0);
  out.write(type, 4, "latin1");
  payload.copy(out, 8);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function children(buf, parent) {
  return parseBoxes(buf, parent.start + 8, parent.start + parent.size);
}

function sub(buf, parent) {
  return buf.subarray(parent.start, parent.start + parent.size);
}

function readStbl(buf, stbl) {
  const list = children(buf, stbl);
  const pick = (type) => {
    const found = list.find((child) => child.type === type);
    return found ? sub(buf, found) : null;
  };
  return { stsd: pick("stsd"), stts: pick("stts"), stsz: pick("stsz"), stsc: pick("stsc"), stss: pick("stss") };
}

// Chunk byte ranges for a track, in chunk order.
function chunkRanges(buf, stbl) {
  const stco = children(buf, stbl).find((child) => child.type === "stco");
  const stsz = children(buf, stbl).find((child) => child.type === "stsz");
  const stsc = children(buf, stbl).find((child) => child.type === "stsc");
  if (!stco || !stsz || !stsc) return [];
  const chunkCount = stco.size >= 16 ? stco.start + stco.size - (stco.start + 16) : 0;
  const offsets = [];
  for (let i = 0; i < chunkCount / 4; i += 1) offsets.push(buf.readUInt32BE(stco.start + 16 + i * 4));
  const fixedSize = buf.readUInt32BE(stsz.start + 12);
  const sampleCount = buf.readUInt32BE(stsz.start + 16);
  const sizes = [];
  for (let i = 0; i < sampleCount; i += 1) sizes.push(fixedSize !== 0 ? fixedSize : buf.readUInt32BE(stsz.start + 20 + i * 4));
  const stscCount = buf.readUInt32BE(stsc.start + 12);
  const stscEntries = [];
  for (let i = 0; i < stscCount; i += 1) {
    stscEntries.push({ firstChunk: buf.readUInt32BE(stsc.start + 16 + i * 12), samplesPerChunk: buf.readUInt32BE(stsc.start + 20 + i * 12) });
  }
  const ranges = [];
  let sampleIndex = 0;
  for (let chunk = 0; chunk < offsets.length; chunk += 1) {
    let samplesPerChunk = 1;
    for (let i = stscEntries.length - 1; i >= 0; i -= 1) {
      if (stscEntries[i].firstChunk <= chunk + 1) {
        samplesPerChunk = stscEntries[i].samplesPerChunk;
        break;
      }
    }
    let length = 0;
    for (let s = 0; s < samplesPerChunk; s += 1) {
      if (sampleIndex >= sizes.length) break;
      length += sizes[sampleIndex];
      sampleIndex += 1;
    }
    ranges.push({ start: offsets[chunk], end: offsets[chunk] + length });
  }
  return ranges;
}

// Rebuild a trak, replacing stco inside its stbl with the given box.
function rebuildTrak(buf, trak, stcoBox) {
  const parts = [];
  for (const child of children(buf, trak)) {
    if (child.type === "mdia") {
      const mdiaParts = [];
      for (const mdiaChild of children(buf, child)) {
        if (mdiaChild.type === "minf") {
          const minfParts = [];
          for (const minfChild of children(buf, mdiaChild)) {
            if (minfChild.type === "stbl") {
              const info = readStbl(buf, minfChild);
              const parts = [info.stsd, info.stts, info.stsz, info.stsc, stcoBox, info.stss].filter(Boolean);
              minfParts.push(box("stbl", ...parts));
            } else {
              minfParts.push(sub(buf, minfChild));
            }
          }
          mdiaParts.push(box("minf", ...minfParts));
        } else {
          mdiaParts.push(sub(buf, mdiaChild));
        }
      }
      parts.push(box("mdia", ...mdiaParts));
    } else {
      parts.push(sub(buf, child));
    }
  }
  return box("trak", ...parts);
}

function extractTrack(input, trackId) {
  const top = parseBoxes(input, 0, input.length);
  const ftyp = top.find((found) => found.type === "ftyp");
  const moov = top.find((found) => found.type === "moov");
  if (!ftyp || !moov) throw new Error("missing ftyp/moov");
  const mvhd = children(input, moov).find((found) => found.type === "mvhd");
  if (!mvhd) throw new Error("missing mvhd");

  const classified = children(input, moov)
    .filter((found) => found.type === "trak")
    .map((trak) => {
      const tkhd = children(input, trak).find((found) => found.type === "tkhd");
      const mdia = children(input, trak).find((found) => found.type === "mdia");
      const hdlr = mdia ? children(input, mdia).find((found) => found.type === "hdlr") : null;
      return {
        trak,
        id: tkhd ? input.readUInt32BE(tkhd.start + 8 + 12) : 0,
        handler: hdlr ? fourcc(input, hdlr.start + 16) : "",
      };
    });

  const video = classified.find((item) => item.handler === "vide" && item.id === trackId);
  const audio = classified.find((item) => item.handler === "soun");
  if (!video) throw new Error(`video track ${trackId} not found`);
  const selected = audio ? [video, audio] : [video];

  // Copy each selected track's sample bytes and record new chunk offsets.
  const payloads = [];
  const offsetLists = [];
  let running = 0;
  for (const item of selected) {
    const mdia = children(input, item.trak).find((found) => found.type === "mdia");
    const minf = children(input, mdia).find((found) => found.type === "minf");
    const stbl = children(input, minf).find((found) => found.type === "stbl");
    const offsets = [];
    for (const range of chunkRanges(input, stbl)) {
      offsets.push(running);
      payloads.push(input.subarray(range.start, range.end));
      running += range.end - range.start;
    }
    offsetLists.push(offsets);
  }
  const payload = Buffer.concat(payloads);

  // stco values depend on moov size; build with zeros first, then rebuild.
  const buildMoov = (offsetListsFor) =>
    box(
      "moov",
      sub(input, mvhd),
      ...selected.map((item, index) => {
        const offsets = offsetListsFor ? offsetListsFor[index] : item.offsets ? item.offsets : offsetLists[index].map(() => 0);
        const stcoPayload = Buffer.concat([u32(0), u32(offsets.length), ...offsets.map(u32)]);
        return rebuildTrak(input, item.trak, box("stco", stcoPayload));
      }),
    );
  const placeholder = buildMoov(null);
  const mdatOffset = ftyp.size + placeholder.length + 8;
  const realOffsets = offsetLists.map((offsets) => offsets.map((value) => mdatOffset + value));
  const moovOut = buildMoov(realOffsets);

  return Buffer.concat([sub(input, ftyp), moovOut, box("mdat", payload)]);
}

module.exports = { extractTrack };
