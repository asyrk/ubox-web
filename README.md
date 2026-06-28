# IMPORTANT

This project was 100% vibecoded. I have not reviewed this code, nor did I code anything that you can see here. I needed a web viewer since there's nothing native, so I asked the AI to do it - and after few days it came up with this. Use at your own risk, I take no responsibility for anything this does, I will not maintain it, I will not accept pull requests.

I hope this can serve as a base for somebody smarter than me and with more time to spare, to create something universally usable.

# UBox Web

Unofficial local web viewer for UBox-compatible cameras. It logs in to your UBox
account, lists your cameras, starts the live camera session, decodes the H.264
video in the browser, and shows transport diagnostics while the stream is
running.

This project is intended for cameras and accounts you own. It is not affiliated
with UBox, Ubi, Ubia, APKPure, or the Android app vendor.

## Status

Working:

- Account login against the UBox cloud API
- Remembered local login between debug sessions
- Camera/device list
- Live stream startup through the reverse-engineered UBox relay path
- Dual-channel display for devices that expose primary and secondary streams
- Browser-side H.264 decode through WebCodecs
- Live diagnostics for bytes/sec, frames/sec, and stream session events
- Vite HMR development on the same local origin as the backend

Still experimental:

- The live transport is reverse engineered from traffic and native-library
  behavior, so reconnect and loss handling may still need tuning.
- WebCodecs is required for live playback. Use a Chromium-based browser.
- The project is a local viewer, not a packaged desktop app yet.

<img width="963" height="863" alt="image" src="https://github.com/user-attachments/assets/0da3c2c6-22b6-49d4-a162-a0eee0f869e0" />

## Why It Works This Way

The Android app does not expose a simple RTSP or HTTP video URL. Its live view
uses native Android libraries and a proprietary relay/P2P protocol. Loading those
Android `.so` libraries directly in a normal Windows web app is not practical,
and bridging through an emulator would only mirror the app instead of producing a
real reusable viewer.

So this project uses a local Node backend to handle the parts a browser cannot:

- UBox cloud API login and device lookup
- live session setup
- relay/P2P packet handling
- KCP-like stream reassembly
- extraction of length-prefixed Annex B H.264 frames

The browser handles what it is good at:

- account/device/live-stream UI
- WebCodecs H.264 decode
- drawing decoded frames to canvas
- diagnostics charts and event logs

Keeping backend and frontend on the same local origin avoids CORS problems,
keeps auth local, and makes stream endpoints simple:

- `GET /api/status`
- `POST /api/login`
- `GET /api/devices`
- `POST /api/stream/start`
- `GET /api/stream/live.h264?track=primary`
- `GET /api/stream/live.h264?track=secondary`
- `GET /api/stream/events`
- `POST /api/stream/stop`

## Architecture

```mermaid
flowchart LR
  Browser["Svelte app"]
  Backend["Local Node backend"]
  UBox["UBox cloud API"]
  Relay["UBox relay/P2P network"]
  Camera["Camera"]

  Browser -->|"login, devices, stream control"| Backend
  Backend -->|"auth and device APIs"| UBox
  Backend -->|"relay session and video transport"| Relay
  Relay --> Camera
  Backend -->|"length-prefixed H.264"| Browser
  Backend -->|"SSE diagnostics"| Browser
```

## Network Layer Architecture

Live video is not fetched from a normal URL. The backend builds the same kind of
relay session the Android app appears to build.

Transport stack:

```text
UDP socket
  -> UBox P4P packet wrapper
      -> relay/session messages
      -> KCP packets in 0x1409 / 0x140a messages
          -> UBox inner stream records
              -> Annex B H.264 frames
                  -> browser WebCodecs canvas playback
```

### P4P

`P4P` is the project name for the proprietary UBox outer packet/session layer.
The name comes from symbols found in the Android native libraries, such as
`p4p_client_send_rlystreamreq`, `p4p_client_handle_kcp`, and
`Java_com_ubia_p4p_UBICAPIs_*`.

P4P handles:

- packet header and light byte obfuscation
- discovery/query packets
- relay wake-up
- relay stream open
- session IDs (`sid`, `remoteSid`, `videoSid`)
- keepalive
- start-video control
- carrying KCP bytes

P4P packet header shape:

```text
magic, version, length, sid/channel, msg, msgLen, seqOrParam, kind, flag
```

Important P4P message IDs:

```text
0x1051 query request
0x1201 relay wake-up request
0x1202 relay wake-up response
0x1205 relay stream request
0x1206 relay stream response
0x1405 keepalive
0x1407 start-video control
0x1409 KCP client packet
0x140a KCP device packet
```

