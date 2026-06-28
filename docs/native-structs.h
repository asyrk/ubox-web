#pragma once

/*
 * Inferred native UBox/P4P transport structs.
 *
 * Source binary:
 *   E:\dev\libs\libUBICAPIs29.so
 *
 * Evidence:
 *   decompiled C files in docs/decompiled/libUBICAPIs29/
 *   docs/native-xrefs.md
 *
 * These are reverse-engineering notes, not vendor headers. Field names are
 * inferred from use sites. Keep offsets stable; rename fields only when a
 * handler proves a better name.
 */

#include <stdint.h>

#pragma pack(push, 1)

typedef struct p4p_header {
    uint16_t magic;          /* +0x00: 0x1807 */
    uint16_t version;        /* +0x02: 0x0010 */
    uint16_t payload_len;    /* +0x04: bytes after this 16-byte header */
    uint16_t sid_or_channel; /* +0x06 */
    uint16_t msg;            /* +0x08 */
    uint16_t msg_len;        /* +0x0a */
    uint16_t seq_or_param;   /* +0x0c */
    uint8_t kind;            /* +0x0e: AV channel / stream kind */
    uint8_t flags;           /* +0x0f */
    uint8_t payload[];       /* +0x10 */
} p4p_header;

typedef struct p4p_sockaddr_like {
    uint16_t family;         /* +0x00: native writes 2 or 10 */
    uint16_t port;           /* +0x02 */
    uint8_t addr[16];        /* +0x04: IPv4 uses first 4 bytes */
    uint8_t extra[8];        /* +0x14: present on relay/source copies */
} p4p_sockaddr_like;

typedef struct relay_stream_req_payload {
    uint8_t request_type;       /* +0x00: native writes 1 */
    uint8_t relay_mode;         /* +0x01: 0 direct, 1 relay-server path */
    uint8_t reserved_02;        /* +0x02 */
    uint8_t seq_byte;           /* +0x03: p4p_session.seq_byte */
    uint8_t reserved_04[0x08];  /* +0x04 */
    uint32_t direct_server_ip;  /* +0x0c: only direct path, pP4PMgmt+0x10 */
    uint16_t direct_server_port;/* +0x10: only direct path, pP4PMgmt+0x0e */
    uint8_t reserved_12[0x06];  /* +0x12 */
    uint8_t uid_or_relay_token[0x14];
                               /* +0x18: UID; relay mode overwrites first 16 bytes */
    uint8_t session_blob_108[0x14];
                               /* +0x2c: copied from p4p_session+0x108 */
    uint8_t zero_40;            /* +0x40 */
    uint8_t av_kind;            /* +0x41: p4p_session.av_kind */
    uint8_t local_sid;          /* +0x42: p4p_session.local_sid */
    uint8_t reserved_43[0x05];  /* +0x43 */
    uint32_t random_id;         /* +0x48: p4p_session.random_id */
    uint8_t session_blob_f8[0x10];
                               /* +0x4c: copied from p4p_session+0x0f8 */
    uint8_t stream_req_code;    /* +0x5c: 0 or 9 from p4p_session.stream_req_enabled */
    uint8_t reserved_5d;        /* +0x5d */
    uint8_t req_byte_e1;        /* +0x5e: p4p_session+0xe1 */
    uint8_t req_flags;          /* +0x5f: bit0 from +0xde, bit1 from +0xdf */
    uint8_t reserved_60[0x02];  /* +0x60 */
    uint8_t zero_62;            /* +0x62 */
    uint8_t reserved_63;        /* +0x63 */
    uint32_t client_start_second;
                               /* +0x64: p4p_session+0x128 */
    uint8_t reserved_68[0x04];  /* +0x68 */
} relay_stream_req_payload;     /* size 0x6c */

typedef struct relay_stream_rsp_record {
    int16_t status;             /* +0x00: 0 success, negative error */
    uint8_t reserved_02[0x12];  /* +0x02 */
    uint16_t direct_port_a;     /* +0x14 -> p4p_session.direct_addr_a.port */
    uint16_t addr_port;         /* +0x16 -> p4p_session direct/relay addr port */
    uint32_t addr_ip;           /* +0x18 -> p4p_session direct/relay addr */
    int16_t av_state;           /* +0x1a -> av_channel.state */
    uint8_t reserved_1c;        /* +0x1c */
    uint8_t av_kind;            /* +0x1d: used by p4p_client_find_avchn */
    uint8_t session_index;      /* +0x1e */
    uint8_t peer_sid_byte;      /* +0x1f -> p4p_session.peer_sid_byte */
    uint16_t peer_value_08;     /* +0x20 -> p4p_session+0x08 */
    uint16_t peer_value_0a;     /* +0x22 -> p4p_session+0x0a */
    uint32_t random_id;         /* +0x24: must match p4p_session.random_id */
    uint8_t data[0x184];        /* +0x28 */
} relay_stream_rsp_record;      /* size 0x1ac */

