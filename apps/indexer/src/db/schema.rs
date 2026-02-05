use rusqlite::Connection;

use crate::error::Result;

const SCHEMA_VERSION: i64 = 1;

pub fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_version VALUES (1);

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic BLOB NOT NULL,
            seq INTEGER NOT NULL,
            sender BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            timestamp INTEGER NOT NULL,
            nonce INTEGER NOT NULL,
            block_number INTEGER NOT NULL,
            log_index INTEGER NOT NULL,
            block_timestamp INTEGER NOT NULL,
            UNIQUE(topic, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_msg_topic_seq ON messages(topic, seq);
        CREATE INDEX IF NOT EXISTS idx_msg_block ON messages(block_number, log_index);

        CREATE TABLE IF NOT EXISTS handshakes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipient_hash BLOB NOT NULL,
            seq INTEGER NOT NULL,
            sender BLOB NOT NULL,
            pub_keys BLOB NOT NULL,
            ephemeral_pub_key BLOB NOT NULL,
            plaintext_payload BLOB NOT NULL,
            block_number INTEGER NOT NULL,
            log_index INTEGER NOT NULL,
            block_timestamp INTEGER NOT NULL,
            UNIQUE(recipient_hash, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_hs_recipient_seq ON handshakes(recipient_hash, seq);

        CREATE TABLE IF NOT EXISTS handshake_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            global_seq INTEGER NOT NULL UNIQUE,
            in_response_to BLOB NOT NULL,
            responder BLOB NOT NULL,
            responder_ephemeral_r BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            block_number INTEGER NOT NULL,
            log_index INTEGER NOT NULL,
            block_timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hsr_seq ON handshake_responses(global_seq);

        CREATE TABLE IF NOT EXISTS seq_counters (
            key_type TEXT NOT NULL,
            key_hash BLOB,
            next_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(key_type, key_hash)
        );

        CREATE TABLE IF NOT EXISTS indexer_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;

    let version: i64 = conn.query_row(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
        [],
        |row| row.get(0),
    )?;

    tracing::info!(schema_version = version, "Database initialized");
    assert_eq!(version, SCHEMA_VERSION, "Schema version mismatch");

    Ok(())
}
