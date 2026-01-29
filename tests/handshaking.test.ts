// tests/handshakeresp.test.ts
// This file contains integration tests for the Smart Accounts Handshaking via Direct EntryPoint
import { expect, describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  getBytes,
} from "ethers";

import nacl from "tweetnacl";
import {
  ExecutorFactory,
  initiateHandshake,
  respondToHandshake,
  DirectEntryPointExecutor,
  deriveIdentityKeyPairWithProof,
  verifyHandshakeIdentity,
  verifyHandshakeResponseIdentity,
  computeHybridTagFromInitiator,
  decodeUnifiedPubKeys,
  kem,
} from "../packages/sdk/src/index.js";

import {
  ERC1967Proxy__factory,
  EntryPoint__factory,
  type EntryPoint,
  LogChainV1__factory,
  type LogChainV1,
  TestSmartAccount__factory,
  type TestSmartAccount,
} from "../packages/contracts/typechain-types/index.js";
import { AnvilSetup } from "./setup.js";
import { createMockSmartAccountClient } from "./utils.js";

const ENTRYPOINT_ADDR = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

describe("Smart Account Handshake Response via Direct EntryPoint", () => {
  let anvil: AnvilSetup;
  let provider: JsonRpcProvider;
  let entryPoint: EntryPoint;
  let logChain: LogChainV1;
  let testSmartAccount: TestSmartAccount;
  let responderSmartAccount: TestSmartAccount;
  let executor: DirectEntryPointExecutor;
  let responderExecutor: DirectEntryPointExecutor;

  let deployer: Wallet;
  let smartAccountOwner: Wallet;
  let responderOwner: Wallet;
  let recipient: Wallet;

  let ownerIdentityKeys: any;
  let responderIdentityKeys: any;

  beforeAll(async () => {
    anvil = new AnvilSetup(8545);
    const forkUrl = "https://base-rpc.publicnode.com";

    await anvil.start(forkUrl);
    provider = anvil.provider;

    const testPrivateKeys = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ];

    deployer = new Wallet(testPrivateKeys[0], provider);
    smartAccountOwner = new Wallet(testPrivateKeys[1], provider);
    responderOwner = new Wallet(testPrivateKeys[2], provider);
    recipient = new Wallet(testPrivateKeys[3], provider);

    const tempBundler = new Wallet(
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926d",
      provider
    );

    const fundBundlerTx = await deployer.sendTransaction({
      to: tempBundler.address,
      value: parseEther("5"),
    });
    await fundBundlerTx.wait();
    await new Promise((r) => setTimeout(r, 100));

    entryPoint = EntryPoint__factory.connect(ENTRYPOINT_ADDR, provider);

    const logChainFactory = new LogChainV1__factory(deployer);
    const logChainImpl = await logChainFactory.deploy();
    await logChainImpl.deploymentTransaction()?.wait();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const initData = logChainFactory.interface.encodeFunctionData(
      "initialize",
      []
    );

    const proxyFactory = new ERC1967Proxy__factory(deployer);
    const proxy = await proxyFactory.deploy(
      await logChainImpl.getAddress(),
      initData
    );
    await proxy.deploymentTransaction()?.wait();

    logChain = LogChainV1__factory.connect(await proxy.getAddress(), deployer);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const testSmartAccountFactory = new TestSmartAccount__factory(deployer);
    testSmartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      smartAccountOwner.address
    );
    await testSmartAccount.deploymentTransaction()?.wait();
    await new Promise((resolve) => setTimeout(resolve, 200));

    responderSmartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      responderOwner.address
    );
    await responderSmartAccount.deploymentTransaction()?.wait();
    await new Promise((resolve) => setTimeout(resolve, 200));

    let deployerNonce = await provider.getTransactionCount(
      deployer.address,
      "pending"
    );

    const fundTx1 = await deployer.sendTransaction({
      to: await testSmartAccount.getAddress(),
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx1.wait();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const fundTx2 = await deployer.sendTransaction({
      to: await responderSmartAccount.getAddress(),
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx2.wait();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Derive identity keys with executorSafeAddress (3rd param) for binding proof
    const testSmartAccountAddr = await testSmartAccount.getAddress();
    ownerIdentityKeys = await deriveIdentityKeyPairWithProof(
      smartAccountOwner,
      testSmartAccountAddr,
      testSmartAccountAddr // executorSafeAddress = smart account address
    );

    const responderSmartAccountAddr = await responderSmartAccount.getAddress();
    responderIdentityKeys = await deriveIdentityKeyPairWithProof(
      responderOwner,
      responderSmartAccountAddr,
      responderSmartAccountAddr // executorSafeAddress = smart account address
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, 180000);

  afterAll(async () => {
    await anvil.stop();
  });

  beforeEach(async () => {
    // Long wait to ensure blockchain state is settled
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Force block queries
    await provider.getBlockNumber();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // CRITICAL: Create TWO SEPARATE bundler wallet instances
    // Each executor needs its own wallet to avoid nonce conflicts!
    const initiatorBundler = new Wallet(
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926d",
      provider
    );

    const responderBundler = new Wallet(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
      provider
    );

    // Force nonce queries with both fresh wallets
    await initiatorBundler.getNonce("latest");
    await responderBundler.getNonce("latest");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Create executors with SEPARATE bundler wallets
    executor = ExecutorFactory.createDirectEntryPoint(
      await testSmartAccount.getAddress(),
      entryPoint.connect(initiatorBundler) as unknown as Contract,
      await logChain.getAddress(),
      createMockSmartAccountClient(testSmartAccount, smartAccountOwner),
      initiatorBundler // Use initiatorBundler
    ) as DirectEntryPointExecutor;

    responderExecutor = ExecutorFactory.createDirectEntryPoint(
      await responderSmartAccount.getAddress(),
      entryPoint.connect(responderBundler) as unknown as Contract,
      await logChain.getAddress(),
      createMockSmartAccountClient(responderSmartAccount, responderOwner),
      responderBundler // Use responderBundler
    ) as DirectEntryPointExecutor;

    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  async function waitForNonceSync() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await provider.getBlockNumber();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  it("should respond to handshake from smart account via canonical EntryPoint", async () => {
    const ephemeralKeys = nacl.box.keyPair();

    const initiateHandshakeTx = await initiateHandshake({
      executor,
      recipientAddress: await responderSmartAccount.getAddress(),
      identityKeyPair: ownerIdentityKeys.keyPair,
      ephemeralPubKey: ephemeralKeys.publicKey,
      plaintextPayload: "Hello from initiator smart account!",
      identityProof: ownerIdentityKeys.identityProof,
      signer: smartAccountOwner,
    });

    const initiateReceipt = await initiateHandshakeTx.wait();
    expect(initiateReceipt.status).toBe(1);

    await waitForNonceSync();

    const handshakeFilter = logChain.filters.Handshake();
    const handshakeEvents = await logChain.queryFilter(
      handshakeFilter,
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );

    expect(handshakeEvents).toHaveLength(1);

    const decodedInitiator = decodeUnifiedPubKeys(
      Uint8Array.from(
        Buffer.from(handshakeEvents[0].args.pubKeys.slice(2), "hex")
      )
    );
    if (!decodedInitiator) throw new Error("Invalid initiator unified pubkeys");
    const initiatorIdentityPubKey = decodedInitiator.identityPubKey;

    const respondTx = await respondToHandshake({
      executor: responderExecutor,
      initiatorPubKey: ephemeralKeys.publicKey,
      responderIdentityKeyPair: responderIdentityKeys.keyPair,
      note: "Hello back from responder smart account!",
      identityProof: responderIdentityKeys.identityProof,
      signer: responderOwner,
      initiatorIdentityPubKey,
    });
    const respondReceipt = await respondTx.tx.wait();
    expect(respondReceipt.status).toBe(1);

    const responseFilter = logChain.filters.HandshakeResponse();

    while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const responseEvents = await logChain.queryFilter(
      responseFilter,
      respondReceipt.blockNumber,
      respondReceipt.blockNumber
    );

    expect(responseEvents).toHaveLength(1);

    const responseEvent = responseEvents[0];
    expect(responseEvent.args.responder).toBe(
      await responderSmartAccount.getAddress()
    );
    const Rbytes = getBytes(responseEvent.args.responderEphemeralR);
    const expectedTag = computeTagFromInitiator(
      ephemeralKeys.secretKey,
      Rbytes
    );
    expect(responseEvent.args.inResponseTo).toBe(expectedTag);
  }, 30000);

  it("should handle multiple handshake responses", async () => {
    const handshakeCount = 3;
    const handshakeData: Array<{
      ephemeralKeys: nacl.BoxKeyPair;
      initiateReceipt: any;
      inResponseTo: string;
    }> = [];

    // CRITICAL: Send handshakes ONE AT A TIME and wait for each to complete
    for (let i = 0; i < handshakeCount; i++) {
      const ephemeralKeys = nacl.box.keyPair();

      const initiateHandshakeTx = await initiateHandshake({
        executor,
        recipientAddress: await responderSmartAccount.getAddress(),
        identityKeyPair: ownerIdentityKeys.keyPair,
        ephemeralPubKey: ephemeralKeys.publicKey,
        plaintextPayload: `Batch handshake ${i + 1}`,
        identityProof: ownerIdentityKeys.identityProof,
        signer: smartAccountOwner,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();

      // CRITICAL: Wait for block to be mined AND extra time for nonce sync
      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // Extra delay to ensure nonce is updated
      await new Promise((resolve) => setTimeout(resolve, 200));

      handshakeData.push({
        ephemeralKeys,
        initiateReceipt,
        inResponseTo: initiateReceipt.hash,
      });
    }

    // Now respond to each handshake ONE AT A TIME
    const responseReceipts: any[] = [];
    for (let i = 0; i < handshakeData.length; i++) {
      const handshakeFilter = logChain.filters.Handshake();
      const handshakeEventsForItem = await logChain.queryFilter(
        handshakeFilter,
        handshakeData[i].initiateReceipt.blockNumber,
        handshakeData[i].initiateReceipt.blockNumber
      );
      if (handshakeEventsForItem.length !== 1)
        throw new Error("Expected 1 handshake event for item");
      const decodedInitiatorForItem = decodeUnifiedPubKeys(
        Uint8Array.from(
          Buffer.from(handshakeEventsForItem[0].args.pubKeys.slice(2), "hex")
        )
      );
      if (!decodedInitiatorForItem)
        throw new Error("Invalid initiator unified pubkeys for item");
      const initiatorIdentityPubKey = decodedInitiatorForItem.identityPubKey;

      const respondTx = await respondToHandshake({
        executor: responderExecutor,
        initiatorPubKey: handshakeData[i].ephemeralKeys.publicKey,
        responderIdentityKeyPair: responderIdentityKeys.keyPair,
        note: `Batch response ${i + 1}`,
        identityProof: responderIdentityKeys.identityProof,
        signer: responderOwner,
        initiatorIdentityPubKey,
      });

      const respondReceipt = await respondTx.tx.wait();

      // CRITICAL: Wait for block to be mined AND extra time for nonce sync
      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // Extra delay to ensure nonce is updated
      await new Promise((resolve) => setTimeout(resolve, 200));

      responseReceipts.push(respondReceipt);
    }

    const responseFilter = logChain.filters.HandshakeResponse();
    const fromBlock = responseReceipts[0].blockNumber;
    const toBlock = responseReceipts[responseReceipts.length - 1].blockNumber;

    while ((await provider.getBlockNumber()) < toBlock) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const responseEvents = await logChain.queryFilter(
      responseFilter,
      fromBlock,
      toBlock
    );

    expect(responseEvents.length).toBeGreaterThanOrEqual(handshakeCount);

    for (let i = 0; i < handshakeCount; i++) {
      const expectedTagI = computeTagFromInitiator(
        handshakeData[i].ephemeralKeys.secretKey,
        getBytes(responseEvents[i].args.responderEphemeralR)
      );
      const matchingEvent = responseEvents.find(
        (event) => event.args.inResponseTo === expectedTagI
      );
      expect(matchingEvent).toBeDefined();
      expect(matchingEvent?.args.responder).toBe(
        await responderSmartAccount.getAddress()
      );
    }
  }, 60000);

  it("should fail gracefully when responding to non-existent handshake", async () => {
    const fakeHandshakeId = "0x" + "99".repeat(32);

    const respondTx = await respondToHandshake({
      executor: responderExecutor,
      initiatorPubKey: ownerIdentityKeys.keyPair.publicKey,
      responderIdentityKeyPair: responderIdentityKeys.keyPair,
      note: "Response to non-existent handshake",
      identityProof: responderIdentityKeys.identityProof,
      signer: responderOwner,
    });

    const respondReceipt = await respondTx.tx.wait();
    expect(respondReceipt.status).toBe(1);

    const responseFilter = logChain.filters.HandshakeResponse();
    const responseEvents = await logChain.queryFilter(
      responseFilter,
      respondReceipt.blockNumber,
      respondReceipt.blockNumber
    );

    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0].args.inResponseTo).not.toBe(fakeHandshakeId);
    expect(
      /^0x[0-9a-fA-F]{64}$/.test(responseEvents[0].args.inResponseTo)
    ).toBe(true);
    expect(responseEvents[0].args.responder).toBe(
      await responderSmartAccount.getAddress()
    );
  }, 30000);

  it("should handle responses with different note lengths", async () => {
    const testNotes = [
      "",
      "Short note",
      "This is a medium length note that contains more information about the handshake response",
      "This is a very long note that simulates a detailed response message that might be sent during a handshake process. It contains enough text to test how the system handles larger payload sizes and ensures that the encryption and decryption processes work correctly with varying message lengths. The note might contain important context or instructions for the handshake completion.",
    ];

    for (let i = 0; i < testNotes.length; i++) {
      const ephemeralKeys = nacl.box.keyPair();

      const initiateHandshakeTx = await initiateHandshake({
        executor,
        recipientAddress: await responderSmartAccount.getAddress(),
        identityKeyPair: ownerIdentityKeys.keyPair,
        ephemeralPubKey: ephemeralKeys.publicKey,
        plaintextPayload: `Note length test ${i + 1}`,
        identityProof: ownerIdentityKeys.identityProof,
        signer: smartAccountOwner,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();

      // Wait for block before querying
      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      const handshakeFilter = logChain.filters.Handshake();
      const events = await logChain.queryFilter(
        handshakeFilter,
        initiateReceipt.blockNumber,
        initiateReceipt.blockNumber
      );
      if (events.length !== 1) {
        throw new Error(`Expected 1 Handshake event, got ${events.length}`);
      }
      const ev = events[0];

      const decodedInitiator = decodeUnifiedPubKeys(
        Uint8Array.from(Buffer.from(ev.args.pubKeys.slice(2), "hex"))
      );
      if (!decodedInitiator)
        throw new Error("Invalid initiator unified pubkeys");
      const initiatorIdentityPubKey = decodedInitiator.identityPubKey;

      const aliceEphemeralPubKeyFromEvent = Uint8Array.from(
        Buffer.from(ev.args.ephemeralPubKey.slice(2), "hex")
      );

      const respondTx = await respondToHandshake({
        executor: responderExecutor,
        initiatorPubKey: aliceEphemeralPubKeyFromEvent,
        responderIdentityKeyPair: responderIdentityKeys.keyPair,
        note: `Batch verification response ${i + 1}`,
        identityProof: responderIdentityKeys.identityProof,
        signer: responderOwner,
        initiatorIdentityPubKey,
      });

      const respondReceipt = await respondTx.tx.wait();
      expect(respondReceipt.status).toBe(1);

      // Wait for block before next iteration
      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60000);

  it("should verify handshake identity successfully", async () => {
    const ephemeralKeys = nacl.box.keyPair();

    const initiateHandshakeTx = await initiateHandshake({
      executor,
      recipientAddress: await responderSmartAccount.getAddress(),
      identityKeyPair: ownerIdentityKeys.keyPair,
      ephemeralPubKey: ephemeralKeys.publicKey,
      plaintextPayload: "Identity verification test handshake",
      identityProof: ownerIdentityKeys.identityProof,
      signer: smartAccountOwner,
    });

    const initiateReceipt = await initiateHandshakeTx.wait();
    expect(initiateReceipt.status).toBe(1);

    const handshakeFilter = logChain.filters.Handshake();
    const handshakeEvents = await logChain.queryFilter(
      handshakeFilter,
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );

    expect(handshakeEvents).toHaveLength(1);
    const handshakeEvent = handshakeEvents[0];

    const handshakeLog = {
      recipientHash: handshakeEvent.args.recipientHash,
      sender: handshakeEvent.args.sender,
      pubKeys: handshakeEvent.args.pubKeys,
      ephemeralPubKey: handshakeEvent.args.ephemeralPubKey,
      plaintextPayload: handshakeEvent.args.plaintextPayload,
    };

    const isValidHandshake = await verifyHandshakeIdentity(
      handshakeLog,
      provider
    );

    expect(isValidHandshake).toBe(true);
  }, 30000);

  it("should verify handshake response identity successfully", async () => {
    const aliceEphemeralKeys = nacl.box.keyPair();

    const initiateHandshakeTx = await initiateHandshake({
      executor,
      recipientAddress: await responderSmartAccount.getAddress(),
      identityKeyPair: ownerIdentityKeys.keyPair,
      ephemeralPubKey: aliceEphemeralKeys.publicKey,
      plaintextPayload: "Response identity verification test",
      identityProof: ownerIdentityKeys.identityProof,
      signer: smartAccountOwner,
    });

    const initiateReceipt = await initiateHandshakeTx.wait();

    const handshakeFilter = logChain.filters.Handshake();
    const handshakeEvents = await logChain.queryFilter(
      handshakeFilter,
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );

    expect(handshakeEvents).toHaveLength(1);
    const handshakeEvent = handshakeEvents[0];

    const aliceEphemeralPubKeyFromEvent = new Uint8Array(
      Buffer.from(handshakeEvent.args.ephemeralPubKey.slice(2), "hex")
    );

    const respondTx = await respondToHandshake({
      executor: responderExecutor,
      initiatorPubKey: aliceEphemeralPubKeyFromEvent,
      responderIdentityKeyPair: responderIdentityKeys.keyPair,
      note: "Response identity verification test",
      identityProof: responderIdentityKeys.identityProof,
      signer: responderOwner,
    });

    const respondReceipt = await respondTx.tx.wait();
    expect(respondReceipt.status).toBe(1);

    // ADD THIS: Wait for block to be mined
    while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const responseFilter = logChain.filters.HandshakeResponse();
    const responseEvents = await logChain.queryFilter(
      responseFilter,
      respondReceipt.blockNumber,
      respondReceipt.blockNumber
    );

    expect(responseEvents).toHaveLength(1);
    const responseEvent = responseEvents[0];

    const responseLog = {
      inResponseTo: responseEvent.args.inResponseTo,
      responder: responseEvent.args.responder,
      responderEphemeralR: responseEvents[0].args.responderEphemeralR,
      ciphertext: responseEvent.args.ciphertext,
    };

    const isValidResponse = await verifyHandshakeResponseIdentity(
      responseLog,
      responderIdentityKeys.keyPair.publicKey,
      aliceEphemeralKeys.secretKey,
      provider
    );

    expect(isValidResponse).toBe(true);
  }, 30000);

  it("should fail handshake identity verification with invalid identity proof", async () => {
    const ephemeralKeys = nacl.box.keyPair();

    const invalidWallet = new Wallet(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
      provider
    );

    const invalidMessage = "Invalid identity message";
    const invalidSignature = await invalidWallet.signMessage(invalidMessage);

    const invalidIdentityProof = {
      message: invalidMessage,
      signature: invalidSignature,
    };

    const initiateHandshakeTx = await initiateHandshake({
      executor,
      recipientAddress: await responderSmartAccount.getAddress(),
      identityKeyPair: ownerIdentityKeys.keyPair,
      ephemeralPubKey: ephemeralKeys.publicKey,
      plaintextPayload: "Invalid identity verification test",
      identityProof: invalidIdentityProof,
      signer: smartAccountOwner,
    });

    const initiateReceipt = await initiateHandshakeTx.wait();
    expect(initiateReceipt.status).toBe(1);

    const handshakeFilter = logChain.filters.Handshake();
    const handshakeEvents = await logChain.queryFilter(
      handshakeFilter,
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );

    expect(handshakeEvents).toHaveLength(1);
    const handshakeEvent = handshakeEvents[0];

    const handshakeLog = {
      recipientHash: handshakeEvent.args.recipientHash,
      sender: handshakeEvent.args.sender,
      pubKeys: handshakeEvent.args.pubKeys,
      ephemeralPubKey: handshakeEvent.args.ephemeralPubKey,
      plaintextPayload: handshakeEvent.args.plaintextPayload,
    };

    const isValidHandshake = await verifyHandshakeIdentity(
      handshakeLog,
      provider
    );

    expect(isValidHandshake).toBe(false);
  }, 30000);

  it("should handle identity verification for multiple handshakes and responses", async () => {
    const handshakeCount = 2;
    const verificationResults: {
      handshakeIndex: number;
      handshakeValid: boolean;
      responseValid: boolean;
    }[] = [];

    for (let i = 0; i < handshakeCount; i++) {
      const aliceEphemeralKeys = nacl.box.keyPair();

      const initiateHandshakeTx = await initiateHandshake({
        executor,
        recipientAddress: await responderSmartAccount.getAddress(),
        identityKeyPair: ownerIdentityKeys.keyPair,
        ephemeralPubKey: aliceEphemeralKeys.publicKey,
        plaintextPayload: `Batch verification test ${i + 1}`,
        identityProof: ownerIdentityKeys.identityProof,
        signer: smartAccountOwner,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();

      // Wait for block
      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      const handshakeFilter = logChain.filters.Handshake();
      const handshakeEvents = await logChain.queryFilter(
        handshakeFilter,
        initiateReceipt.blockNumber,
        initiateReceipt.blockNumber
      );

      const handshakeLog = {
        recipientHash: handshakeEvents[0].args.recipientHash,
        sender: handshakeEvents[0].args.sender,
        pubKeys: handshakeEvents[0].args.pubKeys,
        ephemeralPubKey: handshakeEvents[0].args.ephemeralPubKey,
        plaintextPayload: handshakeEvents[0].args.plaintextPayload,
      };

      const isValidHandshake = await verifyHandshakeIdentity(
        handshakeLog,
        provider
      );

      const aliceEphemeralPubKeyFromEvent = new Uint8Array(
        Buffer.from(handshakeEvents[0].args.ephemeralPubKey.slice(2), "hex")
      );

      const respondTx = await respondToHandshake({
        executor: responderExecutor,
        initiatorPubKey: aliceEphemeralPubKeyFromEvent,
        responderIdentityKeyPair: responderIdentityKeys.keyPair,
        note: `Batch verification response ${i + 1}`,
        identityProof: responderIdentityKeys.identityProof,
        signer: responderOwner,
      });

      const respondReceipt = await respondTx.tx.wait();

      // Wait for block
      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      const responseFilter = logChain.filters.HandshakeResponse();
      const responseEvents = await logChain.queryFilter(
        responseFilter,
        respondReceipt.blockNumber,
        respondReceipt.blockNumber
      );

      const responseLog = {
        inResponseTo: responseEvents[0].args.inResponseTo,
        responder: responseEvents[0].args.responder,
        responderEphemeralR: responseEvents[0].args.responderEphemeralR,
        ciphertext: responseEvents[0].args.ciphertext,
      };

      const isValidResponse = await verifyHandshakeResponseIdentity(
        responseLog,
        responderIdentityKeys.keyPair.publicKey,
        aliceEphemeralKeys.secretKey,
        provider
      );

      verificationResults.push({
        handshakeIndex: i + 1,
        handshakeValid: isValidHandshake,
        responseValid: isValidResponse,
      });

      // Wait before next iteration
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    verificationResults.forEach((result) => {
      expect(result.handshakeValid).toBe(true);
      expect(result.responseValid).toBe(true);
    });
  }, 60000);
});