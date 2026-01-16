# Verbeth Metadata Privacy Model

## On-Chain Data (Public)

| Event | Visible Fields | Links Participants? |
|-------|---------------|---------------------|
| **Handshake** | sender, `recipientHash` | ⚠️ Confirmable only (requires guessing recipient) |
| **HandshakeResponse** | responder, `inResponseTo` tag | ❌ No (tag is ephemeral-derived) |
| **MessageSent** | sender, `topic`, ciphertext | ❌ No (topic is one-directional) |

## What Passive Chain Observers Learn

✅ **Can determine:**
- Address X uses Verbeth
- Address X sends messages to topic T
- Address X initiated a handshake with *someone* (if recipientHash matched to a guessed address)

❌ **Cannot determine:**
- Who receives messages on topic T
- Whether a handshake was accepted (response tag unlinkable)
- That Alice and Bob are conversing (their topics are cryptographically independent)

## The RPC Problem

The RPC endpoint sees query parameters, not just on-chain data.

```typescript
// Alice's RPC sees:
eth_getLogs({ topics: [MessageSent, null, [topicA, topicB, ...]] })
```

| Query Type | RPC Learns |
|------------|------------|
| Handshakes | User's `recipientHash` (trivially reversible) |
| Messages | All active inbound topics for this user |

**Correlation attack (same RPC):**
```
Alice queries for topic_X → RPC logs this
Bob sends to topic_X     → RPC logs this
Conclusion: Bob → Alice conversation exists
```

## Trust Requirements

| Entity | Trust Level | Justification |
|--------|-------------|---------------|
| Blockchain / Indexers | None required | Cannot link conversations |
| Your RPC provider | **Full trust** | Sees all your topic queries |
| Counterparty's RPC | Independent | Only risks their privacy, not yours |

## Summary

Verbeth provides **strong on-chain privacy**: passive observers cannot link conversation participants. The metadata leak is concentrated at the **RPC layer**, which sees topic queries and can correlate them with senders.

### Mitigation Options

| Approach | Effectiveness |
|----------|---------------|
| Self-hosted node | Eliminates RPC trust entirely |
| Tor for RPC calls | Hides IP, RPC still sees query content |
| Decoy topic queries | Adds noise, increases bandwidth |
| Rotate RPC endpoints | Dilutes correlation, doesn't eliminate |