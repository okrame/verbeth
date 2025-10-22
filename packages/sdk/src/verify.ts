// packages/sdk/src/verify.ts
import { JsonRpcProvider, getBytes, hexlify, getAddress } from "ethers";
import { decryptAndExtractHandshakeKeys, computeTagFromInitiator, verifyDuplexTopicsChecksum, deriveDuplexTopics } from "./crypto.js";
import { HandshakeLog, HandshakeResponseLog, IdentityProof, TopicInfoWire, DuplexTopics } from "./types.js";
import { parseHandshakePayload, parseHandshakeKeys, decodeHandshakeResponseContent } from "./payload.js";
import {
  Rpcish,
  makeViemPublicClient,
  parseBindingMessage,
} from "./utils.js";

// ============= Handshake Verification =============

/**
 * handshake verification with mandatory identity proof
 */
export async function verifyHandshakeIdentity(
  handshakeEvent: HandshakeLog,
  provider: JsonRpcProvider
): Promise<boolean> {
  try {
    let plaintextPayload = handshakeEvent.plaintextPayload;

    if (
      typeof plaintextPayload === "string" &&
      plaintextPayload.startsWith("0x")
    ) {
      try {
        const bytes = new Uint8Array(
          Buffer.from(plaintextPayload.slice(2), "hex")
        );
        plaintextPayload = new TextDecoder().decode(bytes);
      } catch (err) {
        console.error("Failed to decode hex payload:", err);
        return false;
      }
    }

    const content = parseHandshakePayload(plaintextPayload);

    const parsedKeys = parseHandshakeKeys(handshakeEvent);
    if (!parsedKeys) {
      console.error("Failed to parse unified pubKeys from handshake event");
      return false;
    }

    // // 6492 awareness
    // const dp: any = content.identityProof;
    // const sigPrimary: string = dp.signature;
    // const sig6492: string | undefined = dp.signature6492 ?? dp.erc6492;
    // const uses6492 = hasERC6492Suffix(sigPrimary) || !!sig6492;

    // const isContract1271 = await isSmartContract1271(handshakeEvent.sender, provider);

    return await verifyIdentityProof(
      content.identityProof,
      handshakeEvent.sender,
      parsedKeys,
      provider
    );
  } catch (err) {
    console.error("verifyHandshakeIdentity error:", err);
    return false;
  }
}

// ============= HandshakeResponse Verification =============

/**
 * handshake response verification with mandatory identity proof
 */
export async function verifyHandshakeResponseIdentity(
  responseEvent: HandshakeResponseLog,
  responderIdentityPubKey: Uint8Array,
  initiatorEphemeralSecretKey: Uint8Array,
  provider: JsonRpcProvider
): Promise<boolean> {
  try {
    const extractedResponse = decryptAndExtractHandshakeKeys(
      responseEvent.ciphertext,
      initiatorEphemeralSecretKey
    );

    if (!extractedResponse) {
      console.error("Failed to decrypt handshake response");
      return false;
    }

    if (
      !Buffer.from(extractedResponse.identityPubKey).equals(
        Buffer.from(responderIdentityPubKey)
      )
    ) {
      console.error("Identity public key mismatch in handshake response");
      return false;
    }

    // 6492 awareness
    const dpAny: any = extractedResponse.identityProof;
    if (!dpAny) {
      console.error("Missing identityProof in handshake response payload");
      return false;
    }
    // const sigPrimary: string = dpAny.signature;
    // const sig6492: string | undefined = dpAny.signature6492 ?? dpAny.erc6492;
    // const uses6492 = hasERC6492Suffix(sigPrimary) || !!sig6492;

    // const isContract1271 = await isSmartContract1271(responseEvent.responder,provider);

    const expectedKeys = {
      identityPubKey: extractedResponse.identityPubKey,
      signingPubKey: extractedResponse.signingPubKey,
    };

    return await verifyIdentityProof(
      extractedResponse.identityProof,
      responseEvent.responder,
      expectedKeys,
      provider
    );
  } catch (err) {
    console.error("verifyHandshakeResponseIdentity error:", err);
    return false;
  }
}

/**
 * Verify "IdentityProof" for EOAs and smart accounts.
 * - Verifies the signature with viem (EOA / ERC-1271 / ERC-6492).
 * - Parses and checks the expected address and public key against the message content.
 */