typedef struct relay_stream_rsp_payload {
    uint8_t record_count;       /* P4P payload +0x00, native clamps to 16 */
    uint8_t reserved_01[0x02];
    uint8_t seq_byte;           /* +0x03: must match p4p_session.seq_byte if nonzero */
    uint8_t reserved_04[0x10];
    uint16_t direct_port_a;     /* +0x14 -> p4p_session.direct_addr_a.port */
    uint16_t direct_port_b;     /* +0x16 -> p4p_session.direct_addr_b.port */
    uint32_t direct_ip_b;       /* +0x18 -> p4p_session.direct_addr_b.addr */
    uint32_t direct_ip_c;       /* +0x1c -> p4p_session.direct_addr_c.addr */
    uint16_t direct_port_c;     /* +0x20 -> p4p_session.direct_addr_c.port */
    uint8_t reserved_22[0x02];
    uint32_t direct_ip_a;       /* +0x24 -> p4p_session.direct_addr_a.addr */
    relay_stream_rsp_record records[];
                               /* +0x28, stride 0x1ac */
} relay_stream_rsp_payload;

typedef struct p4p_client_start_config {
    uint8_t lan_wakeup_mode;    /* +0x00: Java devType; 1 sends LAN wakeup, else LAN search */
    uint8_t video_enabled;      /* +0x01: Java videoOn -> session+0xdd / AV channel+0x19 */
    uint8_t listen_enabled;     /* +0x02: Java listenOn -> session+0xde / AV channel+0x1a */
    uint8_t speak_enabled;      /* +0x03: Java speakOn -> session+0xdf / AV channel+0x1b */
    uint8_t channel;            /* +0x04: Java channel -> session+0xe0 / AV kind */
    uint8_t stream_index;       /* +0x05: Java streamindex -> session+0xe1 */
    uint8_t play_record;        /* +0x06: Java playrecord */
    uint8_t zone_id;            /* +0x07: Java zoneID -> session+0x05 query_kind */
    char dev_uid[0x14];         /* +0x08: Java devUID */
    char dev_login_id[0x10];    /* +0x1c: Java devLoginID */
    char dev_login_pwd[0x14];   /* +0x2c: Java devLoginPwd */
} p4p_client_start_config;      /* size 0x40 */

typedef struct p4p_session {
    uint8_t active;             /* +0x00 */
    uint8_t state;              /* +0x01: 1 query, 2 wake, 3 stream req, 6 ready */
    uint8_t reserved_02;        /* +0x02 */
    uint8_t role;               /* +0x03: 1 device, 2 client */
    uint8_t reserved_04;
    uint8_t query_kind;         /* +0x05: copied from p4p_client_start_config.zone_id */
    uint8_t local_sid;          /* +0x06 */
    uint8_t peer_sid_byte;      /* +0x07: from relay_stream_rsp_record+0x1f */
    uint16_t peer_value_08;     /* +0x08 */
    uint16_t peer_value_0a;     /* +0x0a */
    uint32_t random_id;         /* +0x0c */
    uint8_t reserved_10[0x04];
    int16_t session_index;      /* +0x14 */
    uint8_t reserved_16;
    uint8_t seq_byte;           /* +0x17 */
    uint8_t relay_mode;         /* +0x18: 0 direct, nonzero relay */
    uint8_t reserved_19;
    uint8_t live_miss_count;    /* +0x1a: incremented by keepalive timer, reset by data */
    uint8_t alive_send_count;   /* +0x1b: incremented by send_alive when send returns nonzero */
    uint8_t reserved_1c[0x40];
    uint8_t direct_addr_a[0x10];
                               /* +0x5c: sockaddr-like, record+0x14/0x24 */
    uint8_t direct_addr_b[0x10];
                               /* +0x6c: sockaddr-like, response+0x16/0x18 */
    uint8_t direct_addr_c[0x10];
                               /* +0x7c: sockaddr-like, response+0x20/0x1c */
    uint8_t direct_source_addr[0x10];
                               /* +0x8c: source addr copied from direct response */
    uint8_t relay_addr[0x1c];   /* +0x9c: family 10 plus response addr */
    uint8_t relay_source_addr[0x1c];
                               /* +0xb8: source addr copied from relay response */
    uint32_t last_alive_tick;   /* +0xd4: set by p4p_client_handle_alive */
    uint8_t reserved_d8[0x05];
    uint8_t stream_req_enabled; /* +0xdd: request byte becomes 9 when nonzero */
    uint8_t stream_flag_1;      /* +0xde -> relay_stream_req_payload.req_flags bit0 */
    uint8_t stream_flag_2;      /* +0xdf -> relay_stream_req_payload.req_flags bit1 */
    uint8_t av_kind;            /* +0xe0: copied into AV channel kind */
    uint8_t req_byte_e1;        /* +0xe1 */
    uint8_t reserved_e2[0x02];
    char uid[0x14];             /* +0xe4 */
    uint8_t session_blob_f8[0x10];
                               /* +0xf8 */
    uint8_t session_blob_108[0x14];
                               /* +0x108 */
    uint32_t client_start_tick; /* +0x11c: set by p4p_client_start */
    uint32_t stream_rsp_tick;   /* +0x120 */
    uint32_t first_stream_ind_tick;
                               /* +0x124 */
    uint32_t client_start_second;
                               /* +0x128: copied into relay stream request */
    uint8_t reserved_12c[0x08];
} p4p_session;                  /* size 0x134 */

