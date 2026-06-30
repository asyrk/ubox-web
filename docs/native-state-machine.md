# Native P4P Client State Machine

This document reconstructs the native client state machine from the decompiled
`libUBICAPIs29.so` code. It is intentionally limited to network/session state:
query, wake-up, relay/LAN stream open, punch, keepalive, KCP, and AV control.

Primary native sources:

```text
docs/decompiled/libUBICAPIs29/p4p_client_start.c
docs/decompiled/libUBICAPIs29/p4p_client_receiver.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_queryrsp.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_rlywakeuprsp.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_rlystreamrsp.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_lanwakeuprsp.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_lansearchrsp.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_lanstreamrsp.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_knock_r.c
docs/decompiled/libUBICAPIs29/p4p_client_handle_knock.c
docs/decompiled/libUBICAPIs29/p4p_client_startvideo.c
docs/decompiled/libUBICAPIs29/p4p_client_send_avctrl.c
docs/decompiled/libUBICAPIs29/p4p_client_tmout_*.c
docs/decompiled/libUBICAPIs29/p4p_tmout_keepalive.c
```

The `docs/decompiled/` files are local reverse-engineering artifacts and may be
absent from a public checkout. Regenerate them with the workflow in
`docs/reverse-engineering.md` when deeper verification is needed.

## Native Non-LAN Relay/P2P Graph

This graph shows the relay path and the P2P/direct upgrade path. It excludes
LAN wake/search/stream handling, which is split into the next graph.

```mermaid
flowchart TD
  START(["p4p_client_start(config, random_id)"])
  S1["state 1: bootstrap / query<br/>send 0x1051 p4p_client_send_queryreq"]
  S2["state 2: relay wake-up wait<br/>send/retry 0x1201 p4p_client_send_rlywakeupreq"]
  S3["state 3: relay stream wait<br/>send/retry 0x1205 p4p_client_send_rlystreamreq"]
  S5["state 5: punch retries exhausted<br/>relay path still alive, direct punch not proven"]
  S6["state 6: relay stream open / punching<br/>send 0x130b p4p_client_send_knock<br/>send 0x1405 p4p_client_send_alive"]
  S7["state 7: P2P/direct established<br/>0x130c p4p_client_handle_knock_r P2P branch"]
  LIVE["live transport<br/>0x1404 p4p_client_handle_packet<br/>0x1406 p4p_client_handle_alive<br/>0x1408 p4p_client_handle_avctrl<br/>0x140a p4p_client_handle_kcp"]
  AV["AV control allowed when state is 5 or higher<br/>0x1407 p4p_client_send_avctrl<br/>0x1409 p4p_client_kcp_send when KCP-wrapped"]
  STOP["stop/logout<br/>0x1207 relay logout req -> 0x1208 relay logout rsp<br/>0x1309 LAN logout req -> 0x130a LAN logout rsp"]
  E26["state 0x26: relay stream error path<br/>0x1206 status -0x7da"]
  E2B["state 0x2b: relay stream error path<br/>0x1206 status -0x7d5"]
  FAIL["session free / status callback error"]

  START --> S1

  S1 -- "timer 2 p4p_client_tmout_queryreq<br/>retry 0x1051 every 1000 ms, 10 tries" --> S1
  S1 -- "query timeout<br/>status -0x7d3" --> FAIL

  S1 -- "0x1052 query-rsp<br/>p4p_client_handle_queryrsp<br/>update VPG relay table<br/>delete timer 2, add timer 3<br/>state=2, send 0x1201" --> S2
  S2 -- "0x1052 query-rsp repeat<br/>refresh VPG relay table<br/>send 0x1201 again" --> S2
  S2 -- "timer 3 p4p_client_tmout_rlywakeupreq<br/>retry 0x1201 every 500 ms, 20 tries" --> S2
  S2 -- "relay wake timeout<br/>status -0x7d4" --> FAIL

  S2 -- "0x1202 relay-wakeup-rsp<br/>p4p_client_handle_rlywakeuprsp<br/>only accepted when payload/status byte == 2<br/>delete timer 3, add timer 4<br/>state=3, send 0x1205" --> S3
  S3 -- "timer 4 p4p_client_tmout_srvlsrreq<br/>retry 0x1205 every 1000 ms, 16 tries" --> S3
  S3 -- "relay stream timeout<br/>status -0x7dd" --> FAIL

  S3 -- "0x1206 relay-stream-rsp success<br/>p4p_client_handle_rlystreamrsp<br/>delete timer 4, add timer 6 and 7<br/>state=6, send 0x130b and 0x1405" --> S6
  S3 -- "0x1206 relay-stream-rsp status -0x7da" --> E26
  S3 -- "0x1206 relay-stream-rsp status -0x7d5" --> E2B

  S6 -- "timer 6 p4p_client_tmout_punchreq<br/>retry 0x130b every 1000 ms, 6 tries" --> S6
  S6 -- "timer 6 exhausted<br/>state=5" --> S5
  S3 -- "0x130e knock-peer<br/>p4p_client_handle_knock<br/>send 0x130b" --> S3
  S5 -- "0x130e knock-peer<br/>p4p_client_handle_knock<br/>send 0x130b" --> S5
  S6 -- "0x130e knock-peer<br/>p4p_client_handle_knock<br/>send 0x130b" --> S6

  S3 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>P2P branch state=7<br/>send 0x130d and 0x1405" --> S7
  S5 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>P2P branch state=7<br/>send 0x130d and 0x1405" --> S7
  S6 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>P2P branch state=7<br/>send 0x130d and 0x1405" --> S7

  S5 --> LIVE
  S6 --> LIVE
  S7 --> LIVE
  S5 --> AV
  S6 --> AV
  S7 --> AV
  LIVE -- "timer 7 p4p_tmout_keepalive<br/>send 0x1405 every 1000 ms<br/>reset live count on 0x1404/0x1406/0x140a<br/>13 misses => free session" --> LIVE
  AV --> LIVE
  LIVE --> STOP
  STOP --> FAIL
```

