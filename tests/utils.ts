
import {
  Wallet,
  keccak256,
  AbiCoder,
  SigningKey,
  concat,
  toBeHex,
  JsonRpcProvider,
} from "ethers";

import type { Signer } from "ethers";

import {
  split128x128,
  createVerbethClient,
  VerbethClient,
  type SessionStore,
  type PendingStore,
  type PendingMessage,
  type PendingStatus,
  type RatchetSession,
  type IdentityKeyPair,
  type IdentityProof,
  type IExecutor,
} from "../packages/sdk/src/index.js";

import {
  type TestSmartAccount,
  ERC1967Proxy__factory,
  VerbethV1__factory,
  type VerbethV1,
} from "../packages/contracts/typechain-types/index.js";

const ENTRYPOINT_ADDR = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// ============================================================================
// In-Memory SessionStore
// ============================================================================

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, RatchetSession>();

  async get(conversationId: string): Promise<RatchetSession | null> {
    return this.sessions.get(conversationId) ?? null;
  }

  async getByInboundTopic(topic: string): Promise<RatchetSession | null> {
    for (const s of this.sessions.values()) {
      if (
        s.currentTopicInbound === topic ||
        s.nextTopicInbound === topic ||
        s.previousTopicInbound === topic
      ) {
        return s;
      }
    }
    return null;
  }

  async save(session: RatchetSession): Promise<void> {
    this.sessions.set(session.conversationId, session);
  }
}

// ============================================================================
// In-Memory PendingStore
// ============================================================================

export class InMemoryPendingStore implements PendingStore {
  private pending = new Map<string, PendingMessage>();

  async save(msg: PendingMessage): Promise<void> {
    this.pending.set(msg.id, msg);
  }

  async get(id: string): Promise<PendingMessage | null> {
    return this.pending.get(id) ?? null;
  }

  async getByTxHash(txHash: string): Promise<PendingMessage | null> {
    for (const msg of this.pending.values()) {
      if (msg.txHash === txHash) return msg;
    }
    return null;
  }

  async updateStatus(id: string, status: PendingStatus, txHash?: string): Promise<void> {
    const msg = this.pending.get(id);
    if (msg) {
      msg.status = status;
      if (txHash) msg.txHash = txHash;
    }
  }

  async delete(id: string): Promise<void> {
    this.pending.delete(id);
  }

  async getByConversation(conversationId: string): Promise<PendingMessage[]> {
    return Array.from(this.pending.values()).filter(
      (m) => m.conversationId === conversationId
    );
  }
}

// ============================================================================
// Test Client Factory
// ============================================================================

export function createTestVerbethClient(
  address: string,
  signer: Signer,
  identityKeyPair: IdentityKeyPair,
  identityProof: IdentityProof,
  executor: IExecutor
): { client: VerbethClient; sessionStore: InMemorySessionStore } {
  const sessionStore = new InMemorySessionStore();
  const client = createVerbethClient({
    address,
    signer,
    identityKeyPair,
    identityProof,
    executor,
    sessionStore,
    pendingStore: new InMemoryPendingStore(),
  });
  return { client, sessionStore };
}

// ============================================================================
// Shared Helpers
// ============================================================================

export async function waitForBlock(
  provider: JsonRpcProvider,
  blockNumber: number
): Promise<void> {
  while ((await provider.getBlockNumber()) < blockNumber) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

export async function deployVerbeth(deployer: Wallet): Promise<VerbethV1> {
  const factory = new VerbethV1__factory(deployer);
  const impl = await factory.deploy();
  await impl.deploymentTransaction()?.wait();
  await new Promise((r) => setTimeout(r, 200));

  const initData = factory.interface.encodeFunctionData("initialize", []);
  const proxyFactory = new ERC1967Proxy__factory(deployer);
  const proxy = await proxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.deploymentTransaction()?.wait();
  await new Promise((r) => setTimeout(r, 200));

  return VerbethV1__factory.connect(await proxy.getAddress(), deployer);
}

// ============================================================================
// Mock Smart Account Client
// ============================================================================

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
        const nonce = await (smartAccount as any).getNonce();
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
