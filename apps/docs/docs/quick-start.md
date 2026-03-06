---
sidebar_position: 1
slug: /quick-start
title: Quickstart
---

# Quickstart

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
  ExecutorFactory,
  getVerbethAddress,
  VERBETH_ABI,
} from '@verbeth/sdk';
import { ethers } from 'ethers';

// 1. Connect wallet
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const address = await signer.getAddress();

// 2. Derive identity keys (requires 2 wallet signatures)
const { keyPair, identityProof } = await deriveIdentityKeyPairWithProof(
  signer,
  address,
  executorAddress // this could either match the EOA address or not
);

// 3. Create executor for contract interactions
const contract = new ethers.Contract(getVerbethAddress(), VERBETH_ABI, signer);
const executor = ExecutorFactory.createEOA(contract);

// 4. Create client
const client = createVerbethClient({
  address,
  signer,
  keyPair,
  identityProof,
  executor,
  sessionStore, 
  pendingStore, 
});
```

`SessionStore` and `PendingStore` are interfaces you implement to connect the client to your persistence layer (localStorage, IndexedDB, any database, etc.).

## Create a connection

To create a connection between two EVM accounts that have never interacted before, a handshake is required.

### Initate a handshake request

Start a conversation by sending a handshake to another address.

>The optional message attached to the handshake is plaintext, unless a shared secret already exists between the accounts. However, encrypted contact discovery will be covered in future iterations.

The SDK generates and returns two keypairs that must be securely stored until the recipient responds.

```typescript
const recipientAddress = '0x...';

const { tx, ephemeralKeyPair, kemKeyPair } = await client.sendHandshake(
  recipientAddress,
  'Hello from Verbeth!'
);
await tx.wait();

// These secrets are needed to create the session when a response arrives
await pendingContactStore.save({
  contactAddress: recipientAddress,
  ephemeralSecret: ephemeralKeyPair.secretKey,
  kemSecret: kemKeyPair.secretKey,
});
```

### Respond to a handshake request

When a `Handshake` event arrives on-chain, verify the sender's identity proof before responding.

>**Note:** Always call `verifyHandshakeIdentity(handshakeEvent, provider)` before accepting. This checks that the sender's keys are cryptographically bound to their EVM address.   
To see why go read the [Identity](./concepts/identity#why-not-just-use-the-transaction-signature) section.

```typescript
// this public key is a Uint8Array from the on-chain handshake event
const initiatorEphemeralPubKey = handshakeEvent.ephemeralPubKey;

const {
  tx,
  responderEphemeralSecret,
  responderEphemeralPublic,
  salt,
  kemSharedSecret,
} = await client.acceptHandshake(initiatorEphemeralPubKey, 'Hey!');

await tx.wait();
```

## Create a session

After the handshake exchange, both parties independently derive their local session from the exchanged key material. The session manages all state for subsequent encrypted messages.

### As initiator

Call this when a `HandshakeResponse` event arrives on-chain matching your earlier handshake.

>**Note:** Before creating the session, call `verifyAndExtractHandshakeResponseKeys(hsrEvent, storedEphemeralSecret, storedKemSecret, provider)` to verify the responder's identity and the hybrid tag.

```typescript
// storedEphemeralSecret and storedKemSecret were saved after sendHandshake
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

### As responder

Call this right after `acceptHandshake` completes, using the values it returned alongside data from the original `Handshake` event.

```typescript
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

This means that the responder can have a session and start sending e2ee messages immediately, unlike the initiator that must wait for their response. 

## Use a session

Parties can leverage the established session to carry on encrypted conversations over stealth topics to preserve metadata privacy. 

>Verbeth uses rotating stealth topics that change automatically with each Diffie-Hellman ratchet step, hence requiring to update the on-chain event subscriptions. See [Topic Ratcheting](./concepts/ratchet/topic-ratcheting) for a full explanation.


### Send encrypted messages

```typescript
const result = await client.sendMessage(
  session.conversationId,
  'This message is e2e encrypted!'
);

console.log('Sent:', result.txHash);
```

>`sendMessage()` encrypts and burns a ratchet slot immediately. After on-chain confirmation, call `client.confirmTx(result.txHash)` to finalise the pending record. If the transaction fails, the slot is lost but the session remains consistent.

### Decrypt incoming messages

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

The complete flow from wallet connection to encrypted messaging.

<details>
<summary>Setup</summary>

```typescript
import {
  createVerbethClient,
  deriveIdentityKeyPairWithProof,
  ExecutorFactory,
  getVerbethAddress,
  VERBETH_ABI,
} from '@verbeth/sdk';
import { ethers } from 'ethers';

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const address = await signer.getAddress();

const { keyPair, identityProof } = await deriveIdentityKeyPairWithProof(signer, address, address);

const contract = new ethers.Contract(getVerbethAddress(), VERBETH_ABI, signer);
const executor = ExecutorFactory.createEOA(contract);

const client = createVerbethClient({
  address,
  signer,
  keyPair,
  identityProof,
  executor,
  sessionStore,  // your SessionStore implementation
  pendingStore,  // your PendingStore implementation
});
```

</details>

<details>
<summary>Alice: send handshake</summary>

```typescript
const { tx, ephemeralKeyPair, kemKeyPair } = await client.sendHandshake(
  bobAddress,
  'Hello from Verbeth!'
);
await tx.wait();

// Persist handshake secrets until Bob's HandshakeResponse arrives on-chain.
// pendingContactStore is your own store — separate from the SDK's PendingStore (for messages).
await pendingContactStore.save({
  contactAddress: bobAddress,
  ephemeralSecret: ephemeralKeyPair.secretKey,
  kemSecret: kemKeyPair.secretKey,
});
```

</details>

<details>
<summary>Bob: accept handshake & create session</summary>

When a `Handshake` event arrives on-chain for Bob:

```typescript
// initiatorEphemeralPubKey is a Uint8Array from the on-chain Handshake event
const initiatorEphemeralPubKey = handshakeEvent.ephemeralPubKey;

const {
  tx,
  responderEphemeralSecret,
  responderEphemeralPublic,
  salt,
  kemSharedSecret,
} = await client.acceptHandshake(initiatorEphemeralPubKey, 'Hey!');
await tx.wait();

// Bob can create a session and start sending immediately,
// without waiting for Alice to confirm.
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

</details>

<details>
<summary>Alice: create session from Bob's response</summary>

When a `HandshakeResponse` event arrives on-chain for Alice:

```typescript
const { ephemeralSecret, kemSecret } = await pendingContactStore.get(bobAddress);

const session = client.createInitiatorSessionFromHsr({
  contactAddress: bobAddress,
  myEphemeralSecret: ephemeralSecret,
  myKemSecret: kemSecret,
  hsrEvent: {
    responderEphemeralPubKey: hsrEvent.responderEphemeralPubKey,
    inResponseToTag: hsrEvent.inResponseTo,
    kemCiphertext: hsrEvent.kemCiphertext,
  },
});
await sessionStore.save(session);
```

</details>

<details>
<summary>Send and receive messages</summary>


```typescript
// Send
const result = await client.sendMessage(session.conversationId, 'This is e2e encrypted!');
console.log('Sent:', result.txHash);

// Decrypt incoming (from an on-chain MessageSent event)
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

</details>

## Next Steps

- **Identity binding**: Keys are cryptographically bound to your Ethereum address via signed messages
- **Handshake flow**: X3DH-like protocol with ML-KEM-768 for post-quantum security
- **Double Ratchet**: Forward secrecy with automatic topic evolution
