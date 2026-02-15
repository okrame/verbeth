// packages/sdk/test/verify.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hexlify, getAddress } from "ethers";
import { verifyIdentityProof } from "../src/verify.js";
import { parseBindingMessage } from "../src/utils.js";
import type { IdentityProof, IdentityContext } from "../src/types.js";

// Stub makeViemPublicClient so verifyIdentityProof uses our mock client
vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    makeViemPublicClient: vi.fn(),
  };
});

import { makeViemPublicClient } from "../src/utils.js";
const mockedMakeClient = vi.mocked(makeViemPublicClient);

// ── Test fixtures ──

const TEST_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const TEST_SAFE_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const pkX25519 = new Uint8Array(32).fill(0x22);
const pkEd25519 = new Uint8Array(32).fill(0x11);

function buildMessage(overrides?: {
  header?: string;
  address?: string;
  executorAddress?: string;
  pkEd25519Hex?: string;
  pkX25519Hex?: string;
  chainId?: number;
  rpId?: string;
}): string {
  const o = {
    header: "VerbEth Key Binding v1",
    address: TEST_ADDRESS,
    executorAddress: TEST_SAFE_ADDRESS,
    pkEd25519Hex: hexlify(pkEd25519),
    pkX25519Hex: hexlify(pkX25519),
    ...overrides,
  };
  const lines = [
    o.header,
    `Address: ${o.address}`,
    `PkEd25519: ${o.pkEd25519Hex}`,
    `PkX25519: ${o.pkX25519Hex}`,
    `executorAddress: ${o.executorAddress}`,
  ];
  if (o.chainId !== undefined) lines.push(`ChainId: ${o.chainId}`);
  if (o.rpId !== undefined) lines.push(`RpId: ${o.rpId}`);
  return lines.join("\n");
}

function makeProof(messageOverrides?: Parameters<typeof buildMessage>[0]): IdentityProof {
  return {
    message: buildMessage(messageOverrides),
    signature: "0x" + "ab".repeat(65),
  };
}

const expectedKeys = {
  identityPubKey: pkX25519,
  signingPubKey: pkEd25519,
};

// A provider-like stub (only used to pass to verifyIdentityProof; the real
// work is done by the mocked makeViemPublicClient)
const fakeProvider = {
  request: async () => "0x1",
} as any;

describe("verifyIdentityProof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedMakeClient.mockResolvedValue({
      verifyMessage: vi.fn().mockResolvedValue(true),
    } as any);
  });

  it("returns true for valid proof", async () => {
    const result = await verifyIdentityProof(
      makeProof(),
      TEST_SAFE_ADDRESS,
      expectedKeys,
      fakeProvider,
    );
    expect(result).toBe(true);
  });

  it("returns false when signature verification fails", async () => {
    mockedMakeClient.mockResolvedValue({
      verifyMessage: vi.fn().mockResolvedValue(false),
    } as any);

    const result = await verifyIdentityProof(
      makeProof(),
      TEST_SAFE_ADDRESS,
      expectedKeys,
      fakeProvider,
    );
    expect(result).toBe(false);
  });

  it("returns false when executorAddress mismatches input address", async () => {
    const otherAddress = "0x" + "99".repeat(20);
    const result = await verifyIdentityProof(
      makeProof(),
      otherAddress,       // doesn't match executorAddress in the message
      expectedKeys,
      fakeProvider,
    );
    expect(result).toBe(false);
  });

  it("returns false when PkX25519 mismatches expected key", async () => {
    const wrongKeys = {
      identityPubKey: new Uint8Array(32).fill(0xff), // mismatch
      signingPubKey: pkEd25519,
    };
    const result = await verifyIdentityProof(
      makeProof(),
      TEST_SAFE_ADDRESS,
      wrongKeys,
      fakeProvider,
    );
    expect(result).toBe(false);
  });

  it("returns false when PkEd25519 mismatches expected key", async () => {
    const wrongKeys = {
      identityPubKey: pkX25519,
      signingPubKey: new Uint8Array(32).fill(0xff), // mismatch
    };
    const result = await verifyIdentityProof(
      makeProof(),
      TEST_SAFE_ADDRESS,
      wrongKeys,
      fakeProvider,
    );
    expect(result).toBe(false);
  });

  it("returns false when ChainId mismatches context", async () => {
    const ctx: IdentityContext = { chainId: 8453 };
    const result = await verifyIdentityProof(
      makeProof({ chainId: 1 }),  // message says chainId=1
      TEST_SAFE_ADDRESS,
      expectedKeys,
      fakeProvider,
      ctx,                        // expects 8453
    );
    expect(result).toBe(false);
  });

  it("returns false when RpId mismatches context", async () => {
    const ctx: IdentityContext = { rpId: "example.com" };
    const result = await verifyIdentityProof(
      makeProof({ rpId: "evil.com" }),
      TEST_SAFE_ADDRESS,
      expectedKeys,
      fakeProvider,
      ctx,
    );
    expect(result).toBe(false);
  });

  it("returns false for wrong header", async () => {
    const result = await verifyIdentityProof(
      makeProof({ header: "Wrong Header v999" }),
      TEST_SAFE_ADDRESS,
      expectedKeys,
      fakeProvider,
    );
    expect(result).toBe(false);
  });
});
