// tests/e2e.test.ts
// End-to-end integration tests using VerbethClient high-level API
import { expect, describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
} from "ethers";
import {
  ExecutorFactory,
  DirectEntryPointExecutor,
  EOAExecutor,
  deriveIdentityKeyPairWithProof,
  decryptAndExtractHandshakeKeys,
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

function extractPayloadBytes(ciphertext: string): Uint8Array {
  if (typeof ciphertext === "string" && ciphertext.startsWith("0x")) {
    return hexToBytes(ciphertext);
  }
  return new TextEncoder().encode(ciphertext);
}

describe("End-to-End Handshake and Messaging Tests", () => {
  let anvil: AnvilSetup;
  let provider: JsonRpcProvider;
  let entryPoint: EntryPoint;
  let VERBETH: VerbethV1;
  let smartAccount: TestSmartAccount;
  let deployer: Wallet;
  let smartAccountOwner: Wallet;
  let eoaAccount1: Wallet;
  let eoaAccount2: Wallet;
  let smartAccountIdentityKeys: any;
  let eoaAccount1IdentityKeys: any;
  let smartAccountExecutor: DirectEntryPointExecutor;
  let eoaAccount1Executor: EOAExecutor;
  let bundler: Wallet;

  let aliceClient: VerbethClient;
  let aliceSessionStore: import("./utils.js").InMemorySessionStore;
  let bobClient: VerbethClient;
  let bobSessionStore: import("./utils.js").InMemorySessionStore;

  beforeAll(async () => {
    anvil = new AnvilSetup(8547);
    const forkUrl = "https://base-rpc.publicnode.com";
    await anvil.start(forkUrl);
    provider = anvil.provider;

    const testPrivateKeys = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926d",
    ];

    deployer = new Wallet(testPrivateKeys[0], provider);
    smartAccountOwner = new Wallet(testPrivateKeys[1], provider);
    eoaAccount1 = new Wallet(testPrivateKeys[2], provider);
    eoaAccount2 = new Wallet(testPrivateKeys[3], provider);
    bundler = new Wallet(testPrivateKeys[4], provider);

    const fundBundlerTx = await deployer.sendTransaction({
      to: bundler.address,
      value: parseEther("5"),
    });
    await fundBundlerTx.wait();
    await new Promise((r) => setTimeout(r, 100));

    entryPoint = EntryPoint__factory.connect(ENTRYPOINT_ADDR, provider);

    VERBETH = await deployVerbeth(deployer);

    const testSmartAccountFactory = new TestSmartAccount__factory(deployer);
    smartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      smartAccountOwner.address
    );
    await smartAccount.deploymentTransaction()?.wait();
    await new Promise((r) => setTimeout(r, 200));

    let deployerNonce = await provider.getTransactionCount(
      deployer.address,
      "pending"
    );

    const fundTx1 = await deployer.sendTransaction({
      to: await smartAccount.getAddress(),
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx1.wait();
    await new Promise((r) => setTimeout(r, 100));

    const fundTx2 = await deployer.sendTransaction({
      to: eoaAccount1.address,
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx2.wait();
    await new Promise((r) => setTimeout(r, 100));

    const fundTx3 = await deployer.sendTransaction({
      to: eoaAccount2.address,
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx3.wait();
    await new Promise((r) => setTimeout(r, 100));

    const smartAccountAddr = await smartAccount.getAddress();
    smartAccountIdentityKeys = await deriveIdentityKeyPairWithProof(
      smartAccountOwner,
      smartAccountAddr,
      smartAccountAddr
    );

    eoaAccount1IdentityKeys = await deriveIdentityKeyPairWithProof(
      eoaAccount1,
      eoaAccount1.address,
      eoaAccount1.address
    );
  }, 180000);

  afterAll(async () => {
    await anvil.stop();
  });

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));

    await provider.getTransactionCount(bundler.address, "latest");
    await provider.getTransactionCount(
      await smartAccount.getAddress(),
      "latest"
    );
    await provider.getBlockNumber();

    await new Promise((resolve) => setTimeout(resolve, 200));

    smartAccountExecutor = ExecutorFactory.createDirectEntryPoint(
      await smartAccount.getAddress(),
      entryPoint.connect(bundler) as unknown as Contract,
      await VERBETH.getAddress(),
      createMockSmartAccountClient(smartAccount, smartAccountOwner),
      bundler
    ) as DirectEntryPointExecutor;

    eoaAccount1Executor = ExecutorFactory.createEOA(
      VERBETH.connect(eoaAccount1)
    ) as EOAExecutor;

    // Create VerbethClient instances with fresh in-memory stores
    const smartAccountAddr = await smartAccount.getAddress();
    ({ client: aliceClient, sessionStore: aliceSessionStore } = createTestVerbethClient(
      smartAccountAddr,
      smartAccountOwner,
      smartAccountIdentityKeys.keyPair,
      smartAccountIdentityKeys.identityProof,
      smartAccountExecutor
    ));

    ({ client: bobClient, sessionStore: bobSessionStore } = createTestVerbethClient(
      eoaAccount1.address,
      eoaAccount1,
      eoaAccount1IdentityKeys.keyPair,
      eoaAccount1IdentityKeys.identityProof,
      eoaAccount1Executor
    ));
  });

  describe("Smart Account to EOA", () => {
    it("should complete full handshake and bidirectional ratchet messaging flow", async () => {
      // 1. Alice (Smart Account) sends handshake to Bob (EOA)
      const handshakeResult = await aliceClient.sendHandshake(
        eoaAccount1.address,
        "Hello EOA from Smart Account!"
      );

      const initiateReceipt = await handshakeResult.tx.wait();
      expect(initiateReceipt.status).toBe(1);
      await waitForBlock(provider, initiateReceipt.blockNumber);

      // 2. Verify handshake identity
      const handshakeEvents = await VERBETH.queryFilter(
        VERBETH.filters.Handshake(),
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

      const isValidHandshake = await aliceClient.verify.verifyHandshakeIdentity(
        handshakeLog,
        provider
      );
      expect(isValidHandshake).toBe(true);

      // 3. Get Alice's full ephemeral key from event (X25519 + ML-KEM = 1216 bytes)
      const aliceEphemeralPubKeyFromEvent = hexToBytes(
        handshakeEvent.args.ephemeralPubKey
      );

      // 4. Bob accepts handshake
      const acceptResult = await bobClient.acceptHandshake(
        aliceEphemeralPubKeyFromEvent,
        "Hello back from EOA!"
      );

      const respondReceipt = await acceptResult.tx.wait();
      expect(respondReceipt.status).toBe(1);
      await waitForBlock(provider, respondReceipt.blockNumber);

      // 5. Verify handshake response identity
      const responseEvents = await VERBETH.queryFilter(
        VERBETH.filters.HandshakeResponse(),
        respondReceipt.blockNumber,
        respondReceipt.blockNumber
      );
      expect(responseEvents).toHaveLength(1);
      const responseEvent = responseEvents[0];

      const responseLog = {
        inResponseTo: responseEvent.args.inResponseTo,
        responder: responseEvent.args.responder,
        responderEphemeralR: responseEvent.args.responderEphemeralR,
        ciphertext: responseEvent.args.ciphertext,
      };

      const isValidResponse = await aliceClient.verify.verifyHandshakeResponseIdentity(
        responseLog,
        eoaAccount1IdentityKeys.keyPair.publicKey,
        handshakeResult.ephemeralKeyPair.secretKey,
        provider
      );
      expect(isValidResponse).toBe(true);

      // 6. Alice decrypts HSR to get responder's ratchet pub key + KEM ciphertext
      let ciphertextJson = responseEvent.args.ciphertext;
      if (typeof ciphertextJson === "string" && ciphertextJson.startsWith("0x")) {
        ciphertextJson = new TextDecoder().decode(hexToBytes(ciphertextJson));
      }

      const hsrKeys = decryptAndExtractHandshakeKeys(
        ciphertextJson,
        handshakeResult.ephemeralKeyPair.secretKey
      );
      expect(hsrKeys).not.toBeNull();

      // 7. Create ratchet sessions
      const aliceSession = aliceClient.createInitiatorSession({
        contactAddress: eoaAccount1.address,
        initiatorEphemeralSecret: handshakeResult.ephemeralKeyPair.secretKey,
        responderEphemeralPubKey: hsrKeys!.ephemeralPubKey,
        inResponseToTag: responseEvent.args.inResponseTo as `0x${string}`,
        kemCiphertext: hsrKeys!.kemCiphertext,
        initiatorKemSecret: handshakeResult.kemKeyPair.secretKey,
      });

      const bobSession = bobClient.createResponderSession({
        contactAddress: await smartAccount.getAddress(),
        responderEphemeralSecret: acceptResult.responderEphemeralSecret,
        responderEphemeralPublic: acceptResult.responderEphemeralPublic,
        initiatorEphemeralPubKey: aliceEphemeralPubKeyFromEvent,
        salt: acceptResult.salt,
        kemSharedSecret: acceptResult.kemSharedSecret,
      });

      // Save sessions to stores
      await aliceSessionStore.save(aliceSession);
      await bobSessionStore.save(bobSession);

      // 8. Alice sends message to Bob via double ratchet
      const message1 = "First message from Smart Account to EOA";
      const sendResult1 = await aliceClient.sendMessage(
        aliceSession.conversationId,
        message1
      );

      const sendReceipt1 = await provider.waitForTransaction(sendResult1.txHash);
      expect(sendReceipt1!.status).toBe(1);
      await waitForBlock(provider, sendReceipt1!.blockNumber);

      // Query MessageSent event and decrypt
      const msgEvents1 = await VERBETH.queryFilter(
        VERBETH.filters.MessageSent(),
        sendReceipt1!.blockNumber,
        sendReceipt1!.blockNumber
      );
      const smartAccountAddress = await smartAccount.getAddress();
      const saMsg = msgEvents1.find((e) => e.args.sender === smartAccountAddress);
      expect(saMsg).toBeDefined();

      const msgPayload1 = extractPayloadBytes(saMsg!.args.ciphertext);

      const decrypted1 = await bobClient.decryptMessage(
        sendResult1.topic,
        msgPayload1,
        smartAccountIdentityKeys.keyPair.signingPublicKey
      );
      expect(decrypted1).not.toBeNull();
      expect(decrypted1!.plaintext).toBe(message1);

      // 9. Bob responds via double ratchet
      const message2 = "Response message from EOA to Smart Account";
      const sendResult2 = await bobClient.sendMessage(
        bobSession.conversationId,
        message2
      );

      const sendReceipt2 = await provider.waitForTransaction(sendResult2.txHash);
      expect(sendReceipt2!.status).toBe(1);
      await waitForBlock(provider, sendReceipt2!.blockNumber);

      const msgEvents2 = await VERBETH.queryFilter(
        VERBETH.filters.MessageSent(),
        sendReceipt2!.blockNumber,
        sendReceipt2!.blockNumber
      );
      const eoaMsg = msgEvents2.find((e) => e.args.sender === eoaAccount1.address);
      expect(eoaMsg).toBeDefined();

      const msgPayload2 = extractPayloadBytes(eoaMsg!.args.ciphertext);

      const decrypted2 = await aliceClient.decryptMessage(
        sendResult2.topic,
        msgPayload2,
        eoaAccount1IdentityKeys.keyPair.signingPublicKey
      );
      expect(decrypted2).not.toBeNull();
      expect(decrypted2!.plaintext).toBe(message2);
    }, 60000);
  });

  describe("EOA to Smart Account E2E", () => {
    it("should complete full handshake and bidirectional ratchet messaging flow", async () => {
      // Swap roles: Bob (EOA) initiates, Alice (SA) responds
      const eoaClient = bobClient;
      const saClient = aliceClient;

      // 1. EOA sends handshake to Smart Account
      const handshakeResult = await eoaClient.sendHandshake(
        await smartAccount.getAddress(),
        "Hello Smart Account from EOA!"
      );

      const initiateReceipt = await handshakeResult.tx.wait();
      expect(initiateReceipt.status).toBe(1);
      await waitForBlock(provider, initiateReceipt.blockNumber);

      // 2. Verify handshake identity
      const handshakeEvents = await VERBETH.queryFilter(
        VERBETH.filters.Handshake(),
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

      const isValidHandshake = await eoaClient.verify.verifyHandshakeIdentity(
        handshakeLog,
        provider
      );
      expect(isValidHandshake).toBe(true);

      // 3. Get EOA's ephemeral key from event
      const eoaEphemeralPubKeyFromEvent = hexToBytes(
        handshakeEvent.args.ephemeralPubKey
      );

      // 4. Smart Account accepts handshake
      const acceptResult = await saClient.acceptHandshake(
        eoaEphemeralPubKeyFromEvent,
        "Hello back from Smart Account!"
      );

      const respondReceipt = await acceptResult.tx.wait();
      expect(respondReceipt.status).toBe(1);
      await waitForBlock(provider, respondReceipt.blockNumber);

      // 5. Verify handshake response identity
      const responseEvents = await VERBETH.queryFilter(
        VERBETH.filters.HandshakeResponse(),
        respondReceipt.blockNumber,
        respondReceipt.blockNumber
      );
      expect(responseEvents).toHaveLength(1);
      const responseEvent = responseEvents[0];

      const responseLog = {
        inResponseTo: responseEvent.args.inResponseTo,
        responder: responseEvent.args.responder,
        responderEphemeralR: responseEvent.args.responderEphemeralR,
        ciphertext: responseEvent.args.ciphertext,
      };

      const isValidResponse = await eoaClient.verify.verifyHandshakeResponseIdentity(
        responseLog,
        smartAccountIdentityKeys.keyPair.publicKey,
        handshakeResult.ephemeralKeyPair.secretKey,
        provider
      );
      expect(isValidResponse).toBe(true);

      // 6. EOA decrypts HSR
      let ciphertextJson = responseEvent.args.ciphertext;
      if (typeof ciphertextJson === "string" && ciphertextJson.startsWith("0x")) {
        ciphertextJson = new TextDecoder().decode(hexToBytes(ciphertextJson));
      }

      const hsrKeys = decryptAndExtractHandshakeKeys(
        ciphertextJson,
        handshakeResult.ephemeralKeyPair.secretKey
      );
      expect(hsrKeys).not.toBeNull();

      // 7. Create ratchet sessions
      const smartAccountAddr = await smartAccount.getAddress();

      const eoaSession = eoaClient.createInitiatorSession({
        contactAddress: smartAccountAddr,
        initiatorEphemeralSecret: handshakeResult.ephemeralKeyPair.secretKey,
        responderEphemeralPubKey: hsrKeys!.ephemeralPubKey,
        inResponseToTag: responseEvent.args.inResponseTo as `0x${string}`,
        kemCiphertext: hsrKeys!.kemCiphertext,
        initiatorKemSecret: handshakeResult.kemKeyPair.secretKey,
      });

      const saSession = saClient.createResponderSession({
        contactAddress: eoaAccount1.address,
        responderEphemeralSecret: acceptResult.responderEphemeralSecret,
        responderEphemeralPublic: acceptResult.responderEphemeralPublic,
        initiatorEphemeralPubKey: eoaEphemeralPubKeyFromEvent,
        salt: acceptResult.salt,
        kemSharedSecret: acceptResult.kemSharedSecret,
      });

      // Save sessions to stores
      await bobSessionStore.save(eoaSession);
      await aliceSessionStore.save(saSession);

      // 8. EOA sends message to Smart Account
      const message1 = "First message from EOA to Smart Account";
      const sendResult1 = await eoaClient.sendMessage(
        eoaSession.conversationId,
        message1
      );

      const sendReceipt1 = await provider.waitForTransaction(sendResult1.txHash);
      expect(sendReceipt1!.status).toBe(1);
      await waitForBlock(provider, sendReceipt1!.blockNumber);

      const msgEvents1 = await VERBETH.queryFilter(
        VERBETH.filters.MessageSent(),
        sendReceipt1!.blockNumber,
        sendReceipt1!.blockNumber
      );
      const eoaMsg = msgEvents1.find((e) => e.args.sender === eoaAccount1.address);
      expect(eoaMsg).toBeDefined();

      const msgPayload1 = extractPayloadBytes(eoaMsg!.args.ciphertext);

      const decrypted1 = await saClient.decryptMessage(
        sendResult1.topic,
        msgPayload1,
        eoaAccount1IdentityKeys.keyPair.signingPublicKey
      );
      expect(decrypted1).not.toBeNull();
      expect(decrypted1!.plaintext).toBe(message1);

      // 9. Smart Account responds
      const message2 = "Response message from Smart Account to EOA";
      const sendResult2 = await saClient.sendMessage(
        saSession.conversationId,
        message2
      );

      const sendReceipt2 = await provider.waitForTransaction(sendResult2.txHash);
      expect(sendReceipt2!.status).toBe(1);
      await waitForBlock(provider, sendReceipt2!.blockNumber);

      const msgEvents2 = await VERBETH.queryFilter(
        VERBETH.filters.MessageSent(),
        sendReceipt2!.blockNumber,
        sendReceipt2!.blockNumber
      );
      const saMsg = msgEvents2.find(
        (e) => e.args.sender === smartAccountAddr
      );
      expect(saMsg).toBeDefined();

      const msgPayload2 = extractPayloadBytes(saMsg!.args.ciphertext);

      const decrypted2 = await eoaClient.decryptMessage(
        sendResult2.topic,
        msgPayload2,
        smartAccountIdentityKeys.keyPair.signingPublicKey
      );
      expect(decrypted2).not.toBeNull();
      expect(decrypted2!.plaintext).toBe(message2);
    }, 60000);
  });
});
