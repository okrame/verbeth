use alloy::primitives::{Address, B256};
use alloy::rpc::types::Log;

use crate::db::models::{HandshakeRow, HsrRow, MessageRow};
use crate::db::queries::{
    get_and_increment_seq, insert_handshake, insert_hsr, insert_message,
};
use crate::db::DbPool;
use crate::error::{IndexerError, Result};

use super::events::{Handshake, HandshakeResponse, MessageSent};

// Payload size limits (reasonable for Verbeth protocol)
const MAX_CIPHERTEXT_SIZE: usize = 64 * 1024;       // 64 KB per message
const MAX_PUB_KEYS_SIZE: usize = 65;                // version + X25519 + Ed25519
const MAX_EPHEMERAL_KEY_SIZE: usize = 1216;         // X25519 32 + ML-KEM 1184
const MAX_PLAINTEXT_PAYLOAD_SIZE: usize = 1024;     // 1 KB metadata
const MAX_HSR_CIPHERTEXT_SIZE: usize = 4 * 1024;    // 4 KB handshake response

#[derive(Clone)]
pub enum VerbethEvent {
    MessageSent {
        sender: Address,
        ciphertext: Vec<u8>,
        timestamp: u64,
        topic: B256,
        nonce: u64,
    },
    Handshake {
        recipient_hash: B256,
        sender: Address,
        pub_keys: Vec<u8>,
        ephemeral_pub_key: Vec<u8>,
        plaintext_payload: Vec<u8>,
    },
    HandshakeResponse {
        in_response_to: B256,
        responder: Address,
        responder_ephemeral_r: B256,
        ciphertext: Vec<u8>,
    },
}

#[derive(Clone)]
pub struct LogWithMeta {
    pub event: VerbethEvent,
    pub block_number: u64,
    pub log_index: u64,
    pub block_timestamp: u64,
}

fn validate_payload_sizes(event: &VerbethEvent) -> Result<()> {
    match event {
        VerbethEvent::MessageSent { ciphertext, .. } => {
            if ciphertext.len() > MAX_CIPHERTEXT_SIZE {
                return Err(IndexerError::PayloadTooLarge {
                    field: "ciphertext",
                    size: ciphertext.len(),
                    max: MAX_CIPHERTEXT_SIZE,
                });
            }
        }
        VerbethEvent::Handshake { pub_keys, ephemeral_pub_key, plaintext_payload, .. } => {
            if pub_keys.len() > MAX_PUB_KEYS_SIZE {
                return Err(IndexerError::PayloadTooLarge {
                    field: "pubKeys",
                    size: pub_keys.len(),
                    max: MAX_PUB_KEYS_SIZE,
                });
            }
            if ephemeral_pub_key.len() > MAX_EPHEMERAL_KEY_SIZE {
                return Err(IndexerError::PayloadTooLarge {
                    field: "ephemeralPubKey",
                    size: ephemeral_pub_key.len(),
                    max: MAX_EPHEMERAL_KEY_SIZE,
                });
            }
            if plaintext_payload.len() > MAX_PLAINTEXT_PAYLOAD_SIZE {
                return Err(IndexerError::PayloadTooLarge {
                    field: "plaintextPayload",
                    size: plaintext_payload.len(),
                    max: MAX_PLAINTEXT_PAYLOAD_SIZE,
                });
            }
        }
        VerbethEvent::HandshakeResponse { ciphertext, .. } => {
            if ciphertext.len() > MAX_HSR_CIPHERTEXT_SIZE {
                return Err(IndexerError::PayloadTooLarge {
                    field: "hsrCiphertext",
                    size: ciphertext.len(),
                    max: MAX_HSR_CIPHERTEXT_SIZE,
                });
            }
        }
    }
    Ok(())
}

pub struct EventProcessor {
    pool: DbPool,
}

impl EventProcessor {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    pub fn process(&self, log: LogWithMeta) -> Result<bool> {
        // Validate payload sizes before processing
        validate_payload_sizes(&log.event)?;

