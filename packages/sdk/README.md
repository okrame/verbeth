# @verbeth/sdk

Verbeth enables secure, E2EE messaging using Ethereum event logs as the only transport layer. No servers, no relays—just the blockchain.

## Features

- **End-to-end encryption** using NaCl Box (X25519 + XSalsa20-Poly1305)
- **Forward secrecy** with ephemeral keys per message
- **Handshake protocol** for secure key exchange
- **Privacy-focused** with minimal metadata via `recipientHash`
- **EOA & Smart Account support** (ERC-1271/6492 compatible)
- **Fully on-chain** - no centralized infrastructure

## Installation

```bash
npm install @verbeth/sdk ethers tweetnacl
```

## Quick Start

### 1. Initialize with VerbethClient (Recommended)

```typescript
import { VerbethClient, ExecutorFactory, deriveIdentityKeyPairWithProof } from '@verbeth/sdk';
import { Contract, BrowserProvider } from 'ethers';
import { LogChainV1__factory } from '@verbeth/contracts/typechain-types';

// Setup
const provider = new BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const address = await signer.getAddress();

// Create contract instance
const contract = LogChainV1__factory.connect(LOGCHAIN_ADDRESS, signer);

// Derive identity keys (done once, then stored)
const { identityKeyPair, identityProof } = await deriveIdentityKeyPairWithProof(signer);

// Create executor (handles transaction submission)
const executor = ExecutorFactory.createEOA(contract);

// Initialize client
const client = new VerbethClient({
  executor,
  identityKeyPair,
  identityProof,
  signer,
  address
});

// Send a handshake to start chatting
const { tx, ephemeralKeyPair } = await client.sendHandshake(
  '0xRecipientAddress...',
  'Hello! Want to chat?'
);

// Store ephemeralKeyPair. you'll just need it to decrypt the handshake response!

// Accept a handshake
const { tx, duplexTopics } = await client.acceptHandshake(
  handshakeEvent.ephemeralPubKey,
  handshakeEvent.identityPubKey,
  'Sure, lets chat!'
);

// Send encrypted messages
await client.sendMessage(
  duplexTopics.topicOut,
  recipientIdentityPubKey,
  'This message is encrypted!'
);

// Decrypt received messages
const decrypted = await client.decryptMessage(
  messageEvent.ciphertext,
  senderIdentityPubKey
);
```

### 2. Low-level API

For more control, use the low-level functions:

```typescript
import {
  initiateHandshake,
  respondToHandshake,
  sendEncryptedMessage,
  decryptMessage,
  deriveIdentityKeyPairWithProof
} from '@verbeth/sdk';

// Generate identity keys
const { identityKeyPair, identityProof } = await deriveIdentityKeyPairWithProof(signer);

// Initiate handshake
const ephemeralKeyPair = nacl.box.keyPair();
const tx = await initiateHandshake({
  executor,
  recipientAddress: '0xBob...',
  ephemeralPubKey: ephemeralKeyPair.publicKey,
  identityKeyPair,
  identityProof,
  plaintextPayload: 'Hi Bob!'
});

// Send encrypted message
await sendEncryptedMessage({
  executor,
  topic: derivedTopic,
  message: 'Secret message',
  recipientPubKey: bobsIdentityKey,
  senderAddress: myAddress,
  senderSignKeyPair: identityKeyPair,
  timestamp: Date.now()
});

// Decrypt message
const plaintext = decryptMessage(
  ciphertext,
  senderIdentityPubKey,
  myIdentityKeyPair.secretKey
);
```

## Smart Account Support

Verbeth works with ERC-4337 smart accounts:

```typescript
import { ExecutorFactory } from '@verbeth/sdk';

// For UserOp-based execution
const executor = ExecutorFactory.createUserOp(
  contract,
  bundler,
  smartAccount,
  signer
);

// For direct EntryPoint execution
const executor = ExecutorFactory.createDirectEntryPoint(
  contract,
  entryPoint,
  smartAccountAddress,
  signer
);
```

## Contract Addresses

**LogChainV1 Singleton:** `0x41a3eaC0d858028E9228d1E2092e6178fc81c4f0`

**ERC1967Proxy:** `0x62720f39d5Ec6501508bDe4D152c1E13Fd2F6707`

## How It Works

1. **Identity Keys**: Each account derives long-term X25519 (encryption) + Ed25519 (signing) keys bound to their address via signature
2. **Handshake**: Alice sends her ephemeral key + identity proof to Bob via a `Handshake` event
3. **Response**: Bob verifies Alice's identity and responds with his keys + duplex topics
4. **Messaging**: Both parties derive shared topics and exchange encrypted messages via `MessageSent` events
5. **Decryption**: Recipients monitor their inbound topic and decrypt with their identity key


## Security Considerations

- **Forward Secrecy**: Fresh ephemeral keys per message provide sender-side forward secrecy
- **Identity Binding**: Addresses are cryptographically bound to long-term keys via signature
- **Non-Repudiation**: Optional Ed25519 signatures prove message origin
- **Privacy**: RecipientHash hides recipient identity; duplex topics separate communication channels

⚠️ **Note**: Current design provides sender-side forward secrecy. Recipient-side FS requires ephemeral↔ephemeral or session ratcheting (e.g., Double Ratchet).

## Built With

- [TweetNaCl](https://tweetnacl.js.org/) - Encryption primitives
- [Ethers v6](https://docs.ethers.org/v6/) - Ethereum interactions
- [Viem](https://viem.sh/) - EIP-1271/6492 verification
- [Noble Curves](https://github.com/paulmillr/noble-curves) - Elliptic curve operations

## Examples

Check out the [demo application](https://github.com/okrame/verbeth-sdk/tree/main/apps/demo) for a complete implementation.

## Documentation

For detailed protocol documentation, security analysis, and improvement proposals, see the [main repository](https://github.com/okrame/verbeth-sdk).

## License

MPL-2.0

## Links

- [GitHub Repository](https://github.com/okrame/verbeth-sdk)
- [Demo App](https://verbeth-demo.vercel.app/)
- [Contract Source](https://github.com/okrame/verbeth-sdk/tree/main/packages/contracts)

---

**Questions or feedback?** Open an issue on [GitHub](https://github.com/okrame/verbeth-sdk/issues).