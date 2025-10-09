// tests/e2e.test.ts
// This file contains end-to-end integration tests for handshaking and messaging
import { expect, describe, it, beforeAll, afterAll } from "vitest";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  NonceManager,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import nacl from "tweetnacl";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import {
  ExecutorFactory,
  initiateHandshake,
  respondToHandshake,
  DirectEntryPointExecutor,
  EOAExecutor,
  verifyHandshakeIdentity,
  verifyHandshakeResponseIdentity,
  sendEncryptedMessage,
  decryptMessage,
  deriveIdentityKeyPairWithProof,
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

const hexToBytes = (hex: string) =>
  new Uint8Array(Buffer.from(hex.slice(2), "hex"));

const deriveTopic = (
  shared: Uint8Array,
  info: string,
  salt: Uint8Array
): `0x${string}` => {
  const okm = hkdf(sha256, shared, salt, toUtf8Bytes(info), 32);
  return keccak256(okm) as `0x${string}`;
};

const deriveDuplex = (
  mySecret: Uint8Array,
  theirPub: Uint8Array,
  saltHex: `0x${string}`
) => {
  const shared = nacl.scalarMult(mySecret, theirPub);
  const salt = hexToBytes(saltHex);
  return {
    topicOut: deriveTopic(shared, "verbeth:topic-out:v1", salt), // Initiator→Responder
    topicIn: deriveTopic(shared, "verbeth:topic-in:v1", salt), // Responder→Initiator
  } as const;
};

describe("End-to-End Handshake and Messaging Tests", () => {
  let anvil: AnvilSetup;
  let provider: JsonRpcProvider;
  let entryPoint: EntryPoint;
  let logChain: LogChainV1;
  let smartAccount: TestSmartAccount;
  let deployer: Wallet;
  let smartAccountOwner: Wallet;
  let eoaAccount1: NonceManager;
  let eoaAccount2: NonceManager;
  let smartAccountIdentityKeys: any;
  let eoaAccount1IdentityKeys: any;
  let eoaAccount2IdentityKeys: any;
  let smartAccountExecutor: DirectEntryPointExecutor;
  let eoaAccount1Executor: EOAExecutor;
  let eoaAccount2Executor: EOAExecutor;
  let deployerNM: NonceManager;

  beforeAll(async () => {
    anvil = new AnvilSetup(8547);
    const forkUrl = "https://base-rpc.publicnode.com";
    await anvil.start(forkUrl);
    provider = anvil.provider;

    const testPrivateKeys = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    ];

    deployer = new Wallet(testPrivateKeys[0], provider);
    deployerNM = new NonceManager(deployer);
    smartAccountOwner = new Wallet(testPrivateKeys[1], provider);
    const eoaWallet1 = Wallet.createRandom().connect(provider);
    const eoaWallet2 = Wallet.createRandom().connect(provider);
    eoaAccount1 = new NonceManager(eoaWallet1);
    eoaAccount2 = new NonceManager(eoaWallet2);

    entryPoint = EntryPoint__factory.connect(ENTRYPOINT_ADDR, provider);

    const logChainFactory = new LogChainV1__factory(deployerNM);
    const logChainImpl = await logChainFactory.deploy();
    await logChainImpl.waitForDeployment();

    const initData = logChainFactory.interface.encodeFunctionData(
      "initialize",
      []
    );

    const proxyFactory = new ERC1967Proxy__factory(deployerNM);
    const proxy = await proxyFactory.deploy(
      await logChainImpl.getAddress(),
      initData
    );
    await proxy.waitForDeployment();

    logChain = LogChainV1__factory.connect(
      await proxy.getAddress(),
      deployerNM
    );

    const testSmartAccountFactory = new TestSmartAccount__factory(deployerNM);
    smartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      smartAccountOwner.address
    );
    await smartAccount.waitForDeployment();

    // fund accounts
    await deployerNM.sendTransaction({
      to: await smartAccount.getAddress(),
      value: parseEther("1"),
    });
    await deployerNM.sendTransaction({
      to: (eoaAccount1.signer as Wallet).address,
      value: parseEther("1"),
    });
    await deployerNM.sendTransaction({
      to: (eoaAccount2.signer as Wallet).address,
      value: parseEther("1"),
    });

    // derive identity keys using the correct SDK function with full keypairs
    smartAccountIdentityKeys = await deriveIdentityKeyPairWithProof(
      smartAccountOwner,
      await smartAccount.getAddress()
    );

    eoaAccount1IdentityKeys = await deriveIdentityKeyPairWithProof(
      eoaAccount1.signer as Wallet,
      (eoaAccount1.signer as Wallet).address
    );

    eoaAccount2IdentityKeys = await deriveIdentityKeyPairWithProof(
      eoaAccount2.signer as Wallet,
      (eoaAccount2.signer as Wallet).address
    );

    smartAccountExecutor = ExecutorFactory.createDirectEntryPoint(
      await smartAccount.getAddress(),
      entryPoint.connect(deployer) as unknown as Contract,
      await logChain.getAddress(),
      createMockSmartAccountClient(smartAccount, smartAccountOwner),
      deployerNM
    ) as DirectEntryPointExecutor;

    eoaAccount1Executor = ExecutorFactory.createEOA(
      logChain.connect(eoaAccount1)
    ) as EOAExecutor;

    eoaAccount2Executor = ExecutorFactory.createEOA(
      logChain.connect(eoaAccount2)
    ) as EOAExecutor;
  }, 80000);

  afterAll(async () => {
    await anvil.stop();
  });

  describe("Smart Account to EOA", () => {
    it("should complete full handshake and bidirectional messaging flow", async () => {
      // 1. Smart Account initiates handshake with EOA
      const ephemeralKeys = nacl.box.keyPair();
      const initiateHandshakeTx = await initiateHandshake({
        executor: smartAccountExecutor,
        recipientAddress: (eoaAccount1.signer as Wallet).address,
        identityKeyPair: smartAccountIdentityKeys.keyPair,
        ephemeralPubKey: ephemeralKeys.publicKey,
        plaintextPayload: "Hello EOA from Smart Account!",
        identityProof: smartAccountIdentityKeys.identityProof,
        signer: smartAccountOwner,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();
      expect(initiateReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 2. Verify handshake identity
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

      // 3. EOA responds to handshake
      const respondTx = await respondToHandshake({
        executor: eoaAccount1Executor,
        initiatorPubKey: ephemeralKeys.publicKey,
        responderIdentityKeyPair: eoaAccount1IdentityKeys.keyPair,
        note: "Hello back from EOA!",
        identityProof: eoaAccount1IdentityKeys.identityProof,
        signer: eoaAccount1.signer as Wallet,
        initiatorIdentityPubKey: smartAccountIdentityKeys.keyPair.publicKey,
      });

      const respondReceipt = await respondTx.tx.wait();
      expect(respondReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 4. Verify handshake response identity
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
        responderEphemeralR: responseEvent.args.responderEphemeralR,
        ciphertext: responseEvent.args.ciphertext,
      };

      // Derive duplex topics dal long-term DH e salt = inResponseTo
      const { topicOut: saToEoaTopic, topicIn: eoaToSaTopic } = deriveDuplex(
        smartAccountIdentityKeys.keyPair.secretKey, // Alice (initiator) secret
        eoaAccount1IdentityKeys.keyPair.publicKey, // Bob (responder) pub
        responseEvent.args.inResponseTo as `0x${string}` // salt
      );

      const isValidResponse = await verifyHandshakeResponseIdentity(
        responseLog,
        eoaAccount1IdentityKeys.keyPair.publicKey,
        ephemeralKeys.secretKey,
        provider
      );
      console.log("debug isValidResponse:", isValidResponse);
      expect(isValidResponse).toBe(true);

      // 5. Smart Account sends message to EOA
      const message1 = "First message from Smart Account to EOA";

      const sendTx1 = await sendEncryptedMessage({
        executor: smartAccountExecutor,
        topic: saToEoaTopic, // Initiator→Responder
        message: message1,
        recipientPubKey: eoaAccount1IdentityKeys.keyPair.publicKey,
        senderAddress: await smartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: smartAccountIdentityKeys.keyPair.signingSecretKey,
          publicKey: smartAccountIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });

      const sendReceipt1 = await sendTx1.wait();
      expect(sendReceipt1.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt1.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 6. EOA responds with message to Smart Account
      const message2 = "Response message from EOA to Smart Account";

      const sendTx2 = await sendEncryptedMessage({
        executor: eoaAccount1Executor,
        topic: eoaToSaTopic, // Responder→Initiator
        message: message2,
        recipientPubKey: smartAccountIdentityKeys.keyPair.publicKey,
        senderAddress: (eoaAccount1.signer as Wallet).address,
        senderSignKeyPair: {
          secretKey: eoaAccount1IdentityKeys.keyPair.signingSecretKey,
          publicKey: eoaAccount1IdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000) + 1,
      });

      const sendReceipt2 = await sendTx2.wait();
      expect(sendReceipt2.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt2.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 7. Verify both messages can be decrypted
      const messageFilter = logChain.filters.MessageSent();

      // Get Smart Account's message
      const saMessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt1.blockNumber,
        sendReceipt1.blockNumber
      );

      // Get EOA's message
      const eoaMessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt2.blockNumber,
        sendReceipt2.blockNumber
      );

      const smartAccountAddress = await smartAccount.getAddress();
      const saMessageEvent = saMessageEvents.find(
        (event) => event.args.sender === smartAccountAddress
      );
      const eoaMessageEvent = eoaMessageEvents.find(
        (event) => event.args.sender === (eoaAccount1.signer as Wallet).address
      );

      expect(saMessageEvent).toBeDefined();
      expect(eoaMessageEvent).toBeDefined();

      // EOA decrypts Smart Account's message
      let saCiphertextJson = saMessageEvent!.args.ciphertext;
      if (
        typeof saMessageEvent!.args.ciphertext === "string" &&
        saMessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(saMessageEvent!.args.ciphertext.slice(2), "hex")
          );
          saCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      const eoaDecryptedMessage = decryptMessage(
        saCiphertextJson,
        eoaAccount1IdentityKeys.keyPair.secretKey,
        smartAccountIdentityKeys.keyPair.signingPublicKey
      );
      expect(eoaDecryptedMessage).toBe(message1);

      // Smart Account decrypts EOA's message
      let eoaCiphertextJson = eoaMessageEvent!.args.ciphertext;
      if (
        typeof eoaMessageEvent!.args.ciphertext === "string" &&
        eoaMessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(eoaMessageEvent!.args.ciphertext.slice(2), "hex")
          );
          eoaCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {}
      }

      const saDecryptedMessage = decryptMessage(
        eoaCiphertextJson,
        smartAccountIdentityKeys.keyPair.secretKey,
        eoaAccount1IdentityKeys.keyPair.signingPublicKey
      );
      expect(saDecryptedMessage).toBe(message2);
    }, 60000);
  });

  describe("EOA to Smart Account E2E", () => {
    it("should complete full handshake and bidirectional messaging flow", async () => {
      // 1. EOA initiates handshake with Smart Account
      const ephemeralKeys = nacl.box.keyPair();
      const initiateHandshakeTx = await initiateHandshake({
        executor: eoaAccount1Executor,
        recipientAddress: await smartAccount.getAddress(),
        identityKeyPair: eoaAccount1IdentityKeys.keyPair,
        ephemeralPubKey: ephemeralKeys.publicKey,
        plaintextPayload: "Hello Smart Account from EOA!",
        identityProof: eoaAccount1IdentityKeys.identityProof,
        signer: eoaAccount1.signer as Wallet,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();
      expect(initiateReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 2. Verify handshake identity
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

      // 3. Smart Account responds to handshake
      const respondTx = await respondToHandshake({
        executor: smartAccountExecutor,
        initiatorPubKey: ephemeralKeys.publicKey,
        responderIdentityKeyPair: smartAccountIdentityKeys.keyPair,
        note: "Hello back from Smart Account!",
        identityProof: smartAccountIdentityKeys.identityProof,
        signer: smartAccountOwner,
        initiatorIdentityPubKey: eoaAccount1IdentityKeys.keyPair.publicKey,
      });

      const respondReceipt = await respondTx.tx.wait();
      expect(respondReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 4. Verify handshake response identity
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
        responderEphemeralR: responseEvent.args.responderEphemeralR,
        ciphertext: responseEvent.args.ciphertext,
      };

      const { topicOut: eoaToSaTopic, topicIn: saToEoaTopic } = deriveDuplex(
        eoaAccount1IdentityKeys.keyPair.secretKey, // Alice (initiator)
        smartAccountIdentityKeys.keyPair.publicKey, // Bob (responder)
        responseEvent.args.inResponseTo as `0x${string}`
      );

      const isValidResponse = await verifyHandshakeResponseIdentity(
        responseLog,
        smartAccountIdentityKeys.keyPair.publicKey,
        ephemeralKeys.secretKey,
        provider
      );
      expect(isValidResponse).toBe(true);

      // 5. EOA sends message to Smart Account
      const message1 = "First message from EOA to Smart Account";

      const sendTx1 = await sendEncryptedMessage({
        executor: eoaAccount1Executor,
        topic: eoaToSaTopic, // Initiator→Responder
        message: message1,
        recipientPubKey: smartAccountIdentityKeys.keyPair.publicKey,
        senderAddress: (eoaAccount1.signer as Wallet).address,
        senderSignKeyPair: {
          secretKey: eoaAccount1IdentityKeys.keyPair.signingSecretKey,
          publicKey: eoaAccount1IdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });

      const sendReceipt1 = await sendTx1.wait();
      expect(sendReceipt1.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt1.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 6. Smart Account responds with message to EOA
      const message2 = "Response message from Smart Account to EOA";

      const sendTx2 = await sendEncryptedMessage({
        executor: smartAccountExecutor,
        topic: saToEoaTopic, // Responder→Initiator
        message: message2,
        recipientPubKey: eoaAccount1IdentityKeys.keyPair.publicKey,
        senderAddress: await smartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: smartAccountIdentityKeys.keyPair.signingSecretKey,
          publicKey: smartAccountIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000) + 1,
      });

      const sendReceipt2 = await sendTx2.wait();
      expect(sendReceipt2.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt2.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 7. Verify both messages can be decrypted
      const messageFilter = logChain.filters.MessageSent();

      const eoaMessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt1.blockNumber,
        sendReceipt1.blockNumber
      );

      const saMessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt2.blockNumber,
        sendReceipt2.blockNumber
      );

      const eoaMessageEvent = eoaMessageEvents.find(
        (event) => event.args.sender === (eoaAccount1.signer as Wallet).address
      );
      const smartAccountAddress = await smartAccount.getAddress();
      const saMessageEvent = saMessageEvents.find(
        (event) => event.args.sender === smartAccountAddress
      );

      expect(eoaMessageEvent).toBeDefined();
      expect(saMessageEvent).toBeDefined();

      // Smart Account decrypts EOA's message
      let eoaCiphertextJson = eoaMessageEvent!.args.ciphertext;
      if (
        typeof eoaMessageEvent!.args.ciphertext === "string" &&
        eoaMessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(eoaMessageEvent!.args.ciphertext.slice(2), "hex")
          );
          eoaCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {}
      }

      const saDecryptedMessage = decryptMessage(
        eoaCiphertextJson,
        smartAccountIdentityKeys.keyPair.secretKey,
        eoaAccount1IdentityKeys.keyPair.signingPublicKey
      );
      expect(saDecryptedMessage).toBe(message1);

      // EOA decrypts Smart Account's message
      let saCiphertextJson = saMessageEvent!.args.ciphertext;
      if (
        typeof saMessageEvent!.args.ciphertext === "string" &&
        saMessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(saMessageEvent!.args.ciphertext.slice(2), "hex")
          );
          saCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      const eoaDecryptedMessage = decryptMessage(
        saCiphertextJson,
        eoaAccount1IdentityKeys.keyPair.secretKey,
        smartAccountIdentityKeys.keyPair.signingPublicKey
      );
      expect(eoaDecryptedMessage).toBe(message2);
    }, 60000);
  });

  describe("Smart Account to Smart Account", () => {
    it("should complete full handshake and bidirectional messaging flow", async () => {
      const secondSmartAccount = await new TestSmartAccount__factory(
        deployerNM
      ).deploy(ENTRYPOINT_ADDR, (eoaAccount1.signer as Wallet).address);
      await secondSmartAccount.waitForDeployment();
      await deployerNM.sendTransaction({
        to: await secondSmartAccount.getAddress(),
        value: parseEther("1"),
      });

      const secondSmartAccountIdentityKeys =
        await deriveIdentityKeyPairWithProof(
          eoaAccount1.signer as Wallet,
          await secondSmartAccount.getAddress()
        );

      const secondSmartAccountExecutor = ExecutorFactory.createDirectEntryPoint(
        await secondSmartAccount.getAddress(),
        entryPoint.connect(deployer) as unknown as Contract,
        await logChain.getAddress(),
        createMockSmartAccountClient(
          secondSmartAccount,
          eoaAccount1.signer as Wallet
        ),
        deployerNM
      ) as DirectEntryPointExecutor;

      // 1. First Smart Account initiates handshake with Second Smart Account
      const ephemeralKeys = nacl.box.keyPair();

      const initiateHandshakeTx = await initiateHandshake({
        executor: smartAccountExecutor,
        recipientAddress: await secondSmartAccount.getAddress(),
        identityKeyPair: smartAccountIdentityKeys.keyPair,
        ephemeralPubKey: ephemeralKeys.publicKey,
        plaintextPayload: "Hello from first Smart Account!",
        identityProof: smartAccountIdentityKeys.identityProof,
        signer: smartAccountOwner,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();
      expect(initiateReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 2. Verify handshake identity
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

      // 3. Second Smart Account responds to handshake
      const respondTx = await respondToHandshake({
        executor: secondSmartAccountExecutor,
        initiatorPubKey: ephemeralKeys.publicKey,
        responderIdentityKeyPair: secondSmartAccountIdentityKeys.keyPair,
        note: "Hello back from second Smart Account!",
        identityProof: secondSmartAccountIdentityKeys.identityProof,
        signer: eoaAccount1.signer as Wallet,
        initiatorIdentityPubKey: smartAccountIdentityKeys.keyPair.publicKey,
      });

      const respondReceipt = await respondTx.tx.wait();
      expect(respondReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 4. Verify handshake response identity
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
        responderEphemeralR: responseEvent.args.responderEphemeralR,
        ciphertext: responseEvent.args.ciphertext,
      };

      const { topicOut: sa1ToSa2Topic, topicIn: sa2ToSa1Topic } = deriveDuplex(
        smartAccountIdentityKeys.keyPair.secretKey,
        secondSmartAccountIdentityKeys.keyPair.publicKey,
        responseEvent.args.inResponseTo as `0x${string}`
      );

      const isValidResponse = await verifyHandshakeResponseIdentity(
        responseLog,
        secondSmartAccountIdentityKeys.keyPair.publicKey,
        ephemeralKeys.secretKey,
        provider
      );
      expect(isValidResponse).toBe(true);

      // 5. First Smart Account sends message to Second Smart Account
      const message1 = "First message between Smart Accounts";

      const sendTx1 = await sendEncryptedMessage({
        executor: smartAccountExecutor,
        topic: sa1ToSa2Topic, // Initiator→Responder
        message: message1,
        recipientPubKey: secondSmartAccountIdentityKeys.keyPair.publicKey,
        senderAddress: await smartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: smartAccountIdentityKeys.keyPair.signingSecretKey,
          publicKey: smartAccountIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });

      const sendReceipt1 = await sendTx1.wait();
      expect(sendReceipt1.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt1.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 6. Second Smart Account responds with message
      const message2 = "Response between Smart Accounts";

      const sendTx2 = await sendEncryptedMessage({
        executor: secondSmartAccountExecutor,
        topic: sa2ToSa1Topic, // Responder→Initiator
        message: message2,
        recipientPubKey: smartAccountIdentityKeys.keyPair.publicKey,
        senderAddress: await secondSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: secondSmartAccountIdentityKeys.keyPair.signingSecretKey,
          publicKey: secondSmartAccountIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000) + 1,
      });

      const sendReceipt2 = await sendTx2.wait();
      expect(sendReceipt2.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt2.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 7. Verify both messages can be decrypted
      const messageFilter = logChain.filters.MessageSent();

      const sa1MessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt1.blockNumber,
        sendReceipt1.blockNumber
      );

      const sa2MessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt2.blockNumber,
        sendReceipt2.blockNumber
      );

      const smartAccountAddress = await smartAccount.getAddress();
      const sa1MessageEvent = sa1MessageEvents.find(
        (event) => event.args.sender === smartAccountAddress
      );
      const secondSmartAccountAddress = await secondSmartAccount.getAddress();
      const sa2MessageEvent = sa2MessageEvents.find(
        (event) => event.args.sender === secondSmartAccountAddress
      );

      expect(sa1MessageEvent).toBeDefined();
      expect(sa2MessageEvent).toBeDefined();

      // Second Smart Account decrypts first Smart Account's message
      let sa1CiphertextJson = sa1MessageEvent!.args.ciphertext;
      if (
        typeof sa1MessageEvent!.args.ciphertext === "string" &&
        sa1MessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(sa1MessageEvent!.args.ciphertext.slice(2), "hex")
          );
          sa1CiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {}
      }

      const sa2DecryptedMessage = decryptMessage(
        sa1CiphertextJson,
        secondSmartAccountIdentityKeys.keyPair.secretKey,
        smartAccountIdentityKeys.keyPair.signingPublicKey
      );
      expect(sa2DecryptedMessage).toBe(message1);

      // First Smart Account decrypts second Smart Account's message
      let sa2CiphertextJson = sa2MessageEvent!.args.ciphertext;
      if (
        typeof sa2MessageEvent!.args.ciphertext === "string" &&
        sa2MessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(sa2MessageEvent!.args.ciphertext.slice(2), "hex")
          );
          sa2CiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {}
      }

      const sa1DecryptedMessage = decryptMessage(
        sa2CiphertextJson,
        smartAccountIdentityKeys.keyPair.secretKey,
        secondSmartAccountIdentityKeys.keyPair.signingPublicKey
      );
      expect(sa1DecryptedMessage).toBe(message2);
    }, 80000);
  });

  describe("EOA to EOA", () => {
    it("should complete full handshake and bidirectional messaging flow", async () => {
      // 1. First EOA initiates handshake with Second EOA
      const ephemeralKeys = nacl.box.keyPair();
      const initiateHandshakeTx = await initiateHandshake({
        executor: eoaAccount1Executor,
        recipientAddress: (eoaAccount2.signer as Wallet).address,
        identityKeyPair: eoaAccount1IdentityKeys.keyPair,
        ephemeralPubKey: ephemeralKeys.publicKey,
        plaintextPayload: "Hello from first EOA!",
        identityProof: eoaAccount1IdentityKeys.identityProof,
        signer: eoaAccount1.signer as Wallet,
      });

      const initiateReceipt = await initiateHandshakeTx.wait();
      expect(initiateReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < initiateReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 2. Verify handshake identity
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

      // 3. Second EOA responds to handshake
      const respondTx = await respondToHandshake({
        executor: eoaAccount2Executor,
        initiatorPubKey: ephemeralKeys.publicKey,
        responderIdentityKeyPair: eoaAccount2IdentityKeys.keyPair,
        note: "Hello back from second EOA!",
        identityProof: eoaAccount2IdentityKeys.identityProof,
        signer: eoaAccount2.signer as Wallet,
        initiatorIdentityPubKey: eoaAccount1IdentityKeys.keyPair.publicKey,
      });

      const respondReceipt = await respondTx.tx.wait();
      expect(respondReceipt.status).toBe(1);

      while ((await provider.getBlockNumber()) < respondReceipt.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 4. Verify handshake response identity
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
        responderEphemeralR: responseEvent.args.responderEphemeralR,
        ciphertext: responseEvent.args.ciphertext,
      };

      const { topicOut: eoa1ToEoa2Topic, topicIn: eoa2ToEoa1Topic } =
        deriveDuplex(
          eoaAccount1IdentityKeys.keyPair.secretKey,
          eoaAccount2IdentityKeys.keyPair.publicKey,
          responseEvent.args.inResponseTo as `0x${string}`
        );

      const isValidResponse = await verifyHandshakeResponseIdentity(
        responseLog,
        eoaAccount2IdentityKeys.keyPair.publicKey,
        ephemeralKeys.secretKey,
        provider
      );
      expect(isValidResponse).toBe(true);

      // 5. First EOA sends message to Second EOA
      const message1 = "First message between EOAs";

      const sendTx1 = await sendEncryptedMessage({
        executor: eoaAccount1Executor,
        topic: eoa1ToEoa2Topic, // Initiator→Responder
        message: message1,
        recipientPubKey: eoaAccount2IdentityKeys.keyPair.publicKey,
        senderAddress: (eoaAccount1.signer as Wallet).address,
        senderSignKeyPair: {
          secretKey: eoaAccount1IdentityKeys.keyPair.signingSecretKey,
          publicKey: eoaAccount1IdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });

      const sendReceipt1 = await sendTx1.wait();
      expect(sendReceipt1.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt1.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 6. Second EOA responds with message
      const message2 = "Response between EOAs";

      const sendTx2 = await sendEncryptedMessage({
        executor: eoaAccount2Executor,
        topic: eoa2ToEoa1Topic, // Responder→Initiator
        message: message2,
        recipientPubKey: eoaAccount1IdentityKeys.keyPair.publicKey,
        senderAddress: (eoaAccount2.signer as Wallet).address,
        senderSignKeyPair: {
          secretKey: eoaAccount2IdentityKeys.keyPair.signingSecretKey,
          publicKey: eoaAccount2IdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000) + 1,
      });

      const sendReceipt2 = await sendTx2.wait();
      expect(sendReceipt2.status).toBe(1);

      while ((await provider.getBlockNumber()) < sendReceipt2.blockNumber) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 7. Verify both messages can be decrypted
      const messageFilter = logChain.filters.MessageSent();

      const eoa1MessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt1.blockNumber,
        sendReceipt1.blockNumber
      );

      const eoa2MessageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt2.blockNumber,
        sendReceipt2.blockNumber
      );

      const eoa1MessageEvent = eoa1MessageEvents.find(
        (event) => event.args.sender === (eoaAccount1.signer as Wallet).address
      );
      const eoa2MessageEvent = eoa2MessageEvents.find(
        (event) => event.args.sender === (eoaAccount2.signer as Wallet).address
      );

      expect(eoa1MessageEvent).toBeDefined();
      expect(eoa2MessageEvent).toBeDefined();

      // Second EOA decrypts first EOA's message
      let eoa1CiphertextJson = eoa1MessageEvent!.args.ciphertext;
      if (
        typeof eoa1MessageEvent!.args.ciphertext === "string" &&
        eoa1MessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(eoa1MessageEvent!.args.ciphertext.slice(2), "hex")
          );
          eoa1CiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {}
      }

      const eoa2DecryptedMessage = decryptMessage(
        eoa1CiphertextJson,
        eoaAccount2IdentityKeys.keyPair.secretKey,
        eoaAccount1IdentityKeys.keyPair.signingPublicKey
      );
      expect(eoa2DecryptedMessage).toBe(message1);

      // First EOA decrypts second EOA's message
      let eoa2CiphertextJson = eoa2MessageEvent!.args.ciphertext;
      if (
        typeof eoa2MessageEvent!.args.ciphertext === "string" &&
        eoa2MessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(
            Buffer.from(eoa2MessageEvent!.args.ciphertext.slice(2), "hex")
          );
          eoa2CiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {}
      }

      const eoa1DecryptedMessage = decryptMessage(
        eoa2CiphertextJson,
        eoaAccount1IdentityKeys.keyPair.secretKey,
        eoaAccount2IdentityKeys.keyPair.signingPublicKey
      );
      expect(eoa1DecryptedMessage).toBe(message2);
    }, 60000);
  });
});
