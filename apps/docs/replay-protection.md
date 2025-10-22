# Replay Protection in VerbEth

VerbEth uses Ethereum event logs as the only transport layer for encrypted messages.  
Replay protection is not enforced on-chain and it doesn’t need to be (hence saving on gas).

## Why?

Ethereum already gives us:

- **Sender authentication** via `msg.sender`
- **Spam resistance** via gas costs
- **Immutable message delivery** via event logs
- **Timestamped, ordered history** per sender

This means every message is:

- Authenticated by the sender’s Ethereum key
- Costly to publish 
- Cryptographically anchored to the chain

> We rely on AEAD provided by nacl.box (XSalsa20 + Poly1305),
> but avoid additional detached signatures or layered MACs.

---

## So What Does `nonce` Do?

We include a `uint256 nonce` in each message log event to support:

- Client-side **message ordering**
- Optional **deduplication** (e.g. prevent duplicate rendering)
- Future support for **group/thread consistency**

```solidity
event MessageSent(
        address indexed sender,
        bytes ciphertext,
        uint256 timestamp,
        bytes32 indexed topic,
        uint256 nonce
    );
```

But:  
🔸 There is no on-chain enforcement of nonce values  
🔸 Recipients may ignore them entirely or filter replays locally

---

## Should You Verify a Message Wasn't Replayed?

Only if you want to. The SDK may optionally track `(sender, topic, nonce)` triplets to filter duplicates:

```ts
const seen = new Set<string>();
function isReplay(log) {
  const key = `${log.sender}:${log.topic}:${log.nonce}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}
```

---