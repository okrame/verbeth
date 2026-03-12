// @ts-ignore
import { ethers } from "hardhat";
import { expect } from "chai";
import { VerbethV1 } from "../typechain-types";

const X25519_PUBLIC_KEY_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const UNIFIED_PUB_KEYS_BYTES =
  1 + X25519_PUBLIC_KEY_BYTES + ED25519_PUBLIC_KEY_BYTES;
const ML_KEM_PUBLIC_KEY_BYTES = 1184;
const ML_KEM_CIPHERTEXT_BYTES = 1088;
const EXTENDED_EPHEMERAL_KEY_BYTES =
  X25519_PUBLIC_KEY_BYTES + ML_KEM_PUBLIC_KEY_BYTES;
const NACL_BOX_NONCE_BYTES = 24;
const ED25519_SIGNATURE_BYTES = 64;
const RATCHET_HEADER_BYTES = X25519_PUBLIC_KEY_BYTES + 4 + 4;
const SECRETBOX_MAC_BYTES = 16;
const RATCHET_FIXED_PAYLOAD_BYTES =
  1 + ED25519_SIGNATURE_BYTES + RATCHET_HEADER_BYTES;
const SMALL_MESSAGE_BLOB_BYTES =
  RATCHET_FIXED_PAYLOAD_BYTES + NACL_BOX_NONCE_BYTES + SECRETBOX_MAC_BYTES;
const LARGE_MESSAGE_BLOB_BYTES = SMALL_MESSAGE_BLOB_BYTES * 10;

function randomHex(bytes: number): string {
  return ethers.hexlify(ethers.randomBytes(bytes));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function createHandshakePayload(note: string): Uint8Array {
  return ethers.toUtf8Bytes(
    JSON.stringify({
      plaintextPayload: note,
      identityProof: {
        message: "verbeth-handshake:v1",
        signature: randomHex(65),
      },
    })
  );
}

function createMockHandshakeResponseFixture() {
  const kemCiphertext = ethers.randomBytes(ML_KEM_CIPHERTEXT_BYTES);
  const responseContent = {
    unifiedPubKeys: bytesToBase64(ethers.randomBytes(UNIFIED_PUB_KEYS_BYTES)),
    ephemeralPubKey: bytesToBase64(ethers.randomBytes(X25519_PUBLIC_KEY_BYTES)),
    kemCiphertext: bytesToBase64(kemCiphertext),
    note: "Handshake accepted",
    identityProof: {
      message: "verbeth-handshake-response:v1",
      signature: randomHex(65),
    },
  };

  // Mirror the SDK envelope shape so the contract fixture looks like a real HSR payload.
  const responseEnvelope = {
    v: 1,
    epk: bytesToBase64(ethers.randomBytes(X25519_PUBLIC_KEY_BYTES)),
    n: bytesToBase64(ethers.randomBytes(NACL_BOX_NONCE_BYTES)),
    ct: bytesToBase64(ethers.toUtf8Bytes(JSON.stringify(responseContent))),
  };

  return {
    responseContent,
    ciphertext: ethers.hexlify(
      ethers.toUtf8Bytes(JSON.stringify(responseEnvelope))
    ),
  };
}

function createRatchetMessageCiphertext(totalBlobBytes: number): string {
  if (
    totalBlobBytes <
    RATCHET_FIXED_PAYLOAD_BYTES + NACL_BOX_NONCE_BYTES + SECRETBOX_MAC_BYTES
  ) {
    throw new Error("Ratchet payload blob is too small");
  }

  const encryptedPayloadBytes = totalBlobBytes - RATCHET_FIXED_PAYLOAD_BYTES;
  const payload = new Uint8Array(totalBlobBytes);

  let offset = 0;
  payload[offset++] = 0x01; // ratchet payload version
  payload.set(ethers.randomBytes(ED25519_SIGNATURE_BYTES), offset);
  offset += ED25519_SIGNATURE_BYTES;
  payload.set(ethers.randomBytes(X25519_PUBLIC_KEY_BYTES), offset);
  offset += X25519_PUBLIC_KEY_BYTES;

  const view = new DataView(payload.buffer);
  view.setUint32(offset, 3, false);
  offset += 4;
  view.setUint32(offset, 7, false);
  offset += 4;

  payload.set(ethers.randomBytes(encryptedPayloadBytes), offset);

  return ethers.hexlify(payload);
}

describe("Verbeth", () => {
  let verbEth: VerbethV1;

  beforeEach(async () => {
    const factory = await ethers.getContractFactory("VerbethV1");
    verbEth = (await factory.deploy()) as VerbethV1;
    await verbEth.waitForDeployment();
  });

  it("should emit a MessageSent event", async () => {
    const [sender] = await ethers.getSigners();

    const msg = createRatchetMessageCiphertext(SMALL_MESSAGE_BLOB_BYTES);
    const topic = ethers.keccak256(ethers.toUtf8Bytes("chat:dev"));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 1;

    expect(ethers.getBytes(msg).length).to.equal(SMALL_MESSAGE_BLOB_BYTES);

    await expect(verbEth.sendMessage(msg, topic, timestamp, nonce))
      // @ts-ignore
      .to.emit(verbEth, "MessageSent")
      .withArgs(await sender.getAddress(), msg, timestamp, topic, nonce);
  });

  it("should allow duplicate nonce (no on-chain check)", async () => {
    const [] = await ethers.getSigners();

    const msg = createRatchetMessageCiphertext(SMALL_MESSAGE_BLOB_BYTES);
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

    const unifiedPubKeys = randomHex(UNIFIED_PUB_KEYS_BYTES);
    const ephemeralPubKey = randomHex(EXTENDED_EPHEMERAL_KEY_BYTES);
    const plaintextPayload = createHandshakePayload("Hi Bob, respond pls");

    expect(ethers.getBytes(unifiedPubKeys).length).to.equal(UNIFIED_PUB_KEYS_BYTES);
    expect(ethers.getBytes(ephemeralPubKey).length).to.equal(
      EXTENDED_EPHEMERAL_KEY_BYTES
    );

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
    const responderEphemeralR = randomHex(X25519_PUBLIC_KEY_BYTES);
    const { responseContent, ciphertext: responseCiphertext } =
      createMockHandshakeResponseFixture();

    expect(ethers.getBytes(responderEphemeralR).length).to.equal(
      X25519_PUBLIC_KEY_BYTES
    );
    expect(
      Buffer.from(responseContent.kemCiphertext, "base64").length
    ).to.equal(ML_KEM_CIPHERTEXT_BYTES);

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

  it("should emit a MessageSent event for a larger encrypted payload", async () => {
    const [sender] = await ethers.getSigners();

    const msg = createRatchetMessageCiphertext(LARGE_MESSAGE_BLOB_BYTES);
    const topic = ethers.keccak256(ethers.toUtf8Bytes("chat:large-payload"));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 99;

    expect(ethers.getBytes(msg).length).to.equal(LARGE_MESSAGE_BLOB_BYTES);

    await expect(verbEth.sendMessage(msg, topic, timestamp, nonce))
      // @ts-ignore
      .to.emit(verbEth, "MessageSent")
      .withArgs(await sender.getAddress(), msg, timestamp, topic, nonce);
  });
});
