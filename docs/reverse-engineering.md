# Reverse Engineering Notes

This document explains how the Android native libraries were analyzed to build
the current UBox Web network layer.

Scope:

- native `.so` inspection
- Java/JNI mapping
- P4P relay packet format
- KCP correlation
- packet-flow validation

Out of scope:

- bypassing accounts or device ownership
- extracting secrets from third-party devices
- redistributing vendor APKs/libraries
- publishing private packet captures

## Tools

Required:

- `jadx` or `jadx-gui`
- Ghidra
- Android NDK LLVM tools:
  - `llvm-readelf`
  - `llvm-nm`
  - `llvm-objdump`
  - `llvm-strings`
- packet capture tool:
  - Wireshark, tcpdump, or emulator-side capture
- a test account and camera you own

Optional:

- `apktool`
- `zip` / `7z`
- Frida or similar runtime tracer for local authorized testing

## Input Artifacts

The original app package may be APK or XAPK.

Typical extraction:

```sh
mkdir work
cd work
unzip ../UBox.xapk
```

Then inspect APKs inside:

```sh
unzip base.apk -d base
find base/lib -type f
```

Libraries of interest in our case:

```text
libUBICAPIs.so
libUBICAPIs23.so
libUBICAPIs29.so
libdecoder.so
libhi_camplayer_ffmpeg.so
libhi_camplayer_mediacodec.so
```

`libUBICAPIs*.so` was main transport target.

## Step 1: Identify Native Library Architecture

Use `llvm-readelf`:

```sh
llvm-readelf -h libUBICAPIs29.so
```

Observed for `libUBICAPIs29.so`:

```text
Class:   ELF32
Data:    little endian
Machine: ARM
Type:    DYN shared object
SONAME:  libUBICAPIs.so
```

This tells Ghidra import should be 32-bit ARM little-endian.

## Step 2: Export Symbol Inventory

Generate export list:

```sh
llvm-nm -D --defined-only libUBICAPIs29.so > native-exports-ubicapis29.txt
```

Useful exports found:

```text
Java_com_ubia_p4p_UBICAPIs_p4p_client_start
Java_com_ubia_p4p_UBICAPIs_p4p_client_startvideo
Java_com_ubia_p4p_UBICAPIs_p4p_client_stopvideo
Java_com_ubia_p4p_UBICAPIs_p4p_client_send_ioctrl
Java_com_ubia_p4p_UBICAPIs_p4p_client_send_avcommand
Java_com_ubia_p4p_UBICAPIs_p4p_client_set_callback
Java_com_ubia_p4p_UBICAPIs_p4p_client_randomID
```

Important internal symbols:

```text
p4p_client_start
p4p_client_startvideo
p4p_client_stopvideo
p4p_client_send_queryreq
p4p_client_send_rlywakeupreq
p4p_client_send_rlystreamreq
p4p_client_send_alive
p4p_client_send_avctrl
p4p_client_send_ioctrl
p4p_client_handle_packet
p4p_client_handle_queryrsp
p4p_client_handle_rlywakeuprsp
p4p_client_handle_rlystreamrsp
p4p_client_handle_alive
p4p_client_handle_avctrl
p4p_client_handle_kcp
p4p_client_kcp_send
```

KCP symbols were also exported:

```text
ikcp_create
ikcp_input
ikcp_send
ikcp_recv
ikcp_update
ikcp_flush
ikcp_setoutput
ikcp_nodelay
ikcp_wndsize
IKCP_CMD_PUSH
IKCP_CMD_ACK
```

This was strong evidence that transport is:

```text
UBox P4P wrapper -> KCP -> inner AV/video records
```

## Step 3: Java/JNI Mapping With JADX

Open app APK in `jadx-gui`.

Search for:

```text
com.ubia.p4p.UBICAPIs
System.loadLibrary
p4p_client_start
p4p_client_startvideo
p4p_client_set_callback
p4p_client_send_ioctrl
```

Goal:

- find Java class declaring native methods
- find parameter order
- find callback interfaces
- find app-level call sequence

Expected pattern:

```text
load native lib
init/mgmt
set callback
client random ID
client start
client startvideo
callback receives video/audio/ioctrl/data
```

JADX tells what Java thinks each native function means. Ghidra tells how native
code implements it.

## Step 4: Ghidra Import

1. Create new Ghidra project.
2. Import `libUBICAPIs29.so`.
3. Accept ELF import.
4. Confirm language:

```text
ARM:LE:32:v7 or compatible ARM little-endian 32-bit
```

5. Run auto-analysis with defaults.
6. Open Symbol Tree.
7. Start from exports:

