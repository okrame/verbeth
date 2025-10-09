<h1 align="center">
    Verbeth
</h1>

<p align="center">
    <!-- <a href="https://www.npmjs.com/package/@verbeth/sdk">
        <img src="https://img.shields.io/npm/v/@verbeth/sdk?style=flat-square">
    </a> -->
    <a href="LICENSE">
        <img src="https://img.shields.io/badge/license-MPL--2.0-blue?style=flat-square">
    </a>
    <a href="https://github.com/okrame/verbeth-sdk/actions/workflows/ci.yml">
  <img src="https://github.com/okrame/verbeth-sdk/actions/workflows/ci.yml/badge.svg?branch=dev%2Fstealth-hsr" />
</a>
    <a href="https://www.typescriptlang.org/">
        <img src="https://img.shields.io/badge/TypeScript-5.4+-blue?style=flat-square&logo=typescript">
    </a>
    <!-- <a href="https://codecov.io/gh/okrame/verbeth-sdk">
        <img src="https://img.shields.io/codecov/c/github/okrame/verbeth-sdk?style=flat-square">
    </a> -->
</p>

<p align="center">
E2EE messaging over Ethereum logs, using the blockchain as the only transport layer.
</p>

### Built With

This SDK and [demo app](https://verbeth-demo.vercel.app/) rely on few battle-tested libraries:

- [**TweetNaCl**](https://tweetnacl.js.org/) – Encryption/decryption (NaCl box)
- [**Ethers v6**](https://docs.ethers.org/v6/) – Core Ethereum interactions, providers, contracts, signing
- [**Viem**](https://viem.sh/) – Specific for EIP-1271/6492 verification and WebAuthn accounts
- [**Dexie**](https://dexie.org/) – Local IndexedDB storage

---

## How can Alice & Bob use Verbeth?

Alice wants to initiate a secure chat with Bob:

1. Alice generates a new **ephemeral keypair**.
2. She emits a `Handshake` event that includes:
   - her ephemeral public key (for this handshake only)
   - her long-term unified keys (X25519 + Ed25519)
   - a plaintext payload carrying her identityProof and an optional note
   - the recipientHash mapping to Bob
3. Bob watches logs for handshake events addressed to him (matching his recipientHash), and:
   - verifies Alice’s identity with the included identityProof,
   - prepares his `HandshakeResponse`
4. Bob computes a response tag and emits the response event:

   - Bob generates an ephemeral keypair (R, r) dedicated to the tag (i.e. Bob can't forge a response for someone else other than Alice)
   - He computes the tag `H( HKDF( ECDH( r, Alice.viewPub ), "verbeth:hsr"))`
   - He encrypts the response to Alice’s handshake ephemeral public key and includes:
     - his ephemeral public key for post-handshake
     - his identity keys (unified) + identityProof
     - topicInfo (see below) inside the encrypted payload
     - the public R and response tag in the log

5. Using her view (ephemeral) secret key and Bob’s public R, Alice recomputes the tag. She can then filter handshake response logs by this tag and decrypt the matching one.

6. Once handshake is complete, both derive duplex topics and start emitting `MessageSent` events:

- Using a long-term diffie–hellman shared secret and the response tag as salt, they derive:
  ```
  shared  = ECDH( Alice , Bob )
  topic = keccak256( HKDF(sha256, shared, salt, info) )
  ```
  N.B: with the tag salt, each handshake creates fresh topics
- Alice encrypts messages using Bob’s identity key with a fresh ephemeral key per message (and vice versa).
- They can sign messages with their long term signing key

```
ALICE (Initiator)              BLOCKCHAIN               BOB (Responder)
      |                            |                            |
      |----------------------------|----------------------------|
      |                          PHASE 0:                       |
      |                 Identity and Key Derivation             |
      |--------------------------->|                            |
      |  Generate identity keys     |                           |
      | Sign identity-binding msg  |                            |
      |  Create IdentityProof      |                            |
      |                            |<---------------------------|
      |                            |  Generate identity keys    |
      |                            | Sign identity-binding msg  |
      |                            |   Create IdentityProof     |
      |                            |                            |
      |  PHASE 1: Alice Initiates Handshake                     |
      |--------------------------->|                            |
      |  Generate ephemeral keypair|                            |
      |  Prepare HandshakeContent  |                            |
      |  Encode unified pubKeys    |                            |
      |  initiateHandshake()       |--------------------------->|
      |                            |  Emit Handshake event      |
      |                            |--------------------------->|
      |                            |  PHASE 2: Bob Receives     |
      |                            |  Listen for event          |
      |                            |  Parse unified pubKeys     |
      |                            |  Extract IdentityProof     |
      |                            |  Verify Alice's identity   |
      |                            |                            |
      |                            |  PHASE 3: Bob Responds     |
      |                            |--------------------------->|
      |                            |  If valid:                 |
      |                            |   - Generate ephemeral key |
      |                            |   - Prepare response       |
      |                            |   - Encrypt w/ Alice's     |
      |                            |     EPHEMERAL key          |
      |                            |  respondToHandshake()      |
      |                            |  Emit HandshakeResponse    |
      |                            |--------------------------->|
      |                            |  Else: reject handshake    |
      |                            |                            |
      |  PHASE 4: Alice Receives Response                       |
      |<--------------------------|                             |
      |  Listen for HandshakeResponse event                     |
      |  Decrypt response w/ own ephemeral secret               |
      |  Extract Bob's keys & proof                             |
      |  Verify Bob's identity                                  |
      |                                                         |
      |  PHASE 5: Secure Communication Established              |
      |--------------------------->|                            |
      |  Store Bob's keys          |                            |
      |  Ongoing:                  |                            |
      |   - Generate fresh         |                            |
      |     ephemeral keys         |                            |
      |   - Encrypt w/ Bob's       |                            |
      |     IDENTITY key +         |                            |
      |     fresh ephemeral        |                            |
      |   - Sign w/ Alice's key    |                            |
      |   - sendMessage()          |--------------------------->|
      |                            |  Message event received    |
      |                            |  Decrypt w/ Bob's          |
      |                            |    IDENTITY key +          |
      |                            |    ephemeral from msg      |
      |                            |  Verify signature          |
      |                            |  Secure message delivered  |
      |----------------------------|----------------------------|
      |                                                         |

```

## Contract

We include `sender` (= `msg.sender`) as an **indexed event field** to bind each log to the actual caller account (EOA or smart account) and make it "bloom-filterable".

A transaction receipt does not expose the immediate caller of this contract — it only contains the emitter address (this contract) and the topics/data — so recovering `msg.sender` would require execution traces.

Under ERC-4337 this becomes even trickier: the outer transaction targets the EntryPoint and tx.from is the bundler, not the smart account. Without including sender in the event, reliably linking a log to the originating account would require correlating EntryPoint internals or traces.

### Deployed Addresses

LogChainV1 (singleton) `0x41a3eaC0d858028E9228d1E2092e6178fc81c4f0`

ERC1967Proxy `0x62720f39d5Ec6501508bDe4D152c1E13Fd2F6707`

## Features

- Stateless encrypted messaging via logs
- Ephemeral keys & forward secrecy
- Handshake-based key exchange (no prior trust)
- Minimal metadata via `recipientHash`
- Fully on-chain: no servers, no relays
- Compatible with EOAs and smart contract accounts

The SDK now verifies handshakes and handshake responses using [viem.verifyMessage](https://viem.sh/docs/actions/public/verifyMessage).  
It supports both EOAs and Smart Contract Accounts — whether they’re already deployed or still counterfactual/pre-deployed — by leveraging:

- ERC-1271: for verifying signatures from smart contract wallets that are deployed.
- ERC-6492: a wrapper standard that lets smart contract accounts sign and be verified before deployment.

### Notes on the current model

**Discoverability**: If the sender does not yet know the recipient’s long-term public key (X25519), the sender (i.e. initiator) must emit a `Handshake` event. The recipient (i.e. reponder) replies with their keys and identity proof, after which the sender caches the verified mapping. If the key is already known (from a past `HandshakeResponse`, an on-chain announcement, or a static mapping), the handshake can be skipped.

**Identity key binding**: The message (es. “VerbEth Key Binding v1\nAddress: …\nPkEd25519: …\nPkX25519: …\nContext: …\nVersion: …”) is signed by the evm account directly binding its address to the long-term keys (i.e. preventing impersonation).

**Non-repudiation**: By default, confidentiality and integrity are guaranteed by AEAD with NaCl box. Additionally, the sender can attach a detached Ed25519 signature over using the Ed25519 key bound in the handshake. This effectively provides per-message origin authentication that is verifiable: a recipient (or any third party) can prove the message was produced by the holder of that specific Ed25519 key. Otherwise, attribution relies on context, making sender spoofing at the application layer harder to detect.

**Forward secrecy**: Each message uses a fresh sender ephemeral key. This provides sender-side forward secrecy for sent messages: once the sender deletes the ephemeral secret, a future compromise of their long-term keys does not expose past ciphertexts. Handshake responses also use ephemeral↔ephemeral, enjoying the same property. However, if a recipient’s long-term X25519 key is compromised, all past messages addressed to them remain decryptable. A double-ratchet (or ephemeral↔ephemeral messaging) can extend forward secrecy to the recipient side (see [here](#improvement-ideas)).

**Handshake linkability:**
Each handshake relies on a diffie–hellman exchange between the initiator’s handshake ephemeral key and the responder’s tag ephemeral R. The resulting tag is an opaque pointer that hides who the initiator is. Reusing only the responder’s R lets observers group his responses that reused the same tag key, but it does not reveal which initiator each response targets. Reusing only initiator's ephemeral pubkey lets observers group her handshakes (which already show sender in this design, but breaking unlinkability if hidden behind a relay). The tag repeats only if both ephemerals are reused together. The real issue is a lack of forward secrecy during handshaking: if either handshake-ephemeral secret is later compromised and had been reused, an attacker could retroactively derive all matching tags and link multiple past handshakes between the same parties. In practice, both sides should generate fresh ephemerals per handshake and securely erase them after use.

**Communication channels linkability**: Current version has duplex topics by default: one topic per direction, obtained with HKDF. So, each side writes on its own secret topic and we don’t get the “two accounts posting on the same topic, hence they’re chatting” giveaway. Also, the topic is optionally bound to each message by covering it in the detached Ed25519 signature (topic || epk || nonce || ciphertext), which kills cross-topic replays. At the application level, each client queries only its inbound topics so the RPC endpoint never learns both sides of a duplex pair. Note: timing during the handshake phase (and general traffic analysis) can still reveal communication patterns.

## Example Usage (WIP)

```ts
import {
  decryptLog,
  initiateHandshake,
  sendEncryptedMessage,
  deriveIdentityKeyPairWithProof,
} from "@verbeth/sdk";

// 1. Generate or load your long-term identity keypair
const { publicKey, secretKey } = await deriveIdentityKeyPairWithProof(
  walletClient
);

// 2. Receive and decrypt a message from an on-chain log event
const decrypted = decryptLog(eventLog, secretKey);

// 3. Start a handshake with another user
await initiateHandshake({
  contract, // LogChainV1
  recipientAddress: "0xBob...",
  ephemeralPubKey: ephemeralKey.publicKey,
  plaintextPayload: "Hi Bob, ping from Alice", // (optional) plaintext handshake message
});

// 4. Send an encrypted message (after handshake is established)
await sendEncryptedMessage({
  contract,
  recipientAddress: "0xBob...",
  message: "Hello again, Bob!",
  senderEphemeralKeyPair: ephemeralKey, // ephemeral keypair used for forward secrecy
  recipientPublicKey,
});
```

## Improvement ideas

| Title                                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                   | Refs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bidirectional Forward Secrecy (session ratchet)    | Achieve **end-to-end, bilateral FS** even if the **recipient’s long-term X25519** is later compromised. Two options: (1) switch messaging to **ephemeral↔ephemeral** (derive per-message DH and discard secrets), or (2) derive a **symmetric session ratchet** from the handshake (e.g., **Double Ratchet** for 1:1; **MLS** for 1\:many) so every message advances sending/receiving chains and old keys are irrecoverable. | Signal **Double Ratchet** spec (post-X3DH): [https://signal.org/docs/specifications/doubleratchet/](https://signal.org/docs/specifications/doubleratchet/) ; **MLS** (RFC 9420): [https://www.rfc-editor.org/rfc/rfc9420](https://www.rfc-editor.org/rfc/rfc9420) ; Matrix **Olm/Megolm** (Double Ratchet for 1:1 / group): [https://gitlab.matrix.org/matrix-org/olm](https://gitlab.matrix.org/matrix-org/olm) ; **Status/Waku** Double Ratchet transport: [https://specs.status.im/spec/5](https://specs.status.im/spec/5) and Waku X3DH/DR notes: [https://rfc.vac.dev/waku/standards/application/53/x3dh/](https://rfc.vac.dev/waku/standards/application/53/x3dh/) ; **XMTP** (MLS-based): [https://docs.xmtp.org/protocol/overview](https://docs.xmtp.org/protocol/overview) |
| Passkeys & WebAuthn PRF for encryption of messages | Let smart accounts encrypt messages with the same passkey used for UserOps. Use the WebAuthn **PRF** extension to derive an AEAD key at auth time (plus per-message salt/nonce) so users only manage the passkey—gaining stronger security (hardware/biometric protection) and portability/recovery (OS-synced passkeys or hardware keys).                                                                                    | [Corbado: Passkeys & PRF](https://www.corbado.com/blog/passkeys-prf-webauthn), [W3C WebAuthn L3: PRF extension](https://www.w3.org/TR/webauthn-3/), [Chrome: Intent to Ship (PRF)](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI), [SimpleWebAuthn: PRF docs](https://simplewebauthn.dev/docs/advanced/prf)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
