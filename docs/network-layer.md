# Network Layer Notes

Scope: camera wake-up, relay session, KCP transport, keepalive, restart logic.
Out of scope: login, cloud API parsing, H.264 parsing, browser playback.

## Goal

Backend opens one local UDP socket, queries UBox master/discovery servers,
extracts relay endpoints from the query response, wakes the camera through those
discovered relay endpoints, asks for a live relay stream, starts video, receives
KCP-wrapped stream data, sends ACK/control packets, and restarts session when
transport stalls.

## Main Code

- `ubox-live-stream.js`
  - `UBoxLiveStreamManager`
  - `UBoxLiveStreamSession`
  - KCP setup, timers, relay lifecycle
- `p4p-codec.js`
  - P4P packet encode/decode
  - 16-byte P4P header build/parse
  - message names

## Endpoint Discovery

The only static cloud endpoints used by the client path are the native-seeded
master/discovery servers. These are populated by native `p4p_master_init()` and
used by `p4p_client_send_queryreq()` for `0x1051` query requests on UDP
`10240`:

```text
175.178.248.245
121.199.12.37
43.153.110.207
8.208.11.50
43.134.10.68
43.157.31.112
```

Native query fanout depends on `query_kind`, which is copied from the Java
`zoneID` / native start config:

```text
query_kind == 4  -> first 3 master/discovery servers
anything else    -> full seeded master/discovery server list
```

Relay servers are not hardcoded. The `0x1052` query response contains a native
VPG item. Current code parses that item and extracts up to four relay wake-up
targets:

```text
VPG item base in 0x1052 payload: 0x1c
flag[index]                    : base + 0x08 + index
port[index]                    : base + 0x0c + index * 2, network byte order
IPv4[index]                    : base + 0x1c + index * 4
IPv6[index]                    : base + 0x2c + index * 0x10
```

Only IPv4 relay targets are currently sent to, matching the non-IPv6 path we
use. IPv6 relay target metadata is logged for diagnostics but not dialed.

## Packet Wrapper

All UBox transport packets use a 16-byte P4P header:

```text
u16 magic        0x1807
u16 version      0x0010
u16 length       payload bytes
u16 sid/channel
u16 msg
u16 msgLen
u16 seqOrParam
u8  kind
u8  flag
payload
```

Most outbound packets are passed through `encodeP4P()`. Incoming packets are
tested as plain P4P first; if header not valid, decoded with `decodeP4P()`.

