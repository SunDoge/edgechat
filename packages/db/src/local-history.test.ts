import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { clearRoomHistory } from "./local-history";
import { migrateLocalSchema } from "./migrations";

describe("device-local room history clear", () => {
  it("atomically advances a monotonic floor and removes only projections and repair material through it", async () => {
    const db = new PGlite(); await migrateLocalSchema(db);
    const room = "!clear-history:example.com";
    await db.query("INSERT INTO rooms VALUES ($1,'Room','direct',3,1)", [room]);
    await db.query(`INSERT INTO messages (event_id,message_id,room_id,seq,sender,device_id,event_type,created_at,ciphertext,plaintext,payload)
      VALUES ('e1','$m1:example.com',$1,1,'@alice:example.com','d','message.file',1,'c','one','{}'),
             ('e2','$m2:example.com',$1,2,'@bob:example.com','d','message.text',2,'c','two','{}'),
             ('e3','$m3:example.com',$1,3,'@bob:example.com','d','message.text',3,'c','three','{}')`, [room]);
    await db.query("INSERT INTO message_parts VALUES ('part1','$m1:example.com',0,'attachment',NULL,'attachment-clear','{}')");
    await db.query("INSERT INTO attachments (attachment_id,room_id,event_id,message_id,part_id,local_status,metadata) VALUES ('attachment-clear',$1,'e1','$m1:example.com','part1','ready','{}')", [room]);
    await db.query("INSERT INTO image_embeddings VALUES ('attachment-clear','model','v1','p1',1,$1,1)", [new Uint8Array(new Float32Array([1]).buffer)]);
    await db.query("INSERT INTO message_edits VALUES ('edit','$m1:example.com',$1,2,'@alice:example.com','edited',2)", [room]);
    await db.query("INSERT INTO message_reactions VALUES ('reaction','$m3:example.com',$1,3,'@alice:example.com','👍',3)", [room]);
    await db.query("INSERT INTO event_envelopes VALUES ('e1',$1,1,1,'{}',1),('e3',$1,3,3,'{}',3)", [room]);
    await db.query("INSERT INTO archive_keys VALUES ('segment-old',$1,$2,1,2,1),('segment-new',$1,$2,3,3,1)", [room, new Uint8Array(32)]);
    await db.query("INSERT INTO archive_segment_metadata VALUES ('segment-old',$1,1,2,10,$2,$2,1)", [room, new Uint8Array([1])]);
    await db.query("INSERT INTO segment_state VALUES ($1,1,1,3,FALSE)", [room]);
    await db.query("INSERT INTO room_preferences (room_id,manually_unread,updated_at) VALUES ($1,TRUE,1)", [room]);

    await expect(clearRoomHistory(db, room, 2, 100)).resolves.toEqual({ deleted: 2, cleared_through_seq: 2, attachment_ids: ["attachment-clear"], segment_ids: ["segment-old"] });
    expect((await db.query("SELECT seq,plaintext FROM messages ORDER BY seq")).rows).toEqual([{ seq: 3, plaintext: "three" }]);
    expect((await db.query("SELECT seq FROM event_envelopes ORDER BY seq")).rows).toEqual([{ seq: 3 }]);
    expect((await db.query("SELECT segment_id FROM archive_keys ORDER BY segment_id")).rows).toEqual([{ segment_id: "segment-new" }]);
    expect((await db.query("SELECT count(*)::int AS count FROM attachments")).rows).toEqual([{ count: 0 }]);
    expect((await db.query("SELECT count(*)::int AS count FROM image_embeddings")).rows).toEqual([{ count: 0 }]);
    expect((await db.query("SELECT count(*)::int AS count FROM message_edits")).rows).toEqual([{ count: 0 }]);
    expect((await db.query("SELECT reaction_event_id FROM message_reactions")).rows).toEqual([{ reaction_event_id: "reaction" }]);
    expect((await db.query("SELECT cleared_through_seq FROM room_local_history_floor WHERE room_id=$1", [room])).rows)
      .toEqual([{ cleared_through_seq: 2 }]);
    expect((await db.query("SELECT indexed_until_seq,oldest_local_seq,newest_local_seq,history_complete FROM segment_state WHERE room_id=$1", [room])).rows)
      .toEqual([{ indexed_until_seq: 3, oldest_local_seq: 3, newest_local_seq: 3, history_complete: true }]);
    expect((await db.query("SELECT last_read_seq FROM room_read_state WHERE room_id=$1", [room])).rows).toEqual([{ last_read_seq: 2 }]);
    expect((await db.query("SELECT manually_unread FROM room_preferences WHERE room_id=$1", [room])).rows).toEqual([{ manually_unread: false }]);
    await expect(clearRoomHistory(db, room, 1, 110)).resolves.toMatchObject({ deleted: 0, cleared_through_seq: 2 });
    expect((await db.query("SELECT cleared_through_seq FROM room_local_history_floor WHERE room_id=$1", [room])).rows)
      .toEqual([{ cleared_through_seq: 2 }]);
    await db.close();
  });
});
