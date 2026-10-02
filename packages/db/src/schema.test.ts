import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import { ADVANCE_ROOM_SEQUENCE_SQL, APPLY_ROOM_PROFILE_SQL, FIRST_UNREAD_VISIBLE_MESSAGE_SQL, MARK_EVENT_PROCESSED_SQL, MESSAGES_AFTER_SQL, ROOM_ATTACHMENTS_BEFORE_SQL, ROOM_ATTACHMENTS_FIRST_PAGE_SQL, ROOM_LIST_ACTIVITIES_SQL, ROOM_UNREAD_COUNTS_SQL, SET_HIDDEN_ROOM_MEMBERS_SQL, assembleMessageWindow, assembleSignedEventRange, normalizeVector, projectEditedPayload, rankImageEmbeddings, type LocalMessage } from "./index";
import { LOCAL_CLEAR_ACCOUNT_DATA, LOCAL_PREPARE_LINKED_DEVICE_HISTORY, LOCAL_SCHEMA } from "./schema";
import { LOCAL_SCHEMA_V2, LOCAL_SCHEMA_V3, LOCAL_SCHEMA_V4, LOCAL_SCHEMA_V5, LOCAL_SCHEMA_V6 } from "./migrations";
import { purgeRoomBefore, setRoomRetention } from "./retention";
import { messageExpiryAt, purgeExpiredMessages } from "./expiry";

