// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISessionModule {
    function setupSession(
        address safe,
        address signer,
        uint256 expiry,
        address target
    ) external;
}

contract ModuleSetupHelper {
    /**
     * @notice Enable a single module during Safe setup
     * @param module The module address to enable
     */
    function enableModule(address module) external {
        (bool success, bytes memory returnData) = address(this).call(
            abi.encodeWithSignature("enableModule(address)", module)
        );
        require(success, string(abi.encodePacked("Enable module failed: ", returnData)));
    }

    /**
     * @notice Enable module and setup session in one delegatecall
     * @param module The SessionModule address
     * @param sessionSigner The session signer address to authorize
     * @param expiry Session expiry timestamp (type(uint256).max for no expiry)
     * @param target The target contract to allow calls to
     * @dev This is called via delegatecall from Safe.setup()
     *      - address(this) = Safe
     *      - First call enables module on the Safe (internal call)
     *      - Second call configures session on the module (external call, msg.sender = Safe)
     */
    function enableModuleWithSession(
        address module,
        address sessionSigner,
        uint256 expiry,
        address target
    ) external {
        (bool enableSuccess, bytes memory enableData) = address(this).call(
            abi.encodeWithSignature("enableModule(address)", module)
        );
        require(enableSuccess, string(abi.encodePacked("Enable module failed: ", enableData)));


        ISessionModule(module).setupSession(
            address(this), // safe
            sessionSigner,
            expiry,
            target
        );
    }

    function enableModules(address[] calldata modules) external {
        for (uint256 i = 0; i < modules.length; i++) {
            (bool success, bytes memory returnData) = address(this).call(
                abi.encodeWithSignature("enableModule(address)", modules[i])
            );
            require(success, string(abi.encodePacked("Enable module failed: ", returnData)));
        }
    }
}