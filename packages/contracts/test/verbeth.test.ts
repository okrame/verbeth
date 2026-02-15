// @ts-ignore
import { ethers } from "hardhat";
import { expect } from "chai";
import { VerbethV1 } from "../typechain-types";

describe("Verbeth", () => {
  let verbEth: VerbethV1;

  beforeEach(async () => {
    const factory = await ethers.getContractFactory("VerbethV1");
    verbEth = (await factory.deploy()) as VerbethV1;
    await verbEth.waitForDeployment();
  });

  it("should emit a MessageSent event", async () => {
    const [sender] = await ethers.getSigners();

    const msg = ethers.encodeBytes32String("Hello");
    const topic = ethers.keccak256(ethers.toUtf8Bytes("chat:dev"));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 1;

    await expect(verbEth.sendMessage(msg, topic, timestamp, nonce))
      // @ts-ignore
      .to.emit(verbEth, "MessageSent")
      .withArgs(await sender.getAddress(), msg, timestamp, topic, nonce);
  });

  it("should allow duplicate nonce (no on-chain check)", async () => {
    const [] = await ethers.getSigners();

    const msg = ethers.encodeBytes32String("Hello");
    const topic = ethers.keccak256(ethers.toUtf8Bytes("chat:dev"));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 42;

    await verbEth.sendMessage(msg, topic, timestamp, nonce);
    await verbEth.sendMessage(msg, topic, timestamp + 1, nonce); // re-use same nonce, no revert
  });

  it("should emit a Handshake event", async () => {
    const [alice] = await ethers.getSigners();
    const recipient = await alice.getAddress();
    const recipientHash = ethers.keccak256(
      ethers.toUtf8Bytes("contact:" + recipient.toLowerCase())
    );

    const unifiedPubKeys = ethers.hexlify(ethers.randomBytes(65)); // 1 byte version + 32 bytes X25519 + 32 bytes Ed25519 = 65 bytes
    const ephemeralPubKey = ethers.hexlify(ethers.randomBytes(32));
    const plaintextPayload = ethers.toUtf8Bytes("Hi Bob, respond pls");

    await expect(
      verbEth.initiateHandshake(
        recipientHash,
        unifiedPubKeys,
        ephemeralPubKey,
        plaintextPayload
      )
    )
      // @ts-ignore
      .to.emit(verbEth, "Handshake")
      .withArgs(
        recipientHash,
        recipient,
        unifiedPubKeys,
        ephemeralPubKey,
        plaintextPayload
      );
  });

  it("should emit a HandshakeResponse event", async () => {
    const [bob] = await ethers.getSigners();

    const inResponseTo = ethers.keccak256(
      ethers.toUtf8Bytes("handshakeFromAlice")
    );
    const responderEphemeralR = ethers.hexlify(ethers.randomBytes(32)); // 32 bytes pubkey
    const responseCiphertext = ethers.hexlify(ethers.randomBytes(64));

    await expect(
      verbEth.respondToHandshake(
        inResponseTo,
        responderEphemeralR,
        responseCiphertext
      )
    )
      // @ts-ignore
      .to.emit(verbEth, "HandshakeResponse")
      .withArgs(
        inResponseTo,
        await bob.getAddress(),
        responderEphemeralR,
        responseCiphertext
      );
  });
});
