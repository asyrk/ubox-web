# Native Porting Plan

This is the checklist for applying the decompiled native behavior to the Node
transport.

Primary exports:

```text
docs/decompiled/libUBICAPIs29/p4p_client_send_queryreq.c
docs/decompiled/libUBICAPIs29/p4p_client_send_lanwakeupreq.c
docs/decompiled/libUBICAPIs29/p4p_client_send_lansearchreq.c
docs/decompiled/libUBICAPIs29/p4p_client_send_rlywakeupreq.c
docs/decompiled/libUBICAPIs29/p4p_client_send_rlystreamreq.c
docs/decompiled/libUBICAPIs29/p4p_client_kcp_send.c
docs/decompiled/libUBICAPIs29/p4p_kcp_mode.c
docs/decompiled/libUBICAPIs29/p4p_kcp_output.c
docs/decompiled/libUBICAPIs29/p4p_rdt_recv_video_send_ack.c
docs/decompiled/libUBICAPIs29/p4p_rdt_recv_video_tcnone.c
docs/decompiled/libUBICAPIs29/p4p_rdt_recv_video_tcarq.c
docs/decompiled/libUBICAPIs29/p4p_client_stop.c
docs/decompiled/libUBICAPIs29/p4p_client_stopvideo.c
docs/decompiled/libUBICAPIs29/p4p_client_send_logoutreq.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_logoutrsp.c
```

## 1. Session Open Builders

Native startup sends these in order, depending on local/relay mode:

```text
p4p_client_send_lanwakeupreq(uid)
p4p_client_send_lansearchreq(session_index, global_search)
p4p_client_send_queryreq(uid, query_kind)
p4p_client_send_rlywakeupreq(session)
p4p_client_send_rlystreamreq(session)
```

Important packet IDs:

```text
0x1301 LAN wake-up
0x1303 LAN search
0x1051 query request
0x1201 relay wake-up request
0x1205 relay stream request
```

Native `0x1051` query request:

```text
header magic/version 0x1807 / 0x0010
payload length       0x2c
message              0x1051
msg_len              0x28
payload              20-byte UID copied at payload offset 0x04
destination          native-seeded master/discovery addresses on UDP 10240
send count           8 seeded address slots, or 3 when query_kind == 4
encoding             p4p_crypto_encode(packet, 0x3c)
```

`query_kind` controls master/discovery fanout only. It does not choose relay
servers.

Native `0x1052` query response handling:

```text
handler              p4p_client_handle_queryrsp
VPG item source      response payload offset 0x1c
native store         p4p_local_update_vpgitem(packet + 0x2c, ...)
                     which is payload + 0x1c after the 16-byte P4P header
next state           state 1 -> 2
next send            p4p_client_send_rlywakeupreq(session)
```

The relay wake-up destinations are discovered from the VPG item, not hardcoded:

```text
VPG item flag[i]     item + 0x08 + i
VPG item port[i]     item + 0x0c + i * 2
VPG item IPv4[i]     item + 0x1c + i * 4
VPG item IPv6[i]     item + 0x2c + i * 0x10
slot count           4
```

Native `0x1201` relay wake-up request:

```text
payload length       0x2c
message              0x1201
msg_len              0x24
payload byte 0       1
payload              20-byte UID from session+0xe4
destination          direct or relay address table from query response state
encoding             p4p_crypto_encode(packet, 0x3c)
```

Porting rule:

```text
Build start_config first.
Store session state from query/wake responses.
Build 0x1205 only from session state.
Do not build stream-open packets from fixed login/password constants.
```

## 2. KCP Path

Native creates KCP per AV channel:

```text
ikcp_create(session.random_id, av_channel)
ikcp_setoutput(kcp, p4p_kcp_output)
p4p_kcp_mode(kcp, 2)
```

Native KCP defaults from `ikcp_create()`:

```text
mtu  = 0x518
mss  = 0x500
snd_wnd default = 0x40
rcv_wnd default = 0x200
interval default = 100 ms
rx_minrto default = 100 ms
```

Native mode `2`, used by AV channels:

```text
ikcp_wndsize(kcp, 0x80, 0x100)
ikcp_nodelay(kcp, 1, 10, 0, 1)
kcp->rx_minrto = 0x0c
kcp->nc = 0
```

Important detail: `ikcp_wndsize()` clamps receive window upward to at least
`0x200`, so the effective receive window remains `0x200` even when mode `2`
passes `0x100`.