## Native LAN Graph

LAN handling runs beside the relay path. `p4p_client_start()` sends either LAN
wake-up `0x1301` or LAN search `0x1303` while the query/relay path is also
running. LAN responses can take states `1`, `2`, or `3` into state `4`, then
`0x1308` can establish state `8`. A LAN branch can also arrive through
`0x130c p4p_client_handle_knock_r`.

```mermaid
flowchart TD
  START(["p4p_client_start(config, random_id)"])
  S1["state 1: bootstrap / query<br/>send 0x1051 query-req<br/>plus LAN side path"]
  LANWAKE["LAN wake/search side path<br/>0x1301 p4p_client_send_lanwakeupreq or<br/>0x1303 p4p_client_send_lansearchreq"]
  S2["state 2: relay wake-up wait<br/>0x1201 relay-wakeup-req may already be active"]
  S3["state 3: relay stream wait<br/>0x1205 relay-stream-req may already be active"]
  S4["state 4: LAN stream wait<br/>send/retry 0x1307 p4p_client_send_lanstreamreq"]
  S5["state 5: relay punch retries exhausted<br/>still accepts 0x130c"]
  S6["state 6: relay stream open / punching<br/>0x130b knock-req active"]
  S8["state 8: LAN established"]
  LIVE["LAN/direct live transport<br/>0x1404 p4p_client_handle_packet<br/>0x1406 p4p_client_handle_alive<br/>0x1408 p4p_client_handle_avctrl<br/>0x140a p4p_client_handle_kcp"]
  AV["AV control in state 8<br/>0x1407 p4p_client_send_avctrl<br/>direct/LAN-style msgLen 0x21"]
  STOP["LAN stop/logout<br/>0x1309 lan-logout-req -> 0x130a lan-logout-rsp"]
  RELAYFALLBACK["relay fallback<br/>state=2, send 0x1201<br/>add timer 3"]
  E26["state 0x26: LAN stream error path<br/>0x1308 status -0x7da"]
  E2B["state 0x2b: LAN stream error path<br/>0x1308 status -0x7d5"]

  START --> S1
  S1 --> LANWAKE
  LANWAKE -- "timer 1 p4p_client_tmout_lanwakeup<br/>retry 0x1301 every 200 ms, 50 tries" --> LANWAKE
  LANWAKE -- "timer 12 p4p_client_tmout_lansearch<br/>retry 0x1303 every 500 ms, 10 tries" --> LANWAKE

  S1 -- "0x1052 query-rsp<br/>normal relay path enters state=2" --> S2
  S2 -- "0x1202 relay-wakeup-rsp<br/>normal relay path enters state=3" --> S3

  S1 -- "0x1302 LAN wakeup-rsp<br/>p4p_client_handle_lanwakeuprsp<br/>delete query/LAN timers, state=4<br/>send 0x1307" --> S4
  S2 -- "0x1302 LAN wakeup-rsp<br/>p4p_client_handle_lanwakeuprsp<br/>delete relay wake timer, state=4<br/>send 0x1307" --> S4
  S3 -- "0x1302 LAN wakeup-rsp<br/>p4p_client_handle_lanwakeuprsp<br/>delete relay stream timer, state=4<br/>send 0x1307" --> S4
  S1 -- "0x1304 LAN search-rsp<br/>p4p_client_handle_lansearchrsp<br/>state=4, send 0x1307" --> S4
  S2 -- "0x1304 LAN search-rsp<br/>p4p_client_handle_lansearchrsp<br/>state=4, send 0x1307" --> S4
  S3 -- "0x1304 LAN search-rsp<br/>p4p_client_handle_lansearchrsp<br/>state=4, send 0x1307" --> S4

  S6 -- "0x1302 or 0x1304 while state=6<br/>native deletes punch timer if needed<br/>no direct state=4 transition" --> S6
  S4 -- "timer 5 p4p_client_tmout_lanlsrreq<br/>retry 0x1307 every 1000 ms, 3 tries" --> S4
  S4 -- "timer 5 exhausted<br/>p4p_client_tmout_lanlsrreq" --> RELAYFALLBACK
  RELAYFALLBACK --> S2

  S4 -- "0x1308 LAN stream-rsp success<br/>p4p_client_handle_lanstreamrsp<br/>delete timer 5, add keepalive timer 7<br/>state=8, send 0x1405" --> S8
  S4 -- "0x1308 LAN stream-rsp status -0x7da" --> E26
  S4 -- "0x1308 LAN stream-rsp status -0x7d5" --> E2B

  S4 -- "0x130e knock-peer<br/>p4p_client_handle_knock<br/>send 0x130b" --> S4
  S3 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>LAN branch state=8<br/>send 0x130d and 0x1405" --> S8
  S4 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>LAN branch state=8<br/>send 0x130d and 0x1405" --> S8
  S5 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>LAN branch state=8<br/>send 0x130d and 0x1405" --> S8
  S6 -- "0x130c knock-rsp<br/>p4p_client_handle_knock_r<br/>LAN branch state=8<br/>send 0x130d and 0x1405" --> S8

  S8 --> LIVE
  S8 --> AV
  LIVE -- "timer 7 p4p_tmout_keepalive<br/>send 0x1405 every 1000 ms<br/>reset live count on 0x1404/0x1406/0x140a<br/>13 misses => free session" --> LIVE
  AV --> LIVE
  LIVE --> STOP
```

