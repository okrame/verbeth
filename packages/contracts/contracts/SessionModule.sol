// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISafe {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation
    ) external returns (bool success);

    function isOwner(address owner) external view returns (bool);
}

/**
 * @title SessionModule (Singleton)
 * @notice Allows session signers to execute txs on behalf of any Safe that has enabled this module.
 */
contract SessionModule {
    // safe => sessionSigner => expiry timestamp (0 = never expires, < block.timestamp = expired)
    mapping(address => mapping(address => uint256)) public sessionExpiry;

    // safe => target => allowed
    mapping(address => mapping(address => bool)) public isAllowedTarget;

    event SessionSignerSet(address indexed safe, address indexed signer, uint256 expiry);
    event TargetSet(address indexed safe, address indexed target, bool allowed);
    event Executed(address indexed safe, address indexed to, uint256 value, bool success);

    error NotOwnerOrSafe();
    error SessionExpiredOrInvalid();
    error TargetNotAllowed();
    error ExecutionFailed();

    /// @notice Authorize if caller is Safe owner or the Safe itself
    /// @dev Allowing Safe as caller enables setup during deployment via delegatecall helper
    modifier onlySafeOwnerOrSafe(address safe) {
        if (msg.sender != safe && !ISafe(safe).isOwner(msg.sender)) revert NotOwnerOrSafe();
        _;
    }

    /// @notice Check if a session signer is currently valid
    function isValidSession(
        address safe,
        address signer
    ) public view returns (bool) {
        uint256 expiry = sessionExpiry[safe][signer];
        if (expiry == 0) return false; // never set
        if (expiry == type(uint256).max) return true; // never expires
        return block.timestamp < expiry;
    }

    function setSession(
        address safe,
        address signer,
        uint256 expiry
    ) external onlySafeOwnerOrSafe(safe) {
        sessionExpiry[safe][signer] = expiry;
        emit SessionSignerSet(safe, signer, expiry);
    }

    function setTarget(
        address safe,
        address target,
        bool allowed
    ) external onlySafeOwnerOrSafe(safe) {
        isAllowedTarget[safe][target] = allowed;
        emit TargetSet(safe, target, allowed);
    }


    /// @notice set session signer AND allow target in one tx
    /// @param safe The Safe address
    /// @param signer The session signer address  
    /// @param expiry Timestamp when session expires (type(uint256).max for no expiry)
    /// @param target The target contract to allow
    function setupSession(
        address safe,
        address signer,
        uint256 expiry,
        address target
    ) external onlySafeOwnerOrSafe(safe) {
        sessionExpiry[safe][signer] = expiry;
        emit SessionSignerSet(safe, signer, expiry);
        
        isAllowedTarget[safe][target] = true;
        emit TargetSet(safe, target, true);
    }

    /// @notice Execute a transaction on behalf of the Safe (called by session signer)
    function execute(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool) {
        if (!isValidSession(safe, msg.sender)) revert SessionExpiredOrInvalid();
        if (!isAllowedTarget[safe][to]) revert TargetNotAllowed();

        bool success = ISafe(safe).execTransactionFromModule(
            to,
            value,
            data,
            operation
        );
        emit Executed(safe, to, value, success);

        if (!success) revert ExecutionFailed();
        return success;
    }
}
