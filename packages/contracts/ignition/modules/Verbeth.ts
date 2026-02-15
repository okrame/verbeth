import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const VerbethModule = buildModule("VerbethModule", (m) => {
  const verbEthV1 = m.contract("VerbethV1");

  const initCall = m.encodeFunctionCall(verbEthV1, "initialize", []);

  const proxy = m.contract("ERC1967Proxy", [
    verbEthV1,
    initCall
  ]);

  return { verbEth: proxy, verbEthImplementation: verbEthV1 };
});

export default VerbethModule;