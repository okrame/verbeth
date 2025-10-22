import { describe, it, expect, vi, beforeEach } from "vitest";
import { Contract, Signer } from "ethers";
import nacl from "tweetnacl";
import {
  ExecutorFactory,
  EOAExecutor,
  UserOpExecutor,
  DirectEntryPointExecutor,
  sendEncryptedMessage,
  initiateHandshake,
  respondToHandshake,
} from "../src/index.js";
import type { LogChainV1 } from "@verbeth/contracts/typechain-types";
import { IdentityKeyPair, IdentityProof } from "../src/types.js";

const TEST_SMART_ACCOUNT_ADDRESS = "0x" + "12".repeat(20);
const TEST_ENTRYPOINT_ADDRESS = "0x" + "45".repeat(20);
const TEST_LOGCHAIN_ADDRESS = "0x" + "78".repeat(20);

const mockSendMessage = vi.fn().mockResolvedValue("txHash");
const mockInitiateHandshake = vi.fn().mockResolvedValue("txHash");
const mockRespondToHandshake = vi.fn().mockResolvedValue("txHash");

const fakeContract = {
  sendMessage: mockSendMessage,
  initiateHandshake: mockInitiateHandshake,
  respondToHandshake: mockRespondToHandshake,
} as unknown as LogChainV1;

const mockBundler = {
  sendUserOperation: vi.fn().mockResolvedValue("0x123"),
  waitForUserOperationReceipt: vi.fn().mockResolvedValue({ status: 1 }),
};

const mockSmartAccount = {
  getNonce: vi.fn().mockResolvedValue(1n),
  signUserOperation: vi.fn().mockResolvedValue({
    sender: "0x123",
    nonce: 1n,
    signature: "0x456",
  }),
};

const mockEntryPoint = {
  handleOps: vi.fn().mockResolvedValue({
    wait: vi.fn().mockResolvedValue({ status: 1 }),
  }),
  connect: vi.fn().mockReturnThis(),
} as unknown as Contract;

const mockSigner = {
  getAddress: vi.fn().mockResolvedValue("0x789"),
} as unknown as Signer;

// Test data
const testRecipientKey = nacl.box.keyPair();
const testSenderSignKey = nacl.sign.keyPair();
const testIdentityKeyPair: IdentityKeyPair = {
  publicKey: new Uint8Array(32).fill(1),
  secretKey: new Uint8Array(32).fill(2),
  signingPublicKey: new Uint8Array(32).fill(3),
  signingSecretKey: new Uint8Array(32).fill(4),
};
const testIdentityProof: IdentityProof = {
  message: "Test identity proof",
  signature: "0x" + "1".repeat(130),
};

describe("ExecutorFactory", () => {
  it("creates EOA executor correctly", () => {
    const executor = ExecutorFactory.createEOA(fakeContract);
    expect(executor).toBeInstanceOf(EOAExecutor);
  });

  it("creates UserOp executor with correct parameters", () => {
    const executor = ExecutorFactory.createUserOp(
      TEST_SMART_ACCOUNT_ADDRESS,
      TEST_ENTRYPOINT_ADDRESS,
      TEST_LOGCHAIN_ADDRESS,
      mockBundler,
      mockSmartAccount
    );
    expect(executor).toBeInstanceOf(UserOpExecutor);
  });

  it("creates DirectEntryPoint executor for testing", () => {
    const executor = ExecutorFactory.createDirectEntryPoint(
      TEST_SMART_ACCOUNT_ADDRESS,
      mockEntryPoint,
      TEST_LOGCHAIN_ADDRESS,
      mockSmartAccount,
      mockSigner
    );
    expect(executor).toBeInstanceOf(DirectEntryPointExecutor);
  });
});

