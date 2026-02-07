// packages/sdk/test/helpers.ts

import nacl from "tweetnacl";
import { JsonRpcProvider } from "ethers";
import {
  initSessionAsResponder,
  initSessionAsInitiator,
  generateDHKeyPair,
  bytesToHex,
  hexToBytes,
  type RatchetSession,
} from "../src/ratchet/index.js";
import type { IdentityProof } from "../src/types.js";

// ── Topic constants ──

export const TOPIC_A = ("0x" + "1".repeat(64)) as `0x${string}`;
export const TOPIC_B = ("0x" + "2".repeat(64)) as `0x${string}`;

// ── Key helpers ──

export function createEphemeralPair() {
  return nacl.box.keyPair();
}

export function createSigningKeyPair() {
  return nacl.sign.keyPair();
}

// ── Session helpers ──

export function createTestTopics(): {
  topicOut: `0x${string}`;
  topicIn: `0x${string}`;
} {
  const topicOut = bytesToHex(nacl.randomBytes(32)) as `0x${string}`;
  const topicIn = bytesToHex(nacl.randomBytes(32)) as `0x${string}`;
  return { topicOut, topicIn };
}

export function createSessionPair(): {
  aliceSession: RatchetSession;
  bobSession: RatchetSession;
  aliceSigning: nacl.SignKeyPair;
  bobSigning: nacl.SignKeyPair;
} {
  const aliceEphemeral = generateDHKeyPair();
  const bobEphemeral = generateDHKeyPair();
  const topics = createTestTopics();

  const bobSession = initSessionAsResponder({
    myAddress: "0xBob",
    contactAddress: "0xAlice",
    myResponderEphemeralSecret: bobEphemeral.secretKey,
    myResponderEphemeralPublic: bobEphemeral.publicKey,
    theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
    topicOutbound: topics.topicIn,
    topicInbound: topics.topicOut,
  });

  const aliceSession = initSessionAsInitiator({
    myAddress: "0xAlice",
    contactAddress: "0xBob",
    myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
    theirResponderEphemeralPubKey: bobEphemeral.publicKey,
    topicOutbound: topics.topicOut,
    topicInbound: topics.topicIn,
  });

  return {
    aliceSession,
    bobSession,
    aliceSigning: createSigningKeyPair(),
    bobSigning: createSigningKeyPair(),
  };
}

/**
 * Simulate serialization round-trip (as would happen with IndexedDB storage)
 */
export function simulateDbRoundTrip(session: RatchetSession): RatchetSession {
  const serialized = {
    ...session,
    rootKey: bytesToHex(session.rootKey),
    dhMySecretKey: bytesToHex(session.dhMySecretKey),
    dhMyPublicKey: bytesToHex(session.dhMyPublicKey),
    dhTheirPublicKey: bytesToHex(session.dhTheirPublicKey),
    sendingChainKey: session.sendingChainKey
      ? bytesToHex(session.sendingChainKey)
      : null,
    receivingChainKey: session.receivingChainKey
      ? bytesToHex(session.receivingChainKey)
      : null,
    skippedKeys: session.skippedKeys.map((sk) => ({
      ...sk,
      messageKey: bytesToHex(sk.messageKey),
    })),
  };

  const json = JSON.stringify(serialized);
  const parsed = JSON.parse(json);

  return {
    ...parsed,
    rootKey: hexToBytes(parsed.rootKey),
    dhMySecretKey: hexToBytes(parsed.dhMySecretKey),
    dhMyPublicKey: hexToBytes(parsed.dhMyPublicKey),
    dhTheirPublicKey: hexToBytes(parsed.dhTheirPublicKey),
    sendingChainKey: parsed.sendingChainKey
      ? hexToBytes(parsed.sendingChainKey)
      : null,
    receivingChainKey: parsed.receivingChainKey
      ? hexToBytes(parsed.receivingChainKey)
      : null,
    skippedKeys: parsed.skippedKeys.map((sk: any) => ({
      ...sk,
      messageKey: hexToBytes(sk.messageKey),
    })),
  };
}

// ── Mock identity proof ──

export function createMockIdentityProof(
  overrides?: Partial<IdentityProof>
): IdentityProof {
  return {
    message: "VerbEth Key Binding v1\nAddress: 0x1234...",
    signature: "0x" + "1".repeat(130),
    ...overrides,
  };
}

// ── Mock provider ──

export function createMockProvider(
  overrides?: Record<string, (...args: any[]) => any>
): JsonRpcProvider {
  return {
    async getCode(addr: string) {
      return addr === "0xCc…Cc" ? "0x60016000" : "0x";
    },
    async call() {
      return "0x1626ba7e" + "0".repeat(56);
    },
    async resolveName(name: string) {
      return name;
    },
    ...overrides,
  } as unknown as JsonRpcProvider;
}

// ── Mock viem client ──

export function createMockViemClient(
  overrides?: Record<string, any>
): {
  verifyMessage: (args: any) => Promise<boolean>;
  request: (args: any) => Promise<any>;
} {
  return {
    verifyMessage: async () => true,
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x1";
      return null;
    },
    ...overrides,
  };
}
