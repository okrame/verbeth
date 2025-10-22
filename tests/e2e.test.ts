// tests/e2e.test.ts
// This file contains end-to-end integration tests for handshaking and messaging
import { expect, describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
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
  let eoaAccount1: Wallet;
  let eoaAccount2: Wallet;
  let smartAccountIdentityKeys: any;
  let eoaAccount1IdentityKeys: any;
  let smartAccountExecutor: DirectEntryPointExecutor;
  let eoaAccount1Executor: EOAExecutor;
  let eoaAccount2Executor: EOAExecutor;
  let bundler: Wallet;

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
    smartAccount = await testSmartAccountFactory.deploy(
      ENTRYPOINT_ADDR,
      smartAccountOwner.address
    );
    await smartAccount.deploymentTransaction()?.wait();

    await new Promise((resolve) => setTimeout(resolve, 200));

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
    await new Promise((resolve) => setTimeout(resolve, 100));

    const fundTx2 = await deployer.sendTransaction({
      to: eoaAccount1.address,
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx2.wait();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const fundTx3 = await deployer.sendTransaction({
      to: eoaAccount2.address,
      value: parseEther("1"),
      nonce: deployerNonce++,
    });
    await fundTx3.wait();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // derive identity keys using the correct SDK function with full keypairs
    smartAccountIdentityKeys = await deriveIdentityKeyPairWithProof(
      smartAccountOwner,
      await smartAccount.getAddress()
    );

    eoaAccount1IdentityKeys = await deriveIdentityKeyPairWithProof(
      eoaAccount1,
      eoaAccount1.address
    );

  }, 80000);

  afterAll(async () => {
    await anvil.stop();
  });

  beforeEach(async () => {
    // Force cleanup and wait for any pending operations
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
      await logChain.getAddress(),
      createMockSmartAccountClient(smartAccount, smartAccountOwner),
      bundler
    ) as DirectEntryPointExecutor;

    eoaAccount1Executor = ExecutorFactory.createEOA(
      logChain.connect(eoaAccount1)
    ) as EOAExecutor;

    eoaAccount2Executor = ExecutorFactory.createEOA(
      logChain.connect(eoaAccount2)
    ) as EOAExecutor;
  });

  describe("Smart Account to EOA", () => {
    it("should complete full handshake and bidirectional messaging flow", async () => {
      // 1. Smart Account initiates handshake with EOA
      const ephemeralKeys = nacl.box.keyPair();
      const initiateHandshakeTx = await initiateHandshake({
        executor: smartAccountExecutor,
        recipientAddress: eoaAccount1.address,
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
        signer: eoaAccount1,
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
        topic: eoaToSaTopic, // Responder to Initiator
        message: message2,
        recipientPubKey: smartAccountIdentityKeys.keyPair.publicKey,
        senderAddress: eoaAccount1.address,
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
        (event) => event.args.sender === eoaAccount1.address
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
        signer: eoaAccount1,
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
        topic: eoaToSaTopic, // Initiator to Responder
        message: message1,
        recipientPubKey: smartAccountIdentityKeys.keyPair.publicKey,
        senderAddress: eoaAccount1.address,
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
        topic: saToEoaTopic, // Responder to Initiator
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
        (event) => event.args.sender === eoaAccount1.address
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


});