## Native State Table

| State | Meaning inferred from native code | Main native functions |
| --- | --- | --- |
| `1` | Bootstrap/query. Sends cloud query plus LAN wake/search side path. | `p4p_client_start`, `p4p_client_send_queryreq`, `p4p_client_send_lanwakeupreq`, `p4p_client_send_lansearchreq`, `p4p_client_tmout_queryreq` |
| `2` | Waiting for relay wake-up readiness. | `p4p_client_handle_queryrsp`, `p4p_client_send_rlywakeupreq`, `p4p_client_tmout_rlywakeupreq` |
| `3` | Waiting for relay stream response. | `p4p_client_handle_rlywakeuprsp`, `p4p_client_send_rlystreamreq`, `p4p_client_tmout_srvlsrreq` |
| `4` | Waiting for LAN stream response. | `p4p_client_handle_lanwakeuprsp`, `p4p_client_handle_lansearchrsp`, `p4p_client_send_lanstreamreq`, `p4p_client_tmout_lanlsrreq` |
| `5` | Punch retry timer expired, but session is not freed. Native still accepts knock messages and AV control. | `p4p_client_tmout_punchreq`, `p4p_client_handle_knock`, `p4p_client_handle_knock_r`, `p4p_client_startvideo` |
| `6` | Relay stream response succeeded; relay path is usable while native attempts punching/direct upgrade. | `p4p_client_handle_rlystreamrsp`, `p4p_client_send_knock`, `p4p_client_send_alive`, `p4p_client_tmout_punchreq` |
| `7` | P2P/direct transport established. | `p4p_client_handle_knock_r`, `p4p_client_send_avctrl`, `p4p_tmout_keepalive` |
| `8` | LAN transport established. | `p4p_client_handle_lanstreamrsp`, `p4p_client_handle_knock_r`, `p4p_client_send_avctrl`, `p4p_tmout_keepalive` |
| `0x26` | Stream response error for native status `-0x7da`. | `p4p_client_handle_rlystreamrsp`, `p4p_client_handle_lanstreamrsp` |
| `0x2b` | Stream response error for native status `-0x7d5`. | `p4p_client_handle_rlystreamrsp`, `p4p_client_handle_lanstreamrsp` |

