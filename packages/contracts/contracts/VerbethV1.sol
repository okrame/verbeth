// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title Verbeth
 * @dev Contract for messaging using event logs as the sole transport layer.
 * @author okrame
 */
contract VerbethV1 is Initializable, UUPSUpgradeable, OwnableUpgradeable {

    uint256 public constant UPGRADE_DELAY = 2 days;
    address public pendingImplementation;
    uint256 public upgradeEligibleAt;

    event UpgradeProposed(address indexed newImplementation, uint256 eligibleAt);
    event UpgradeCancelled(address indexed newImplementation);

    /**
     * @dev Emitted when a message is sent
     * @param sender The address of the message sender (EOA or contract)
     * @param ciphertext The message payload
     * @param timestamp Unix timestamp when the message was sent
     * @param topic Indexed channel identifier for message filtering
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
     * @param recipientHash e.g. Keccak256 hash of "contact:" + recipient's lowercase address
     * @param sender The address initiating the handshake
     * @param pubKeys The sender's long-term public keys
     * @param ephemeralPubKey Ephemeral public key(s) for this handshake
     * @param plaintextPayload Typically contains a message and identity proof
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
     * @param inResponseTo Matching tag so the initiator can find this response
     * @param responder The address responding to the handshake
     * @param responderEphemeralR Ephemeral public key used to derive the response tag
     * @param ciphertext Encrypted response payload with responder's keys
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

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
    }


    function proposeUpgrade(address newImplementation) external onlyOwner {
        require(newImplementation != address(0), "Invalid implementation");
        pendingImplementation = newImplementation;
        upgradeEligibleAt = block.timestamp + UPGRADE_DELAY;
        emit UpgradeProposed(newImplementation, upgradeEligibleAt);
    }


    function cancelUpgrade() external onlyOwner {
        require(pendingImplementation != address(0), "No pending upgrade");
        address cancelled = pendingImplementation;
        pendingImplementation = address(0);
        upgradeEligibleAt = 0;
        emit UpgradeCancelled(cancelled);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyOwner
    {
        require(newImplementation == pendingImplementation, "Not proposed implementation");
        require(block.timestamp >= upgradeEligibleAt, "Timelock not expired");
        pendingImplementation = address(0);
        upgradeEligibleAt = 0;
    }


    function sendMessage(
        bytes calldata ciphertext,
        bytes32 topic,
        uint256 timestamp,
        uint256 nonce
    ) external {
        emit MessageSent(msg.sender, ciphertext, timestamp, topic, nonce);
    }


    function initiateHandshake(
        bytes32 recipientHash,
        bytes calldata pubKeys,
        bytes calldata ephemeralPubKey,
        bytes calldata plaintextPayload
    ) external {
        emit Handshake(recipientHash, msg.sender, pubKeys, ephemeralPubKey, plaintextPayload);
    }


    function respondToHandshake(bytes32 inResponseTo, bytes32 responderEphemeralR, bytes calldata ciphertext) external {
        emit HandshakeResponse(inResponseTo, msg.sender, responderEphemeralR, ciphertext);
    }

    /**
     * @dev This empty reserved space allows future versions to add new variables
     * without shifting down storage in the inheritance chain.
     * @notice See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     * @notice Reduced from 50 to 48 to account for pendingImplementation and upgradeEligibleAt
     */
    uint256[48] private __gap;
}