use alloy::sol;

sol! {
    event MessageSent(
        address indexed sender,
        bytes ciphertext,
        uint256 timestamp,
        bytes32 indexed topic,
        uint256 nonce
    );

    event Handshake(
        bytes32 indexed recipientHash,
        address indexed sender,
        bytes pubKeys,
        bytes ephemeralPubKey,
        bytes plaintextPayload
    );

    event HandshakeResponse(
        bytes32 indexed inResponseTo,
        address indexed responder,
        bytes32 responderEphemeralR,
        bytes ciphertext
    );
}
