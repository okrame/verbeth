// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockSafe
 * @notice Minimal mock of Safe for testing SessionModule
 * @dev Implements ISafe interface + module management
 */
contract MockSafe {
    mapping(address => bool) public isOwner;
    mapping(address => bool) public isModuleEnabled;
    
    address public lastExecTo;
    uint256 public lastExecValue;
    bytes public lastExecData;
    uint8 public lastExecOperation;
    bool public execShouldFail;
    
    constructor(address _owner) {
        isOwner[_owner] = true;
    }
    
    function addOwner(address owner) external {
        isOwner[owner] = true;
    }
    
    function enableModule(address module) external {
        isModuleEnabled[module] = true;
    }
    
    function setExecShouldFail(bool _fail) external {
        execShouldFail = _fail;
    }
    
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation
    ) external returns (bool success) {
        require(isModuleEnabled[msg.sender], "Module not enabled");
        
        lastExecTo = to;
        lastExecValue = value;
        lastExecData = data;
        lastExecOperation = operation;
        
        return !execShouldFail;
    }
}
