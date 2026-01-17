// import { describe, it, expect, vi } from "vitest";
// import nacl from "tweetnacl";
// import { JsonRpcProvider } from "ethers";

// import { getNextNonce } from "../src/utils/nonce.js";
// import { convertPublicKeyToX25519 } from "../src/utils/x25519.js";
// import { isSmartContract1271, parseBindingMessage } from "../src/utils.js";
// import { ExecutorFactory } from "../src/index.js";
// import type { LogChainV1 } from "@verbeth/contracts/typechain-types";

// const fakeProvider = {
//   async getCode(addr: string) {
//     return addr === "0xCc…Cc" ? "0x60016000" : "0x";
//   },
//   async call() {
//     return "0x1626ba7e" + "0".repeat(56);
//   },
//   async resolveName(name: string) {
//     return name;
//   },
// } as unknown as JsonRpcProvider;


// describe("getNextNonce", () => {
//   it("increments per (sender, topic) and returns bigint", () => {
//     const n1 = getNextNonce("0xAlice", "topic");
//     const n2 = getNextNonce("0xAlice", "topic");
//     const nOther = getNextNonce("0xBob", "topic");
//     expect(n2).toBe(n1 + 1n);
//     expect(nOther).toBe(1n);
//   });
// });

// describe("Utils Functions", () => {
//   it("isSmartContract1271 returns true for contract bytecode", async () => {
//     expect(await isSmartContract1271("0xCc…Cc", fakeProvider)).toBe(true);
//     expect(await isSmartContract1271("0xEe…Ee", fakeProvider)).toBe(false);
//   });

//   it("convertPublicKeyToX25519 returns 32-byte key", () => {
//     const raw = new Uint8Array(64).fill(1);
//     const out = convertPublicKeyToX25519(raw);
//     expect(out).toHaveLength(32);
//   });
// });


// describe("Unified Keys Utilities", () => {
//   it("should handle unified key operations", () => {
//     expect(typeof isSmartContract1271).toBe("function");
//   });
// });

// describe("parseBindingMessage", () => {
//   it("parses a well-formed binding message", () => {
//     const msg = [
//       "VerbEth Key Binding v1",
//       "Address: 0x1234567890abcdef1234567890abcdef12345678",
//       "PkEd25519: 0x" + "11".repeat(32),
//       "PkX25519: 0x" + "22".repeat(32),
//       "Context: verbeth",
//       "Version: 1",
//       "ChainId: 8453",
//       "RpId: example.com",
//     ].join("\n");

//     const parsed = parseBindingMessage(msg);

//     expect(parsed.header).toBe("VerbEth Key Binding v1");
//     expect(parsed.address?.toLowerCase()).toBe("0x1234567890abcdef1234567890abcdef12345678");
//     expect(parsed.pkEd25519).toBe("0x" + "11".repeat(32));
//     expect(parsed.pkX25519).toBe("0x" + "22".repeat(32));
//     expect(parsed.context).toBe("verbeth");
//     expect(parsed.version).toBe("1");
//     expect(parsed.chainId).toBe(8453);
//     expect(parsed.rpId).toBe("example.com");
//   });

//   it("handles missing optional fields", () => {
//     const msg = [
//       "VerbEth Key Binding v1",
//       "Address: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
//     ].join("\n");

//     const parsed = parseBindingMessage(msg);

//     expect(parsed.header).toBe("VerbEth Key Binding v1");
//     expect(parsed.address?.toLowerCase()).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");

//     expect(parsed.pkEd25519).toBeUndefined();
//     expect(parsed.pkX25519).toBeUndefined();
//     expect(parsed.context).toBeUndefined();
//     expect(parsed.version).toBeUndefined();
//     expect(parsed.chainId).toBeUndefined();
//     expect(parsed.rpId).toBeUndefined();
//   });

//   it("ignores lines without ':'", () => {
//     const msg = [
//       "VerbEth Key Binding v1",
//       "This line has no colon",
//       "Address: 0x1234567890abcdef1234567890abcdef12345678",
//     ].join("\n");

//     const parsed = parseBindingMessage(msg);
//     expect(parsed.address?.toLowerCase()).toBe("0x1234567890abcdef1234567890abcdef12345678");
//   });
// });