describe("sendEncryptedMessage with Executors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("works with EOA executor", async () => {
    const executor = ExecutorFactory.createEOA(fakeContract);

    await sendEncryptedMessage({
      executor,
      topic: "0x" + "ab".repeat(32),
      message: "Hello from EOA",
      recipientPubKey: testRecipientKey.publicKey,
      senderAddress: "0xAlice",
      senderSignKeyPair: testSenderSignKey,
      timestamp: 42,
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    const callArgs = mockSendMessage.mock.calls[0];
    expect(callArgs).toHaveLength(4); // ciphertext, topic, timestamp, nonce
    expect(typeof callArgs[1]).toBe("string"); // topic
    expect(typeof callArgs[2]).toBe("number"); // timestamp
    expect(typeof callArgs[3]).toBe("bigint"); // nonce
  });

  it("works with UserOp executor", async () => {
    const executor = ExecutorFactory.createUserOp(
      TEST_SMART_ACCOUNT_ADDRESS,
      TEST_ENTRYPOINT_ADDRESS,
      TEST_LOGCHAIN_ADDRESS,
      mockBundler,
      mockSmartAccount
    );

    await sendEncryptedMessage({
      executor,
      topic: "0x" + "cd".repeat(32),
      message: "Hello from UserOp",
      recipientPubKey: testRecipientKey.publicKey,
      senderAddress: TEST_SMART_ACCOUNT_ADDRESS,
      senderSignKeyPair: testSenderSignKey,
      timestamp: 43,
    });

    expect(mockSmartAccount.getNonce).toHaveBeenCalled();
    expect(mockSmartAccount.signUserOperation).toHaveBeenCalled();
    expect(mockBundler.sendUserOperation).toHaveBeenCalled();
    expect(mockBundler.waitForUserOperationReceipt).toHaveBeenCalled();
  });

  it("works with DirectEntryPoint executor", async () => {
    const executor = ExecutorFactory.createDirectEntryPoint(
      TEST_SMART_ACCOUNT_ADDRESS,
      mockEntryPoint,
      TEST_LOGCHAIN_ADDRESS,
      mockSmartAccount,
      mockSigner
    );

    await sendEncryptedMessage({
      executor,
      topic: "0x" + "ef".repeat(32),
      message: "Hello from DirectEntryPoint",
      recipientPubKey: testRecipientKey.publicKey,
      senderAddress: TEST_SMART_ACCOUNT_ADDRESS,
      senderSignKeyPair: testSenderSignKey,
      timestamp: 44,
    });

    expect(mockSmartAccount.getNonce).toHaveBeenCalled();
    expect(mockSmartAccount.signUserOperation).toHaveBeenCalled();
    expect(mockEntryPoint.handleOps).toHaveBeenCalled();
    expect(mockSigner.getAddress).toHaveBeenCalled();
  });

  it("generates different nonces for different calls with same executor", async () => {
    const executor = ExecutorFactory.createEOA(fakeContract);

    // First message
    await sendEncryptedMessage({
      executor,
      topic: "0x" + "aa".repeat(32),
      message: "Message 1",
      recipientPubKey: testRecipientKey.publicKey,
      senderAddress: "0xAlice",
      senderSignKeyPair: testSenderSignKey,
      timestamp: 100,
    });

    // Second message
    await sendEncryptedMessage({
      executor,
      topic: "0x" + "aa".repeat(32),
      message: "Message 2",
      recipientPubKey: testRecipientKey.publicKey,
      senderAddress: "0xAlice",
      senderSignKeyPair: testSenderSignKey,
      timestamp: 101,
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    const firstNonce = mockSendMessage.mock.calls[0][3];
    const secondNonce = mockSendMessage.mock.calls[1][3];
    expect(secondNonce).toBe(firstNonce + 1n);
  });
});

describe("initiateHandshake with Executors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("works with EOA executor", async () => {
    const executor = ExecutorFactory.createEOA(fakeContract);

    await initiateHandshake({
      executor,
      recipientAddress: "0xBob",
      identityKeyPair: testIdentityKeyPair,
      ephemeralPubKey: nacl.box.keyPair().publicKey,
      plaintextPayload: "Hello Bob from EOA",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockInitiateHandshake).toHaveBeenCalledTimes(1);

    const callArgs = mockInitiateHandshake.mock.calls[0];
    expect(callArgs).toHaveLength(4); // recipientHash, pubKeys, ephemeralPubKey, plaintextPayload
    expect(typeof callArgs[0]).toBe("string"); // recipientHash
    expect(typeof callArgs[1]).toBe("string"); // pubKeys (hexlified)
    expect(typeof callArgs[2]).toBe("string"); // ephemeralPubKey (hexlified)
  });

  it("works with UserOp executor", async () => {
    const executor = ExecutorFactory.createUserOp(
      TEST_SMART_ACCOUNT_ADDRESS,
      TEST_ENTRYPOINT_ADDRESS,
      TEST_LOGCHAIN_ADDRESS,
      mockBundler,
      mockSmartAccount
    );

    await initiateHandshake({
      executor,
      recipientAddress: "0xBob",
      identityKeyPair: testIdentityKeyPair,
      ephemeralPubKey: nacl.box.keyPair().publicKey,
      plaintextPayload: "Hello Bob from UserOp",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockSmartAccount.getNonce).toHaveBeenCalled();
    expect(mockSmartAccount.signUserOperation).toHaveBeenCalled();
    expect(mockBundler.sendUserOperation).toHaveBeenCalled();
  });

  it("works with DirectEntryPoint executor", async () => {
    const executor = ExecutorFactory.createDirectEntryPoint(
      TEST_SMART_ACCOUNT_ADDRESS,
      mockEntryPoint,
      TEST_LOGCHAIN_ADDRESS,
      mockSmartAccount,
      mockSigner
    );

    await initiateHandshake({
      executor,
      recipientAddress: "0xBob",
      identityKeyPair: testIdentityKeyPair,
      ephemeralPubKey: nacl.box.keyPair().publicKey,
      plaintextPayload: "Hello Bob from DirectEntryPoint",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockSmartAccount.getNonce).toHaveBeenCalled();
    expect(mockSmartAccount.signUserOperation).toHaveBeenCalled();
    expect(mockEntryPoint.handleOps).toHaveBeenCalled();
  });
});

describe("respondToHandshake with Executors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("works with EOA executor", async () => {
    const executor = ExecutorFactory.createEOA(fakeContract);

    await respondToHandshake({
      executor,
      initiatorPubKey: testRecipientKey.publicKey,
      responderIdentityKeyPair: testIdentityKeyPair,
      note: "Response from EOA",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockRespondToHandshake).toHaveBeenCalledTimes(1);

    const callArgs = mockRespondToHandshake.mock.calls[0];
    expect(callArgs).toHaveLength(3); // inResponseTo, responderEphemeralR, ciphertext
    expect(typeof callArgs[0]).toBe("string"); // inResponseTo (bytes32 hex)
    expect(typeof callArgs[1]).toBe("string"); // responderEphemeralR (R, 32B hex)
    const c = callArgs[2];
    const isHexString = (v: unknown) =>
      typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
    const isUint8Array = (v: unknown) => v instanceof Uint8Array;
    expect(isHexString(c) || isUint8Array(c)).toBe(true); // ciphertext (hex or Uint8Array)
  });

  it("works with UserOp executor", async () => {
    const executor = ExecutorFactory.createUserOp(
      TEST_SMART_ACCOUNT_ADDRESS,
      TEST_ENTRYPOINT_ADDRESS,
      TEST_LOGCHAIN_ADDRESS,
      mockBundler,
      mockSmartAccount
    );

    await respondToHandshake({
      executor,
      initiatorPubKey: testRecipientKey.publicKey,
      responderIdentityKeyPair: testIdentityKeyPair,
      note: "Response from UserOp",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockSmartAccount.getNonce).toHaveBeenCalled();
    expect(mockSmartAccount.signUserOperation).toHaveBeenCalled();
    expect(mockBundler.sendUserOperation).toHaveBeenCalled();
  });

  it("works with DirectEntryPoint executor", async () => {
    const executor = ExecutorFactory.createDirectEntryPoint(
      TEST_SMART_ACCOUNT_ADDRESS,
      mockEntryPoint,
      TEST_LOGCHAIN_ADDRESS,
      mockSmartAccount,
      mockSigner
    );

    await respondToHandshake({
      executor,
      initiatorPubKey: testRecipientKey.publicKey,
      responderIdentityKeyPair: testIdentityKeyPair,
      note: "Response from DirectEntryPoint",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockSmartAccount.getNonce).toHaveBeenCalled();
    expect(mockSmartAccount.signUserOperation).toHaveBeenCalled();
    expect(mockEntryPoint.handleOps).toHaveBeenCalled();
  });

  it("generates ephemeral key pair when not provided", async () => {
    const executor = ExecutorFactory.createEOA(fakeContract);

    await respondToHandshake({
      executor,
      initiatorPubKey: testRecipientKey.publicKey,
      responderIdentityKeyPair: testIdentityKeyPair,
      // No responderEphemeralKeyPair provided
      note: "Auto-generated ephemeral key",
      identityProof: testIdentityProof,
      signer: mockSigner,
    });

    expect(mockRespondToHandshake).toHaveBeenCalledTimes(1);
  });
});
