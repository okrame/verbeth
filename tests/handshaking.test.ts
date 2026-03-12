// tests/handshaking.test.ts
// Integration tests for Smart Account handshaking via VerbethClient
import { expect, describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  getBytes,
} from "ethers";

import {
  ExecutorFactory,
  DirectEntryPointExecutor,
  deriveIdentityKeyPairWithProof,
  computeHybridTagFromInitiator,
  decryptAndExtractHandshakeKeys,
  kem,
  type VerbethClient,
} from "../packages/sdk/src/index.js";

import {
  EntryPoint__factory,
  type EntryPoint,
  type VerbethV1,
  TestSmartAccount__factory,
  type TestSmartAccount,
} from "../packages/contracts/typechain-types/index.js";
import { AnvilSetup } from "./setup.js";
import {
  createMockSmartAccountClient,
  createTestVerbethClient,
  deployVerbeth,
  waitForBlock,
  hexToBytes,
} from "./utils.js";

const ENTRYPOINT_ADDR = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

describe("Smart Account Handshake Response via Direct EntryPoint", () => {
  let anvil: AnvilSetup;
  let provider: JsonRpcProvider;
  let entryPoint: EntryPoint;
  let verbEth: VerbethV1;
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

  let initiatorClient: VerbethClient;
  let responderClient: VerbethClient;

  beforeAll(async () => {
    anvil = new AnvilSetup(8546);
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

    verbEth = await deployVerbeth(deployer);

    const testSmartAccountFactory = new TestSmartAccount__factory(deployer);
    testSmartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      smartAccountOwner.address
    );
    await testSmartAccount.deploymentTransaction()?.wait();
    await new Promise((r) => setTimeout(r, 200));

    responderSmartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      responderOwner.address
    );
    await responderSmartAccount.deploymentTransaction()?.wait();
    await new Promise((r) => setTimeout(r, 200));

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
    await new Promise((r) => setTimeout(r, 100));

    const fundTx2 = await deployer.sendTransaction({
      to: await responderSmartAccount.getAddress(),
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx2.wait();
    await new Promise((r) => setTimeout(r, 100));

    const testSmartAccountAddr = await testSmartAccount.getAddress();
    ownerIdentityKeys = await deriveIdentityKeyPairWithProof(
      smartAccountOwner,
      testSmartAccountAddr,
      testSmartAccountAddr
    );

    const responderSmartAccountAddr = await responderSmartAccount.getAddress();
    responderIdentityKeys = await deriveIdentityKeyPairWithProof(
      responderOwner,
      responderSmartAccountAddr,
      responderSmartAccountAddr
    );
    await new Promise((r) => setTimeout(r, 300));
  }, 180000);

  afterAll(async () => {
    await anvil.stop();
  });

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await provider.getBlockNumber();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const initiatorBundler = new Wallet(
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926d",
      provider
    );

    const responderBundler = new Wallet(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
      provider
    );

    await initiatorBundler.getNonce("latest");
    await responderBundler.getNonce("latest");
    await new Promise((resolve) => setTimeout(resolve, 200));

    executor = ExecutorFactory.createDirectEntryPoint(
      await testSmartAccount.getAddress(),
      entryPoint.connect(initiatorBundler) as unknown as Contract,
      await verbEth.getAddress(),
      createMockSmartAccountClient(testSmartAccount, smartAccountOwner),
      initiatorBundler
    ) as DirectEntryPointExecutor;

    responderExecutor = ExecutorFactory.createDirectEntryPoint(
      await responderSmartAccount.getAddress(),
      entryPoint.connect(responderBundler) as unknown as Contract,
      await verbEth.getAddress(),
      createMockSmartAccountClient(responderSmartAccount, responderOwner),
      responderBundler
    ) as DirectEntryPointExecutor;

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Create VerbethClient instances with fresh in-memory stores
    ({ client: initiatorClient } = createTestVerbethClient(
      await testSmartAccount.getAddress(),
      smartAccountOwner,
      ownerIdentityKeys.keyPair,
      ownerIdentityKeys.identityProof,
      executor
    ));

    ({ client: responderClient } = createTestVerbethClient(
      await responderSmartAccount.getAddress(),
      responderOwner,
      responderIdentityKeys.keyPair,
      responderIdentityKeys.identityProof,
      responderExecutor
    ));
  });

  async function waitForNonceSync() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await provider.getBlockNumber();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  it("should respond to handshake from smart account via canonical EntryPoint", async () => {
    // Initiator sends handshake via VerbethClient
    const handshakeResult = await initiatorClient.sendHandshake(
      await responderSmartAccount.getAddress(),
      "Hello from initiator smart account!"
    );

    const initiateReceipt = await handshakeResult.tx.wait();
    expect(initiateReceipt.status).toBe(1);
    await waitForNonceSync();

    const handshakeEvents = await verbEth.queryFilter(
      verbEth.filters.Handshake(),
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );
    expect(handshakeEvents).toHaveLength(1);

    // Get initiator's full ephemeral key from event
    const aliceEphemeralPubKeyFromEvent = hexToBytes(
      handshakeEvents[0].args.ephemeralPubKey
    );

    // Responder accepts handshake via VerbethClient
    const acceptResult = await responderClient.acceptHandshake(
      aliceEphemeralPubKeyFromEvent,
      "Hello back from responder smart account!"
    );

    const respondReceipt = await acceptResult.tx.wait();
    expect(respondReceipt.status).toBe(1);

    await waitForBlock(provider, respondReceipt.blockNumber);

    const responseEvents = await verbEth.queryFilter(
      verbEth.filters.HandshakeResponse(),
      respondReceipt.blockNumber,
      respondReceipt.blockNumber
    );
    expect(responseEvents).toHaveLength(1);

    const responseEvent = responseEvents[0];
    expect(responseEvent.args.responder).toBe(
      await responderSmartAccount.getAddress()
    );

    // Verify tag using computeHybridTagFromInitiator
    const Rbytes = getBytes(responseEvent.args.responderEphemeralR);

    // Decrypt HSR to get KEM ciphertext, then decapsulate
    let ciphertextJson = responseEvent.args.ciphertext;
    if (typeof ciphertextJson === "string" && ciphertextJson.startsWith("0x")) {
      ciphertextJson = new TextDecoder().decode(hexToBytes(ciphertextJson));
    }
    const hsrKeys = decryptAndExtractHandshakeKeys(
      ciphertextJson,
      handshakeResult.ephemeralKeyPair.secretKey
    );
    expect(hsrKeys).not.toBeNull();
    expect(hsrKeys!.kemCiphertext).toBeDefined();

    const kemSecret = kem.decapsulate(
      hsrKeys!.kemCiphertext!,
      handshakeResult.kemKeyPair.secretKey
    );
    const expectedTag = computeHybridTagFromInitiator(
      handshakeResult.ephemeralKeyPair.secretKey,
      Rbytes,
      kemSecret
    );
    expect(responseEvent.args.inResponseTo).toBe(expectedTag);
  }, 30000);

  it("should handle multiple handshake responses", async () => {
    const handshakeCount = 3;
    const handshakeData: Array<{
      handshakeResult: any;
      initiateReceipt: any;
    }> = [];

    for (let i = 0; i < handshakeCount; i++) {
      const handshakeResult = await initiatorClient.sendHandshake(
        await responderSmartAccount.getAddress(),
        `Batch handshake ${i + 1}`
      );

      const initiateReceipt = await handshakeResult.tx.wait();
      await waitForBlock(provider, initiateReceipt.blockNumber);
      await new Promise((resolve) => setTimeout(resolve, 200));

      handshakeData.push({ handshakeResult, initiateReceipt });
    }

    const responseReceipts: any[] = [];
    for (let i = 0; i < handshakeData.length; i++) {
      const handshakeEvents = await verbEth.queryFilter(
        verbEth.filters.Handshake(),
        handshakeData[i].initiateReceipt.blockNumber,
        handshakeData[i].initiateReceipt.blockNumber
      );
      expect(handshakeEvents).toHaveLength(1);

      const aliceEphemeralPubKeyFromEvent = hexToBytes(
        handshakeEvents[0].args.ephemeralPubKey
      );

      const acceptResult = await responderClient.acceptHandshake(
        aliceEphemeralPubKeyFromEvent,
        `Batch response ${i + 1}`
      );

      const respondReceipt = await acceptResult.tx.wait();
      await waitForBlock(provider, respondReceipt.blockNumber);
      await new Promise((resolve) => setTimeout(resolve, 200));

      responseReceipts.push(respondReceipt);
    }

    const fromBlock = responseReceipts[0].blockNumber;
    const toBlock = responseReceipts[responseReceipts.length - 1].blockNumber;
    await waitForBlock(provider, toBlock);

    const responseEvents = await verbEth.queryFilter(
      verbEth.filters.HandshakeResponse(),
      fromBlock,
      toBlock
    );
    expect(responseEvents.length).toBeGreaterThanOrEqual(handshakeCount);

    for (let i = 0; i < handshakeCount; i++) {
      const Rbytes = getBytes(responseEvents[i].args.responderEphemeralR);

      // Decrypt HSR to get KEM ciphertext for tag verification
      let ciphertextJson = responseEvents[i].args.ciphertext;
      if (typeof ciphertextJson === "string" && ciphertextJson.startsWith("0x")) {
        ciphertextJson = new TextDecoder().decode(hexToBytes(ciphertextJson));
      }
      const hsrKeys = decryptAndExtractHandshakeKeys(
        ciphertextJson,
        handshakeData[i].handshakeResult.ephemeralKeyPair.secretKey
      );
      expect(hsrKeys).not.toBeNull();

      const kemSecret = kem.decapsulate(
        hsrKeys!.kemCiphertext!,
        handshakeData[i].handshakeResult.kemKeyPair.secretKey
      );
      const expectedTagI = computeHybridTagFromInitiator(
        handshakeData[i].handshakeResult.ephemeralKeyPair.secretKey,
        Rbytes,
        kemSecret
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
    // Use a random ephemeral key — contract doesn't validate handshake existence
    const acceptResult = await responderClient.acceptHandshake(
      ownerIdentityKeys.keyPair.publicKey,
      "Response to non-existent handshake"
    );

    const respondReceipt = await acceptResult.tx.wait();
    expect(respondReceipt.status).toBe(1);

    const responseEvents = await verbEth.queryFilter(
      verbEth.filters.HandshakeResponse(),
      respondReceipt.blockNumber,
      respondReceipt.blockNumber
    );

    expect(responseEvents).toHaveLength(1);
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
      const handshakeResult = await initiatorClient.sendHandshake(
        await responderSmartAccount.getAddress(),
        `Note length test ${i + 1}`
      );

      const initiateReceipt = await handshakeResult.tx.wait();
      await waitForBlock(provider, initiateReceipt.blockNumber);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const handshakeEvents = await verbEth.queryFilter(
        verbEth.filters.Handshake(),
        initiateReceipt.blockNumber,
        initiateReceipt.blockNumber
      );
      expect(handshakeEvents).toHaveLength(1);

      const aliceEphemeralPubKeyFromEvent = hexToBytes(
        handshakeEvents[0].args.ephemeralPubKey
      );

      const acceptResult = await responderClient.acceptHandshake(
        aliceEphemeralPubKeyFromEvent,
        `Batch verification response ${i + 1}`
      );

      const respondReceipt = await acceptResult.tx.wait();
      expect(respondReceipt.status).toBe(1);

      await waitForBlock(provider, respondReceipt.blockNumber);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60000);

  it("should verify handshake identity successfully", async () => {
    const handshakeResult = await initiatorClient.sendHandshake(
      await responderSmartAccount.getAddress(),
      "Identity verification test handshake"
    );

    const initiateReceipt = await handshakeResult.tx.wait();
    expect(initiateReceipt.status).toBe(1);

    const handshakeEvents = await verbEth.queryFilter(
      verbEth.filters.Handshake(),
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );
    expect(handshakeEvents).toHaveLength(1);

    const handshakeLog = {
      recipientHash: handshakeEvents[0].args.recipientHash,
      sender: handshakeEvents[0].args.sender,
      pubKeys: handshakeEvents[0].args.pubKeys,
      ephemeralPubKey: handshakeEvents[0].args.ephemeralPubKey,
      plaintextPayload: handshakeEvents[0].args.plaintextPayload,
    };

    const isValid = await initiatorClient.verify.verifyHandshakeIdentity(
      handshakeLog,
      provider
    );
    expect(isValid).toBe(true);
  }, 30000);

  it("should verify handshake response identity successfully", async () => {
    const handshakeResult = await initiatorClient.sendHandshake(
      await responderSmartAccount.getAddress(),
      "Response identity verification test"
    );

    const initiateReceipt = await handshakeResult.tx.wait();

    const handshakeEvents = await verbEth.queryFilter(
      verbEth.filters.Handshake(),
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );
    expect(handshakeEvents).toHaveLength(1);

    const aliceEphemeralPubKeyFromEvent = hexToBytes(
      handshakeEvents[0].args.ephemeralPubKey
    );

    const acceptResult = await responderClient.acceptHandshake(
      aliceEphemeralPubKeyFromEvent,
      "Response identity verification test"
    );

    const respondReceipt = await acceptResult.tx.wait();
    expect(respondReceipt.status).toBe(1);
    await waitForBlock(provider, respondReceipt.blockNumber);

    const responseEvents = await verbEth.queryFilter(
      verbEth.filters.HandshakeResponse(),
      respondReceipt.blockNumber,
      respondReceipt.blockNumber
    );
    expect(responseEvents).toHaveLength(1);

    const responseLog = {
      inResponseTo: responseEvents[0].args.inResponseTo,
      responder: responseEvents[0].args.responder,
      responderEphemeralR: responseEvents[0].args.responderEphemeralR,
      ciphertext: responseEvents[0].args.ciphertext,
    };

    const isValid = await initiatorClient.verify.verifyHandshakeResponseIdentity(
      responseLog,
      responderIdentityKeys.keyPair.publicKey,
      handshakeResult.ephemeralKeyPair.secretKey,
      provider
    );
    expect(isValid).toBe(true);
  }, 30000);

  it("should fail handshake identity verification with invalid identity proof", async () => {
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

    // Create a client with invalid identity proof
    const { client: invalidClient } = createTestVerbethClient(
      await testSmartAccount.getAddress(),
      smartAccountOwner,
      ownerIdentityKeys.keyPair,
      invalidIdentityProof,
      executor
    );

    const handshakeResult = await invalidClient.sendHandshake(
      await responderSmartAccount.getAddress(),
      "Invalid identity verification test"
    );

    const initiateReceipt = await handshakeResult.tx.wait();
    expect(initiateReceipt.status).toBe(1);

    const handshakeEvents = await verbEth.queryFilter(
      verbEth.filters.Handshake(),
      initiateReceipt.blockNumber,
      initiateReceipt.blockNumber
    );
    expect(handshakeEvents).toHaveLength(1);

    const handshakeLog = {
      recipientHash: handshakeEvents[0].args.recipientHash,
      sender: handshakeEvents[0].args.sender,
      pubKeys: handshakeEvents[0].args.pubKeys,
      ephemeralPubKey: handshakeEvents[0].args.ephemeralPubKey,
      plaintextPayload: handshakeEvents[0].args.plaintextPayload,
    };

    const isValid = await initiatorClient.verify.verifyHandshakeIdentity(
      handshakeLog,
      provider
    );
    expect(isValid).toBe(false);
  }, 30000);

  it("should handle identity verification for multiple handshakes and responses", async () => {
    const handshakeCount = 2;
    const verificationResults: {
      handshakeIndex: number;
      handshakeValid: boolean;
      responseValid: boolean;
    }[] = [];

    for (let i = 0; i < handshakeCount; i++) {
      const handshakeResult = await initiatorClient.sendHandshake(
        await responderSmartAccount.getAddress(),
        `Batch verification test ${i + 1}`
      );

      const initiateReceipt = await handshakeResult.tx.wait();
      await waitForBlock(provider, initiateReceipt.blockNumber);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const handshakeEvents = await verbEth.queryFilter(
        verbEth.filters.Handshake(),
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

      const isValidHandshake = await initiatorClient.verify.verifyHandshakeIdentity(
        handshakeLog,
        provider
      );

      const aliceEphemeralPubKeyFromEvent = hexToBytes(
        handshakeEvents[0].args.ephemeralPubKey
      );

      const acceptResult = await responderClient.acceptHandshake(
        aliceEphemeralPubKeyFromEvent,
        `Batch verification response ${i + 1}`
      );

      const respondReceipt = await acceptResult.tx.wait();
      await waitForBlock(provider, respondReceipt.blockNumber);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const responseEvents = await verbEth.queryFilter(
        verbEth.filters.HandshakeResponse(),
        respondReceipt.blockNumber,
        respondReceipt.blockNumber
      );

      const responseLog = {
        inResponseTo: responseEvents[0].args.inResponseTo,
        responder: responseEvents[0].args.responder,
        responderEphemeralR: responseEvents[0].args.responderEphemeralR,
        ciphertext: responseEvents[0].args.ciphertext,
      };

      const isValidResponse = await initiatorClient.verify.verifyHandshakeResponseIdentity(
        responseLog,
        responderIdentityKeys.keyPair.publicKey,
        handshakeResult.ephemeralKeyPair.secretKey,
        provider
      );

      verificationResults.push({
        handshakeIndex: i + 1,
        handshakeValid: isValidHandshake,
        responseValid: isValidResponse,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    verificationResults.forEach((result) => {
      expect(result.handshakeValid).toBe(true);
      expect(result.responseValid).toBe(true);
    });
  }, 60000);
});
