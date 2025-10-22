
import {
  Wallet,
  keccak256,
  AbiCoder,
  SigningKey,
  concat,
  toBeHex,
} from "ethers";

import {
  split128x128,
} from "../packages/sdk/src/index.js";
import {
  type TestSmartAccount,
} from "../packages/contracts/typechain-types/index.js";

const ENTRYPOINT_ADDR = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

export function detectUserOpFormat(userOp: any): "v0.6" | "v0.7" {
  if ("accountGasLimits" in userOp && "gasFees" in userOp) {
    return "v0.7";
  } else if (
    "callGasLimit" in userOp &&
    "verificationGasLimit" in userOp &&
    "maxFeePerGas" in userOp
  ) {
    return "v0.6";
  }
  return "v0.7";
}

export function createMockSmartAccountClient(
  smartAccount: TestSmartAccount,
  owner: Wallet
) {
  return {
    address: smartAccount.getAddress(),

    async getNonce(): Promise<bigint> {
  try {
    // Always fetch fresh nonce from the blockchain
    const nonce = await smartAccount["getNonce"]();
    console.log(`Smart account nonce: ${nonce}`);
    return nonce;
  } catch (error) {
    console.warn("Failed to get nonce from SmartAccount, using 0:", error);
    return 0n;
  }
},

    async signUserOperation(userOp: any): Promise<any> {
      if (!owner.provider) {
        throw new Error("Owner wallet has no provider attached");
      }
      const chainId = (await owner.provider.getNetwork()).chainId;

      const format = detectUserOpFormat(userOp);
      let callGasLimit: bigint;
      let verificationGasLimit: bigint;
      let maxFeePerGas: bigint;
      let maxPriorityFeePerGas: bigint;

      if (format === "v0.7") {
        let accountGasLimits = userOp.accountGasLimits;
        let gasFees = userOp.gasFees;

        if (typeof accountGasLimits === 'string') {
          accountGasLimits = BigInt(accountGasLimits);
        }
        if (typeof gasFees === 'string') {
          gasFees = BigInt(gasFees);
        }

        [verificationGasLimit, callGasLimit] = split128x128(accountGasLimits);
        [maxFeePerGas, maxPriorityFeePerGas] = split128x128(gasFees);

        console.log("UserOp v0.7 format detected");
      } else {
        callGasLimit = typeof userOp.callGasLimit === 'string' ? BigInt(userOp.callGasLimit) : userOp.callGasLimit;
        verificationGasLimit = typeof userOp.verificationGasLimit === 'string' ? BigInt(userOp.verificationGasLimit) : userOp.verificationGasLimit;
        maxFeePerGas = typeof userOp.maxFeePerGas === 'string' ? BigInt(userOp.maxFeePerGas) : userOp.maxFeePerGas;
        maxPriorityFeePerGas = typeof userOp.maxPriorityFeePerGas === 'string' ? BigInt(userOp.maxPriorityFeePerGas) : userOp.maxPriorityFeePerGas;

        console.log("UserOp v0.6 format detected");
      }

      const abiCoder = new AbiCoder();

      console.log("Encoding UserOp for signing");

      const packedUserOp = abiCoder.encode(
        [
          "address",
          "uint256",
          "bytes32",
          "bytes32",
          "bytes32",
          "uint256",
          "bytes32",
          "bytes32",
        ],
        [
          userOp.sender,
          userOp.nonce,
          keccak256(userOp.initCode || "0x"),
          keccak256(userOp.callData),
          userOp.accountGasLimits,
          userOp.preVerificationGas,
          userOp.gasFees,
          keccak256(userOp.paymasterAndData || "0x"),
        ]
      );

      console.log("Using v0.7 packed format for hash calculation");

      const userOpHash = keccak256(
        abiCoder.encode(
          ["bytes32", "address", "uint256"],
          [keccak256(packedUserOp), ENTRYPOINT_ADDR, chainId]
        )
      );

      const sk =
        (owner as any).signingKey ??
        new SigningKey(owner.privateKey);

      const sig = sk.sign(userOpHash);

      const v = sig.v ?? 27 + sig.yParity;
      const vHex = toBeHex(v, 1);

      const signature = concat([sig.r, sig.s, vHex]);

      console.log("Signature created:", signature);

      return {
        ...userOp,
        signature,
      };
    },
  };
}