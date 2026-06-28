# Native Timer And Live-Count Logic

This documents the timer functions found in `libUBICAPIs29.so` after applying
the inferred `/ubox` Ghidra structs.

Exported decompiler output lives in:

```text
docs/decompiled/libUBICAPIs29/
```

## Timer Dispatch

Native timer IDs are encoded as:

```text
timer_key = session_id | (timer_type << 8)
```

`p4p_timer_timeout()` dispatches by `timer_type`:

```text
1  -> p4p_client_tmout_lanwakeup
2  -> p4p_client_tmout_queryreq
3  -> p4p_client_tmout_rlywakeupreq
4  -> p4p_client_tmout_srvlsrreq
5  -> p4p_client_tmout_lanlsrreq
6  -> p4p_client_tmout_punchreq
7  -> p4p_tmout_keepalive
12 -> p4p_client_tmout_lansearch
13 -> p4p_client_tmout_syncdb
15 -> p4p_client_tmout_logout
16 -> p4p_client_tmout_clilansearch
```

`p4p_timer_add(type, interval_ms, left_count, session_id)` forwards to
`p4p_timer_intern_add()` with that encoded key.

`left_count == 0` means the current timer has exhausted retries. Nonzero means
retry/resend.

## Startup Timers

### Query Request: `p4p_client_tmout_queryreq`

State gate:

```text
session.active == 1
session.state == 1
```

Behavior:

```text
left_count == 0 -> delete timer 0x200, free session, status -0x7d3
left_count != 0 -> resend p4p_client_send_queryreq()
```

### Relay Wake-Up: `p4p_client_tmout_rlywakeupreq`

State gate:

```text
session.active == 1
session.state == 2
```

Behavior:

```text
left_count == 0 -> free session, status -0x7d4
left_count != 0 -> resend p4p_client_send_rlywakeupreq()
```

### Relay Stream Request: `p4p_client_tmout_srvlsrreq`

State gate:

```text
session.active == 1
session.state == 3
```

Behavior:

```text
left_count == 0 -> free session, status -0x7dd
left_count != 0 -> resend p4p_client_send_rlystreamreq()
```

This is timer type `4`. Native `p4p_client_handle_rlywakeuprsp()` adds it with:

```text
p4p_timer_add(4, 1000, 0x10, session_id)
```

So native retries the relay stream request every second, up to 16 counts.

## Post-Stream Timers

### Punch / Knock: `p4p_client_tmout_punchreq`

State gate:

```text
session.active == 1
session.state == 6
```

Behavior:

```text
left_count == 0 -> session.state = 5
left_count != 0 -> resend p4p_client_send_knock()
```

Native stream response success adds:

```text
p4p_timer_add(6, 1000, 6, session_id)
```

So after stream response, native sends/continues knock for about six one-second
ticks. On exhaustion it demotes session state from `6` to `5`, rather than
freeing the session.

### Keepalive: `p4p_tmout_keepalive`

Native stream response success also does:

```text
p4p_client_send_knock(session)
p4p_timer_add(7, 1000, -1, session_id)
p4p_client_send_alive(session)
```

Timer type `7` is keepalive.

On each keepalive timeout:

```text
session.live_miss_count += 1

if session.live_miss_count < 13:
  if session.role == 2:
    p4p_client_send_alive(session)
  else:
    p4p_device_send_alive(session)

  if left_count == 0:
    re-add keepalive timer forever
else:
  delete/free session and report status
```

Important threshold:

```text
13 missed live updates => session is considered dead
```

## Live Count Reset

`p4p_client_update_livecnt(session_id)` validates:

```text
session_id in 0..255
pP4PMgmt != null
session.active == 1
session.local_sid == session_id
```

Then it resets:

```text
session.live_miss_count = 0
```

It is called by:

```text
p4p_client_handle_packet()  // inbound direct/RDT packets
p4p_client_handle_kcp()     // inbound 0x140a KCP packets
p4p_client_handle_alive()   // inbound alive response
```

So any of these inbound packets keep the session alive:

```text
0x1404 direct/RDT packet
0x1406 alive response
0x140a KCP packet
```

## Struct Updates

The timer pass proves these `p4p_session` fields:

```text
session+0x03 role             1 device, 2 client
session+0x1a live_miss_count  incremented by keepalive, reset by inbound data
session+0x1b alive_send_count incremented by p4p_client_send_alive
session+0xd4 last_alive_tick  set by p4p_client_handle_alive
```

## Implementation Impact

UBox Web should track the same logical counters:

```text
live_miss_count
last_alive_at
last_kcp_or_direct_packet_at
knock retry count
relay stream request retry count
```

The key native behavior is not just "send alive every second". It is:

```text
send alive every second
reset miss counter on inbound direct/KCP/alive packet
kill session after 13 missed inbound updates
retry relay stream request for 16 seconds during state 3
retry knock for 6 seconds during state 6, then demote to state 5
```
