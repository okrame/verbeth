// packages/sdk/src/verify.ts
// CLEANED VERSION - duplexTopics verification removed

import { JsonRpcProvider, getBytes, hexlify, getAddress } from "ethers";
import { decryptAndExtractHandshakeKeys, computeTagFromInitiator } from "./crypto.js";
// REMOVED: verifyDuplexTopicsChecksum, deriveDuplexTopics imports
import { HandshakeLog, HandshakeResponseLog, IdentityProof, IdentityContext } from "./types.js";
// REMOVED: TopicInfoWire, DuplexTopics from imports
import { parseHandshakePayload, parseHandshakeKeys } from "./payload.js";
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
  provider: JsonRpcProvider,
  ctx?: IdentityContext
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

    return await verifyIdentityProof(
      content.identityProof,
      handshakeEvent.sender,
      parsedKeys,
      provider,
      ctx
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
  provider: JsonRpcProvider,
  ctx?: IdentityContext
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

    const dpAny: any = extractedResponse.identityProof;
    if (!dpAny) {
      console.error("Missing identityProof in handshake response payload");
      return false;
    }

    const expectedKeys = {
      identityPubKey: extractedResponse.identityPubKey,
      signingPubKey: extractedResponse.signingPubKey,
    };

    return await verifyIdentityProof(
      extractedResponse.identityProof,
      responseEvent.responder,
      expectedKeys,
      provider,
      ctx
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
  address: string,
  expectedUnifiedKeys: {
    identityPubKey: Uint8Array; 
    signingPubKey: Uint8Array; 
  },
  provider: Rpcish,
  ctx?: IdentityContext
): Promise<boolean> {
  try {
    const client = await makeViemPublicClient(provider);
    const inputAddress = address as `0x${string}`;

    const parsed = parseBindingMessage(identityProof.message);

    if (!parsed.address) {
      console.error("Parsed address is undefined");
      return false;
    }
    const signerAddress = getAddress(parsed.address) as `0x${string}`;

    const okSig = await client.verifyMessage({
      address: signerAddress,
      message: identityProof.message,
      signature: identityProof.signature as `0x${string}`,
    });
    if (!okSig) {
      console.error("Binding signature invalid for signer address");
      return false;
    }

    if (parsed.header && parsed.header !== "VerbEth Key Binding v1") {
      console.error("Unexpected binding header:", parsed.header);
      return false;
    }

    if (
      !parsed.executorSafeAddress ||
      getAddress(parsed.executorSafeAddress) !== getAddress(inputAddress)
    ) {
      console.error("Binding message Safe address mismatch");
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

    // anti replay cross chain or cross dapp:
    if (typeof ctx?.chainId === "number") {
      if (typeof parsed.chainId !== "number" || parsed.chainId !== ctx.chainId) {
        console.error("ChainId mismatch");
        return false;
      }
    }
    if (ctx?.rpId) {
      if (!parsed.rpId || parsed.rpId !== ctx.rpId) {
        console.error("RpId mismatch");
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error("verifyIdentityProof error:", err);
    return false;
  }
}

// ============= Utility Functions =============

export async function verifyAndExtractHandshakeKeys(
  handshakeEvent: HandshakeLog,
  provider: JsonRpcProvider,
  ctx?: IdentityContext
): Promise<{
  isValid: boolean;
  keys?: {
    identityPubKey: Uint8Array;
    signingPubKey: Uint8Array;
  };
}> {
  const isValid = await verifyHandshakeIdentity(handshakeEvent, provider, ctx);

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
  provider: JsonRpcProvider,
  ctx?: IdentityContext
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
    provider,
    ctx
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

// =============================================================================
// REMOVED FUNCTIONS:
// =============================================================================
// 
// verifyDerivedDuplexTopics() - removed, no longer using identity-based topics
//                               Topics now derive from ephemeral DH in ratchet/kdf.ts
//
// =============================================================================