# Native Constant Cross-References

This document records the native-library cross-reference pass for the UBox live
transport constants used by UBox Web.

Analyzed binary:

```text
E:\dev\libs\libUBICAPIs29.so
```

Disassembly mode:

```powershell
llvm-objdump.exe -d --triple=thumbv7-linux-android --no-show-raw-insn libUBICAPIs29.so
```

Important: addresses below are from this exact ARMv7/Thumb library build. Other
UBox releases can move functions even when names and protocol behavior remain
similar.

## Packet Header

Native send functions build the same 16-byte P4P packet header used by the local
Node implementation:

```text
offset  size  meaning
0x00    u16   magic, normally 0x1807
0x02    u16   version, normally 0x0010
0x04    u16   payload length
0x06    u16   sid/channel
0x08    u16   message id
0x0a    u16   message body length / subtype length
0x0c    u16   sequence, session value, or relay parameter
0x0e    u8    kind / stream id
0x0f    u8    flags
0x10    ...   payload
```

## Message Map

| Message | Direction | Native function / handler | Address | Meaning |
| --- | --- | --- | --- | --- |
| `0x1051` | client to server | `p4p_client_send_queryreq` | `0x1f490` | Query request |
| `0x1201` | client to relay | `p4p_client_send_rlywakeupreq` | `0x21468` | Relay wake-up request |
| `0x1205` | client to relay | `p4p_client_send_rlystreamreq` | `0x217f4` | Relay stream request |
| `0x1206` | relay to client | `p4p_client_handle_rlystreamrsp` | `0x23314` | Relay stream response |
| `0x1403` | client to peer/relay | `p4p_client_send_packet` | `0x26074` | Direct non-KCP stream packet / ACK path |
| `0x1405` | client to peer/relay | `p4p_client_send_alive` | `0x22028` | Keepalive |
| `0x1407` | client to peer/relay | `p4p_client_send_avctrl` | `0x1fff0` | Direct AV control |
| `0x1409` | client to peer/relay | `p4p_client_kcp_send` | `0x26254` | Client KCP carrier |
| `0x140a` | peer/relay to client | `p4p_client_receiver` -> `p4p_client_handle_kcp` | `0x2566c` -> `0x254c0` | Inbound KCP carrier |

Related response handlers:

| Message | Handler | Address |
| --- | --- | --- |
| `0x1052` | `p4p_client_handle_queryrsp` | dispatch at `0x25794` |
| `0x1202` | `p4p_client_handle_rlywakeuprsp` | `0x2311c` |
| `0x1404` | `p4p_client_handle_packet` | dispatch at `0x25860` |
| `0x1406` | `p4p_client_handle_alive` | dispatch at `0x25854` |
| `0x1408` | `p4p_client_handle_avctrl` | dispatch at `0x2583c` |

## Send-Side Findings

### `p4p_client_send_queryreq` (`0x1f490`)

Builds a query packet:

```text
magic      0x1807
version    0x0010
length     0x002c
message    0x1051
msgLen     0x0028
sid/seq    0
payload    UID copied at packet+0x14
```

The full packet length passed to `p4p_crypto_encode` is `0x3c`.

### `p4p_client_send_rlywakeupreq` (`0x21468`)

Builds relay wake-up:

```text
magic      0x1807
version    0x0010
length     0x002c
message    0x1201
msgLen     0x0024
sid/seq    0
payload    includes UID copied from session+0xe4
```

The function sends to relay/server address slots. The wake-up response handler
then advances session state and immediately calls `p4p_client_send_rlystreamreq`.

### `p4p_client_send_rlystreamreq` (`0x217f4`)

Builds relay stream request:

```text
magic      0x1807
version    0x0010
length     0x006c
message    0x1205 when session state byte == 3
msgLen     0x0024
sid/seq    0
payload    UID and relay/session fields
send size  0x007c
```

Important payload/session copies observed:

