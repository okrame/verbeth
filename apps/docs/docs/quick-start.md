---
sidebar_position: 1
slug: /quick-start
title: Quick Start
---

# Quick Start

Get end-to-end encrypted messaging working in your dApp.

## Install

```bash
npm install @verbeth/sdk ethers
```

## Setup Client

```typescript
import {
  createVerbethClient,
  deriveIdentityKeyPairWithProof,
  ExecutorFactory
} from '@verbeth/sdk';
import { ethers } from 'ethers';

// Contract address (Base mainnet)
const LOGCHAIN_ADDRESS = '0x62720f39d5Ec6501508bDe4D152c1E13Fd2F6707';

// 1. Connect wallet
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const address = await signer.getAddress();

// 2. Derive identity keys (requires 2 wallet signatures)
const { identityKeyPair, identityProof } = await deriveIdentityKeyPairWithProof(
  signer,
  address
);

// 3. Create executor for contract interactions
const contract = new ethers.Contract(LOGCHAIN_ADDRESS, LOGCHAIN_ABI, signer);
const executor = ExecutorFactory.createEOA(contract);

// 4. Create client
const client = createVerbethClient({
  address,
  signer,
  identityKeyPair,
  identityProof,
  executor,
});
```

## Send a Handshake

Start a conversation by sending a handshake to another address.
The returned secrets must be stored until the recipient responds.

```typescript
const recipientAddress = '0x...';

const { tx, ephemeralKeyPair, kemKeyPair } = await client.sendHandshake(
  recipientAddress,
  'Hello from Verbeth!'
);
await tx.wait();
```

## Accept a Handshake

When you receive a handshake, accept it to establish the encrypted channel. You can implement your own storage to persist the session.


```typescript
// Parse incoming handshake event from blockchain logs
const initiatorEphemeralPubKey = handshakeEvent.ephemeralPubKey;

const {
  tx,
  topicOutbound,
  topicInbound,
  responderEphemeralSecret,
  responderEphemeralPublic,
  salt,
  kemSharedSecret,
} = await client.acceptHandshake(initiatorEphemeralPubKey, 'Hey!');

await tx.wait();

const session = client.createResponderSession({
  contactAddress: handshakeEvent.sender,
  responderEphemeralSecret,
  responderEphemeralPublic,
  initiatorEphemeralPubKey,
  salt,
  kemSharedSecret,
});

await sessionStore.save(session);
```

## Create Session from Response

When the recipient responds to your handshake, create your session using the previously stored secrets.

```typescript
// hsrEvent is the HandshakeResponse event from the blockchain
const session = client.createInitiatorSessionFromHsr({
  contactAddress: recipientAddress,
  myEphemeralSecret: storedEphemeralSecret,     
  myKemSecret: storedKemSecret,                  
  hsrEvent: {
    responderEphemeralPubKey: hsrEvent.responderEphemeralPubKey,
    inResponseToTag: hsrEvent.inResponseTo,
    kemCiphertext: hsrEvent.kemCiphertext,
  },
});

await sessionStore.save(session);
```

## Send Messages

Once you have a session, configure the storage and send encrypted messages.

```typescript
client.setSessionStore(sessionStore);
client.setPendingStore(pendingStore);

const result = await client.sendMessage(
  session.conversationId,
  'This message is end-to-end encrypted!'
);

console.log('Sent:', result.txHash);
```

## Decrypt Messages

Decrypt incoming messages from the blockchain.

```typescript
const decrypted = await client.decryptMessage(
  messageEvent.topic,
  messageEvent.payload,
  senderSigningKey,
  false // isOwnMessage
);

if (decrypted) {
  console.log('Received:', decrypted.plaintext);
}
```

## Full Example

```typescript
import {
  createVerbethClient,
  deriveIdentityKeyPairWithProof,
  ExecutorFactory
} from '@verbeth/sdk';
import { ethers } from 'ethers';

const LOGCHAIN_ADDRESS = '0x62720f39d5Ec6501508bDe4D152c1E13Fd2F6707';

async function initVerbeth() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();

  const { identityKeyPair, identityProof } = await deriveIdentityKeyPairWithProof(
    signer,
    address
  );

  const contract = new ethers.Contract(LOGCHAIN_ADDRESS, LOGCHAIN_ABI, signer);
  const executor = ExecutorFactory.createEOA(contract);

  const client = createVerbethClient({
    address,
    signer,
    identityKeyPair,
    identityProof,
    executor,
  });

  return { client, identityKeyPair };
}

async function startConversation(client, recipientAddress: string) {
  const { tx, ephemeralKeyPair, kemKeyPair } = await client.sendHandshake(
    recipientAddress,
    'Starting secure conversation'
  );

  await tx.wait();

  return {
    ephemeralSecret: ephemeralKeyPair.secretKey,
    kemSecret: kemKeyPair.secretKey,
  };
}
```

## Next Steps

- **Identity binding**: Keys are cryptographically bound to your Ethereum address via signed messages
- **Handshake flow**: X3DH-like protocol with ML-KEM-768 for post-quantum security
- **Double Ratchet**: Forward secrecy with automatic topic evolution
