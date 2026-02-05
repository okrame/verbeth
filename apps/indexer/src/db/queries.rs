use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;

use super::models::{EventCounts, HandshakeRow, HsrRow, MessageRow};

pub fn get_and_increment_seq(
    conn: &Connection,
    key_type: &str,
    key_hash: Option<&[u8; 32]>,
) -> Result<i64> {
    let seq: i64 = conn
        .query_row(
            "SELECT next_seq FROM seq_counters WHERE key_type = ?1 AND key_hash IS ?2",
            params![key_type, key_hash.map(|h| h.as_slice())],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO seq_counters (key_type, key_hash, next_seq) VALUES (?1, ?2, ?3)
         ON CONFLICT(key_type, key_hash) DO UPDATE SET next_seq = ?3",
        params![key_type, key_hash.map(|h| h.as_slice()), seq + 1],
    )?;

    Ok(seq)
}

pub fn insert_message(conn: &Connection, row: &MessageRow) -> Result<bool> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO messages
         (topic, seq, sender, ciphertext, timestamp, nonce, block_number, log_index, block_timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            row.topic.as_slice(),
            row.seq,
            row.sender.as_slice(),
            &row.ciphertext,
            row.timestamp,
            row.nonce,
            row.block_number,
            row.log_index,
            row.block_timestamp,
        ],
    )?;
    Ok(inserted > 0)
}

pub fn insert_handshake(conn: &Connection, row: &HandshakeRow) -> Result<bool> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO handshakes
         (recipient_hash, seq, sender, pub_keys, ephemeral_pub_key, plaintext_payload, block_number, log_index, block_timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            row.recipient_hash.as_slice(),
            row.seq,
            row.sender.as_slice(),
            &row.pub_keys,
            &row.ephemeral_pub_key,
            &row.plaintext_payload,
            row.block_number,
            row.log_index,
            row.block_timestamp,
        ],
    )?;
    Ok(inserted > 0)
}

pub fn insert_hsr(conn: &Connection, row: &HsrRow) -> Result<bool> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO handshake_responses
         (global_seq, in_response_to, responder, responder_ephemeral_r, ciphertext, block_number, log_index, block_timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            row.global_seq,
            row.in_response_to.as_slice(),
            row.responder.as_slice(),
            row.responder_ephemeral_r.as_slice(),
            &row.ciphertext,
            row.block_number,
            row.log_index,
            row.block_timestamp,
        ],
    )?;
    Ok(inserted > 0)
}

pub fn get_last_processed_block(conn: &Connection) -> Result<Option<i64>> {
    let value = conn
        .query_row(
            "SELECT value FROM indexer_state WHERE key = 'last_block'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.parse::<i64>().ok());

    Ok(value)
}

pub fn set_last_processed_block(conn: &Connection, block: i64) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO indexer_state (key, value) VALUES ('last_block', ?1)",
        params![block.to_string()],
    )?;
    Ok(())
}

pub fn get_event_counts(conn: &Connection) -> Result<EventCounts> {
    let messages: i64 =
        conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
    let handshakes: i64 =
        conn.query_row("SELECT COUNT(*) FROM handshakes", [], |row| row.get(0))?;
    let handshake_responses: i64 =
        conn.query_row("SELECT COUNT(*) FROM handshake_responses", [], |row| row.get(0))?;

    Ok(EventCounts {
        messages,
        handshakes,
        handshake_responses,
    })
}

pub fn is_db_empty(conn: &Connection) -> Result<bool> {
    let counts = get_event_counts(conn)?;
    Ok(counts.messages == 0 && counts.handshakes == 0 && counts.handshake_responses == 0)
}
