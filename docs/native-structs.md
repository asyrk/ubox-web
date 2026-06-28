# Native Struct Notes

This file explains [native-structs.h](native-structs.h), which contains inferred
C structs for the UBox/P4P transport.

The structs were built from Ghidra decompiler output exported under:

```text
docs/decompiled/libUBICAPIs29/
```

Primary functions used:

```text
p4p_client_send_rlystreamreq
p4p_client_send_queryreq
p4p_client_send_lanwakeupreq
p4p_client_send_lansearchreq
p4p_client_send_rlywakeupreq
p4p_client_start
p4p_client_startvideo
Java_com_ubia_p4p_UBICAPIs_p4p_1client_1start
p4p_client_stop
p4p_client_stopvideo
p4p_client_send_logoutreq
p4p_client_handle_logoutrsp
p4p_client_handle_rlywakeuprsp
p4p_client_handle_rlystreamrsp
p4p_client_kcp_send
p4p_kcp_mode
p4p_kcp_output
p4p_client_send_avctrl
p4p_client_send_ioctrl
p4p_client_handle_avctrl
p4p_client_video_callback
p4p_client_find_avchn
p4p_client_add_avchn
p4p_client_handle_packet
p4p_client_handle_kcp
p4p_video_client_kcp_recv
p4p_rdt_recv_video_tcnone
p4p_rdt_recv_video_tcarq
p4p_rdt_recv_video_send_ack
rdt_recv_video_tcnone_output
p4p_rdt_recv_video_indicate
```

## Confidence

High confidence:

- `p4p_header`
- `kcp_inner_record`
- `video_frame_info`
- top-level `relay_stream_req_payload` offsets
- `relay_stream_rsp_record` offsets through `0x24`
- `p4p_client_start_config`
- key `av_channel` offsets: active, kind, KCP pointer, KCP buffer, flags,
  session index, video/audio receiver pointers

Medium confidence:

- `p4p_session` address blocks
- names for `peer_value_08` / `peer_value_0a`
- names for `session_blob_f8` / `session_blob_108`

Low confidence:

- semantic names for some relay-stream response tail fields
- exact address-family layout beyond the first `sockaddr`-like bytes

## Important Findings

`p4p_session` is the missing piece for cross-device compatibility. Native
`p4p_client_send_rlystreamreq()` does not build `0x1205` from login strings.
It copies fields that previous native handlers stored in `p4p_session`.

Native `relay_stream_req_payload` construction uses these session offsets:

```text
session+0x06  -> payload+0x42
session+0x0c  -> payload+0x48
session+0x17  -> payload+0x03
session+0xdd  -> payload+0x5c, value 0 or 9
session+0xde  -> payload+0x5f bit0
session+0xdf  -> payload+0x5f bit1
session+0xe0  -> payload+0x41
session+0xe1  -> payload+0x5e
session+0xe4  -> payload+0x18, 20 bytes
session+0xf8  -> payload+0x4c, 16 bytes
session+0x108 -> payload+0x2c, 20 bytes
session+0x128 -> payload+0x64, client_start_second
```

The first source for many of those session fields is
`p4p_client_start_config`, a 64-byte blob created by the JNI wrapper from Java
object fields:

```text
config+0x00 devType      -> LAN wake-up mode
config+0x01 videoOn      -> session+0xdd / AV channel video flag
config+0x02 listenOn     -> session+0xde / AV channel listen flag
config+0x03 speakOn      -> session+0xdf / AV channel speak flag
config+0x04 channel      -> session+0xe0 / AV kind
config+0x05 streamindex  -> session+0xe1
config+0x06 playrecord
config+0x07 zoneID       -> session+0x05 query_kind
config+0x08 devUID       -> session+0xe4, 20 bytes
config+0x1c devLoginID   -> session+0xf8, 16 bytes
config+0x2c devLoginPwd  -> session+0x108, 20 bytes
```

Native stream response handling uses:

```text
payload+0x00      -> record count, clamped to 16
payload+0x03      -> optional seq byte checked against session+0x17
payload+0x18/0x24 -> address fields used in direct mode
payload+0x28      -> first relay_stream_rsp_record
record stride     -> 0x1ac
record+0x00       -> status
record+0x1a       -> AV channel state
record+0x1d       -> AV channel kind
record+0x1e       -> session index
record+0x1f       -> session+0x07
record+0x20       -> session+0x08
record+0x22       -> session+0x0a
record+0x24       -> random id, checked against session+0x0c
```

Native KCP video records match our browser stream parser:

```text
0x00 u16 type         0x11 / 0x14 for video
0x03 u8  stream_byte  observed as track selector
0x06 u16 frame_seq
0x08 u32 record_len   frame_info + payload, not including 16-byte header
0x0c u32 crc32
0x10 16 bytes frame_info
0x20 H.264 payload
```

Direct RDT video packets are different. They arrive as `0x1404` packets with a
RDT block header, then reassemble into a frame that looks like the KCP inner
record shape.

## Practical Impact

To make other cameras work, the next code change should not be another guessed
constant. It should parse/store a `p4p_session`-like state object and build
`0x1205` from that state.

Minimum useful Node state:

```text
active
state
role
local_sid
peer_sid_byte
peer_value_08
peer_value_0a
random_id
session_index
seq_byte
relay_mode
live_miss_count
alive_send_count
query_kind
direct_source_addr
relay_source_addr
last_alive_tick
stream_req_enabled
stream_flag_1
stream_flag_2
av_kind
req_byte_e1
uid
session_blob_f8
session_blob_108
client_start_second
```