```text
session+0xe4 -> request payload UID area, 20 bytes
session+0x108 -> request payload area, 64 bytes
session+0xf8 -> request payload area, 16 bytes
session+0xe0 -> request byte near packet+0x51
session+0xe1 -> request byte near packet+0x6e
session+0xdd -> toggles request byte to 0 or 9
session+0xde -> sets low flag bit
session+0xdf -> sets second flag bit
session+0x8c -> direct address structure
session+0xb8 -> relay address structure
```

This confirms our stream request must carry more than the UID. It also contains
address and session-state material learned from previous responses.

### `p4p_client_send_alive` (`0x22028`)

Builds keepalive:

```text
magic      0x1807
version    0x0010
length     0x0014
message    0x1405
send size  0x0024
```

Header fields depend on session state:

```text
if session state is 7 or 8:
  msgLen = 0x21
  seq    = session+0x07
  sid    = session+0x06
else:
  msgLen = 0x24
  seq    = u16(session+0x0a)
  sid    = u8(session+0x06)
```

Destination selection:

```text
session+0x18 == 0 -> use global socket at +0x40 and session+0x8c address
session+0x18 != 0 -> use global socket at +0x50 and session+0xb8 address
```

The same direct-vs-relay address switch appears in stream and KCP send paths.

### `p4p_client_send_avctrl` (`0x1fff0`)

There are two send paths.

KCP path:

```text
inner header:
  u16 0x0001
  byte stream/channel at +0x02
  payload length at +0x08
  user AV payload copied at +0x10

send:
  p4p_kcp_send(av_channel, inner_packet, payload_len + 0x10)
```

Direct UDP fallback path:

```text
magic      0x1807
version    0x0010
length     user_payload_len
message    0x1407
kind       stream/channel byte
send size  0x20 for a 16-byte start-video payload
```

This is important: start-video control is normally sent over KCP once the AV
channel is ready. Direct `0x1407` exists, but it is not the only path.

### `p4p_client_startvideo` (`0x1fe5c`)

Builds the AV control payload used to start video:

```text
payload[0] = 0x09
payload[1] = 0x00
payload[2] = stream index / channel selector
payload[3] = caller flags byte
payload[4..15] = 0
```

Then calls:

```text
p4p_client_send_avctrl(session, channel, payload, 0x10)
```

The AV channel state bytes are also updated before sending:

```text
av_channel+0x19 = 1
av_channel+0x1a = bit 0 of flags
av_channel+0x1b = bit 1 of flags
```

## KCP Carrier Findings

### Outbound `0x1409`: `p4p_client_kcp_send` (`0x26254`)

Builds a P4P packet with:

```text
magic      0x1807
version    0x0010
length     KCP payload length
message    0x1409
kind       stream/channel byte
payload    raw KCP bytes at packet+0x10
```

It copies caller bytes directly to `packet+0x10`; there is no extra wrapper
between P4P and KCP here.

The native library rejects KCP payloads larger than `0x578` bytes.

Destination selection again uses:

```text
session+0x18 == 0 -> socket +0x40, address session+0x8c
session+0x18 != 0 -> socket +0x50, address session+0xb8
```

### Inbound `0x140a`: `p4p_client_handle_kcp` (`0x254c0`)

The receiver dispatches message `0x140a` to `p4p_client_handle_kcp`.

The handler:

```text
kind = packet[0x0e]
seqOrParam = u16(packet+0x0c)
av_channel = p4p_client_find_avchn(seqOrParam, kind)
p4p_client_update_livecnt(seqOrParam)
p4p_kcp_input(av_channel, packet+0x10, u16(packet+0x04))
```

This confirms inbound KCP bytes begin exactly at P4P payload offset `0x10`.

## Relay Response Findings

### Wake-up response: `p4p_client_handle_rlywakeuprsp` (`0x2311c`)

Important behavior:

