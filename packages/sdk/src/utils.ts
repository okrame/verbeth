// packages/sdk/src/utils.ts

import {
  Contract,
  JsonRpcProvider,
  getAddress,
  hexlify,
} from "ethers";
import { keccak256, toUtf8Bytes } from "ethers";
import { AbiCoder } from "ethers";
import {
  createPublicClient,
  custom,
  defineChain,
  type PublicClient,
} from "viem";
import { DuplexTopics } from "./types.js";


export function parseBindingMessage(message: string): {
  header?: string;
  address?: string;
  pkEd25519?: `0x${string}`;
  pkX25519?: `0x${string}`;
  context?: string;
  version?: string;
  chainId?: number;
  rpId?: string;
} {
  const lines = message.split("\n").map((l) => l.trim());
  const out: any = {};
  if (lines[0]) out.header = lines[0];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();

    if (key === "address") out.address = getAddress(val);
    if (key === "pked25519") {
      out.pkEd25519 = hexlify(val) as `0x${string}`;
    }
    if (key === "pkx25519") {
      out.pkX25519 = hexlify(val) as `0x${string}`;
    }
    if (key === "context") out.context = val;
    if (key === "version") out.version = val;
    if (key === "chainid") out.chainId = Number(val);
    if (key === "rpid") out.rpId = val;
  }
  return out;
}

export type Rpcish =
  | import("ethers").JsonRpcProvider
  | import("ethers").BrowserProvider 
  | { request: (args: { method: string; params?: any[] }) => Promise<any> }; // generic EIP-1193

function toEip1193(provider: Rpcish) {
  if ((provider as any).request)
    return provider as { request: ({ method, params }: any) => Promise<any> };

  if ((provider as any).send) {
    return {
      request: ({ method, params }: { method: string; params?: any[] }) =>
        (provider as any).send(method, params ?? []),
    };
  }
  throw new Error("Unsupported provider: cannot build EIP-1193 request");
}

export async function makeViemPublicClient(
  provider: Rpcish
): Promise<PublicClient> {
  const eip1193 = toEip1193(provider);

  let chainId = 1;
  try {
    const hex = await eip1193.request({ method: "eth_chainId" });
    chainId = Number(hex);
  } catch {

  }

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });

  return createPublicClient({ chain, transport: custom(eip1193) });
}

export const ERC6492_SUFFIX =
  "0x6492649264926492649264926492649264926492649264926492649264926492";

export function hasERC6492Suffix(sigHex: string): boolean {
  if (!sigHex || typeof sigHex !== "string") return false;
  const s = sigHex.toLowerCase();
  return s.endsWith(ERC6492_SUFFIX.slice(2).toLowerCase());
}

/**
 * Checks if an address is a smart contract that supports EIP-1271 signature verification
 * Returns true if the address has deployed code AND implements isValidSignature function
 */
export async function isSmartContract1271(
  address: string,
  provider: JsonRpcProvider
): Promise<boolean> {
  try {
    const code = await provider.getCode(address);
    if (code === "0x") {
      return false;
    }

    const contract = new Contract(
      address,
      [
        "function isValidSignature(bytes32, bytes) external view returns (bytes4)",
      ],
      provider
    );

    // ECDSA smart contracts
    try {
      await contract.isValidSignature.staticCall(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x"
      );
      return true;
    } catch (simpleErr) {
      // WebAuthn format
      try {
        const authenticatorData = "0xdeadbeef";
        const clientDataJSON = "0xbeefdead";
        const rawSignature = "0x" + "11".repeat(64);

        const abi = AbiCoder.defaultAbiCoder();
        const webAuthnAuth = abi.encode(
          ["bytes", "bytes", "bytes"],
          [authenticatorData, clientDataJSON, rawSignature]
        );
        const ownerIndex = 0;
        const signatureWrapper = abi.encode(
          ["uint256", "bytes"],
          [ownerIndex, webAuthnAuth]
        );
        const hash = keccak256(toUtf8Bytes("test message"));

        const result = await contract.isValidSignature.staticCall(
          hash,
          signatureWrapper
        );
        return result === "0x1626ba7e";
      } catch (webAuthnErr: any) {
        // if it's a CALL_EXCEPTION without data then function exists
        if (
          (webAuthnErr as any).code === "CALL_EXCEPTION" &&
          (!(webAuthnErr as any).data ||
            (webAuthnErr as any).data === "0x" ||
            (webAuthnErr as any).data === null)
        ) {
          return true;
        }
        return false;
      }
    }
  } catch (err) {
    console.error("Error checking if address is smart contract:", err);
    return false;
  }
}

// picks the correct outbound topic from a DuplexTopics structure
export function pickOutboundTopic(isInitiator: boolean, t: DuplexTopics): `0x${string}` {
  return isInitiator ? t.topicOut : t.topicIn;
}

