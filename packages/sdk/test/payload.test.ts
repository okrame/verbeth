import { describe, expect, it } from "vitest";

import { parseHandshakePayload } from "../src/payload.js";

describe("parseHandshakePayload", () => {
  it("accepts an empty plaintextPayload when identityProof is valid", () => {
    const payload = JSON.stringify({
      plaintextPayload: "",
      identityProof: {
        message: "VerbEth Key Binding v1\nAddress: 0x1234...",
        signature: "0x" + "ab".repeat(65),
      },
    });

    expect(parseHandshakePayload(payload)).toEqual({
      plaintextPayload: "",
      identityProof: {
        message: "VerbEth Key Binding v1\nAddress: 0x1234...",
        signature: "0x" + "ab".repeat(65),
      },
    });
  });

  it("rejects payloads with malformed identityProof shape", () => {
    const payload = JSON.stringify({
      plaintextPayload: "",
      identityProof: {
        message: "VerbEth Key Binding v1\nAddress: 0x1234...",
      },
    });

    expect(() => parseHandshakePayload(payload)).toThrow(
      "Invalid handshake payload: missing identityProof"
    );
  });
});
