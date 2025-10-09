// tests/messaging.test.ts
// This file contains integration tests for secure messaging after handshake completion
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

import {
  ExecutorFactory,
  sendEncryptedMessage,
  DirectEntryPointExecutor,
  deriveIdentityKeyPairWithProof,
  decryptMessage,
  encryptStructuredPayload,
  decryptStructuredPayload,
  MessagePayload,
  getNextNonce,
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

describe("Smart Account Secure Messaging (Phase 5)", () => {
  let anvil: AnvilSetup;
  let provider: JsonRpcProvider;
  let entryPoint: EntryPoint;
  let logChain: LogChainV1;
  let aliceSmartAccount: TestSmartAccount;
  let bobSmartAccount: TestSmartAccount;
  let aliceExecutor: DirectEntryPointExecutor;
  let bobExecutor: DirectEntryPointExecutor;

  let deployer: Wallet;
  let aliceOwner: Wallet;
  let bobOwner: Wallet;

  let aliceIdentityKeys: any;
  let bobIdentityKeys: any;

  beforeAll(async () => {
    anvil = new AnvilSetup(8546);
    const forkUrl = "https://base-rpc.publicnode.com";

    await anvil.start(forkUrl);
    provider = anvil.provider;

    const testPrivateKeys = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    ];

    deployer = new Wallet(testPrivateKeys[0], provider);
    const deployerNM = new NonceManager(deployer);
    aliceOwner = new Wallet(testPrivateKeys[1], provider);
    bobOwner = new Wallet(testPrivateKeys[2], provider);

    entryPoint = EntryPoint__factory.connect(ENTRYPOINT_ADDR, provider);

    // Deploy LogChainV1 contract
    const logChainFactory = new LogChainV1__factory(deployerNM);
    const logChainImpl = await logChainFactory.deploy();
    await logChainImpl.waitForDeployment();

    const initData = logChainFactory.interface.encodeFunctionData("initialize", []);

    const proxyFactory = new ERC1967Proxy__factory(deployerNM);
    const proxy = await proxyFactory.deploy(await logChainImpl.getAddress(), initData);
    await proxy.waitForDeployment();

    logChain = LogChainV1__factory.connect(await proxy.getAddress(), deployerNM);

    // Deploy test smart accounts
    const testSmartAccountFactory = new TestSmartAccount__factory(deployerNM);
    aliceSmartAccount = await testSmartAccountFactory.deploy(ENTRYPOINT_ADDR, aliceOwner.address);
    await aliceSmartAccount.waitForDeployment();

    bobSmartAccount = await testSmartAccountFactory.deploy(ENTRYPOINT_ADDR, bobOwner.address);
    await bobSmartAccount.waitForDeployment();

    // Fund smart accounts
    await deployerNM.sendTransaction({
      to: await aliceSmartAccount.getAddress(),
      value: parseEther("1"),
    });
    await deployerNM.sendTransaction({
      to: await bobSmartAccount.getAddress(),
      value: parseEther("1"),
    });

    // Derive identity keys for both accounts
    aliceIdentityKeys = await deriveIdentityKeyPairWithProof(
      aliceOwner,
      await aliceSmartAccount.getAddress()
    );

    bobIdentityKeys = await deriveIdentityKeyPairWithProof(
      bobOwner,
      await bobSmartAccount.getAddress()
    );

    // Create executors
    aliceExecutor = ExecutorFactory.createDirectEntryPoint(
      await aliceSmartAccount.getAddress(),
      entryPoint.connect(deployer) as unknown as Contract,
      await logChain.getAddress(),
      createMockSmartAccountClient(aliceSmartAccount, aliceOwner),
      deployerNM
    ) as DirectEntryPointExecutor;

    bobExecutor = ExecutorFactory.createDirectEntryPoint(
      await bobSmartAccount.getAddress(),
      entryPoint.connect(deployer) as unknown as Contract,
      await logChain.getAddress(),
      createMockSmartAccountClient(bobSmartAccount, bobOwner),
      deployerNM
    ) as DirectEntryPointExecutor;
  }, 80000);

  afterAll(async () => {
    await anvil.stop();
  });

  describe("Simple API", () => {
    it("should send and decrypt simple text messages", async () => {
      const testMessage = "Hello Bob, this is a simple message from Alice!";
      const topic = "simple-chat";
      const timestamp = Math.floor(Date.now() / 1000);

      // Alice sends a simple text message
      const sendTx = await sendEncryptedMessage({
        executor: aliceExecutor,
        topic: keccak256(toUtf8Bytes(topic)),
        message: testMessage,
        recipientPubKey: bobIdentityKeys.keyPair.publicKey,
        senderAddress: await aliceSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: aliceIdentityKeys.keyPair.signingSecretKey,
          publicKey: aliceIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp,
      });

      const sendReceipt = await sendTx.wait();
      expect(sendReceipt.status).toBe(1);

      // Verify MessageSent event was emitted
      const messageFilter = logChain.filters.MessageSent();
      const messageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt.blockNumber,
        sendReceipt.blockNumber
      );

      expect(messageEvents).toHaveLength(1);
      const messageEvent = messageEvents[0];

      // Bob decrypts using simple convenience API
      let ciphertextJson = messageEvent.args.ciphertext;
      if (
        typeof messageEvent.args.ciphertext === "string" &&
        messageEvent.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(messageEvent.args.ciphertext.slice(2), "hex"));
          ciphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
        }
      }

      const decryptedMessage = decryptMessage(
        ciphertextJson,
        aliceIdentityKeys.keyPair.secretKey, // wrong key
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      expect(decryptedMessage).toBeNull();

      // also test structured decryption failure
      const decryptedPayload = decryptStructuredPayload(
        ciphertextJson,
        aliceIdentityKeys.keyPair.secretKey, // Wrong key!
        (obj) => obj as MessagePayload,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      expect(decryptedPayload).toBeNull();
    }, 30000);

    it("should decrypt messages correctly with right recipient", async () => {
      const testMessage = "Hello Bob, this is a simple message from Alice!";
      const topic = "simple-chat";
      const timestamp = Math.floor(Date.now() / 1000);

      const sendTx = await sendEncryptedMessage({
        executor: aliceExecutor,
        topic: keccak256(toUtf8Bytes(topic)),
        message: testMessage,
        recipientPubKey: bobIdentityKeys.keyPair.publicKey,
        senderAddress: await aliceSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: aliceIdentityKeys.keyPair.signingSecretKey,
          publicKey: aliceIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp,
      });

      const sendReceipt = await sendTx.wait();
      expect(sendReceipt.status).toBe(1);

      // verify MessageSent event was emitted
      const messageFilter = logChain.filters.MessageSent();
      const messageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt.blockNumber,
        sendReceipt.blockNumber
      );

      expect(messageEvents).toHaveLength(1);
      const messageEvent = messageEvents[0];

      let ciphertextJson = messageEvent.args.ciphertext;
      if (
        typeof messageEvent.args.ciphertext === "string" &&
        messageEvent.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(messageEvent.args.ciphertext.slice(2), "hex"));
          ciphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      const decryptedMessage = decryptMessage(
        ciphertextJson,
        bobIdentityKeys.keyPair.secretKey,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      expect(decryptedMessage).toBe(testMessage);
    }, 30000);

    it("should handle bidirectional simple messaging", async () => {
      const aliceMessage = "Hello Bob!";
      const bobMessage = "Hi Alice!";
      const topic = "bidirectional-simple";

      // Alice to Bob
      const aliceSendTx = await sendEncryptedMessage({
        executor: aliceExecutor,
        topic: keccak256(toUtf8Bytes(topic)),
        message: aliceMessage,
        recipientPubKey: bobIdentityKeys.keyPair.publicKey,
        senderAddress: await aliceSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: aliceIdentityKeys.keyPair.signingSecretKey,
          publicKey: aliceIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });

      const aliceReceipt = await aliceSendTx.wait();

      // Bob to Alice
      const bobSendTx = await sendEncryptedMessage({
        executor: bobExecutor,
        topic: keccak256(toUtf8Bytes(topic)),
        message: bobMessage,
        recipientPubKey: aliceIdentityKeys.keyPair.publicKey,
        senderAddress: await bobSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: bobIdentityKeys.keyPair.signingSecretKey,
          publicKey: bobIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp: Math.floor(Date.now() / 1000) + 1,
      });

      const bobReceipt = await bobSendTx.wait();

      // Verify both messages can be decrypted
      const messageFilter = logChain.filters.MessageSent();

      // Get Alice's message from her specific transaction block
      const aliceMessageEvents = await logChain.queryFilter(
        messageFilter,
        aliceReceipt.blockNumber,
        aliceReceipt.blockNumber
      );

      // Get Bob's message from his specific transaction block  
      const bobMessageEvents = await logChain.queryFilter(
        messageFilter,
        bobReceipt.blockNumber,
        bobReceipt.blockNumber
      );

      const aliceSmartAccountAddress = await aliceSmartAccount.getAddress();
      const bobSmartAccountAddress = await bobSmartAccount.getAddress();

      const aliceMessageEvent = aliceMessageEvents.find(
        (event) => event.args.sender === aliceSmartAccountAddress
      );
      const bobMessageEvent = bobMessageEvents.find(
        (event) => event.args.sender === bobSmartAccountAddress
      );

      expect(aliceMessageEvent).toBeDefined();
      expect(bobMessageEvent).toBeDefined();

      // Bob decrypts Alice's message
      let aliceCiphertextJson = aliceMessageEvent!.args.ciphertext;
      if (
        typeof aliceMessageEvent!.args.ciphertext === "string" &&
        aliceMessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(aliceMessageEvent!.args.ciphertext.slice(2), "hex"));
          aliceCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }
      const bobDecryptedMessage = decryptMessage(
        aliceCiphertextJson,
        bobIdentityKeys.keyPair.secretKey,
        aliceIdentityKeys.keyPair.signingPublicKey
      );
      expect(bobDecryptedMessage).toBe(aliceMessage);

      // Alice decrypts Bob's message
      let bobCiphertextJson = bobMessageEvent!.args.ciphertext;
      if (
        typeof bobMessageEvent!.args.ciphertext === "string" &&
        bobMessageEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(bobMessageEvent!.args.ciphertext.slice(2), "hex"));
          bobCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }
      const aliceDecryptedMessage = decryptMessage(
        bobCiphertextJson,
        aliceIdentityKeys.keyPair.secretKey,
        bobIdentityKeys.keyPair.signingPublicKey
      );
      expect(aliceDecryptedMessage).toBe(bobMessage);
    }, 45000);
  });

  describe("Forward Secrecy", () => {
    it("should use different ephemeral keys for each message", async () => {
      const messages = [
        "First message with forward secrecy",
        "Second message with different ephemeral key",
        "Third message continues the conversation",
      ];
      const topic = "forward-secrecy-test";

      const sentMessages: any[] = [];

      // send multiple messages
      for (let i = 0; i < messages.length; i++) {
        const timestamp = Math.floor(Date.now() / 1000) + i;

        const sendTx = await sendEncryptedMessage({
          executor: aliceExecutor,
          topic: keccak256(toUtf8Bytes(topic)),
          message: messages[i],
          recipientPubKey: bobIdentityKeys.keyPair.publicKey,
          senderAddress: await aliceSmartAccount.getAddress(),
          senderSignKeyPair: {
            secretKey: aliceIdentityKeys.keyPair.signingSecretKey,
            publicKey: aliceIdentityKeys.keyPair.signingPublicKey,
          },
          timestamp,
        });

        const sendReceipt = await sendTx.wait();
        sentMessages.push(sendReceipt);
      }

      // retrieve and verify ephemeral key uniqueness
      const messageFilter = logChain.filters.MessageSent();
      const fromBlock = sentMessages[0].blockNumber;
      const toBlock = sentMessages[sentMessages.length - 1].blockNumber;

      const messageEvents = await logChain.queryFilter(messageFilter, fromBlock, toBlock);

      const aliceSmartAccountAddress = await aliceSmartAccount.getAddress();
      const aliceMessages = messageEvents.filter(
        (event) => event.args.sender === aliceSmartAccountAddress
      );

      const ephemeralKeys: string[] = [];

      for (const event of aliceMessages) {
        let ciphertextJson = event.args.ciphertext;
        if (
          typeof event.args.ciphertext === "string" &&
          event.args.ciphertext.startsWith("0x")
        ) {
          try {
            const bytes = new Uint8Array(Buffer.from(event.args.ciphertext.slice(2), "hex"));
            ciphertextJson = new TextDecoder().decode(bytes);
          } catch (err) {
            // Keep original if decoding fails
          }
        }

        // Extract ephemeral key from ciphertext
        const parsed = JSON.parse(ciphertextJson);
        ephemeralKeys.push(parsed.epk);
      }

      // verify forward secrecy: each message should use a different ephemeral key
      const uniqueEphemeralKeys = new Set(ephemeralKeys);
      expect(uniqueEphemeralKeys.size).toBe(ephemeralKeys.length);
      expect(ephemeralKeys.length).toBeGreaterThanOrEqual(messages.length);
    }, 60000);
  });

  describe("Advanced API", () => {
    it("should send and decrypt structured messages with metadata", async () => {
      const topic = "structured-chat";
      const timestamp = Math.floor(Date.now() / 1000);

      const messagePayload: MessagePayload = {
        content: "Hello Bob, this is a structured message with metadata!",
        timestamp,
        messageType: "text",
        metadata: {
          sender: "alice",
          topic,
          priority: "high",
          tags: ["important", "demo"],
          replyTo: null,
        },
      };

      const ephemeralKeyPair = nacl.box.keyPair();

      const ciphertext = encryptStructuredPayload(
        messagePayload,
        bobIdentityKeys.keyPair.publicKey,
        ephemeralKeyPair.secretKey,
        ephemeralKeyPair.publicKey,
        aliceIdentityKeys.keyPair.signingSecretKey,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      const nonce = getNextNonce(await aliceSmartAccount.getAddress(), keccak256(toUtf8Bytes(topic)));

      const sendTx = await aliceExecutor.sendMessage(toUtf8Bytes(ciphertext), keccak256(toUtf8Bytes(topic)), timestamp, nonce);

      const sendReceipt = await sendTx.wait();
      expect(sendReceipt.status).toBe(1);

      // retrieve and decrypt using structured API
      const messageFilter = logChain.filters.MessageSent();
      const messageEvents = await logChain.queryFilter(messageFilter, sendReceipt.blockNumber, sendReceipt.blockNumber);

      expect(messageEvents).toHaveLength(1);
      const messageEvent = messageEvents[0];

      let ciphertextJson = messageEvent.args.ciphertext;
      if (
        typeof messageEvent.args.ciphertext === "string" &&
        messageEvent.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(messageEvent.args.ciphertext.slice(2), "hex"));
          ciphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      const decryptedPayload = decryptStructuredPayload(
        ciphertextJson,
        bobIdentityKeys.keyPair.secretKey,
        (obj) => obj as MessagePayload,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      expect(decryptedPayload).toBeDefined();
      expect(decryptedPayload?.content).toBe(messagePayload.content);
      expect(decryptedPayload?.messageType).toBe("text");
      expect(decryptedPayload?.timestamp).toBe(timestamp);
      expect(decryptedPayload?.metadata?.priority).toBe("high");
      expect(decryptedPayload?.metadata?.tags).toEqual(["important", "demo"]);
    }, 30000);

    it("should handle different message types with structured payloads", async () => {
      const topic = "multi-type-chat";
      const baseTimestamp = Math.floor(Date.now() / 1000);

      const messagePayloads: MessagePayload[] = [
        {
          content: "Text message with file attachment info",
          timestamp: baseTimestamp,
          messageType: "text",
          metadata: { hasAttachment: true, attachmentType: "pdf" },
        },
        {
          content: "Media message description",
          timestamp: baseTimestamp + 1,
          messageType: "media",
          metadata: { mediaType: "image", resolution: "1920x1080" },
        },
        {
          content: "file://document.docx",
          timestamp: baseTimestamp + 2,
          messageType: "file",
          metadata: {
            fileName: "document.docx",
            fileSize: 2048,
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        },
      ];

      const sentMessages: any[] = [];

      // send multiple message types using structured API
      for (let i = 0; i < messagePayloads.length; i++) {
        const payload = messagePayloads[i];
        const ephemeralKeyPair = nacl.box.keyPair();

        const ciphertext = encryptStructuredPayload(
          payload,
          bobIdentityKeys.keyPair.publicKey,
          ephemeralKeyPair.secretKey,
          ephemeralKeyPair.publicKey,
          aliceIdentityKeys.keyPair.signingSecretKey,
          aliceIdentityKeys.keyPair.signingPublicKey
        );

        const nonce = getNextNonce(await aliceSmartAccount.getAddress(), keccak256(toUtf8Bytes(topic)));

        const sendTx = await aliceExecutor.sendMessage(toUtf8Bytes(ciphertext), keccak256(toUtf8Bytes(topic)), payload.timestamp!, nonce);

        const sendReceipt = await sendTx.wait();
        sentMessages.push(sendReceipt);
      }

      // Retrieve and verify all structured messages using specific block ranges
      const messageFilter = logChain.filters.MessageSent();
      const fromBlock = sentMessages[0].blockNumber;
      const toBlock = sentMessages[sentMessages.length - 1].blockNumber;

      const messageEvents = await logChain.queryFilter(messageFilter, fromBlock, toBlock);

      const aliceSmartAccountAddress = await aliceSmartAccount.getAddress();
      const aliceMessages = messageEvents.filter((event) => event.args.sender === aliceSmartAccountAddress);

      expect(aliceMessages.length).toBeGreaterThanOrEqual(messagePayloads.length);

      const decryptedPayloads: MessagePayload[] = [];

      for (const event of aliceMessages) {
        let ciphertextJson = event.args.ciphertext;
        if (
          typeof event.args.ciphertext === "string" &&
          event.args.ciphertext.startsWith("0x")
        ) {
          try {
            const bytes = new Uint8Array(Buffer.from(event.args.ciphertext.slice(2), "hex"));
            ciphertextJson = new TextDecoder().decode(bytes);
          } catch (err) {
            // Keep original if decoding fails
          }
        }

        const decryptedPayload = decryptStructuredPayload(
          ciphertextJson,
          bobIdentityKeys.keyPair.secretKey,
          (obj) => obj as MessagePayload,
          aliceIdentityKeys.keyPair.signingPublicKey
        );

        if (decryptedPayload) {
          decryptedPayloads.push(decryptedPayload);
        }
      }

      expect(decryptedPayloads).toHaveLength(messagePayloads.length);

      const textMessage = decryptedPayloads.find((p) => p.messageType === "text");
      const mediaMessage = decryptedPayloads.find((p) => p.messageType === "media");
      const fileMessage = decryptedPayloads.find((p) => p.messageType === "file");

      expect(textMessage).toBeDefined();
      expect(textMessage?.metadata?.hasAttachment).toBe(true);

      expect(mediaMessage).toBeDefined();
      expect(mediaMessage?.metadata?.mediaType).toBe("image");

      expect(fileMessage).toBeDefined();
      expect(fileMessage?.metadata?.fileName).toBe("document.docx");
      expect(fileMessage?.metadata?.fileSize).toBe(2048);
    }, 60000);

    it("should handle conversation threading with structured metadata", async () => {
      const topic = "threaded-conversation";
      const conversationId = "conv-123";
      const baseTimestamp = Math.floor(Date.now() / 1000);

      const threadMessages: MessagePayload[] = [
        {
          content: "Starting a new conversation thread",
          timestamp: baseTimestamp,
          messageType: "text",
          metadata: {
            conversationId,
            threadId: "thread-1",
            isThreadStart: true,
            sequenceNumber: 1,
          },
        },
        {
          content: "This is a reply in the thread",
          timestamp: baseTimestamp + 1,
          messageType: "text",
          metadata: {
            conversationId,
            threadId: "thread-1",
            replyTo: 1,
            sequenceNumber: 2,
          },
        },
        {
          content: "Another reply with deeper context",
          timestamp: baseTimestamp + 2,
          messageType: "text",
          metadata: {
            conversationId,
            threadId: "thread-1",
            replyTo: 2,
            sequenceNumber: 3,
            context: { mentioned: ["@alice"], links: ["https://example.com"] },
          },
        },
      ];

      const sentMessages: any[] = [];

      // Send threaded messages using structured API
      for (const payload of threadMessages) {
        const ephemeralKeyPair = nacl.box.keyPair();

        const ciphertext = encryptStructuredPayload(
          payload,
          bobIdentityKeys.keyPair.publicKey,
          ephemeralKeyPair.secretKey,
          ephemeralKeyPair.publicKey,
          aliceIdentityKeys.keyPair.signingSecretKey,
          aliceIdentityKeys.keyPair.signingPublicKey
        );

        const nonce = getNextNonce(await aliceSmartAccount.getAddress(), keccak256(toUtf8Bytes(topic)));

        const sendTx = await aliceExecutor.sendMessage(toUtf8Bytes(ciphertext), keccak256(toUtf8Bytes(topic)), payload.timestamp!, nonce);

        const sendReceipt = await sendTx.wait();
        sentMessages.push(sendReceipt);
      }

      // Retrieve and verify threaded conversation using specific block range
      const messageFilter = logChain.filters.MessageSent();
      const fromBlock = sentMessages[0].blockNumber;
      const toBlock = sentMessages[sentMessages.length - 1].blockNumber;
      const messageEvents = await logChain.queryFilter(messageFilter, fromBlock, toBlock);

      const aliceSmartAccountAddress = await aliceSmartAccount.getAddress();
      const aliceMessages = messageEvents.filter((event) => event.args.sender === aliceSmartAccountAddress);

      const decryptedThread: MessagePayload[] = [];

      for (const event of aliceMessages) {
        let ciphertextJson = event.args.ciphertext;
        if (
          typeof event.args.ciphertext === "string" &&
          event.args.ciphertext.startsWith("0x")
        ) {
          try {
            const bytes = new Uint8Array(Buffer.from(event.args.ciphertext.slice(2), "hex"));
            ciphertextJson = new TextDecoder().decode(bytes);
          } catch (err) {
            // Keep original if decoding fails
          }
        }

        const decryptedPayload = decryptStructuredPayload(
          ciphertextJson,
          bobIdentityKeys.keyPair.secretKey,
          (obj) => obj as MessagePayload,
          aliceIdentityKeys.keyPair.signingPublicKey
        );

        if (decryptedPayload?.metadata?.conversationId === conversationId) {
          decryptedThread.push(decryptedPayload);
        }
      }

      expect(decryptedThread).toHaveLength(threadMessages.length);

      // Sort by sequence number for verification
      decryptedThread.sort(
        (a, b) => (a.metadata?.sequenceNumber || 0) - (b.metadata?.sequenceNumber || 0)
      );

      expect(decryptedThread[0].metadata?.isThreadStart).toBe(true);
      expect(decryptedThread[1].metadata?.replyTo).toBe(1);
      expect(decryptedThread[2].metadata?.replyTo).toBe(2);
      expect(decryptedThread[2].metadata?.context?.mentioned).toEqual(["@alice"]);
    }, 60000);
  });

  describe("API Compatibility", () => {
    it("should produce equivalent results for simple content using both APIs", async () => {
      const testMessage = "This message will be sent using both messaging APIs";
      const topic = "api-compatibility-test";
      const timestamp = Math.floor(Date.now() / 1000);

      // Send using simple convenience API
      const simpleSendTx = await sendEncryptedMessage({
        executor: aliceExecutor,
        topic: keccak256(toUtf8Bytes(topic + "-simple")),
        message: testMessage,
        recipientPubKey: bobIdentityKeys.keyPair.publicKey,
        senderAddress: await aliceSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: aliceIdentityKeys.keyPair.signingSecretKey,
          publicKey: aliceIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp,
      });

      const simpleReceipt = await simpleSendTx.wait();

      // Send same content using structured API
      const messagePayload: MessagePayload = {
        content: testMessage,
      };

      const ephemeralKeyPair = nacl.box.keyPair();

      const ciphertext = encryptStructuredPayload(
        messagePayload,
        bobIdentityKeys.keyPair.publicKey,
        ephemeralKeyPair.secretKey,
        ephemeralKeyPair.publicKey,
        aliceIdentityKeys.keyPair.signingSecretKey,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      const nonce = getNextNonce(await aliceSmartAccount.getAddress(), keccak256(toUtf8Bytes(topic + "-structured")));

      const structuredSendTx = await aliceExecutor.sendMessage(
        toUtf8Bytes(ciphertext),
        keccak256(toUtf8Bytes(topic + "-structured")),
        timestamp + 1,
        nonce
      );

      const structuredReceipt = await structuredSendTx.wait();

      // Retrieve both messages using specific block numbers
      const messageFilter = logChain.filters.MessageSent();

      // Get simple API message
      const simpleEvents = await logChain.queryFilter(
        messageFilter,
        simpleReceipt.blockNumber,
        simpleReceipt.blockNumber
      );

      // Get structured API message  
      const structuredEvents = await logChain.queryFilter(
        messageFilter,
        structuredReceipt.blockNumber,
        structuredReceipt.blockNumber
      );

      const aliceSmartAccountAddress = await aliceSmartAccount.getAddress();
      
      const simpleEvent = simpleEvents.find((event) => event.args.sender === aliceSmartAccountAddress);
      const structuredEvent = structuredEvents.find((event) => event.args.sender === aliceSmartAccountAddress);

      expect(simpleEvent).toBeDefined();
      expect(structuredEvent).toBeDefined();

      // Decrypt both using both methods
      let simpleDecrypted: string | null = null;
      let structuredDecrypted: MessagePayload | null = null;

      let simpleCiphertextJson = simpleEvent!.args.ciphertext;
      if (
        typeof simpleEvent!.args.ciphertext === "string" &&
        simpleEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(simpleEvent!.args.ciphertext.slice(2), "hex"));
          simpleCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      let structuredCiphertextJson = structuredEvent!.args.ciphertext;
      if (
        typeof structuredEvent!.args.ciphertext === "string" &&
        structuredEvent!.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(structuredEvent!.args.ciphertext.slice(2), "hex"));
          structuredCiphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      // Try simple decryption
      simpleDecrypted = decryptMessage(
        simpleCiphertextJson,
        bobIdentityKeys.keyPair.secretKey,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      // Try structured decryption
      structuredDecrypted = decryptStructuredPayload(
        structuredCiphertextJson,
        bobIdentityKeys.keyPair.secretKey,
        (obj) => obj as MessagePayload,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      // Both APIs should produce the same content
      expect(simpleDecrypted).toBe(testMessage);
      expect(structuredDecrypted?.content).toBe(testMessage);
      expect(simpleDecrypted).toBe(structuredDecrypted?.content);
    }, 45000);
  });

  describe("Error Handling", () => {
    it("should fail to decrypt message with wrong recipient key", async () => {
      const testMessage = "This message should not be decryptable";
      const topic = "wrong-key-test";
      const timestamp = Math.floor(Date.now() / 1000);

      const sendTx = await sendEncryptedMessage({
        executor: aliceExecutor,
        topic: keccak256(toUtf8Bytes(topic)),
        message: testMessage,
        recipientPubKey: bobIdentityKeys.keyPair.publicKey,
        senderAddress: await aliceSmartAccount.getAddress(),
        senderSignKeyPair: {
          secretKey: aliceIdentityKeys.keyPair.signingSecretKey,
          publicKey: aliceIdentityKeys.keyPair.signingPublicKey,
        },
        timestamp,
      });

      const sendReceipt = await sendTx.wait();

      const messageFilter = logChain.filters.MessageSent();
      const messageEvents = await logChain.queryFilter(
        messageFilter,
        sendReceipt.blockNumber,
        sendReceipt.blockNumber
      );

      expect(messageEvents).toHaveLength(1);
      const messageEvent = messageEvents[0];

      let ciphertextJson = messageEvent.args.ciphertext;
      if (
        typeof messageEvent.args.ciphertext === "string" &&
        messageEvent.args.ciphertext.startsWith("0x")
      ) {
        try {
          const bytes = new Uint8Array(Buffer.from(messageEvent.args.ciphertext.slice(2), "hex"));
          ciphertextJson = new TextDecoder().decode(bytes);
        } catch (err) {
          // Keep original if decoding fails
        }
      }

      const decryptedMessage = decryptMessage(
        ciphertextJson,
        aliceIdentityKeys.keyPair.secretKey, // wrong key
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      expect(decryptedMessage).toBeNull();

      const decryptedPayload = decryptStructuredPayload(
        ciphertextJson,
        aliceIdentityKeys.keyPair.secretKey, // wrong key
        (obj) => obj as MessagePayload,
        aliceIdentityKeys.keyPair.signingPublicKey
      );

      expect(decryptedPayload).toBeNull();
    }, 30000);
  });
});