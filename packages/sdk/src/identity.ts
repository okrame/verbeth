import { sha256 } from "@noble/hashes/sha2";
import { hkdf } from "@noble/hashes/hkdf";
import { Signer, concat, hexlify, getBytes } from "ethers";
import nacl from "tweetnacl";
import { encodeUnifiedPubKeys } from "./payload.js";
import { IdentityContext, IdentityKeyPair, IdentityProof } from "./types.js";
import { exec } from "child_process";


const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.length ? BigInt("0x" + hex) : 0n;
}

function bigIntTo32BytesBE(x: bigint): Uint8Array {
  let hex = x.toString(16);
  if (hex.length > 64) hex = hex.slice(hex.length - 64);
  hex = hex.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Canonicalize an Ethereum ECDSA signature (65 bytes) to low-s form.
 * This is only used as KDF input.
 */
function canonicalizeEcdsaSig65(sig: Uint8Array): Uint8Array {
  if (sig.length !== 65) return sig;
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  const v = sig[64];

  const sBig = bytesToBigIntBE(s);
  if (sBig <= SECP256K1_HALF_N) return sig;

  const sLow = SECP256K1_N - sBig;
  const out = new Uint8Array(65);
  out.set(r, 0);
  out.set(bigIntTo32BytesBE(sLow), 32);
  out[64] = v; 
  return out;
}

function buildSeedMessage(addrLower: string): string {
  const lines = [
    "VerbEth Identity Seed v1",
    `Address: ${addrLower}`,
    "Context: verbeth",
  ];
  return lines.join("\n");
}

function buildBindingMessage(
  addrLower: string,
  pkEd25519Hex: string,
  pkX25519Hex: string,
  executorSafeAddress?: string,
  ctx?: IdentityContext
): string {
  const lines = [
    "VerbEth Key Binding v1",
    `Address: ${addrLower}`,
    `PkEd25519: ${pkEd25519Hex}`,
    `PkX25519: ${pkX25519Hex}`,
    `ExecutorSafeAddress: ${executorSafeAddress ?? ""}`
  ];
  if (typeof ctx?.chainId === "number") lines.push(`ChainId: ${ctx.chainId}`);
  if (ctx?.rpId) lines.push(`RpId: ${ctx.rpId}`);
  return lines.join("\n");
}

/**
 * HKDF (RFC 5869) identity key derivation.
 * Returns a proof binding the derived keypair to the wallet address.
 */
export async function deriveIdentityKeyPairWithProof(
  signer: any,
  address: string,
  executorSafeAddress?: string,
  ctx?: IdentityContext
): Promise<{ keyPair: IdentityKeyPair; identityProof: IdentityProof }> {
  const enc = new TextEncoder();
  const addrLower = address.toLowerCase();
  const executorSafeAddressLower = executorSafeAddress?.toLowerCase();

  // 1) Signature-based seed
  const seedMessage = buildSeedMessage(addrLower);
  let seedSignature = await signer.signMessage(seedMessage);
  const seedSigBytes = canonicalizeEcdsaSig65(getBytes(seedSignature));
  seedSignature = ""; // wipe from memory

  // IKM = HKDF( canonicalSig || H(seedMessage) || "verbeth/addr:" || address_lower )
  // salt/info are public domain labels (versioned)
  const seedSalt = enc.encode("verbeth/seed-sig-v1");
  const seedInfo = enc.encode("verbeth/ikm");
  const seedMsgHash = sha256(enc.encode(seedMessage));
  const ikmInput = getBytes(concat([
    seedSigBytes,
    seedMsgHash,
    enc.encode("verbeth/addr:" + addrLower),
  ]));
  const ikm = hkdf(sha256, ikmInput, seedSalt, seedInfo, 32);

  // Derive X25519 (encryption)
  const info_x25519 = enc.encode("verbeth-x25519-v1");
  const x25519_sk = hkdf(sha256, ikm, new Uint8Array(0), info_x25519, 32);
  const boxKeyPair = nacl.box.keyPair.fromSecretKey(x25519_sk);

  // Derive Ed25519 (signing)
  const info_ed25519 = enc.encode("verbeth-ed25519-v1");
  const ed25519_seed = hkdf(sha256, ikm, new Uint8Array(0), info_ed25519, 32);
  const signKeyPair = nacl.sign.keyPair.fromSeed(ed25519_seed);

  // wipe intermediates without affecting returned keyPair buffers
  try {
    seedSigBytes.fill(0);
    seedMsgHash.fill(0);
    ikmInput.fill(0);
    ikm.fill(0);
    ed25519_seed.fill(0);
  } catch {}

  const pkX25519Hex = hexlify(boxKeyPair.publicKey);
  const pkEd25519Hex = hexlify(signKeyPair.publicKey);

  const keyPair: IdentityKeyPair = {
    publicKey: boxKeyPair.publicKey,
    secretKey: boxKeyPair.secretKey,
    signingPublicKey: signKeyPair.publicKey,
    signingSecretKey: signKeyPair.secretKey,
  };

  // 2) Second signature: binding both public keys + safe address
  const message = buildBindingMessage(
    addrLower,
    pkEd25519Hex,
    pkX25519Hex,
    executorSafeAddressLower,
    ctx
  );
  const signature = await signer.signMessage(message);

  const messageRawHex = ("0x" +
    Buffer.from(message, "utf-8").toString("hex")) as `0x${string}`;

  return {
    keyPair,
    identityProof: {
      message,
      signature,
      messageRawHex,
    },
  };
}

export async function deriveIdentityWithUnifiedKeys(
  signer: Signer,
  address: string,
  executorSafeAddress?: string,
  ctx?: IdentityContext
): Promise<{
  identityProof: IdentityProof;
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  unifiedPubKeys: Uint8Array;
}> {
  const result = await deriveIdentityKeyPairWithProof(signer, address, executorSafeAddress ,ctx);

  const unifiedPubKeys = encodeUnifiedPubKeys(
    result.keyPair.publicKey, // X25519
    result.keyPair.signingPublicKey // Ed25519
  );

  return {
    identityProof: result.identityProof,
    identityPubKey: result.keyPair.publicKey,
    signingPubKey: result.keyPair.signingPublicKey,
    unifiedPubKeys,
  };
}