Outbound KCP bytes are wrapped by `p4p_client_kcp_send()`:

```text
message        0x1409
payload_len    KCP byte length
kind           AV channel kind
destination    session direct or relay source address
send size      payload_len + 0x10
```

Porting rule:

```text
Use conv = session.random_id.
Use mtu 0x518 / mss 0x500 if the JS KCP library allows it.
Use nodelay(1, 10, 0, 1).
Use send window 0x80 and receive window effectively 0x200.
Flush/update at native timer cadence, not only when browser reads frames.
```

## 3. RDT Fallback

The native app supports direct `0x1404` video packets that do not go through
KCP.

Modes observed:

```text
p4p_rdt_recv_video_tcnone  block reassembly, no ACK
p4p_rdt_recv_video_tcarq   block reassembly plus ACK/NACK bitmap
p4p_rdt_recv_video_tcauto  stub; validates args and returns 0
```

`tcnone` behavior:

```text
find/create frame by frame_id
copy each block payload to block_index * 0x500
track received block slots
when accumulated length equals full frame length, output frame
```

`tcarq` behavior:

```text
track block/frame ranges
copy missing blocks into queued frame buffer
send ACK/NACK when end/flag bits require it or when range goes backwards
```

`p4p_rdt_recv_video_send_ack()` builds a `0x1403`-style acknowledgement payload
with:

```text
receiver timing stats
latest frame/block ids
loss bitmap
optional rate/buffer stats
```

Porting rule:

```text
Keep KCP as the primary path, but preserve the existing direct/RDT parser.
If a device sends 0x1404 and no 0x140a KCP, enable RDT reassembly and ACKs.
Log RDT mode, block gaps, frame id, block index, and ACK bitmap size.
```

## 4. Stop And Cleanup

Native has two shutdown layers.

Stop video only:

```text
p4p_client_stopvideo(uid, session_index, kind, stream_selector, flags)
payload[0] = 0x02
payload[1] = 0x00
payload[2] = stream_selector
payload[3] = flags
p4p_client_send_avctrl(..., payload, 0x10)
```

Stop audio/speak:

```text
p4p_client_stopaudio  payload[0] = 0x11, payload[3] = 1 or 3
p4p_client_stopspeak  payload[0] = 0x11, payload[3] = 2
```

Stop full session:

```text
p4p_client_stop(uid, session_index)
  validates UID/session
  sets session+0x16 flag to 1
  sends p4p_client_send_logoutreq(session)
  adds timer type 0x0f, interval 200 ms, count 3
```

Logout request:

```text
state 7/8 path -> message 0x1309, msg_len 0x21
normal path    -> message 0x1207, msg_len 0x24
payload length -> 0x54
destination    -> direct or relay source address
```

Logout response:

```text
p4p_client_handle_logoutrsp(packet)
  uses packet byte +0x3a as session id
  deletes timer session_id | 0x0f00
  frees AV channel(s)
  frees session
  emits status callback 7
```

Porting rule:

```text
On Stop Live Stream or page refresh:
  send stop-video AV control first
  then send logout request
  keep socket alive briefly for logout response/retries
  only then free local session/KCP state
```

This likely matters for the freeze-on-refresh behavior we saw.

## 5. Timers And Retry Rules

Native timer behavior is already summarized in
[native-timers.md](native-timers.md). The pieces to mirror first:

```text
query request       retry 10 times every 1000 ms
relay wake-up       retry according to timer type 3
relay stream request retry 16 times every 1000 ms
knock               retry 6 times every 1000 ms, then demote state 6 -> 5
keepalive           every 1000 ms forever while session is alive
dead threshold      13 missed inbound updates
logout              retry 3 times every 200 ms
```

Inbound packets that reset live miss count:

```text
0x1404 direct/RDT packet
0x1406 alive response
0x140a KCP packet
```

Porting rule:

```text
Session liveness must be driven by inbound transport packets, not by whether
the browser is currently decoding frames.
```

## Recommended Node Implementation Order

1. Replace fixed `0x1205` construction with session-derived fields.
2. Match native KCP mode: conv, mtu/mss, nodelay, windows, update cadence.
3. Implement graceful stop: stop-video, logout, short retry window, then free.
4. Add state-machine retry timers for query/wake/stream/knock/keepalive.
5. Harden RDT direct-video fallback and ACK handling for non-KCP devices.
6. Add diagnostics for session state, timer retries, KCP mode, RDT mode, and
   logout/cleanup outcome.