### KCP

KCP is the reliable ordered transport running inside the P4P relay session. The
native library exports `ikcp_*` symbols and KCP constants, and the observed
packet shape matches the original [skywind3000/kcp](https://github.com/skywind3000/kcp)
segment header:

```text
conv, cmd, frg, wnd, ts, sn, una, len, data
```

The backend uses `kcpjs` for this layer. Incoming `0x1409` / `0x140a` payloads
are fed into KCP; KCP output is wrapped back into P4P `0x1409` packets.

KCP does not wake the camera or open the relay. It only reassembles the ordered
stream once P4P has established the relay path.

### Stream Output

After KCP messages are drained, the backend extracts UBox inner stream records,
finds H.264 Annex B frame payloads, and exposes them to the browser as:

```text
GET /api/stream/live.h264?track=primary
GET /api/stream/live.h264?track=secondary
```

Each browser stream is length-prefixed:

```text
uint32be frameLength
Annex B H.264 frame bytes
```

The frontend decodes those frames with WebCodecs and draws to `<canvas>`.

## Project Layout

```text
server.js                  Local HTTP API, auth, static serving, Vite dev middleware
ubox-live-stream.js        Live relay/P2P session and stream extraction
p4p-codec.js               UBox/P4P packet helpers
h264-mp4.js, live-mp4.js   MP4/H.264 helpers kept for diagnostics and experiments
src/App.svelte             App coordinator and session lifecycle
src/lib/app/               Svelte screen and panel components
src/lib/livePlayback.js    Browser WebCodecs playback controller
src/lib/streamMetrics.js   Diagnostics chart bucketing
src/lib/api.js             Frontend API helpers
docs/network-layer.md      Camera wake-up and stream transport notes
docs/reverse-engineering.md Native-library reverse-engineering workflow
```

For current relay/KCP wake-up logic, see [docs/network-layer.md](docs/network-layer.md).
For native-library analysis workflow, see [docs/reverse-engineering.md](docs/reverse-engineering.md).

## Requirements

- Node.js 20 or newer recommended
- npm
- Chromium, Chrome, Edge, or another browser with WebCodecs support
- A UBox account with one or more cameras

## Install

```sh
npm install
```

## Development With HMR

Run one command:

```sh
npm run dev
```

Open:

```text
http://127.0.0.1:48263
```

In dev mode, `server.js` owns port `48263`, serves all `/api/*` and stream
routes, and mounts Vite as middleware for the Svelte app. That gives normal Vite
HMR without moving the frontend to a different origin.

If you prefer the older two-terminal setup:

```sh
npm run backend
npm run dev:vite
```

## Production-Style Local Run

Build the frontend:

```sh
npm run build
```

Start the local backend:

```sh
npm start
```

Open:

```text
http://127.0.0.1:48263
```

## Configuration

Environment variables:

```text
PORT=48263
UBOX_API=https://portal.ubianet.com
UBOX_APP_NAME=UBox
UBOX_APP_VERSION=1.1.363
UBOX_LANG=en
UBOX_REGION=US
UBOX_AUTH_FILE=.ubox-auth.json
```

Login state is stored locally in `.ubox-auth.json` so refreshes and server
restarts do not force a new login. The file contains the account identifier,
hashed password material, and session token. It is ignored by git.

## Diagnostics

The diagnostics panel is intentionally part of the app because the stream is
still being hardened. It shows:

- transferred KB/s per stream
- parsed frames/sec per stream
- recent stream/session events
- relay/session snapshots from the backend

Useful interpretation:

- KB/s moving but frames/video frozen usually means frame parsing or decode is
  stuck.
- KB/s at zero usually means transport/session data stopped arriving.
- frames moving but canvas frozen points at browser decode or draw behavior.

## GitHub Publishing Notes

Before publishing, verify that the repository does not include private or bulky
debug artifacts:

- `.ubox-auth.json`
- `live-dumps/`
- `live-session-logs/`
- `server.out.log`
- `server.err.log`
- packet captures, APKs, XAPKs, decoded private account data

The current `.gitignore` is set up for the normal local artifacts. If you add
new capture or reverse-engineering output folders, add them to `.gitignore`
before committing.

Recommended before first public release:

- add a license file
- add screenshots only if they do not show private cameras or account details
- keep example logs redacted
- mark the project as unofficial

## License

WTFPL. See [LICENSE](LICENSE).

## Legal And Privacy Notes

Use this only with accounts and cameras you own or are authorized to access.
This project stores credentials locally and talks to the same UBox cloud services
used by the official app, but it is not endorsed by nor affiliated with the vendor.
