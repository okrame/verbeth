---
sidebar_position: 1
title: Threat Model
---

# Threat Model

Verbeth considers three distinct adversary classes. For each, we describe what they can see, what they cannot do, and a short scenario illustrating the boundary.

## 1. Passive Observer

**Who**: Block explorers, chain indexers, MEV searchers, i.e. anyone reading public blockchain data.

**Can see**: all on-chain data (events, calldata), sender addresses, topic hashes, transaction timing, gas costs.

**Cannot**: read message contents, link topics to recipients, or determine conversation participants from topics alone.

> **E.g.** Eve runs an indexer that tracks every `MessageSent` event on Base. She sees 0x123 emit a ciphertext on topic `0xab12…`. She knows 0x123 sent something, but the topic is a hash derived from shared secrets, the recipient is unlinkable, and the content is encrypted. Eve can build a graph of addresses that emit events but cannot reconstruct who is talking to whom.

## 2. Active RPC Adversary

**Who**: Any RPC provider (Infura, Alchemy, or a self-hosted node operator).

**Can see**: every query you make, e.g. which topics you subscribe to, when you poll, which blocks you request.

**Cannot**: decrypt message contents or forge messages.

> **E.g.** 0x789 uses Alchemy to poll for new messages. Alchemy sees 0x789 querying topic `0xab12…` every 10 seconds. When 0x123 publishes a message on that topic, Alchemy observes 0x789's next query shortly after. By correlating timing, Alchemy can infer that 0x789 is a recipient of 0x123's messages, even though it cannot read the content. See [Metadata Privacy](./metadata-privacy.md#the-rpc-problem) for mitigations.

## 3. State Compromise

**Who**: Malware, device theft, insider threat, i.e. anyone who obtains a copy of session state.

**Can see**: current root keys, chain keys, and any skipped message keys still in memory. This allows decrypting messages from the current DH epoch forward, and potentially impersonating the compromised party.

**Cannot**: decrypt past messages (forward secrecy deletes old keys), or continue reading after the next DH ratchet step restores security (post-compromise security).

> **E.g.** Mallory steals a snapshot of 0x123's ratchet state. She can decrypt the next few messages 0x123 receives. But when 0x789 sends a message that triggers a new DH ratchet step, 0x123 and 0x789 derive fresh keys from a new Diffie-Hellman exchange that Mallory cannot replicate. From that point on, Mallory is locked out. Past messages are also safe because the keys that encrypted them were deleted after use.

For the cryptographic mechanisms see more in [Cryptographic Guarantees](./cryptographic-guarantees.md).

## Non-Repudiation

[Non-repudiation](https://en.wikipedia.org/wiki/Non-repudiation) is the property that provides protection against an entity falsely denying having performed a particular action, such as sending a message or creating data.
Verbeth provides it by design since every message is an on-chain tx publicly attributable to the account that authorized it (whether an EOA or a contract such as a Safe), verified by every node, and stored immutably. So, a sender cannot later deny having sent a message.


|  | Verbeth | Signal | XMTP |
|---|---|---|---|
| **Message attribution** | Permanent, on a public ledger | Intentionally deniable | Not publicly witnessed by default |
| **Third-party verification** | Anyone can verify sender on-chain | Not designed to prove authorship to outsiders | Possible if transcript + keys are exported; not globally public |

> **E.g.** 0x123 and 0x789 negotiate a consulting agreement over Verbeth. Six months later, 0x789 claims he never agreed to the payment terms. 0x123 points to the on-chain transaction: block 18,200,431, `msg.sender = 0x789…`, topic `0xef34…`. The blockchain proves 0x789 sent a message at that time and 0x789 cannot deny it. To reveal *what* 0x789 actually said, 0x123 decrypts the ciphertext and presents the plaintext, but the chain already establishes that 0x789 authored it. If we were in Signal, 0x789 could plausibly argue the transcript was forged, while in XMTP 0x123 could prove it by exporting the signed transcript, in other words requiring active disclosure and possibly an archival policy to be externally compelling.

Historically, Signal comes from the lineage of activists, journalists, and the principle that a saved chat log should never become a cryptographic affidavit. It achieves this through deniable authentication in that messages are verified with symmetric MAC keys that both parties share, so either side could plausibly have forged any message. Differently, in XMTP attribution is verifiable for participants, and technically for third parties too, if someone discloses the transcript along with the relevant public keys.

For Verbeth the attribution is intentionally part of the shared public record, verifiable by anyone, indefinitely. Importantly, though, only the *fact* that a message was sent (and by whom) is public while the message content remains private unless one of the participants chooses to disclose it.  