typedef struct av_channel {
    uint8_t reserved_00[0x04];
    uint8_t active;             /* +0x04 */
    uint8_t reserved_05;
    uint8_t kind;               /* +0x06: matches p4p_session.av_kind */
    uint8_t reserved_07[0x05];
    void *kcp;                  /* +0x0c */
    uint8_t *kcp_buf;           /* +0x10: native allocates 0x80000 */
    uint8_t state;              /* +0x14 */
    uint8_t reserved_15[0x04];
    uint8_t video_enabled;      /* +0x19 */
    uint8_t flag_1;             /* +0x1a: start flags bit0 */
    uint8_t flag_2;             /* +0x1b: start flags bit1 */
    int16_t session_index;      /* +0x1c */
    uint8_t reserved_1e[0x556];
    void *video_receiver;       /* +0x574 */
    void *audio_sender;         /* +0x578 */
    void *audio_receiver;       /* +0x57c */
    uint8_t reserved_580[0x30];
    uint32_t stream_counters[6];/* +0x5b0: indexed by stream_byte / 4 */
} av_channel;                   /* native stride 0x5c8 */

typedef struct kcp_inner_record {
    uint16_t type;              /* +0x00: 2 avctrl, 4 ioctrl, 0x11/0x14 video */
    uint8_t reserved_02;
    uint8_t stream_byte;        /* +0x03: 0 primary-ish, 4 secondary-ish */
    uint16_t reserved_04;
    uint16_t frame_seq;         /* +0x06 */
    uint32_t record_len;        /* +0x08: includes frame_info, excludes 16-byte header */
    uint32_t crc32;             /* +0x0c: may be 0 */
    uint8_t frame_info[0x10];   /* +0x10 */
    uint8_t payload[];          /* +0x20: H.264 for video records */
} kcp_inner_record;

typedef struct video_frame_info {
    uint8_t codec;              /* +0x00 */
    uint8_t reserved_01;
    uint8_t flags;              /* +0x02 */
    uint8_t camera_index;       /* +0x03: native stores seq per this byte */
    uint8_t online;             /* +0x04 */
    uint8_t reserved_05[0x07];
    uint32_t timestamp;         /* +0x0c */
} video_frame_info;

typedef struct rdt_video_block_record {
    uint8_t type;               /* +0x00: handle_packet routes 0x05 and 0x09 to video */
    uint8_t flags;              /* +0x01 */
    uint16_t packet_len;        /* +0x02 */
    uint16_t block_seq;         /* +0x04 */
    uint16_t base_block_seq;    /* +0x06 */
    uint8_t block_count;        /* +0x08 */
    uint8_t blocks_in_frame;    /* +0x09 */
    uint16_t frame_no;          /* +0x0a */
    uint16_t frame_id;          /* +0x0c: frame-list key in tcnone */
    uint8_t reserved_0e;
    uint8_t block_index;        /* +0x0f */
    uint32_t full_frame_len;    /* +0x10 */
    uint8_t reserved_14[0x04];
    uint8_t block_payload[];    /* +0x18: reassembled into kcp_inner_record-like frame */
} rdt_video_block_record;

typedef kcp_inner_record video_frame_record;

#pragma pack(pop)