        let conn = self.pool.get()?;

        match log.event {
            VerbethEvent::MessageSent {
                sender,
                ciphertext,
                timestamp,
                topic,
                nonce,
            } => {
                let topic_bytes: [u8; 32] = topic.0;
                let seq = get_and_increment_seq(&conn, "message", Some(&topic_bytes))?;

                insert_message(
                    &conn,
                    &MessageRow {
                        topic: topic_bytes,
                        seq,
                        sender: sender.0 .0,
                        ciphertext,
                        timestamp: timestamp as i64,
                        nonce: nonce as i64,
                        block_number: log.block_number as i64,
                        log_index: log.log_index as i64,
                        block_timestamp: log.block_timestamp as i64,
                    },
                )
            }
            VerbethEvent::Handshake {
                recipient_hash,
                sender,
                pub_keys,
                ephemeral_pub_key,
                plaintext_payload,
            } => {
                let recipient_hash_bytes: [u8; 32] = recipient_hash.0;
                let seq =
                    get_and_increment_seq(&conn, "handshake", Some(&recipient_hash_bytes))?;

                insert_handshake(
                    &conn,
                    &HandshakeRow {
                        recipient_hash: recipient_hash_bytes,
                        seq,
                        sender: sender.0 .0,
                        pub_keys,
                        ephemeral_pub_key,
                        plaintext_payload,
                        block_number: log.block_number as i64,
                        log_index: log.log_index as i64,
                        block_timestamp: log.block_timestamp as i64,
                    },
                )
            }
            VerbethEvent::HandshakeResponse {
                in_response_to,
                responder,
                responder_ephemeral_r,
                ciphertext,
            } => {
                let global_seq = get_and_increment_seq(&conn, "hsr", None)?;

                insert_hsr(
                    &conn,
                    &HsrRow {
                        global_seq,
                        in_response_to: in_response_to.0,
                        responder: responder.0 .0,
                        responder_ephemeral_r: responder_ephemeral_r.0,
                        ciphertext,
                        block_number: log.block_number as i64,
                        log_index: log.log_index as i64,
                        block_timestamp: log.block_timestamp as i64,
                    },
                )
            }
        }
    }
}

pub fn decode_log(log: &Log) -> Option<VerbethEvent> {
    use alloy::sol_types::SolEvent;

    let topics = log.topics();
    if topics.is_empty() {
        return None;
    }

    let sig = topics[0];

    if sig == MessageSent::SIGNATURE_HASH {
        let decoded = MessageSent::decode_log(log.inner.as_ref(), true).ok()?;
        return Some(VerbethEvent::MessageSent {
            sender: decoded.sender,
            ciphertext: decoded.ciphertext.to_vec(),
            timestamp: decoded.timestamp.try_into().ok()?,
            topic: decoded.topic,
            nonce: decoded.nonce.try_into().ok()?,
        });
    }

    if sig == Handshake::SIGNATURE_HASH {
        let decoded = Handshake::decode_log(log.inner.as_ref(), true).ok()?;
        return Some(VerbethEvent::Handshake {
            recipient_hash: decoded.recipientHash,
            sender: decoded.sender,
            pub_keys: decoded.pubKeys.to_vec(),
            ephemeral_pub_key: decoded.ephemeralPubKey.to_vec(),
            plaintext_payload: decoded.plaintextPayload.to_vec(),
        });
    }

    if sig == HandshakeResponse::SIGNATURE_HASH {
        let decoded = HandshakeResponse::decode_log(log.inner.as_ref(), true).ok()?;
        return Some(VerbethEvent::HandshakeResponse {
            in_response_to: decoded.inResponseTo,
            responder: decoded.responder,
            responder_ephemeral_r: decoded.responderEphemeralR,
            ciphertext: decoded.ciphertext.to_vec(),
        });
    }

    None
}