## Message Map

Native inbound dispatch is in `p4p_client_receiver.c`. The names below are the
native handler names or the project labels derived directly from those handler
names.

| Code | Native/project name | Native role |
| --- | --- | --- |
| `0x1051` | `query-req` / `p4p_client_send_queryreq` | Outbound master/discovery query. Sends to first 3 master servers when `query_kind == 4`, otherwise the full seeded master list. |
| `0x1052` | `query-rsp` / `p4p_client_handle_queryrsp` | Inbound query response; carries VPG relay endpoints and moves state `1 -> 2`. |
| `0x1054` | `syncdb-rsp` / `p4p_client_handle_syncdbrsp` | Inbound sync DB response; not part of live stream startup path. |
| `0x1201` | `relay-wakeup-req` / `p4p_client_send_rlywakeupreq` | Outbound relay wake-up request. |
| `0x1202` | `relay-wakeup-rsp` / `p4p_client_handle_rlywakeuprsp` | Inbound relay wake-up response; accepts only ready byte `2`, then moves `2 -> 3`. |
| `0x1204` | `relay-login-rsp` / `p4p_client_handle_loginrsp` | Inbound relay login response; not used by the current live path. |
| `0x1205` | `relay-stream-req` / `p4p_client_send_rlystreamreq` | Outbound relay stream request; only sent in state `3`. |
| `0x1206` | `relay-stream-rsp` / `p4p_client_handle_rlystreamrsp` | Inbound relay stream response; success moves `3 -> 6`. |
| `0x1207` | `relay-logout-req` | Outbound relay logout. |
| `0x1208` | `relay-logout-rsp` / `p4p_client_handle_logoutrsp` | Inbound relay logout response. |
| `0x1209` | `relay-close-req` / `p4p_client_handle_rlyclosereq` | Inbound relay close request. |
| `0x120e` | `relay-rtd-update` | Inbound relay timing/RTD update path. |
| `0x1301` | `lan-wakeup-req` / `p4p_client_send_lanwakeupreq` | Outbound LAN wake-up request. |
| `0x1302` | `lan-wakeup-rsp` / `p4p_client_handle_lanwakeuprsp` | Inbound LAN wake-up response; can move early states to `4`. |
| `0x1303` | `lan-search-req` / `p4p_client_send_lansearchreq` | Outbound LAN search request. |
| `0x1304` | `lan-search-rsp` / `p4p_client_handle_lansearchrsp` | Inbound LAN search response; can move early states to `4`. |
| `0x1306` | `lan-login-rsp` / `p4p_client_handle_loginrsp` | Inbound LAN login response; not used by the current live path. |
| `0x1307` | `lan-stream-req` / `p4p_client_send_lanstreamreq` | Outbound LAN stream request; only sent in state `4`. |
| `0x1308` | `lan-stream-rsp` / `p4p_client_handle_lanstreamrsp` | Inbound LAN stream response; success moves `4 -> 8`. |
| `0x1309` | `lan-logout-req` | Outbound LAN logout. |
| `0x130a` | `lan-logout-rsp` / `p4p_client_handle_logoutrsp` | Inbound LAN logout response. |
| `0x130b` | `knock-req` / `p4p_client_send_knock` | Outbound punch/knock request. |
| `0x130c` | `knock-rsp` / `p4p_client_handle_knock_r` | Inbound punch/knock response; moves to state `7` or `8`. |
| `0x130d` | `knock-ack` | Outbound knock acknowledgement sent by `p4p_client_handle_knock_r`. |
| `0x130e` | `knock-peer` / `p4p_client_handle_knock` | Inbound peer knock; native replies with `0x130b`. |
| `0x1402` | `ioctrl-rsp` / `p4p_client_handle_ioctrl` | Inbound IO control response. |
| `0x1404` | `rdt-video` / `p4p_client_handle_packet` | Inbound direct/RDT packet; resets live count. |
| `0x1405` | `alive-req` / `p4p_client_send_alive` | Outbound keepalive. |
| `0x1406` | `alive-rsp` / `p4p_client_handle_alive` | Inbound keepalive response; resets live count. |
| `0x1407` | `avctrl-req` / `p4p_client_send_avctrl` | Outbound AV control, including start video. |
| `0x1408` | `avctrl-rsp` / `p4p_client_handle_avctrl` | Inbound AV control response. |
| `0x1409` | `kcp-client` / `p4p_client_kcp_send` | Outbound client KCP packet. |
| `0x140a` | `kcp-device` / `p4p_client_handle_kcp` | Inbound device KCP packet; resets live count. |

