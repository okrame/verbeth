pub struct MessageRow {
    pub topic: [u8; 32],
    pub seq: i64,
    pub sender: [u8; 20],
    pub ciphertext: Vec<u8>,
    pub timestamp: i64,
    pub nonce: i64,
    pub block_number: i64,
    pub log_index: i64,
    pub block_timestamp: i64,
}

pub struct HandshakeRow {
    pub recipient_hash: [u8; 32],
    pub seq: i64,
    pub sender: [u8; 20],
    pub pub_keys: Vec<u8>,
    pub ephemeral_pub_key: Vec<u8>,
    pub plaintext_payload: Vec<u8>,
    pub block_number: i64,
    pub log_index: i64,
    pub block_timestamp: i64,
}

pub struct HsrRow {
    pub global_seq: i64,
    pub in_response_to: [u8; 32],
    pub responder: [u8; 20],
    pub responder_ephemeral_r: [u8; 32],
    pub ciphertext: Vec<u8>,
    pub block_number: i64,
    pub log_index: i64,
    pub block_timestamp: i64,
}

pub struct EventCounts {
    pub messages: i64,
    pub handshakes: i64,
    pub handshake_responses: i64,
}
