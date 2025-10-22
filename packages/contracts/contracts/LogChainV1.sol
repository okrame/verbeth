// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title LogChainV1
 * @dev Contract for end-to-end encrypted messaging using Ethereum event logs as the sole transport layer.
 * @author guefett0
 * @notice This contract enables secure, decentralized messaging without relying on off-chain infrastructure.
 */
contract LogChainV1 is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    
    /**
     * @dev Emitted when an encrypted message is sent
     * @param sender The address of the message sender (EOA or smart account)
     * @param ciphertext The encrypted message payload
     * @param timestamp Unix timestamp when the message was sent
     * @param topic Indexed topic/channel identifier for message filtering
     * @param nonce Sequential number for message ordering and deduplication
     */
    event MessageSent(
        address indexed sender,
        bytes ciphertext,
        uint256 timestamp,
        bytes32 indexed topic,
        uint256 nonce
    );

    /**
     * @dev Emitted when initiating a handshake with a recipient
     * @param recipientHash Keccak256 hash of "contact:" + recipient's lowercase address
     * @param sender The address initiating the handshake
     * @param pubKeys The sender's long-term singing and identity pubkeys (32 bytes each)
     * @param ephemeralPubKey Fresh public key generated for this specific handshake
     * @param plaintextPayload Human-readable message or JSON with optional identity proof
     */
    event Handshake(
        bytes32 indexed recipientHash,
        address indexed sender,
        bytes pubKeys,
        bytes ephemeralPubKey,
        bytes plaintextPayload
    );

    /**
     * @dev Emitted when responding to a handshake
     * @param inResponseTo Response tag derived from ECDH(viewPubA, R) and HKDF.
     * @param responder The address responding to the handshake
     * @param responderEphemeralR Ephemeral public key R used to generate the response tag.
     * @param ciphertext Encrypted response containing responder's public keys
     */
    event HandshakeResponse(
        bytes32 indexed inResponseTo,
        address indexed responder,
        bytes32 responderEphemeralR, 
        bytes ciphertext
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initializes the contract using the proxy pattern
     * @notice Should be called immediately after deployment via proxy
     */
    function initialize() public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
    }

    /**
     * @dev Authorizes contract upgrades (restricted to owner)
     * @param newImplementation Address of the new implementation contract
     */
    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        onlyOwner 
    {}

    /**
     * @dev Sends an encrypted message to a recipient
     * @param ciphertext The encrypted message payload (JSON-encoded EncryptedPayload)
     * @param topic Channel or conversation identifier for message filtering
     * @param timestamp Unix timestamp when the message was created
     * @param nonce Sequential number for message ordering (not enforced on-chain)
     * 
     * @notice Gas cost scales with message size. Consider message splitting for large payloads.
     * @notice Nonce values are not validated on-chain - clients should handle replay protection.
     */
    function sendMessage(
        bytes calldata ciphertext,
        bytes32 topic,
        uint256 timestamp,
        uint256 nonce
    ) external {
        emit MessageSent(msg.sender, ciphertext, timestamp, topic, nonce);
    }

    /**
     * @dev Initiates a secure handshake with a recipient
     * @param recipientHash Keccak256("contact:" + recipient.toLowerCase())
     * @param pubKeys Sender's long-term X25519 public key (32 bytes)
     * @param ephemeralPubKey Fresh X25519 public key for this handshake (32 bytes)
     * @param plaintextPayload Human-readable greeting or JSON with identity proof
     * 
     * @notice Recipients monitor for events where recipientHash matches their address hash
     * @notice For smart accounts, plaintextPayload may include EIP-1271 signature proof
     */
    function initiateHandshake(
        bytes32 recipientHash,
        bytes calldata pubKeys,
        bytes calldata ephemeralPubKey,
        bytes calldata plaintextPayload
    ) external {
        emit Handshake(recipientHash, msg.sender, pubKeys, ephemeralPubKey, plaintextPayload);
    }

    /**
     * @dev Responds to a handshake with encrypted public keys
     * @param inResponseTo Reference tag for the handshake initiator
     * @param responderEphemeralR Ephemeral public key R used to generate the response tag.
     * @param ciphertext Encrypted payload containing responder's identity and ephemeral keys
     * 
     * @notice The ciphertext should be encrypted to the initiator's ephemeral public key
     */
    function respondToHandshake(bytes32 inResponseTo, bytes32 responderEphemeralR, bytes calldata ciphertext) external {
        emit HandshakeResponse(inResponseTo, msg.sender, responderEphemeralR, ciphertext);
    }

    /**
     * @dev This empty reserved space allows future versions to add new variables
     * without shifting down storage in the inheritance chain.
     * @notice See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[50] private __gap;
}