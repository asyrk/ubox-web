# Native Control And Callback Flow

This note covers native control packets and video callback dispatch from
`libUBICAPIs29.so`.

Decompiler exports:

```text
docs/decompiled/libUBICAPIs29/p4p_client_send_avctrl.c
docs/decompiled/libUBICAPIs29/p4p_client_send_ioctrl.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_avctrl.c
docs/decompiled/libUBICAPIs29/p4p_client_video_callback.c
```

## `p4p_client_send_avctrl`

Typed signature:

```c
p4p_client_send_avctrl(session_index, kind, payload, payload_len)
```

Native sends AV control in two ways.

If the AV channel is not KCP-ready, it sends a direct P4P packet:

```text
magic       0x1807
version     0x0010
payload_len user payload length
msg         0x1407
kind        caller kind
payload     user AV-control payload
```

If the AV channel is KCP-ready, it wraps the same payload in an inner KCP
record:

```text
+0x00 u16 record_type = 1
+0x02 u8  kind
+0x08 u32 payload_len
+0x10     user AV-control payload
```

The start-video command built by `p4p_client_startvideo()` is the known AV
control payload:

```text
09 00 <stream_selector> <flags> 00 ... 00
```

Native also updates AV channel local state based on payload byte `0` and
payload byte `3`:

```text
payload[0] == 0 or 2 -> video/listen flags are cleared
payload[0] < 10 and not 0/2 -> video/listen/speak flags are enabled from payload[3]
```

## `p4p_client_send_ioctrl`

Typed signature:

```c
p4p_client_send_ioctrl(session_index, kind, command, payload, payload_len)
```

This mirrors AV control, but carries IO-control commands.

Direct P4P path:

```text
msg         0x1401
payload_len user payload length + 0x0c
payload+0x00 = 3
payload+0x04 = payload_len
payload+0x08 = command
payload+0x0c = user payload
```

KCP-ready path:

```text
+0x00 u16 record_type = 3
+0x02 u8  kind
+0x08 u32 payload_len
+0x0c u32 command
+0x10     user payload
```

The implementation uses the same direct-vs-relay destination selection as
AV-control and stream traffic.

## `p4p_client_handle_avctrl`

Typed signature:

```c
p4p_client_handle_avctrl(packet, from_addr)
```

This is only a Java callback bridge. It validates non-null arguments, takes the
global Java-callback lock, then calls:

```text
ubic_java_cb_avctrl(
  packet->seq_or_param,
  packet->kind,
  packet->payload,
  packet->payload_len
)
```

So inbound P4P `0x1408` AV-control responses are not deeply parsed here.

## `p4p_client_video_callback`

Typed signature:

```c
p4p_client_video_callback(
  session_index,
  kind,
  stream_byte,
  status,
  timestamp_or_buffer,
  payload_len,
  payload,
  frame_info_len
)
```

This function is also only a Java callback bridge. It takes the same callback
lock and forwards all arguments to `ubic_java_cb_video()`.

Call sites:

```text
p4p_video_client_kcp_recv()
p4p_rdt_recv_video_indicate()
```

Status values observed at call sites:

```text
0          normal frame
0xfffff80c frame sequence mismatch
0xfffff810 CRC mismatch
0xfffff80f / nearby negative codes from RDT reassembly failures
```

## Implementation Impact

For UBox Web, these functions do not reveal a hidden decoder. They confirm the
native app hands already-reassembled frame bytes upward through callbacks.

The useful compatibility details are:

```text
start-video may travel as direct P4P 0x1407 or as KCP inner record type 1
IO-control may travel as direct P4P 0x1401 or as KCP inner record type 3
video callbacks report stream_byte separately from kind
CRC/sequence failures are surfaced as callback status values, not repaired here
```

That suggests our diagnostics should keep tracking per-stream sequence gaps and
CRC/drop status separately from decode errors.