export async function verifyIdentityProof(
  identityProof: IdentityProof,
  smartAccountAddress: string,
  expectedUnifiedKeys: {
    identityPubKey: Uint8Array; 
    signingPubKey: Uint8Array; 
  },
  provider: Rpcish
): Promise<boolean> {
  try {
    const client = await makeViemPublicClient(provider);
    const address = smartAccountAddress as `0x${string}`;

    const okSig = await client.verifyMessage({
      address,
      message: identityProof.message,
      signature: identityProof.signature as `0x${string}`,
    });
    if (!okSig) {
      console.error("Binding signature invalid for address");
      return false;
    }

    const parsed = parseBindingMessage(identityProof.message);

    if (parsed.header && parsed.header !== "VerbEth Key Binding v1") {
      console.error("Unexpected binding header:", parsed.header);
      return false;
    }


    if (
      !parsed.address ||
      getAddress(parsed.address) !== getAddress(smartAccountAddress)
    ) {
      console.error("Binding message address mismatch");
      return false;
    }

    const expectedPkX = hexlify(
      expectedUnifiedKeys.identityPubKey
    ) as `0x${string}`;
    const expectedPkEd = hexlify(
      expectedUnifiedKeys.signingPubKey
    ) as `0x${string}`;

    if (!parsed.pkX25519 || hexlify(parsed.pkX25519) !== expectedPkX) {
      console.error("PkX25519 mismatch");
      return false;
    }
    if (!parsed.pkEd25519 || hexlify(parsed.pkEd25519) !== expectedPkEd) {
      console.error("PkEd25519 mismatch");
      return false;
    }

    if (parsed.context && parsed.context !== "verbeth") {
      console.error("Unexpected context:", parsed.context);
      return false;
    }
    if (parsed.version && parsed.version !== "1") {
      console.error("Unexpected version:", parsed.version);
      return false;
    }

    // if (typeof parsed.chainId === 'number' && parsed.chainId !== currentChainId) return false;

    return true;
  } catch (err) {
    console.error("verifyIdentityProof error:", err);
    return false;
  }
}

// ============= Utility Functions =============

export async function verifyAndExtractHandshakeKeys(
  handshakeEvent: HandshakeLog,
  provider: JsonRpcProvider
): Promise<{
  isValid: boolean;
  keys?: {
    identityPubKey: Uint8Array;
    signingPubKey: Uint8Array;
  };
}> {
  const isValid = await verifyHandshakeIdentity(handshakeEvent, provider);

  if (!isValid) {
    return { isValid: false };
  }

  const parsedKeys = parseHandshakeKeys(handshakeEvent);
  if (!parsedKeys) {
    return { isValid: false };
  }

  return {
    isValid: true,
    keys: parsedKeys,
  };
}

export async function verifyAndExtractHandshakeResponseKeys(
  responseEvent: HandshakeResponseLog,
  initiatorEphemeralSecretKey: Uint8Array,
  provider: JsonRpcProvider
): Promise<{
  isValid: boolean;
  keys?: {
    identityPubKey: Uint8Array;
    signingPubKey: Uint8Array;
    ephemeralPubKey: Uint8Array;
    note?: string;
  };
}> {

  const Rbytes = getBytes(responseEvent.responderEphemeralR); // hex -> Uint8Array
  const expectedTag = computeTagFromInitiator(
    initiatorEphemeralSecretKey,
    Rbytes
  );
  if (expectedTag !== responseEvent.inResponseTo) {
    return { isValid: false };
  }

  const extractedResponse = decryptAndExtractHandshakeKeys(
    responseEvent.ciphertext,
    initiatorEphemeralSecretKey
  );

  if (!extractedResponse) {
    return { isValid: false };
  }

  const isValid = await verifyHandshakeResponseIdentity(
    responseEvent,
    extractedResponse.identityPubKey,
    initiatorEphemeralSecretKey,
    provider
  );

  if (!isValid) {
    return { isValid: false };
  }

  return {
    isValid: true,
    keys: {
      identityPubKey: extractedResponse.identityPubKey,
      signingPubKey: extractedResponse.signingPubKey,
      ephemeralPubKey: extractedResponse.ephemeralPubKey,
      note: extractedResponse.note,
    },
  };
}

/**
 * Verify and derive duplex topics from a long-term DH secret.
 * - Accepts either `tag` (inResponseTo) or a raw salt as KDF input.
 * - Recomputes topicOut/topicIn deterministically from the identity DH.
 * - If topicInfo is provided (from HSR), also verify the checksum.
 * - Used by the initiator after decrypting a HandshakeResponse to confirm responder’s topics.
 */
export function verifyDerivedDuplexTopics({
  myIdentitySecretKey,
  theirIdentityPubKey,     
  tag,            
  salt,                     
  topicInfo
}: {
  myIdentitySecretKey: Uint8Array;
  theirIdentityPubKey: Uint8Array;
  tag?: `0x${string}`;
  salt?: Uint8Array;
  topicInfo?: TopicInfoWire;
}): { topics: DuplexTopics; ok?: boolean } {
  const s = salt ?? (tag ? getBytes(tag) : undefined);
  if (!s) throw new Error("Provide either salt or inResponseTo");

  const { topicOut, topicIn, checksum } = deriveDuplexTopics(
    myIdentitySecretKey,
    theirIdentityPubKey,
    s
  );

  const ok = topicInfo ? verifyDuplexTopicsChecksum(topicOut, topicIn, topicInfo.chk) : undefined;
  return { topics: { topicOut, topicIn }, ok };
}