## Native AV-Control Gate

`p4p_client_startvideo()` and `p4p_client_send_avctrl()` both reject sessions
whose state is below `5`.

Native AV-control addressing changes by state:

```text
state 7 or state 8 -> msgLen 0x21, direct/LAN-style SID fields
state 5 or state 6 -> msgLen 0x24, relay-style SID fields
```

So native start-video is legal after relay stream success (`state 6`) and after
direct/LAN promotion (`state 7` or `8`). It is not legal during query, wake-up,
relay stream request, or LAN stream request states (`1` through `4`).

## Current UBox Web State Machine

Current implementation lives mostly in `ubox-live-stream.js`.

```mermaid
flowchart TD
  CSTART(["UBoxLiveStreamSession.start()"])
  C1["state 1<br/>send 0x1051 query-req"]
  C2["state 2<br/>send/retry 0x1201 relay-wakeup-req"]
  C3["state 3<br/>send/retry 0x1205 relay-stream-req"]
  C6["state 6<br/>relay established<br/>send 0x130b, 0x1405, 0x1407"]
  C5["state 5<br/>punch retries expired"]
  C7["state 7<br/>knock response handled as P2P/direct<br/>active peer becomes 0x130c sender"]
  CLAN["LAN-only stream messages logged and ignored<br/>0x1301/0x1302/0x1303/0x1304/0x1307/0x1308"]
  CKCP["live packet handling<br/>0x1404 RDT, 0x1406 alive, 0x1409/0x140a KCP"]
  CRESTART["restartSession / timeout cleanup"]

  CSTART --> C1
  C1 -- "0x1052 query-rsp" --> C2
  C1 -- "query timeout" --> CRESTART
  C2 -- "0x1202 relay-wakeup-rsp<br/>ready byte accepted" --> C3
  C2 -- "relay wake timeout" --> CRESTART
  C3 -- "0x1206 relay-stream-rsp success" --> C6
  C3 -- "relay stream timeout" --> CRESTART
  C3 -- "0x130e knock-peer<br/>reply 0x130b" --> C3
  C6 -- "punch timer exhausted" --> C5
  C6 -- "0x130e knock-peer<br/>reply 0x130b" --> C6
  C5 -- "0x130e knock-peer<br/>reply 0x130b" --> C5
  C3 -- "0x130c knock-rsp<br/>non-LAN native gate" --> C7
  C6 -- "0x130c knock-rsp<br/>non-LAN native gate" --> C7
  C5 -- "0x130c knock-rsp<br/>non-LAN native gate" --> C7
  C1 -. "LAN message" .-> CLAN
  C2 -. "LAN message" .-> CLAN
  C3 -. "LAN message" .-> CLAN
  C6 -. "LAN message" .-> CLAN
  C6 --> CKCP
  C7 --> CKCP
  CKCP -- "keepalive misses / watchdog" --> CRESTART
```

## Native vs Current Comparison

