# Native Start Flow

This note documents the native startup calls exported from
`libUBICAPIs29.so`.

Decompiler exports:

```text
docs/decompiled/libUBICAPIs29/Java_com_ubia_p4p_UBICAPIs_p4p_1client_1start.c
docs/decompiled/libUBICAPIs29/Java_com_ubia_p4p_UBICAPIs_p4p_1client_1startvideo.c
docs/decompiled/libUBICAPIs29/p4p_client_start.c
docs/decompiled/libUBICAPIs29/p4p_client_startvideo.c
```

Decompiler C is approximate, but constants, offsets, copy sizes, and call order
are the useful evidence.

## `p4p_client_start`

The JNI wrapper builds a 64-byte `p4p_client_start_config` from a Java object:

```text
devType, videoOn, listenOn, speakOn,
channel, streamindex, playrecord, zoneID,
devUID, devLoginID, devLoginPwd
```

Native then calls:

```c
p4p_client_start(config, random_id);
```

The config layout is:

```text
+0x00 u8  devType / lan_wakeup_mode
+0x01 u8  videoOn
+0x02 u8  listenOn
+0x03 u8  speakOn
+0x04 u8  channel
+0x05 u8  streamindex
+0x06 u8  playrecord
+0x07 u8  zoneID
+0x08 char devUID[0x14]
+0x1c char devLoginID[0x10]
+0x2c char devLoginPwd[0x14]
```

Session setup:

```text
session+0x00 active = 1
session+0x01 state = 1
session+0x03 role = 2
session+0x05 query_kind = config.zoneID
session+0x06 local_sid = allocated session index
session+0x0c random_id = random_id argument
session+0x17 seq_byte = global sequence byte, then incremented
session+0xdc copies the full 0x40-byte start config
session+0x11c client_start_tick = p4p_tickcount()
session+0x128 client_start_second = p4p_second()
```

After the session is allocated, native chooses the wake path:

```text
if config.devType == 1:
  send LAN wake-up request using config.devUID
  add timer type 1, every 200 ms, 0x32 attempts
  send query request using config.devUID and config.zoneID
  add timer type 2, every 1000 ms, 10 attempts
else:
  send LAN search request
  add timer type 12, every 500 ms, 10 attempts
  send query request using config.devUID and config.zoneID
  add timer type 2, every 1000 ms, 10 attempts
```

It also creates an AV channel and copies initial flags:

```text
config.videoOn  -> av_channel+0x19
config.listenOn -> av_channel+0x1a
config.speakOn  -> av_channel+0x1b
```

## `p4p_client_startvideo`

JNI passes a UID string plus four numeric arguments to native:

```c
p4p_client_startvideo(uid, session_index, kind, stream_selector, flags);
```

Native behavior:

```text
require P4P initialized
require session_index in 0..255
require session active
require session state != 0
require session state >= 5
find or create AV channel by session_index + kind
mark AV channel video enabled
copy flags bit0/bit1 into AV channel listen/speak flags
send 16-byte AV control payload with p4p_client_send_avctrl()
```

The payload sent through P4P `0x1407` is:

```text
payload[0] = 0x09
payload[1] = 0x00
payload[2] = stream_selector
payload[3] = flags
payload[4..15] = 0
```

## Implementation Impact

The native app does not build `0x1205` from arbitrary fixed login bytes. It first
stores this start config into `p4p_session`, then later relay/query handlers add
more session state before `p4p_client_send_rlystreamreq()` sends the stream
request.

For UBox Web, the important compatibility rule is:

```text
cloud/device fields -> p4p_client_start_config-like state
query/wake responses -> p4p_session peer/address state
p4p_session state -> 0x1205 relay stream request
state >= 5 -> 0x1407 start-video control
```

That is the path to making new camera models work without device-specific fixed
payload guesses.