```text
response[0x10] = count, clamped to 16
response+0x24 = repeated UID/session records
session state 2 -> state 3
copies source address:
  relay path  -> session+0xb8, 28 bytes
  direct path -> session+0x8c, 16 bytes
calls p4p_client_send_rlystreamreq(session)
```

So wake-up is not final. The native sequence is:

```text
query -> relay wake-up -> relay stream request
```

### Stream response: `p4p_client_handle_rlystreamrsp` (`0x23314`)

Important behavior:

```text
response[0x10] = count, clamped to 16
response+0x28 = repeated stream records, stride 0x1ac
record+0x1e = session index
record+0x24 = value checked against session+0x0c
record+0x1d = AV channel / stream id
record+0x1a = AV channel state/control byte
record+0x1f = copied to session+0x07
record+0x20 = copied to session+0x08
record+0x22 = copied to session+0x0a
```

Address copies:

```text
relay path:
  response source address -> session+0xb8, 28 bytes
  response+0x18          -> session+0xa4, 16 bytes
  response+0x16          -> session+0x9e

direct path:
  response source address -> session+0x8c, 16 bytes
  record+0x18             -> session+0x70
  record+0x16             -> session+0x6e
  record+0x24             -> session+0x60
  record+0x14             -> session+0x5e
```

On successful response:

```text
session state = 6
session+0x120 = tick count
status callback event = 3
p4p_client_send_knock(session)
timer 7 added every 1000 ms
p4p_client_send_alive(session)
```

This strongly suggests our local implementation must preserve the full response
state and start keepalive/knock quickly after stream response, not merely send
start-video once.

## Receiver Dispatch

Client dispatch in `p4p_client_receiver` (`0x2566c`):

```text
0x1052 -> p4p_client_handle_queryrsp
0x1202 -> p4p_client_handle_rlywakeuprsp
0x1204 -> p4p_client_handle_loginrsp
0x1206 -> p4p_client_handle_rlystreamrsp
0x1208 -> p4p_client_handle_logoutrsp
0x1209 -> p4p_client_handle_rlyclosereq
0x1302 -> p4p_client_handle_lanwakeuprsp
0x1304 -> p4p_client_handle_lansearchrsp
0x1308 -> p4p_client_handle_lanstreamrsp
0x130e -> p4p_client_handle_knock
0x1402 -> p4p_client_handle_ioctrl
0x1404 -> p4p_client_handle_packet
0x1406 -> p4p_client_handle_alive
0x1408 -> p4p_client_handle_avctrl
0x140a -> p4p_client_handle_kcp
```

Device-side dispatch in the same library mirrors the client-side meanings:

```text
0x1403 -> p4p_device_handle_packet
0x1405 -> p4p_device_handle_alive
0x1407 -> p4p_device_handle_avctrl
0x1409 -> p4p_device_handle_kcp
```

This explains the odd/even pairing:

```text
client sends odd IDs:  0x1403, 0x1405, 0x1407, 0x1409
client receives even IDs: 0x1404, 0x1406, 0x1408, 0x140a
```

## Implementation Impact

The xrefs support these requirements for UBox Web:

- Keep `0x1409`/`0x140a` as raw KCP carrier packets inside P4P.
- Feed inbound KCP with exactly `packet.payload`, no additional stripping.
- Send start-video as AV control payload `09 00 <stream> <flags> ...`.
- Prefer KCP AV control once KCP is established; direct `0x1407` is fallback.
- Maintain direct and relay address candidates separately.
- Start knock/keepalive immediately after successful relay stream response.
- Enforce a KCP/P4P payload ceiling near `0x578` bytes.
- Treat stream response records as state-bearing, not just success/failure.

## Still Unknown

These items need another targeted pass if stream stability remains poor:

- Exact `p4p_client_send_knock` payload and timer behavior.
- Exact `p4p_client_handle_alive` counter reset behavior.
- Exact `p4p_rdt_recv_video_input` loss/ACK rules after KCP output.
- Whether multi-channel devices use separate AV channel structs or separate
  `kind` values under one session.