| Area | Native behavior | Current UBox Web behavior | Match |
| --- | --- | --- | --- |
| Initial state | `p4p_client_start()` sets state `1`. | Constructor sets `sessionState.state = 1`. | Yes |
| Query request | Sends `0x1051` to native master/discovery servers and retries timer type `2` every 1000 ms, 10 tries. Fanout is 3 servers when `query_kind == 4`, otherwise the full seeded list. | Sends `0x1051` to the same seeded master/discovery list with the same `query_kind == 4` fanout. | Yes |
| LAN startup side path | Also sends `0x1301` LAN wake-up or `0x1303` LAN search, with timers `1` or `12`. | Not implemented; LAN stream messages are logged and ignored. | Intentionally no |
| Query response | `0x1052` updates native VPG/local tables, deletes query timer, adds relay wake timer, sets state `2`, sends `0x1201` to discovered VPG relay endpoints. | Parses the VPG item at payload offset `0x1c`, extracts up to four IPv4 relay targets, stores IPv6 metadata for diagnostics, sets state `2`, starts relay wake timer, sends `0x1201` to the discovered IPv4 targets. | Mostly |
| Relay wake response | `0x1202` accepted only in state `2` and only when native ready byte is `2`; then state `3`, timer `4`, send `0x1205`. | Same state gate and ready-byte gate when `requireWakeupReadyStatus` is enabled; then state `3`, send/retry `0x1205`. | Mostly |
| Relay stream request | Native sends `0x1205` only in state `3`, retries every 1000 ms, 16 tries. | Same state and retry shape. Payload may still differ in fields not fully reconstructed. | Partial |
| Relay stream response | `0x1206` success sets state `6`, starts punch timer `6`, keepalive timer `7`, sends `0x130b` and `0x1405`. | `0x1206` success sets state `6`, starts punch retries, sends `0x130b` and `0x1405`. | Yes |
| Start-video timing | Native allows `p4p_client_startvideo()` only when state `>= 5`. Java/native caller decides when to call it. | Sends `0x1407` automatically right after `0x1206` moves to state `6`, and again when KCP appears. | Legal by native gate, but timing differs |
| Punch retries | Native retries `0x130b` in state `6` for 6 ticks, then demotes to state `5`. | Same state `6 -> 5` retry model. | Yes |
| Knock response | Native accepts `0x130c` in states `3`, `4`, `5`, `6`; branch decides state `7` P2P or state `8` LAN, sends `0x130d` and `0x1405`. | Accepts `0x130c` only in non-LAN states `3`, `5`, `6`; switches active peer to the packet sender, sends `0x130d` and `0x1405`; always promotes to state `7`. | Partial |
| Peer knock | Native handles `0x130e` in states `3`, `4`, `5`, `6` and replies with `0x130b`. | Handles `0x130e` in non-LAN states `3`, `5`, `6` and replies with `0x130b`. | Partial |
| LAN stream | Native can move `1/2/3 -> 4` on `0x1302` or `0x1304`, send `0x1307`, then `0x1308` success moves to `8`. In state `6`, those LAN responses only cancel punch timer; LAN promotion from `6` happens through the `0x130c` LAN branch. | Not implemented; `0x1301`, `0x1302`, `0x1303`, `0x1304`, `0x1307`, and `0x1308` are logged as ignored. | Intentionally no |
| Live count | Native resets live count on `0x1404`, `0x1406`, and `0x140a`; keepalive frees session after 13 misses. | Resets on `0x1404`, `0x1406`, `0x1409`, `0x140a`; restarts after configured miss limit, default 13. | Mostly |
| KCP direction | Native sends client KCP as `0x1409`, receives device KCP as `0x140a`. | Sends KCP as `0x1409`; accepts both `0x1409` and `0x140a` inbound. | Superset |
| AV-control addressing | Native uses relay-style fields in states `5/6`, direct/LAN-style fields in states `7/8`. | Same `state === 7 || state === 8` branch exists, but state `8` is never reached. | Partial |
| Stop/logout | Native sends relay logout `0x1207` or LAN logout `0x1309`, receives `0x1208`/`0x130a`. | Sends relay or LAN logout based on state, but practical path is relay/P2P because state `8` is absent. | Partial |

## Main Differences To Investigate Later

The highest-signal remaining gaps are:

1. Native LAN path is missing: `0x1301`, `0x1302`, `0x1303`, `0x1304`, `0x1307`,
   `0x1308`, and state `4/8`.
2. Native `0x1052` stores full VPG/local routing tables, including IPv6 relay
   slots. Current code extracts the native IPv4 relay slots used by the
   non-IPv6 path and logs IPv6 metadata, but does not dial IPv6 relays or keep
   the full native VPG cache/refcount model.
3. Native `0x130c` can promote to state `8` when it identifies a LAN path;
   current code always promotes to state `7`.
4. Native accepts `0x130e` in state `4`; current code intentionally limits it
   to non-LAN states `3`, `5`, and `6`.
5. Native start-video is caller-driven after state `>= 5`; current code sends it
   automatically as soon as relay stream response succeeds.
