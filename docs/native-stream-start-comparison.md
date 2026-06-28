# Native Stream/Start Comparison

This compares the Ghidra-decompiled native functions with the current UBox Web
implementation.

Exported decompiler output:

- `docs/decompiled/libUBICAPIs29/p4p_client_send_rlystreamreq.c`
- `docs/decompiled/libUBICAPIs29/p4p_client_start.c`
- `docs/decompiled/libUBICAPIs29/p4p_client_startvideo.c`
- `docs/decompiled/libUBICAPIs29/Java_com_ubia_p4p_UBICAPIs_p4p_1client_1start.c`

Decompiler output is approximate C. Field names are synthetic, but constants,
offsets, copies, and call shape are useful.

## `p4p_client_startvideo`

Native behavior:

```text
validate P4P initialized
validate session index 0..255
require session exists
require session state byte >= 5
find or create AV channel by session index + channel/kind
set AV channel state flags
build 16-byte AV control payload
call p4p_client_send_avctrl(sessionIndex, channel, payload, 0x10)
```

The 16-byte start payload is:

```text
payload[0] = 0x09
payload[1] = 0x00
payload[2] = stream index / video selector
payload[3] = flags byte
payload[4..15] = 0
```

UBox Web currently matches this payload shape:

```js
payload[0] = 9;
payload[1] = 0;
payload[2] = identity.streamIndex & 0xff;
payload[3] = 1;
```

Likely differences:

- Native does not send start-video until session state is at least `5`.
- Native finds/creates an AV channel first; UBox Web does not model that state.
- Native uses a caller-provided channel/kind (`param_3`) and stream selector
  (`param_4`) separately.
- UBox Web hardcodes `flags = 1`.

Compatibility impact:

- Start-video payload itself is probably correct.
- Devices with multiple streams may fail if `channel/kind` is wrong even when
  `streamIndex` is right.
- Some devices may need `flags = 0`, `1`, `2`, or `3`; native passes this from
  the app caller.
- Sending start too early can be ignored on devices that enforce native session
  state more strictly.

## `p4p_client_send_rlystreamreq`

Native behavior:

```text
validate management/session pointer
validate session index in session+0x14
build P4P header:
  magic   = 0x1807
  version = 0x0010
  length  = 0x006c
  msg     = 0x1205 when session state byte == 3
  msgLen  = 0x0024
send size = 0x007c
```

Native request payload is session-derived, not a fixed account/device template.
Observed inputs:

```text
session+0x06   -> request header/session byte
session+0x0c   -> request session/random value
session+0x17   -> request flag/selector byte
session+0xdd   -> toggles request byte between 0 and 9
session+0xde   -> sets request flag bit 0
session+0xdf   -> sets request flag bit 1
session+0xe0   -> request byte
session+0xe1   -> request byte
session+0xe4   -> copied, 20 bytes
session+0xf8   -> copied, 16 bytes
session+0x108  -> copied, 20 bytes
session+0x128  -> copied, 4 bytes
```

Native destination choice:

```text
if pP4PMgmt+0x08 == 0:
  send to session+0x8c using socket pP4PMgmt+0x40
else:
  copy pP4PMgmt+0x24 into request
  send to session+0xb8 using socket pP4PMgmt+0x50
```

UBox Web originally built `0x1205` as a fixed 108-byte payload:

```text
payload[0]  = 1
payload[3]  = deviceType
payload[12] = 0x0a
payload[14] = 0x02
payload[15] = 0x0f
payload[16] = random low bits
payload[24] = UID
payload[44] = loginId
payload[66] = videoSidSeed
payload[72] = randomId
payload[76] = loginPwd
payload[92] = 9
payload[95] = 1
payload[100] = zoneId
```

Confirmed differences:

- Native copies the `p4p_client_start_config` into `p4p_session+0xdc`.
- Native then copies session fields into `0x1205`.
- The start config includes `devUID`, `devLoginID`, and `devLoginPwd`, but they
  are session config fields, not arbitrary hardcoded stream constants.
- Native copies additional state from earlier query/wakeup/session records into
  `0x1205`.
- Native switches between direct and relay address blocks.
- Native sets several bytes from session offsets populated by previous native
  handlers; UBox Web guesses fixed values.

Compatibility impact:

- `0x1205` is the highest-risk mismatch for other devices.
- A camera can work if our guessed payload matches the observed device, then
  fail on another model/region because the previous native state differs.
- The fix path is to parse and store the same fields from `0x1052`, `0x1202`,
  and `0x1206`, then build `0x1205` from that state instead of from a fixed
  cloud-account template.

## Short Answer

For cross-device compatibility:

```text
start-video: mostly right, but channel/kind and flags may vary
relay-stream request: likely wrong/too static for other devices
```

The next useful native targets are:

```text
p4p_client_handle_queryrsp
p4p_client_handle_rlywakeuprsp
p4p_client_handle_rlystreamrsp
p4p_client_send_knock
p4p_client_handle_alive
```

Those handlers explain exactly how the session fields used by
`p4p_client_send_rlystreamreq` are populated.

For the exact `p4p_client_start` / `p4p_client_startvideo` flow, see
[native-start.md](native-start.md).
