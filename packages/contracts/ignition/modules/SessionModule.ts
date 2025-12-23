import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SessionModuleModule = buildModule("SessionModuleModule", (m) => {
    const sessionModule = m.contract("SessionModule");

    const moduleSetupHelper = m.contract("ModuleSetupHelper");

    return { sessionModule, moduleSetupHelper };
});

export default SessionModuleModule;