```text
Java_com_ubia_p4p_UBICAPIs_p4p_client_startvideo
p4p_client_startvideo
p4p_client_send_rlystreamreq
p4p_client_handle_rlystreamrsp
p4p_client_handle_kcp
p4p_client_kcp_send
```

## Step 5: Rename Functions And Types

Rename as you learn.

Useful convention:

```text
p4p_packet_header
p4p_build_packet
p4p_encode_packet
p4p_decode_packet
p4p_send_udp
p4p_handle_msg_1206
p4p_handle_kcp
```

Add structure for 16-byte P4P header:

```c
struct p4p_header {
    uint16_t magic;
    uint16_t version;
    uint16_t length;
    uint16_t sid_or_channel;
    uint16_t msg;
    uint16_t msg_len;
    uint16_t seq_or_param;
    uint8_t kind;
    uint8_t flag;
};
```

Observed header constants:

```text
magic   0x1807
version 0x0010
```

## Step 6: Identify P4P Encode/Decode

Look for code that:

- transforms packet bytes before UDP send
- reverses transform after UDP receive
- checks `0x1807` and `0x10`
- uses fixed ASCII key-like string

Implemented result in `p4p-codec.js`:

- `decodeP4P()`
- `encodeP4P()`
- `parseHeader()`
- `buildPacket()`

Observed transform:

- 16-byte block processing
- byte swaps
- XOR with fixed key:

```text
I believe 1 ^ill win the battle!
```

- 32-bit rotate operations
- tail block handled separately

This is obfuscation/light encoding, not normal TLS.

## Step 7: Build Message ID Table

Use native names plus packet captures to map message IDs.

Current mapping:

```text
0x1051 query-req
0x1052 query-rsp
0x1201 relay-wakeup-req
0x1202 relay-wakeup-rsp
0x1205 relay-stream-req
0x1206 relay-stream-rsp
0x1403 rdt-video-ack
0x1405 alive / keepalive
0x1406 alive-like inbound
0x1407 avctrl-direct
0x1408 avctrl
0x1409 kcp-client
0x140a kcp-device
```

Correlate functions:

```text
p4p_client_send_queryreq       -> 0x1051
p4p_client_handle_queryrsp     -> 0x1052
p4p_client_send_rlywakeupreq   -> 0x1201
p4p_client_handle_rlywakeuprsp -> 0x1202
p4p_client_send_rlystreamreq   -> 0x1205
p4p_client_handle_rlystreamrsp -> 0x1206
p4p_client_send_alive          -> 0x1405
p4p_client_send_avctrl         -> 0x1407 / 0x1408 area
p4p_client_handle_kcp          -> 0x1409 / 0x140a area
p4p_client_kcp_send            -> 0x1409 outbound
```

## Step 8: Correlate With Packet Capture

Capture one clean live-view session from official app.

Recommended capture plan:

1. Start capture.
2. Open app.
3. Wait until camera listed online.
4. Tap live view.
5. Let stream run 20-30 seconds.
6. Stop live view cleanly.
7. Stop capture.

Useful Wireshark filters:

```text
udp
udp.port == 10240
udp.port == 20001
ip.addr == <relay-ip>
```

Do not publish raw capture. It may include video and session data.

Validation method:

1. Export UDP payload bytes.
2. Run payload through `decodeP4P()`.
3. Confirm header:

```text
magic = 0x1807
version = 0x10
msg sequence matches native function names
```

4. Confirm live-view sequence:

```text
0x1051 -> discovery/query
0x1201 -> relay wakeup
0x1202 -> relay wakeup response
0x1205 -> relay stream request
0x1206 -> relay stream response
0x1405 -> keepalive
0x1407 -> start video
0x1409/0x140a -> KCP data
```

## Step 9: Confirm KCP

KCP signs:

- `ikcp_*` symbols exist
- constants match KCP naming:

```text
IKCP_CMD_PUSH
IKCP_CMD_ACK
IKCP_WND_SND
IKCP_WND_RCV
IKCP_OVERHEAD
```

- KCP segment header observed inside `0x1409` / `0x140a`:

```text
u32 conv
u8  cmd
u8  frg
u16 wnd
u32 ts
u32 sn
u32 una
u32 len
data[len]
```

This matches skywind3000 KCP packet shape.

Our implementation uses `kcpjs` for this middle layer:

```js
this.kcp = new Kcp(conv, { session: this });
this.kcp.setNoDelay(1, 10, 0, 0);
this.kcp.setWndSize(128, 256);
this.kcp.setOutput((data, size) => this.sendKcpOutput(data, size));
```

## Step 10: Rebuild Minimal Network Flow

Implement one stage at a time. Do not jump straight to video.

Order:

1. UDP socket bind.
2. Send `0x1051` query to master/discovery servers.
3. Decode inbound `0x1052` and parse the native VPG item at payload offset
   `0x1c`.