Message IDs currently used:

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
0x1407 avctrl-direct / start video direct
0x1409 kcp-client
0x140a kcp-device
```

## Session Start Flow

1. Create UDP socket.

   - Bind to OS-chosen local port: `socket.bind(0)`.
   - One socket per live session.

2. Emit `session-started`.

3. Send discovery query.

   - Message: `0x1051`.
   - Destination: native master/discovery servers on UDP `10240`.
   - Fanout: first 3 servers when `query_kind == 4`, otherwise the full seeded
     list.
   - Payload includes camera UID fixed to 20 ASCII bytes.
   - Event: `p4p-query-sent`.

4. Wait for discovery query response.

   - Incoming message: `0x1052`.
   - Updates session state from query to relay wake-up.
   - Parses the native VPG item at payload offset `0x1c`.
   - Stores discovered relay wake-up targets.
   - Event: `p4p-query-rsp`.

5. Start relay wake timer.

   - Every `500 ms`, until relay wake response or timeout.
   - Message: `0x1201`.
   - Destination: discovered VPG relay targets from `0x1052`.
   - Payload includes camera UID fixed to 20 ASCII bytes.
   - Event: `relay-wakeup-sent`.

6. Wait for relay wake response.

   - Incoming message: `0x1202`.
   - Source IP/port becomes `relayPeer`.
   - Immediately send relay stream request to same peer.

7. Send relay stream request.

   - Message: `0x1205`.
   - Destination: `relayPeer`.
   - Payload includes:
     - device type
     - UID
     - device login id, if present
     - device login password or fallback `"admin"`
     - local random ID
     - video SID seed
     - zone ID
   - Event: `relay-stream-req-sent`.

7. Wait for relay stream response.

   - Incoming message: `0x1206`.
   - Extract:
     - `videoSid` from payload byte `54`
     - local `sid` from payload byte `55`
     - `remoteSid` from payload bytes `58..59`
   - Mark `relayEstablished = true`.
   - Clear `relayPendingSince`.
   - Event: `relay-stream-rsp`.

8. Send start-video control.

   - If KCP not created yet:
     - send direct P4P `0x1407`.
   - If KCP exists:
     - wrap same control payload as inner KCP record and send through KCP.
   - Payload:

```text
byte 0 = 9
byte 1 = 0
byte 2 = streamIndex
byte 3 = 1
rest zero
```

## Keepalive

Every `1000 ms`, after `relayPeer` known:

- Message: `0x1405`.
- Destination: relay peer.
- `sidOrChannel` = `videoSid` if valid, else `sid`.
- `seqOrParam` = `remoteSid` or channel.
- Payload includes:
  - alive SID
  - channel
  - local random ID

Purpose: keep relay session and camera path alive.

## KCP Handling

Inbound KCP can arrive inside:

- `0x1409` (`kcp-client`)
- `0x140a` (`kcp-device`)

For `0x140a`, code may also learn/adjust:

- `remoteSid` from P4P header `sidOrChannel`
- `videoSid` from P4P header `seqOrParam`

KCP segment format expected:

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

Current KCP logic:

1. Parse all KCP segments in datagram.
2. First segment `conv` creates KCP instance if needed.
3. KCP config:

```js
kcp.setNoDelay(1, 10, 0, 0)
kcp.setWndSize(128, 256)
kcp.update() every 20 ms
```

4. KCP output callback wraps outgoing KCP bytes as P4P `0x1409`.
5. Input uses:

```js
kcp.input(kcpBytes, true, true)
```

6. On data segments (`cmd === 0x51`), sequence numbers are tracked for gap
   diagnostics/recovery.
7. `drainKcpMessages()` repeatedly calls `peekSize()` and `recv()`.

## RDT Video ACK

If enabled, backend sends video ACK packets.

Timers:

- `rdtAckIntervalMs = 25`
- minimum frame-triggered interval `rdtAckMinIntervalMs = 20`

ACK packet:

- P4P message `0x1403`.
- Destination: relay peer.
- Requires relay established, `sid`, `remoteSid`, and at least one observed video
  record.
- Payload is TLV-like:
  - type `1`: frame sequence bitmap
  - type `4`: empty stats block
  - type `5`: bandwidth/fps-ish block

Purpose: mimic app behavior that confirms received video frame sequence numbers.
If a camera sends data and then stops, ACK compatibility is suspect.

## Watchdog And Recovery

Video watchdog runs every `2000 ms`.

### Relay not established

If no relay after `relayReestablishTimeoutMs` (`8000 ms` default):

- emit `relay-reestablish-timeout`
- manager restarts whole live session

### Relay established but no H264/video output

If no H264 output for `5000 ms`, and last kick older than `5000 ms`:

1. Try KCP live-skip recovery.
2. Emit `video-watchdog-kick`.
3. If KCP input quiet longer than `relayRenewAfterMs` (`15000 ms` default),
   renew relay, throttled by `relayRenewThrottleMs` (`10000 ms` default).
4. Else send start-video control again.

### Relay renew

Relay renew does:

- emit `relay-renew`
- clear `relayEstablished`
- clear `relayPeer`
- set `relayPendingSince`
- reset `sid`, `remoteSid`, `videoSid`
- reset KCP
- clear KCP receipt tracking
- send `0x1201` relay wakeup again

### KCP stall recovery

If KCP has queued/buffered data but no complete message:

- wait `kcpSkipAfterMs = 2500`
- throttle by `kcpSkipThrottleMs = 1500`
- drop incomplete queued fragments if needed
- advance `rcv_nxt` to next buffered segment if gap blocks receive
- emit `kcp-live-skip`

This favors live video continuity over perfect reliability.

## Stale Session Reuse

Starting stream for same UID reuses current session only if not stale.

Stale check:

- session age must exceed `reuseStaleAfterMs = 10000`
- then stale if:
  - no H264/video for longer than stale threshold, or
  - no KCP input for longer than `2 * stale threshold`

If stale, manager stops old session and starts fresh.

## Current Timers

```text
relay wakeup          1000 ms
alive keepalive       1000 ms
KCP update              20 ms
RDT ACK                 25 ms
session snapshot      2000 ms
video watchdog        2000 ms
session log flush      250 ms
```

## Useful Debug Signals

For public issues, share sanitized app diagnostics rather than raw packet
captures.

Most useful events:

```text
session-started
p4p-query-sent
relay-wakeup-sent
relay-stream-req-sent
relay-stream-rsp
start-video-sent
start-video-kcp-sent
kcp-created
kcp-input-error
kcp-state
kcp-live-skip
rdt-video-ack-sent
video-watchdog-kick
relay-renew
relay-reestablish-timeout
session-auto-restart
session-snapshot
```

Most useful counters:

```text
rx
tx
decoded
kcpSegments
kcpMessages
kcpInputErrors
kcpGapDrops
kcpOutputPackets
rdtAckPackets
videoKicks
relayRenews
```

Most useful current state:

```text
sid
remoteSid
videoSid
channel
relayEstablished
relayPeer present/not present
lastKcpInputAgoMs
lastKcpMessageAgoMs
lastH264AgoMs
kcpState.conv
kcpState.rcvNxt
kcpState.rcvQueue
kcpState.rcvBuf
kcpState.peekSize
```

## Failure Patterns

### No `relay-stream-rsp`

Likely:

- no usable VPG relay target in the `0x1052` query response
- discovered relay endpoint is unreachable from this network
- device identity fields wrong
- device type wrong
- camera asleep/offline/cellular unreachable

Need:

- events through `relay-wakeup-sent`
- `p4p-query-rsp` fields:
  - `vpgId`
  - `vpgFlags`
  - `relayTargetCount`
  - `relayTargets`
  - `ipv6RelayTargetCount`
- whether any `0x1202` arrives
- sanitized `relay-stream-req-sent` fields:
  - `loginIdPresent`
  - `loginPwdPresent`
  - `p4pDeviceType`
  - `cloudDeviceType`
  - `videoSidSeed`

Do not share UID or device credential strings publicly.

### `relay-stream-rsp` exists, but no KCP

Likely:

- start-video control mismatch
- wrong SID/remote SID/video SID usage
- camera expects different stream index/channel
- keepalive mismatch

Need:

- `sid`, `remoteSid`, `videoSid`, `channel`
- whether `start-video-sent` or `start-video-kcp-sent` happened
- any inbound `0x1406`, `0x1409`, `0x140a`

### KCP exists, but no messages

Likely:

- KCP ACK/output not accepted
- KCP conv changes
- missing retransmit/ACK detail
- packet loss/gap behavior

Need:

- `kcp-created`
- `kcp-state`
- `kcp-input-error`
- `kcp-output-sent`
- `rcvNxt`, `rcvQueue`, `rcvBuf`, `peekSize`

### KCP messages exist, then freeze

Likely:

- ACK behavior mismatch
- gap recovery too aggressive or not aggressive enough
- relay quiet/stale session
- cellular network loss

Need:

- before/after `session-snapshot`
- `video-watchdog-kick`
- `kcp-live-skip`
- `relay-renew`
- packet/byte rates

## Safe Debug Bundle Proposal

Best next app feature: export sanitized network debug bundle:

```json
{
  "version": "ubox-web debug v1",
  "time": "...",
  "device": {
    "uidHash": "...",
    "loginIdPresent": true,
    "loginPwdPresent": true,
    "cloudDeviceType": 0,
    "p4pDeviceType": 2,
    "streamIndex": 0,
    "zoneId": 0,
    "channel": 0,
    "videoSidSeed": 15
  },
  "session": {
    "sid": 1,
    "remoteSid": 1234,
    "videoSid": 15,
    "relayEstablished": true,
    "kcpState": {
      "conv": 123456,
      "rcvNxt": 100,
      "rcvQueue": 0,
      "rcvBuf": 2,
      "peekSize": -1
    },
    "counters": {}
  },
  "events": []
}
```

Redact/remove:

- UID raw value
- account/email
- auth tokens
- login ID/password
- relay peer IP if sharing publicly
- packet payload hex beyond message headers
- any video payload

## Big Unknowns

Current implementation matches one observed camera/app path. Other camera models
or firmware versions may differ in:

- VPG item contents returned by `0x1052`
- IPv4 vs IPv6 relay availability
- `deviceType`
- `streamIndex`
- channel number
- credential fields needed in relay request
- start-video control payload
- RDT ACK payload expectations
- sleep/wake behavior on cellular

Most likely useful investigation: compare network-stage progress, not video
payload.