describe("PGlite local full-text index", () => {
  it("keeps the newest encrypted room profile by authoritative room sequence", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA); await db.exec(LOCAL_SCHEMA_V2); await db.exec(LOCAL_SCHEMA_V3); await db.exec(LOCAL_SCHEMA_V4); await db.exec(LOCAL_SCHEMA_V5); await db.exec(LOCAL_SCHEMA_V6);
    const room = "!profile:example.com";
    const avatar = { attachment_id: "avatar-0123456789", mime_type: "image/webp", plaintext_bytes: 100,
      key: "A".repeat(43), nonce: "B".repeat(16) };
    await db.query(APPLY_ROOM_PROFILE_SQL, [room, "newer", 5, "New name", JSON.stringify(avatar), "@alice:example.com", 20]);
    await db.query(APPLY_ROOM_PROFILE_SQL, [room, "older", 4, "Old name", null, "@alice:example.com", 30]);
    expect((await db.query("SELECT event_id,event_seq,name,updated_at FROM room_profiles")).rows)
      .toEqual([{ event_id: "newer", event_seq: 5, name: "New name", updated_at: 20 }]);
    expect((await db.query("SELECT avatar FROM room_profiles")).rows).toEqual([{ avatar }]);
    await db.close();
  });

  it("expires local plaintext and search projections while preserving the signed repair envelope", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!expiring:example.com";
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload,search_vector,expires_at)
      VALUES ('expired-event','$expired:example.com',$1,1,'@alice:example.com','phone','message.image',1,'opaque','searchable banana','{}',to_tsvector('simple','searchable banana'),100),
             ('live-event','$live:example.com',$1,2,'@alice:example.com','phone','message.text',2,'opaque','keep me','{}',to_tsvector('simple','keep me'),300)`, [room]);
    await db.query("INSERT INTO message_parts (part_id,message_id,position,kind,attachment_id,metadata) VALUES ('part','$expired:example.com',0,'image','attachment','{}')");
    await db.query("INSERT INTO attachments (attachment_id,room_id,event_id,message_id,part_id,mime_type,plaintext_bytes,width,height,local_status,metadata) VALUES ('attachment',$1,'expired-event','$expired:example.com','part','image/png',4,1,1,'ready','{}')", [room]);
    await db.query("INSERT INTO image_embeddings VALUES ('attachment','clip','1','1',2,$1,1)", [new Uint8Array(new Float32Array([1, 0]).buffer)]);
    await db.query("INSERT INTO message_edits VALUES ('edit','$expired:example.com',$1,3,'@alice:example.com','edited searchable',3)", [room]);
    await db.query("INSERT INTO message_reactions VALUES ('reaction','$expired:example.com',$1,4,'@bob:example.com','👍',4)", [room]);
    await db.query("INSERT INTO event_envelopes VALUES ('expired-event',$1,1,1,$2::jsonb,1)", [room, JSON.stringify({ event_id: "expired-event", ciphertext: "opaque", signature: "signed" })]);

    expect(await purgeExpiredMessages(db, 200)).toBe(1);
    expect((await db.query("SELECT message_id FROM messages ORDER BY seq")).rows).toEqual([{ message_id: "$live:example.com" }]);
    expect((await db.query("SELECT message_id FROM expired_messages")).rows).toEqual([{ message_id: "$expired:example.com" }]);
    for (const table of ["message_parts", "attachments", "image_embeddings", "message_edits", "message_reactions"]) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows, table).toHaveLength(0);
    }
    expect((await db.query("SELECT event_json FROM event_envelopes")).rows).toHaveLength(1);
    expect((await db.query("SELECT message_id FROM messages WHERE search_vector @@ plainto_tsquery('simple','banana')")).rows).toHaveLength(0);
    await db.close();
  });

  it("anchors expiry to the server acceptance receipt when one is present", () => {
    expect(messageExpiryAt({ created_at: 1_000, acceptance_receipt: { accepted_at: 5_000 } } as RoomEvent, 3_600)).toBe(3_605_000);
    expect(messageExpiryAt({ created_at: 1_000 } as RoomEvent, 3_600)).toBe(3_601_000);
  });

  it("keeps exact signed event envelopes and only exposes complete contiguous ranges", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!repairable:example.com" as RoomId;
    const makeEvent = (seq: number): RoomEvent => ({
      event_id: `event-${seq}` as RoomEvent["event_id"], room_id: room, seq,
      sender: "@alice:example.com" as RoomEvent["sender"], device_id: "phone",
      type: seq === 2 ? "control.key.update" : "message.text", created_at: seq * 100,
      ciphertext: `cipher-${seq}`, metadata: { mls_epoch: 1 }, signature: `signature-${seq}`,
    });
    for (const event of [makeEvent(1), makeEvent(2), makeEvent(3)]) {
      await db.query(MARK_EVENT_PROCESSED_SQL, [event.event_id, event.room_id, event.seq, event.created_at, JSON.stringify(event), 999]);
    }
    const rows = (await db.query<{ event_id: string; room_id: string; seq: number; event_json: RoomEvent }>(
      "SELECT event_id,room_id,seq,event_json FROM event_envelopes WHERE room_id = $1 ORDER BY seq", [room],
    )).rows;
    expect(assembleSignedEventRange(rows, room, 1, 3)).toEqual({ events: [makeEvent(1), makeEvent(2), makeEvent(3)], complete: true, missing_seq: null });
    expect(assembleSignedEventRange([rows[0], rows[2]], room, 1, 3)).toEqual({ events: [makeEvent(1)], complete: false, missing_seq: 2 });
    expect((await db.query("SELECT event_id FROM processed_events ORDER BY seq")).rows).toEqual([{ event_id: "event-1" }, { event_id: "event-2" }, { event_id: "event-3" }]);
    await db.close();
  });

  it("rejects a conflicting event at an already stored room sequence atomically", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!fork:example.com";
    const event = { event_id: "event-a", room_id: room, seq: 1, sender: "@alice:example.com", device_id: "phone", type: "message.text", created_at: 1, ciphertext: "a", metadata: {}, signature: "sig-a" };
    await db.query(MARK_EVENT_PROCESSED_SQL, [event.event_id, room, 1, 1, JSON.stringify(event), 1]);
    const fork = { ...event, event_id: "event-b", ciphertext: "b", signature: "sig-b" };
    await expect(db.query(MARK_EVENT_PROCESSED_SQL, [fork.event_id, room, 1, 1, JSON.stringify(fork), 2])).rejects.toThrow();
    expect((await db.query("SELECT event_id FROM event_envelopes")).rows).toEqual([{ event_id: "event-a" }]);
    expect((await db.query("SELECT event_id FROM processed_events")).rows).toEqual([{ event_id: "event-a" }]);
    await db.close();
  });

  it("advances room progress only across a contiguous processed prefix after the device baseline", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!ordered:example.com";
    await db.query("INSERT INTO room_sync_state VALUES ($1,5,5,1)", [room]);
    const event = (seq: number) => ({ event_id: `event-${seq}`, room_id: room, seq, sender: "@alice:example.com", device_id: "phone", type: "message.text", created_at: seq, ciphertext: `cipher-${seq}`, metadata: {}, signature: `sig-${seq}` });
    for (const seq of [7, 6, 9]) {
      const value = event(seq);
      await db.query(MARK_EVENT_PROCESSED_SQL, [value.event_id, room, seq, seq, JSON.stringify(value), seq]);
      await db.query(ADVANCE_ROOM_SEQUENCE_SQL, [room, seq]);
      const state = (await db.query<{ processed_through_seq: number }>("SELECT processed_through_seq FROM room_sync_state WHERE room_id = $1", [room])).rows[0];
      expect(Number(state.processed_through_seq)).toBe(seq === 7 ? 5 : 7);
    }
    const value = event(8);
    await db.query(MARK_EVENT_PROCESSED_SQL, [value.event_id, room, 8, 8, JSON.stringify(value), 8]);
    await db.query(ADVANCE_ROOM_SEQUENCE_SQL, [room, 8]);
    expect((await db.query("SELECT processed_through_seq FROM room_sync_state WHERE room_id = $1", [room])).rows).toEqual([{ processed_through_seq: 9 }]);
    await db.close();
  });

  it("keeps deferred ciphertext outside the processed sequence ledger", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!deferred:example.com";
    const event = { event_id: "event-3", room_id: room, seq: 3, sender: "@alice:example.com", device_id: "phone", type: "message.text", created_at: 3, ciphertext: "cipher-3", metadata: {}, signature: "sig-3" };
    await db.query("INSERT INTO room_sync_state VALUES ($1,0,0,1)", [room]);
    await db.query("INSERT INTO deferred_room_events VALUES ($1,$2,$3,$4::jsonb,5)", [event.event_id, room, event.seq, JSON.stringify(event)]);
    await db.query(ADVANCE_ROOM_SEQUENCE_SQL, [room, 6]);
    expect((await db.query("SELECT processed_through_seq FROM room_sync_state WHERE room_id = $1", [room])).rows).toEqual([{ processed_through_seq: 0 }]);
    expect((await db.query("SELECT event_id,seq FROM deferred_room_events WHERE room_id = $1", [room])).rows).toEqual([{ event_id: "event-3", seq: 3 }]);
    expect((await db.query("SELECT * FROM processed_events")).rows).toHaveLength(0);
    await db.close();
  });

  it("round-trips a compressed physical snapshot for atomic restore staging", async () => {
    const source = new PGlite();
    await source.exec(LOCAL_SCHEMA);
    await source.query("INSERT INTO account_state VALUES (1,'@backup:example.com','Backup',1)");
    await source.query("INSERT INTO users VALUES ('@backup:example.com','Backup',1)");
    await source.query("INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload,search_vector) VALUES ('event','$message:example.com','!room:example.com',1,'@backup:example.com','device','message.text',1,'cipher','recoverable words','{}',to_tsvector('simple','recoverable words'))");
    const snapshot = await source.dumpDataDir("gzip");
    await source.close();

    const restored = new PGlite({ loadDataDir: snapshot });
    await restored.waitReady;
    expect((await restored.query<{ user_id: string }>("SELECT user_id FROM users")).rows).toEqual([{ user_id: "@backup:example.com" }]);
    expect((await restored.query<{ user_id: string }>("SELECT user_id FROM account_state WHERE id = 1")).rows).toEqual([{ user_id: "@backup:example.com" }]);
    expect((await restored.query<{ plaintext: string }>("SELECT plaintext FROM messages WHERE search_vector @@ plainto_tsquery('simple','recoverable')")).rows).toEqual([{ plaintext: "recoverable words" }]);
    await restored.close();
  });

  it("keeps searchable history and archive keys but strips source-device queues from a linked-device snapshot", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA); await db.exec(LOCAL_SCHEMA_V2); await db.exec(LOCAL_SCHEMA_V3); await db.exec(LOCAL_SCHEMA_V4); await db.exec(LOCAL_SCHEMA_V5); await db.exec(LOCAL_SCHEMA_V6);
    await db.query("INSERT INTO account_state VALUES (1,'@linked:example.com','Linked',1)");
    await db.query("INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload,search_vector) VALUES ('event','$message:example.com','!room:example.com',1,'@linked:example.com','old-device','message.text',1,'cipher','kept history','{}',to_tsvector('simple','kept history'))");
    await db.query("INSERT INTO archive_keys VALUES ('segment','!room:example.com',$1,1,10,1)", [new Uint8Array(32)]);
    await db.query("INSERT INTO archive_segment_metadata VALUES ('segment','!room:example.com',1,10,100,$1,$2,1)", [new Uint8Array([1]), new Uint8Array([2])]);
    await db.query("INSERT INTO event_envelopes VALUES ('signed-event','!room:example.com',1,1,$1::jsonb,1)", [JSON.stringify({ event_id: "signed-event", room_id: "!room:example.com", seq: 1 })]);
    await db.query("INSERT INTO room_sync_state VALUES ('!room:example.com',0,1,1)");
    await db.query("INSERT INTO deferred_room_events VALUES ('deferred-event','!room:example.com',2,$1::jsonb,1)", [JSON.stringify({ event_id: "deferred-event", room_id: "!room:example.com", seq: 2 })]);
    await db.query("INSERT INTO decrypted_event_staging VALUES ('staged-event','!room:example.com',2,$1::jsonb,$2,$3,$4,1)", [JSON.stringify({ event_id: "staged-event", room_id: "!room:example.com", seq: 2 }), new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    await db.query("INSERT INTO crypto_state VALUES ('!room:example.com',1,$1,'openmls',1)", [new Uint8Array([1])]);
    await db.query("INSERT INTO room_preferences (room_id,pinned_at,archived_at,muted_until,local_retention_days,updated_at) VALUES ('!room:example.com',1,NULL,NULL,NULL,1)");
    await db.query("INSERT INTO device_preferences (id,link_previews,share_presence,updated_at) VALUES (1,FALSE,TRUE,1)");
    await db.query("INSERT INTO composer_drafts (room_id,text_content,mode,target_message_id,updated_at) VALUES ('!room:example.com','not for the new device','message',NULL,1)");
    await db.query("INSERT INTO cached_session VALUES (1,$1::jsonb,1)", [JSON.stringify({ user_id: "@linked:example.com", device_id: "old-device" })]);
    await db.query("INSERT INTO room_snapshots VALUES ('!room:example.com',$1::jsonb,1)", [JSON.stringify({ room_id: "!room:example.com" })]);
    await db.query("INSERT INTO compaction_jobs VALUES ('!room:example.com','segment','lease',1,10,99,'building',NULL,1)");
    await db.query("INSERT INTO device_verifications VALUES ('@bob:example.com','bob-phone','AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111',1)");
    await db.query("INSERT INTO room_profiles VALUES ('!room:example.com','profile-event',4,'Weekend plans','@alice:example.com',1,NULL)");
    await db.query(`INSERT INTO room_membership_outbox (room_id,operation,target_user_id,target_device_ids,event_json,mls_claim_ids,previous_mls_state,mls_state,created_at,updated_at)
      VALUES ('!room:example.com','remove','@bob:example.com','["bob-phone"]','{"event_id":"membership"}','[]',$1,$2,1,1)`, [new Uint8Array([1]), new Uint8Array([2])]);
    await db.exec(LOCAL_PREPARE_LINKED_DEVICE_HISTORY);
    expect((await db.query("SELECT event_id FROM messages")).rows).toEqual([{ event_id: "event" }]);
    expect((await db.query("SELECT segment_id FROM archive_keys")).rows).toEqual([{ segment_id: "segment" }]);
    expect((await db.query("SELECT segment_id FROM archive_segment_metadata")).rows).toEqual([{ segment_id: "segment" }]);
    expect((await db.query("SELECT event_id FROM event_envelopes")).rows).toEqual([{ event_id: "signed-event" }]);
    expect((await db.query("SELECT * FROM crypto_state")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_sync_state")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM deferred_room_events")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM decrypted_event_staging")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_preferences")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM device_preferences")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM composer_drafts")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM compaction_jobs")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM cached_session")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_snapshots")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_membership_outbox")).rows).toHaveLength(0);
    expect((await db.query("SELECT user_id,device_id,fingerprint FROM device_verifications")).rows).toEqual([{ user_id: "@bob:example.com", device_id: "bob-phone", fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111" }]);
    expect((await db.query("SELECT name FROM room_profiles")).rows).toEqual([{ name: "Weekend plans" }]);
    await db.close();
  });

  it("finds only locally decrypted plaintext", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    await db.query(
      `INSERT INTO messages (event_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, search_vector)
       VALUES ($1,$2,1,$3,'d','message.text',1,'cipher',$4,'{}',to_tsvector('simple',$4))`,
      ["event", "!0123456789abcdef:example.com", "@alice:example.com", "edge searchable phrase"],
    );
    const result = await db.query<{ event_id: string }>("SELECT event_id FROM messages WHERE search_vector @@ plainto_tsquery('simple', $1)", ["searchable"]);
    expect(result.rows[0].event_id).toBe("event");
    await db.close();
  });

  it("keeps hidden group messages locally while excluding them from timeline, unread, text, and image search", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!hidden-group:example.com";
    await db.query("INSERT INTO rooms (room_id,name,kind,current_seq,updated_at) VALUES ($1,'Group','group',2,1)", [room]);
    await db.query("INSERT INTO room_read_state VALUES ($1,0,0,1)", [room]);
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload,search_vector)
      VALUES ('alice-event','$alice:example.com',$1,1,'@alice:example.com','a','message.text',1,'cipher','visible apricot','{}',to_tsvector('simple','visible apricot')),
             ('bob-event','$bob:example.com',$1,2,'@bob:example.com','b','message.image',2,'cipher','hidden banana','{}',to_tsvector('simple','hidden banana'))`, [room]);
    await db.query("INSERT INTO attachments (attachment_id,room_id,event_id,message_id,part_id,mime_type,plaintext_bytes,width,height,local_status,metadata) VALUES ('image-bob',$1,'bob-event','$bob:example.com','part','image/png',1,1,1,'ready',$2::jsonb)", [room, JSON.stringify({ name: "banana.png" })]);
    await db.query("INSERT INTO image_embeddings VALUES ('image-bob','clip','1','1',2,$1,1)", [new Uint8Array(new Float32Array([1, 0]).buffer)]);
    await db.query(SET_HIDDEN_ROOM_MEMBERS_SQL, [room, JSON.stringify(["@bob:example.com"]), 1]);

    const visible = (await db.query<{ message_id: string }>(`SELECT message_id FROM messages m WHERE room_id = $1
      AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender) ORDER BY seq`, [room])).rows;
    expect(visible).toEqual([{ message_id: "$alice:example.com" }]);
    const text = (await db.query(`SELECT message_id FROM messages m WHERE search_vector @@ plainto_tsquery('simple','banana')
      AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)`)).rows;
    expect(text).toHaveLength(0);
    const unread = (await db.query<{ count: number }>(`SELECT count(m.event_id)::int AS count FROM messages m WHERE m.room_id = $1 AND m.sender <> '@me:example.com'
      AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)`, [room])).rows[0];
    expect(unread).toEqual({ count: 1 });
    const images = (await db.query(`SELECT a.attachment_id FROM image_embeddings e JOIN attachments a ON a.attachment_id = e.attachment_id JOIN messages m ON m.message_id = a.message_id
      WHERE NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)`)).rows;
    expect(images).toHaveLength(0);

    await db.query(SET_HIDDEN_ROOM_MEMBERS_SQL, [room, JSON.stringify([]), 2]);
    expect((await db.query("SELECT message_id FROM messages WHERE room_id = $1 ORDER BY seq", [room])).rows).toEqual([{ message_id: "$alice:example.com" }, { message_id: "$bob:example.com" }]);
    await db.close();
  });

  it("persists one local composer draft per room and keeps it out of message search", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!draft-room-00001:example.com";
    await db.query("INSERT INTO composer_drafts (room_id,text_content,mode,target_message_id,updated_at) VALUES ($1,$2,'reply',$3,10)", [room, "unfinished searchable thought", "$target:example.com"]);
    await db.query("INSERT INTO composer_drafts (room_id,text_content,mode,target_message_id,updated_at) VALUES ($1,$2,'message',NULL,20) ON CONFLICT (room_id) DO UPDATE SET text_content = EXCLUDED.text_content, mode = EXCLUDED.mode, target_message_id = EXCLUDED.target_message_id, updated_at = EXCLUDED.updated_at", [room, "newer local text"]);
    expect((await db.query("SELECT text_content,mode,target_message_id,updated_at FROM composer_drafts WHERE room_id = $1", [room])).rows[0]).toEqual({ text_content: "newer local text", mode: "message", target_message_id: null, updated_at: 20 });
    expect((await db.query("SELECT event_id FROM messages WHERE search_vector @@ plainto_tsquery('simple','local')")).rows).toHaveLength(0);
    await db.close();
  });

  it("queues encrypted cross-device draft work and rejects stale remote projections", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!draft-sync-room1:example.com" as RoomId;
    const local = { room_id: room, text_content: "new local", mode: "message" as const, target_message_id: null, quote_text: null, updated_at: 20 };
    await db.query("INSERT INTO composer_drafts (room_id,text_content,mode,target_message_id,quote_text,updated_at) VALUES ($1,$2,$3,$4,$5,$6)", [room, local.text_content, local.mode, null, null, local.updated_at]);
    await db.query("INSERT INTO composer_draft_outbox (room_id,draft_json,client_updated_at) VALUES ($1,$2::jsonb,$3)", [room, JSON.stringify(local), 20]);
    await db.query("UPDATE composer_draft_outbox SET attempts = attempts + 1, next_attempt_at = 30, last_error = 'offline' WHERE room_id = $1", [room]);
    expect((await db.query("SELECT draft_json,client_updated_at,attempts,next_attempt_at,last_error FROM composer_draft_outbox WHERE room_id = $1", [room])).rows[0]).toMatchObject({ draft_json: local, client_updated_at: 20, attempts: 1, next_attempt_at: 30, last_error: "offline" });
    await db.query("INSERT INTO composer_draft_sync_state (room_id,server_updated_at) VALUES ($1,2) ON CONFLICT (room_id) DO UPDATE SET server_updated_at = GREATEST(composer_draft_sync_state.server_updated_at, EXCLUDED.server_updated_at)", [room]);
    await db.query("INSERT INTO composer_draft_sync_state (room_id,server_updated_at) VALUES ($1,1) ON CONFLICT (room_id) DO UPDATE SET server_updated_at = GREATEST(composer_draft_sync_state.server_updated_at, EXCLUDED.server_updated_at)", [room]);
    expect((await db.query("SELECT server_updated_at FROM composer_draft_sync_state WHERE room_id = $1", [room])).rows[0]).toEqual({ server_updated_at: 2 });
    await db.close();
  });

  it("upgrades existing composer drafts to preserve encrypted quote composition", async () => {
    const db = new PGlite();
    await db.exec(`CREATE TABLE composer_drafts (
      room_id TEXT PRIMARY KEY,
      text_content TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('message', 'reply', 'edit')),
      target_message_id TEXT,
      updated_at BIGINT NOT NULL
    )`);
    await db.exec(LOCAL_SCHEMA);
    await db.query(
      "INSERT INTO composer_drafts (room_id,text_content,mode,target_message_id,quote_text,updated_at) VALUES ($1,$2,'quote',$3,$4,1)",
      ["!quote-draft:example.com", "my response", "$quoted:example.com", "quoted words"],
    );
    expect((await db.query("SELECT mode,target_message_id,quote_text FROM composer_drafts")).rows).toEqual([{ mode: "quote", target_message_id: "$quoted:example.com", quote_text: "quoted words" }]);
    await db.close();
  });

  it("pages older local history by room sequence without a remote object read", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!paged-history:example.com";
    for (let seq = 1; seq <= 250; seq += 1) {
      await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload)
        VALUES ($1,$2,$3,$4,'@alice:example.com','d','message.text',$4,'cipher',$5,'{}')`, [`event-${seq}`, `$message-${seq}:example.com`, room, seq, `message ${seq}`]);
    }
    const latest = await db.query<{ seq: number }>("SELECT seq FROM messages WHERE room_id = $1 ORDER BY seq DESC LIMIT 200", [room]);
    expect(latest.rows).toHaveLength(200);
    expect(Number(latest.rows.at(-1)?.seq)).toBe(51);
    const older = await db.query<{ seq: number }>("SELECT seq FROM messages WHERE room_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 100", [room, 51]);
    expect(older.rows).toHaveLength(50);
    expect(older.rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: 50 }, (_, index) => 50 - index));
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload)
      VALUES ('event-hidden','$message-hidden:example.com',$1,251,'@hidden:example.com','d','message.text',251,'cipher','hidden','{}')`, [room]);
    await db.query("INSERT INTO room_hidden_senders VALUES ($1,'@hidden:example.com',251)", [room]);
    const ascending = await db.query<{ seq: number }>(MESSAGES_AFTER_SQL, [room, 248, 10]);
    expect(ascending.rows.map((row) => Number(row.seq))).toEqual([249, 250]);
    await db.close();
  });

  it("assembles a bounded, ordered window around an arbitrary local search result", () => {
    const message = (seq: number) => ({ seq, message_id: `$message-${seq}:example.com` }) as LocalMessage;
    const window = assembleMessageWindow([message(50), message(49), message(48), message(47)], [message(51), message(52), message(53)], 2, 2);
    expect(window.messages.map((row) => row.seq)).toEqual([48, 49, 50, 51, 52]);
    expect(window.hasOlder).toBe(true);
    expect(window.hasNewer).toBe(true);
  });

  it("persists archive keys and recoverable compaction jobs", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    const key = crypto.getRandomValues(new Uint8Array(32));
    await db.query("INSERT INTO archive_keys VALUES ($1,$2,$3,1,100,$4)", ["segment", "!0123456789abcdef:example.com", key, Date.now()]);
    await db.query("INSERT INTO compaction_jobs VALUES ($1,$2,$3,1,100,$4,'building',NULL,$5)", ["!0123456789abcdef:example.com", "segment", "lease", Date.now() + 60_000, Date.now()]);
    const keyResult = await db.query<{ segment_key: Uint8Array }>("SELECT segment_key FROM archive_keys WHERE segment_id = 'segment'");
    const jobResult = await db.query<{ status: string }>("SELECT status FROM compaction_jobs");
    expect(Array.from(keyResult.rows[0].segment_key)).toEqual(Array.from(key));
    expect(jobResult.rows[0].status).toBe("building");
    await db.close();
  });

  it("persists the exact signed ciphertext envelope in the durable outbox", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    await db.query(
      `INSERT INTO outbox (event_id, message_id, room_id, event_json, plaintext, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('event','$message:example.com','!0123456789abcdef:example.com',$1::jsonb,'hello',$2::jsonb,'pending',0,1,1,1)`,
      [JSON.stringify({ event_id: "event", ciphertext: "one-time-ciphertext", signature: "signature" }), JSON.stringify({ version: 2, message_id: "$message:example.com" })],
    );
    const result = await db.query<{ event_json: { ciphertext: string }; status: string }>("SELECT event_json, status FROM outbox");
    expect(result.rows[0]).toMatchObject({ event_json: { ciphertext: "one-time-ciphertext" }, status: "pending" });
    await db.close();
  });

  it("persists an exact MLS device-removal commit across reloads", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    const event = { event_id: "revoke-event", room_id: "!0123456789abcdef:example.com", type: "control.device.revoke", ciphertext: "one-time-mls-commit", signature: "device-signature", metadata: { mls_epoch: 7 } };
    await db.query(
      `INSERT INTO device_revocation_outbox (revocation_id, room_id, target_device_id, event_json, previous_mls_state, mls_state, created_at, updated_at)
       VALUES ('revocation',$1,'lost-device',$2::jsonb,$3,$4,1,1)`,
      [event.room_id, JSON.stringify(event), new Uint8Array([9, 8, 7]), new Uint8Array([1, 2, 3])],
    );
    const result = await db.query<{ event_json: typeof event; previous_mls_state: Uint8Array; mls_state: Uint8Array }>("SELECT event_json, previous_mls_state, mls_state FROM device_revocation_outbox WHERE revocation_id = 'revocation'");
    expect(result.rows[0].event_json).toEqual(event);
    expect(Array.from(result.rows[0].previous_mls_state)).toEqual([9, 8, 7]);
    expect(Array.from(result.rows[0].mls_state)).toEqual([1, 2, 3]);
    await db.query(
      `INSERT INTO device_link_outbox (link_id, room_id, target_device_id, event_json, encrypted_state, previous_mls_state, mls_state, created_at, updated_at)
       VALUES ('link', '!room:example.com', 'new-device', $1::jsonb, 'welcome', $2, $3, 1, 1)`,
      [JSON.stringify(event), new Uint8Array([5]), new Uint8Array([6])],
    );
    const link = await db.query<{ encrypted_state: string; previous_mls_state: Uint8Array; mls_state: Uint8Array }>("SELECT encrypted_state, previous_mls_state, mls_state FROM device_link_outbox WHERE link_id = 'link'");
    expect(link.rows[0].encrypted_state).toBe("welcome");
    expect(Array.from(link.rows[0].previous_mls_state)).toEqual([5]);
    expect(Array.from(link.rows[0].mls_state)).toEqual([6]);
    await db.close();
  });

  it("persists an exact MLS account-removal commit across reloads", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    const event = { event_id: "account-remove-event", room_id: "!0123456789abcdef:example.com", type: "control.group.commit", ciphertext: "one-time-account-remove", signature: "device-signature", metadata: { mls_epoch: 8 } };
    await db.query(
      `INSERT INTO account_removal_outbox (deletion_id, room_id, target_user_id, target_device_ids, event_json, previous_mls_state, mls_state, created_at, updated_at)
       VALUES ('deletion',$1,'@gone:example.com',$2::jsonb,$3::jsonb,$4,$5,1,1)`,
      [event.room_id, JSON.stringify(["gone-phone", "gone-laptop"]), JSON.stringify(event), new Uint8Array([6, 5, 4]), new Uint8Array([4, 5, 6])],
    );
    const result = await db.query<{ target_device_ids: string[]; event_json: typeof event; previous_mls_state: Uint8Array; mls_state: Uint8Array }>("SELECT target_device_ids, event_json, previous_mls_state, mls_state FROM account_removal_outbox WHERE deletion_id = 'deletion'");
    expect(result.rows[0].target_device_ids).toEqual(["gone-phone", "gone-laptop"]);
    expect(result.rows[0].event_json).toEqual(event);
    expect(Array.from(result.rows[0].previous_mls_state)).toEqual([6, 5, 4]);
    expect(Array.from(result.rows[0].mls_state)).toEqual([4, 5, 6]);
    await db.close();
  });

  it("clears plaintext, crypto state, queues, and cursors for account deletion", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA); await db.exec(LOCAL_SCHEMA_V2); await db.exec(LOCAL_SCHEMA_V3); await db.exec(LOCAL_SCHEMA_V4); await db.exec(LOCAL_SCHEMA_V5); await db.exec(LOCAL_SCHEMA_V6);
    await db.query("INSERT INTO users VALUES ('@alice:example.com','Alice',1)");
    await db.query("INSERT INTO crypto_state VALUES ('!room:example.com',1,$1,'openmls',1)", [new Uint8Array([1, 2, 3])]);
    await db.query("INSERT INTO archive_segment_metadata VALUES ('segment','!room:example.com',1,10,100,$1,$2,1)", [new Uint8Array([1]), new Uint8Array([2])]);
    await db.query("INSERT INTO decrypted_event_staging VALUES ('staged-event','!room:example.com',1,$1::jsonb,$2,$3,$4,1)", [JSON.stringify({ event_id: "staged-event", room_id: "!room:example.com", seq: 1 }), new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    await db.query("INSERT INTO composer_drafts (room_id,text_content,mode,target_message_id,updated_at) VALUES ('!room:example.com','private unfinished text','message',NULL,1)");
    await db.query("INSERT INTO cached_session VALUES (1,$1::jsonb,1)", [JSON.stringify({ user_id: "@alice:example.com", device_id: "phone" })]);
    await db.query("INSERT INTO room_snapshots VALUES ('!room:example.com',$1::jsonb,1)", [JSON.stringify({ room_id: "!room:example.com" })]);
    await db.query("INSERT INTO device_verifications VALUES ('@bob:example.com','bob-phone','AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111',1)");
    await db.query("INSERT INTO device_preferences (id,link_previews,share_presence,updated_at) VALUES (1,FALSE,TRUE,1)");
    await db.query("INSERT INTO room_profiles VALUES ('!room:example.com','profile-event',4,'Weekend plans','@alice:example.com',1,NULL)");
    await db.query(`INSERT INTO room_membership_outbox (room_id,operation,target_user_id,target_device_ids,event_json,mls_claim_ids,previous_mls_state,mls_state,created_at,updated_at)
      VALUES ('!room:example.com','remove','@bob:example.com','["bob-phone"]','{"event_id":"membership"}','[]',$1,$2,1,1)`, [new Uint8Array([1]), new Uint8Array([2])]);
    await db.query("UPDATE sync_state SET cursor = 99, updated_at = 99 WHERE id = 1");
    await db.exec(LOCAL_CLEAR_ACCOUNT_DATA);
    expect((await db.query("SELECT * FROM users")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM crypto_state")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM archive_segment_metadata")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM decrypted_event_staging")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM composer_drafts")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM cached_session")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_snapshots")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM device_verifications")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM device_preferences")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_membership_outbox")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM room_profiles")).rows).toHaveLength(0);
    expect((await db.query<{ cursor: number }>("SELECT cursor FROM sync_state WHERE id = 1")).rows[0]).toEqual({ cursor: 0 });
    await db.close();
  });

  it("keeps logical messages, content parts, attachments, and image vectors separate", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    await db.query(
      `INSERT INTO messages (event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload)
       VALUES ('event-2','$message:example.com','!0123456789abcdef:example.com',2,'@alice:example.com','d','message.image',2,'cipher','caption','{}')`,
    );
    await db.query("INSERT INTO attachments (attachment_id, room_id, event_id, message_id, part_id, local_status, metadata) VALUES ('a','!0123456789abcdef:example.com','event-2','$message:example.com','part','remote','{}')");
    await db.query("INSERT INTO message_parts (part_id, message_id, position, kind, attachment_id) VALUES ('part','$message:example.com',0,'image','a')");
    const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
    await db.query("INSERT INTO image_embeddings VALUES ('a','clip','v1','p1',3,$1,1)", [vector]);
    const result = await db.query<{ message_id: string; dimensions: number }>("SELECT m.message_id, e.dimensions FROM messages m JOIN attachments a USING (message_id) JOIN image_embeddings e USING (attachment_id)");
    expect(result.rows[0]).toEqual({ message_id: "$message:example.com", dimensions: 3 });
    await db.close();
  });

  it("pages room media locally while excluding withdrawn and hidden-member attachments", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!0123456789abcdef:example.com";
    for (const [seq, sender, deleted] of [[1, "@alice:example.com", false], [2, "@hidden:example.com", false], [3, "@alice:example.com", true], [4, "@alice:example.com", false], [5, "@alice:example.com", false]] as const) {
      await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,payload,deleted_at)
        VALUES ($1,$2,$3,$4,$5,'phone','message.image',$4,'cipher','{}',$6)`, [`event-${seq}`, `$message${seq}:example.com`, room, seq, sender, deleted ? seq : null]);
      const partCount = seq === 4 ? 2 : 1;
      for (let position = 0; position < partCount; position += 1) {
        const attachmentId = `attachment-${seq}-${position}`; const partId = `part-${seq}-${position}`;
        await db.query("INSERT INTO attachments (attachment_id,room_id,event_id,message_id,part_id,local_status,metadata) VALUES ($1,$2,$3,$4,$5,'remote',$6::jsonb)", [attachmentId, room, `event-${seq}`, `$message${seq}:example.com`, partId, JSON.stringify({ id: attachmentId, name: `${seq}.png`, type: "image/png", size: 10, key: "key", nonce: "nonce" })]);
        await db.query("INSERT INTO message_parts (part_id,message_id,position,kind,attachment_id) VALUES ($1,$2,$3,'image',$4)", [partId, `$message${seq}:example.com`, position, attachmentId]);
      }
    }
    await db.query("INSERT INTO room_hidden_senders VALUES ($1,'@hidden:example.com',1)", [room]);

    const first = await db.query<{ attachment_id: string; seq: number; position: number }>(ROOM_ATTACHMENTS_FIRST_PAGE_SQL, [room, 3]);
    expect(first.rows.map(({ attachment_id }) => attachment_id)).toEqual(["attachment-5-0", "attachment-4-1", "attachment-4-0"]);
    const second = await db.query<{ attachment_id: string }>(ROOM_ATTACHMENTS_BEFORE_SQL, [room, 4, 0, 3]);
    expect(second.rows.map(({ attachment_id }) => attachment_id)).toEqual(["attachment-1-0"]);
    await db.close();
  });

  it("keeps a tombstone while removing plaintext, FTS content, attachments, and image vectors", async () => {
    const db = new PGlite();
    await db.exec(LOCAL_SCHEMA);
    const room = "!0123456789abcdef:example.com";
    const message = "$message1:example.com";
    await db.query(`INSERT INTO messages (event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, search_vector)
      VALUES ('event-delete-target',$1,$2,1,'@alice:example.com','d','message.image',1,'cipher','secret words','{}',to_tsvector('simple','secret words'))`, [message, room]);
    await db.query("INSERT INTO message_parts (part_id, message_id, position, kind, attachment_id) VALUES ('part-delete',$1,0,'image','attachment-delete')", [message]);
    await db.query("INSERT INTO attachments (attachment_id, room_id, event_id, message_id, part_id, local_status, metadata) VALUES ('attachment-delete',$1,'event-delete-target',$2,'part-delete','remote','{}')", [room, message]);
    await db.query("INSERT INTO image_embeddings VALUES ('attachment-delete','clip','v1','p1',2,$1,1)", [new Uint8Array(new Float32Array([1, 0]).buffer)]);
    await db.query("INSERT INTO message_tombstones VALUES ($1,$2,'delete-event',2,'@alice:example.com',2)", [message, room]);
    await db.query("UPDATE messages SET plaintext = NULL, payload = $2::jsonb, search_vector = NULL, deleted_at = 2, deleted_by = '@alice:example.com', delete_event_id = 'delete-event' WHERE message_id = $1", [message, JSON.stringify({ version: 2, message_id: message, parts: [], deleted: true })]);
    await db.query("DELETE FROM image_embeddings WHERE attachment_id IN (SELECT attachment_id FROM attachments WHERE message_id = $1)", [message]);
    await db.query("DELETE FROM attachments WHERE message_id = $1", [message]);
    await db.query("DELETE FROM message_parts WHERE message_id = $1", [message]);
    const result = await db.query<{ plaintext: string | null; deleted_at: number; deleted: boolean; parts: number; attachments: number; vectors: number }>(
      `SELECT m.plaintext, m.deleted_at, (m.payload->>'deleted')::boolean AS deleted,
        (SELECT count(*)::int FROM message_parts WHERE message_id = $1) AS parts,
        (SELECT count(*)::int FROM attachments WHERE message_id = $1) AS attachments,
        (SELECT count(*)::int FROM image_embeddings WHERE attachment_id = 'attachment-delete') AS vectors
       FROM messages m WHERE m.message_id = $1`, [message],
    );
    expect(result.rows[0]).toEqual({ plaintext: null, deleted_at: 2, deleted: true, parts: 0, attachments: 0, vectors: 0 });
    expect((await db.query("SELECT event_id FROM messages WHERE search_vector @@ plainto_tsquery('simple','secret')")).rows).toHaveLength(0);
    await db.close();
  });

  it("projects edits without changing stable part or attachment references", async () => {
    const original = { version: 2, message_id: "$message:example.com", parts: [
      { part_id: "text-part", kind: "text", text: "before" },
      { part_id: "image-part", kind: "image", attachment: { id: "attachment" } },
    ] };
    const edited = projectEditedPayload(original, original.message_id, "after");
    expect(edited.payload).toMatchObject({ parts: [
      { part_id: "text-part", kind: "text", text: "after" },
      { part_id: "image-part", kind: "image", attachment: { id: "attachment" } },
    ] });
    expect(projectEditedPayload(original, original.message_id, "").payload).toMatchObject({ parts: [{ part_id: "image-part" }] });
    expect(projectEditedPayload({ ...original, parts: original.parts.slice(1) }, original.message_id, "new caption").payload).toMatchObject({ parts: [{ kind: "text", text: "new caption" }, { part_id: "image-part" }] });
  });

  it("reduces each sender's reaction stream to its latest choice", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!0123456789abcdef:example.com"; const message = "$message:example.com";
    await db.query("INSERT INTO message_reactions VALUES ('r1',$1,$2,1,'@alice:example.com','👍',1),('r2',$1,$2,2,'@alice:example.com','❤️',2),('r3',$1,$2,3,'@bob:example.com','❤️',3)", [message, room]);
    const result = await db.query<{ reaction: string; count: number }>(`SELECT reaction, count(*)::int AS count FROM (SELECT DISTINCT ON (target_message_id, sender) target_message_id, sender, reaction FROM message_reactions WHERE room_id = $1 ORDER BY target_message_id, sender, reaction_seq DESC) latest WHERE reaction IS NOT NULL GROUP BY reaction`, [room]);
    expect(result.rows).toEqual([{ reaction: "❤️", count: 2 }]);
    await db.close();
  });

  it("keeps unread state local and advances read and delivery receipts monotonically", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA); await db.exec(LOCAL_SCHEMA_V5); await db.exec(LOCAL_SCHEMA_V6);
    const room = "!0123456789abcdef:example.com";
    await db.query("INSERT INTO rooms VALUES ($1,'Room','direct',3,1)", [room]);
    await db.query(
      `INSERT INTO messages (event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload)
       VALUES ('m1','$message1:example.com',$1,1,'@alice:example.com','a','message.text',1,'c','own','{}'),
              ('m2','$message2:example.com',$1,2,'@bob:example.com','b','message.text',2,'c','unread','{}'),
              ('m3','$message3:example.com',$1,3,'@bob:example.com','b','message.text',3,'c',NULL,'{}')`,
      [room],
    );
    await db.query("UPDATE messages SET deleted_at = 4 WHERE event_id = 'm3'");
    await db.query("INSERT INTO room_read_state VALUES ($1,1,0,1)", [room]);
    const unread = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM messages m JOIN room_read_state s USING (room_id)
       WHERE m.room_id = $1 AND m.seq > s.last_read_seq AND m.sender <> '@alice:example.com' AND m.deleted_at IS NULL`, [room],
    );
    expect(unread.rows[0].count).toBe(1);
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload)
      VALUES ('m4','$message4:example.com',$1,4,'@carol:example.com','c','message.text',4,'c','hidden','{}')`, [room]);
    await db.query("INSERT INTO room_hidden_senders VALUES ($1,'@carol:example.com',4)", [room]);
    expect((await db.query(FIRST_UNREAD_VISIBLE_MESSAGE_SQL, [room, 1, "@alice:example.com"])).rows)
      .toEqual([{ message_id: "$message2:example.com", seq: 2 }]);
    expect((await db.query(FIRST_UNREAD_VISIBLE_MESSAGE_SQL, [room, 2, "@alice:example.com"])).rows).toEqual([]);
    await db.query("UPDATE room_read_state SET last_read_seq = 3 WHERE room_id = $1", [room]);
    await db.query("INSERT INTO room_preferences (room_id,manually_unread,updated_at) VALUES ($1,TRUE,2)", [room]);
    expect((await db.query<{ unread_count: number; last_read_seq: number }>(ROOM_UNREAD_COUNTS_SQL, ["@alice:example.com"])).rows)
      .toEqual([{ room_id: room, unread_count: 1, last_read_seq: 3 }]);
    expect((await db.query("SELECT last_receipt_sent_seq FROM room_read_state WHERE room_id = $1", [room])).rows)
      .toEqual([{ last_receipt_sent_seq: 0 }]);
    await db.query("UPDATE room_preferences SET manually_unread = FALSE WHERE room_id = $1", [room]);
    expect((await db.query<{ unread_count: number }>(ROOM_UNREAD_COUNTS_SQL, ["@alice:example.com"])).rows[0]?.unread_count).toBe(0);
    await db.query("INSERT INTO read_receipts VALUES ($1,'@bob:example.com',3,'new',3)", [room]);
    await db.query(
      `INSERT INTO read_receipts VALUES ($1,'@bob:example.com',2,'old',2)
       ON CONFLICT (room_id,user_id) DO UPDATE SET last_read_seq = GREATEST(read_receipts.last_read_seq, EXCLUDED.last_read_seq)`, [room],
    );
    const receipt = await db.query<{ last_read_seq: number }>("SELECT last_read_seq FROM read_receipts WHERE room_id = $1", [room]);
    expect(Number(receipt.rows[0].last_read_seq)).toBe(3);
    await db.query("INSERT INTO delivery_receipts VALUES ($1,'@bob:example.com',3,'delivered-new',3)", [room]);
    await db.query(
      `INSERT INTO delivery_receipts VALUES ($1,'@bob:example.com',2,'delivered-old',2)
       ON CONFLICT (room_id,user_id) DO UPDATE SET last_delivered_seq = GREATEST(delivery_receipts.last_delivered_seq, EXCLUDED.last_delivered_seq)`, [room],
    );
    const delivered = await db.query<{ last_delivered_seq: number }>("SELECT last_delivered_seq FROM delivery_receipts WHERE room_id = $1", [room]);
    expect(Number(delivered.rows[0].last_delivered_seq)).toBe(3);
    await db.close();
  });

  it("selects one visible local activity per room and lets a visible outbox message lead", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const roomA = "!aaaaaaaaaaaaaaaa:example.com"; const roomB = "!bbbbbbbbbbbbbbbb:example.com";
    await db.query(
      `INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload)
       VALUES ('a-visible','$a-visible:example.com',$1,1,'@bob:example.com','bob','message.text',10,'ciphertext','visible',$3::jsonb),
              ('a-hidden','$a-hidden:example.com',$1,2,'@mallory:example.com','mallory','message.text',20,'ciphertext','hidden',$4::jsonb),
              ('b-visible','$b-visible:example.com',$2,1,'@bob:example.com','bob','message.image',15,'ciphertext',NULL,$5::jsonb)`,
      [roomA, roomB, JSON.stringify({ version: 2, message_id: "$a-visible:example.com", parts: [] }), JSON.stringify({ version: 2, message_id: "$a-hidden:example.com", parts: [] }), JSON.stringify({ version: 2, message_id: "$b-visible:example.com", parts: [] })],
    );
    await db.query("INSERT INTO room_hidden_senders VALUES ($1,'@mallory:example.com',20)", [roomA]);
    await db.query(
      `INSERT INTO outbox (event_id,message_id,room_id,event_json,plaintext,payload,status,attempts,next_attempt_at,created_at,updated_at)
       VALUES ('a-pending','$a-pending:example.com',$1,$2::jsonb,'pending preview',$3::jsonb,'failed',1,30,30,30),
              ('a-reaction','$a-reaction:example.com',$1,$4::jsonb,'',$5::jsonb,'pending',0,40,40,40)`,
      [roomA,
        JSON.stringify({ event_id: "a-pending", sender: "@alice:example.com", type: "message.text" }), JSON.stringify({ version: 2, message_id: "$a-pending:example.com", parts: [] }),
        JSON.stringify({ event_id: "a-reaction", sender: "@alice:example.com", type: "message.reaction" }), JSON.stringify({})],
    );
    const activities = (await db.query<{ room_id: string; message_id: string; plaintext: string | null; outbox_status: string | null }>(ROOM_LIST_ACTIVITIES_SQL)).rows;
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({ room_id: roomA, message_id: "$a-pending:example.com", plaintext: "pending preview", outbox_status: "failed" });
    expect(activities[1]).toMatchObject({ room_id: roomB, message_id: "$b-visible:example.com", plaintext: null, outbox_status: null });
    await db.close();
  });

  it("stores chat organization locally and unarchives only unmuted incoming activity", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!0123456789abcdef:example.com";
    await db.query("INSERT INTO room_preferences (room_id,pinned_at,archived_at,muted_until,local_retention_days,updated_at) VALUES ($1,10,20,NULL,NULL,20)", [room]);
    const unarchived = await db.query<{ room_id: string }>("UPDATE room_preferences SET archived_at = NULL, updated_at = 30 WHERE room_id = $1 AND archived_at IS NOT NULL AND (muted_until IS NULL OR muted_until <= 30) RETURNING room_id", [room]);
    expect(unarchived.rows).toEqual([{ room_id: room }]);
    await db.query("UPDATE room_preferences SET archived_at = 40, muted_until = 100, updated_at = 40 WHERE room_id = $1", [room]);
    const stayedArchived = await db.query<{ room_id: string }>("UPDATE room_preferences SET archived_at = NULL WHERE room_id = $1 AND archived_at IS NOT NULL AND (muted_until IS NULL OR muted_until <= 50) RETURNING room_id", [room]);
    expect(stayedArchived.rows).toEqual([]);
    const preference = await db.query<{ pinned_at: number | null; archived_at: number; muted_until: number }>("SELECT pinned_at, archived_at, muted_until FROM room_preferences WHERE room_id = $1", [room]);
    expect(preference.rows[0]).toEqual({ pinned_at: 10, archived_at: 40, muted_until: 100 });
    await db.close();
  });

  it("atomically purges expired local plaintext, attachment metadata, vectors, and relations without rewinding durable sync", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!retention:example.com";
    await db.query("UPDATE sync_state SET cursor = 77, updated_at = 77 WHERE id = 1");
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload,search_vector)
      VALUES ('old-event','$old:example.com',$1,1,'@alice:example.com','d','message.image',100,'cipher','expired secret','{}',to_tsvector('simple','expired secret')),
             ('new-event','$new:example.com',$1,2,'@alice:example.com','d','message.text',300,'cipher','keep me','{}',to_tsvector('simple','keep me'))`, [room]);
    await db.query("INSERT INTO message_parts (part_id,message_id,position,kind,attachment_id) VALUES ('old-part','$old:example.com',0,'image','old-attachment')");
    await db.query("INSERT INTO attachments (attachment_id,room_id,event_id,message_id,part_id,local_status,metadata) VALUES ('old-attachment',$1,'old-event','$old:example.com','old-part','remote','{}')", [room]);
    await db.query("INSERT INTO image_embeddings VALUES ('old-attachment','clip','v1','p1',2,$1,1)", [new Uint8Array(new Float32Array([1, 0]).buffer)]);
    await db.query("INSERT INTO message_edits VALUES ('edit','$old:example.com',$1,3,'@alice:example.com','edited',150)", [room]);
    await db.query("INSERT INTO message_reactions VALUES ('reaction','$old:example.com',$1,4,'@bob:example.com','👍',150)", [room]);
    await db.query("INSERT INTO message_tombstones VALUES ('$old:example.com',$1,'delete',5,'@alice:example.com',150)", [room]);
    await db.query("INSERT INTO segment_state VALUES ($1,1,1,2,TRUE)", [room]);
    await db.query("INSERT INTO event_envelopes VALUES ('old-envelope',$1,1,100,'{}',100),('new-envelope',$1,2,300,'{}',300)", [room]);

    expect(await purgeRoomBefore(db, room, 200)).toBe(1);
    expect((await db.query<{ event_id: string }>("SELECT event_id FROM messages ORDER BY seq")).rows).toEqual([{ event_id: "new-event" }]);
    expect((await db.query<{ event_id: string }>("SELECT event_id FROM event_envelopes ORDER BY seq")).rows).toEqual([{ event_id: "new-envelope" }]);
    for (const table of ["message_parts", "attachments", "image_embeddings", "message_edits", "message_reactions"]) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows, table).toHaveLength(0);
    }
    expect((await db.query<{ target_message_id: string }>("SELECT target_message_id FROM message_tombstones")).rows).toEqual([{ target_message_id: "$old:example.com" }]);
    expect((await db.query<{ cursor: number }>("SELECT cursor FROM sync_state WHERE id = 1")).rows[0]).toEqual({ cursor: 77 });
    expect((await db.query("SELECT indexed_until_seq,oldest_local_seq,newest_local_seq,history_complete FROM segment_state WHERE room_id = $1", [room])).rows[0]).toEqual({ indexed_until_seq: 2, oldest_local_seq: 2, newest_local_seq: 2, history_complete: false });
    await db.close();
  });

  it("updates local retention and performs its first purge in one transaction without changing other room preferences", async () => {
    const db = new PGlite(); await db.exec(LOCAL_SCHEMA);
    const room = "!retention-setting:example.com";
    const now = 20 * 86_400_000;
    await db.query("INSERT INTO room_preferences (room_id,pinned_at,archived_at,muted_until,local_retention_days,updated_at) VALUES ($1,10,NULL,999,NULL,10)", [room]);
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload)
      VALUES ('expired','$expired:example.com',$1,1,'@alice:example.com','d','message.text',1,'cipher','old','{}'),
             ('current','$current:example.com',$1,2,'@alice:example.com','d','message.text',$2,'cipher','new','{}')`, [room, now]);
    expect(await setRoomRetention(db, room, 7, now)).toBe(1);
    expect((await db.query("SELECT pinned_at,muted_until,local_retention_days,updated_at FROM room_preferences WHERE room_id = $1", [room])).rows[0]).toEqual({ pinned_at: 10, muted_until: 999, local_retention_days: 7, updated_at: now });
    expect((await db.query<{ event_id: string }>("SELECT event_id FROM messages")).rows).toEqual([{ event_id: "current" }]);
    await expect(setRoomRetention(db, room, 2 as 7, now)).rejects.toThrow("Invalid local retention setting");
    expect((await db.query<{ local_retention_days: number }>("SELECT local_retention_days FROM room_preferences WHERE room_id = $1", [room])).rows[0]).toEqual({ local_retention_days: 7 });
    await db.close();
  });

  it("normalizes embeddings for cosine search", () => {
    expect(Array.from(normalizeVector(new Float32Array([3, 4])))).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(() => normalizeVector(new Float32Array([0, 0]))).toThrow();
  });

  it("ranks image vectors locally without exposing them to the server", () => {
    const bytes = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);
    const base = { message_id: "$message:example.com", room_id: "!0123456789abcdef:example.com" as const, seq: 1, sender: "@alice:example.com", created_at: 1, name: "image", dimensions: 2 };
    const results = rankImageEmbeddings([
      { ...base, attachment_id: "opposite", embedding: bytes([0, 1]) },
      { ...base, attachment_id: "match", embedding: bytes([1, 0]) },
    ], new Float32Array([2, 0]));
    expect(results.map((result) => result.attachment_id)).toEqual(["match", "opposite"]);
  });
});