4. Extract up to four relay wake-up endpoints from that VPG item.
5. Send `0x1201` relay wakeup to those discovered relay endpoints.
6. Decode inbound `0x1202`.
7. Send `0x1205` relay stream request to responder.
8. Decode inbound `0x1206`.
9. Extract `sid`, `remoteSid`, `videoSid`.
10. Send keepalive `0x1405`.
11. Send start-video `0x1407`.
12. Accept `0x1409` / `0x140a`.
13. Feed KCP.
14. Drain KCP messages.

Each stage should emit logs before moving to next stage.

## Step 11: Validate Against Native Function Names

Code-to-native map:

```text
p4p-codec.js:buildPacket          approximates native packet builder
p4p-codec.js:encodeP4P/decodeP4P  approximates native packet transform
sendDiscovery                     p4p_client_send_queryreq
sendRelayWakeup                   p4p_client_send_rlywakeupreq
sendRelayStreamRequest            p4p_client_send_rlystreamreq
sendAlive                         p4p_client_send_alive
sendStartVideoControl             p4p_client_startvideo / send_avctrl path
handleDatagram                    p4p_client_handle_packet
handleKcpDatagram                 p4p_client_handle_kcp
sendKcpOutput                     p4p_client_kcp_send
```

If behavior diverges, inspect corresponding native function again.

## Step 12: Useful Ghidra Targets

When stuck, inspect these functions first:

```text
p4p_client_send_rlywakeupreq
p4p_client_send_rlystreamreq
p4p_client_handle_rlystreamrsp
p4p_client_send_alive
p4p_client_startvideo
p4p_client_send_avctrl
p4p_client_handle_kcp
p4p_client_kcp_send
p4p_client_video_callback
ikcp_input
ikcp_send
ikcp_recv
```

Look for:

- constants written into payload
- offsets copied from device identity
- SID/channel fields
- stream index usage
- start/stop video command payload
- timers and retry counters
- ACK payload shape

## Step 13: Runtime Cross-Checks

Best runtime cross-checks:

- Does official app send same message sequence?
- Does our payload length match official app?
- Does `0x1206` response give same SID offsets?
- Does official app use direct `0x1407`, KCP-wrapped command, or both?
- Does official app send `0x1403` video ACK immediately after frames?
- Do KCP `conv`, `sn`, `una`, and command values match expected KCP?

## Step 14: New Camera / Firmware Differences

For another model or firmware, compare network stages:

```text
stage 1: query/wakeup response?
stage 2: relay stream response?
stage 3: SID fields same offsets?
stage 4: start-video accepted?
stage 5: KCP packets arrive?
stage 6: KCP messages drain?
stage 7: video records continue?
```

Possible differences:

- VPG relay endpoints returned by `0x1052`
- IPv4 vs IPv6 relay availability
- device type byte
- stream index
- channel
- video SID seed
- credential fields in `0x1205`
- start-video payload
- video ACK requirements

## Safe Public Debug Output

Publish only sanitized summaries:

```text
event names
message IDs
packet lengths
counters
timing
boolean credential-field presence
KCP queue sizes
KCP error codes
```

Do not publish:

```text
account email
auth token
raw UID
device login ID
device login password
raw packet payloads
video payload
public IPs tied to a private camera
```

## Repro Checklist

From clean APK/XAPK:

```text
1. Extract APK/XAPK.
2. Locate native libraries.
3. Use jadx to find Java native method declarations.
4. Use llvm-readelf to identify ELF architecture.
5. Use llvm-nm to list JNI/native exports.
6. Import libUBICAPIs*.so into Ghidra.
7. Rename JNI wrappers and p4p_client_* functions.
8. Find packet header constants 0x1807 and 0x10.
9. Rebuild P4P encode/decode.
10. Map message IDs from send/handle functions.
11. Confirm KCP via ikcp_* symbols and segment headers.
12. Capture official app live-view packet sequence.
13. Compare our packet sequence stage by stage.
14. Implement only verified fields.
15. Add diagnostics before changing retry/recovery behavior.
```

## Current Confidence

High confidence:

- P4P is UBox outer relay/session wrapper.
- `0x1409` / `0x140a` carry KCP bytes.
- KCP implementation is compatible with skywind-style KCP.
- `0x1201 -> 0x1202 -> 0x1205 -> 0x1206` is relay-open path.
- `0x1405` keepalive matters.

Medium confidence:

- all `0x1205` payload offsets
- all SID offset semantics
- `0x1403` RDT ACK payload completeness
- exact start-video variants needed by every camera model

Low confidence:

- behavior across all regions, firmwares, and cellular camera variants
- long-term loss/reconnect behavior
