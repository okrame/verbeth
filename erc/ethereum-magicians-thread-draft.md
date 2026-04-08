# Event log end-to-end encrypted messaging

Hi all

I have been working on a predraft for a post-quantum resistant encrypted messaging over EVM event logs and I wanted to share it early for feedback before trying to turn it into a formal ERC submission. Also, I want to gather opinions if this needs a standardization at all.

[Public draft link goes here](PUBLIC_URL_HERE)

The goal is to standardize a small transport and wire format surface that independent clients can actually interoperate on, not to standardize indexing, notifications, storage, spam control, account abstraction UX or inbox behavior. Those concerns are left to frontend applications.

## Related work

This is not the first attempt in this area. 

- [ERC 7627](https://ethereum-magicians.org/t/erc-7627-secure-messaging-protocol/18761) explores secure messaging with more emphasis on onchain key registration and flexible conversation metadata. 

- [ERC 7970](https://ethereum-magicians.org/t/erc-stateless-encrypted-communication-standard/24554) is probably the closest event based proposal in spirit, but it keeps the cryptographic behavior and wire format somewhat unspecified.

- [ERC 8180](https://ethereum-magicians.org/t/erc-8180-blob-authenticated-messaging-bam/27868) (somewhat the evolution od ERC-3722) is also relevant, but to me it sits next to this work rather than on top of the same exact problem, since it is about authenticated messaging over blobs and decoder discovery.

My impression is that the design space still has not converged, and I think there is room for a more opinionated interoperable approach here. This post also comes from an implementation first perspective, since I have been exploring and testing these ideas in a [public SDK]((https://github.com/okrame/verbeth/tree/main/packages/sdk)) and [demo](https://verbeth-demo.vercel.app/) already.


## What I am proposing

1. A small transport contract with `sendMessage`, `initiateHandshake`, and `respondToHandshake`
2. Three events for handshake initiation, handshake response, and post handshake message delivery
3. Versioned long term public keys for encryption and signing
4. Wallet bound identity proofs that bind those keys to an EVM account
5. Handshake response tags that are not publicly linkable to the initiating handshake
6. Ratcheted message topics that rotate across epochs rather than behaving like stable conversation identifiers

## High level flow

This is the simplified lifecycle I have been experimenting with:

```text
Alice                                                      Bob

1. Gen ephemeral X25519 key
2. Gen ML-KEM 768 keypair
3. Build wallet bound identity proof

Handshake event  ------------------------------------------>
  recipientHash selector
  sender longterm pubkeys
  initiator ephemeral X25519 + ML-KEM pubkey
  identity proof + optional pt note

                                                          4. Read handshake
                                                          5. Verify identity proof
                                                          6. Gen response tag keypair
                                                          7. Gen first ratchet keypair
                                                          8. Encapsulate to Alice ML-KEM pubkey
                                                          9. Derive hybrid response tag

HandshakeResponse event  <---------------------------------
  inResponseTo derived from classical + PQ secret material
  public response tag key
  encrypted payload carrying
    responder longterm pubkeys
    first ratchet public key
    ML-KEM ciphertext
    responder identity proof

10. Decrypt response
11. Recompute and verify inResponseTo
12. Derive the same hybrid root key
13. Initialize ratchet session

Session established

MessageSent event  ---------------------------------------->
  signed ratcheted payload on current topic

MessageSent event  <----------------------------------------
  signed ratcheted payload on current topic

As new DH epochs appear, topics rotate and old topics stop behaving like a
stable public conversation identifier.
```


## Why non-repudiation matters

[Non-repudiation](https://en.wikipedia.org/wiki/Non-repudiation) is an unusual property for a e2ee messaging protocol, and I think it is worth considering it more closely, as it allows for some interesting applications.

Since every delivered ciphertext is also an onchain tx, any third party can verify the block, the tx hash, the emitting contract and the account that published it. Attribution is direct if the sender is an EOA, less so if it's smart account (i.e. still it reduces to owner signatures in calldata or a UserOp signature). Either way, that means the chain already proves one important fact without any transcript disclosure at all: a specific account authorized the publication of a specific ciphertext at a specific time. If plaintext is later disclosed, the wallet bound identity proof and the signed ratcheted payload can connect that disclosed content to the messaging identity used in the session.

This is quite different from systems in the Signal family which are designed so that a saved transcript does not become a portable proof for outsiders (i.e. messages are verified with symmetric MAC keys that both parties share, so either side could plausibly have forged any message).

What I propose here is also different from offchain systems like XMTP but in a more specific way. XMTP can support verifiable attribution through exported protocol artifacts and its identity layer, but that proof is not normally a publicly witnessed chain event. It depends on disclosing offchain transcript material and relating installation level keys to an inbox identity and then to a wallet or other identifier.

### Thoughts on further extensions

One possible extension is hidden delegation, where a relay publishes the ciphertext while the principal identity remains inside the encrypted envelope. In that case, accountability becomes disclosure dependent. Once the recipient reveals the hidden identity proof, a third party can verify both the onchain relay publication and the principal attribution carried in the disclosed proof.

As for deniability, my current view is that full transport level deniability is not compatible with public event logs. A narrower form of deniability inside the ratchet transcript may still be worth exploring, and I would be interested in feedback on whether that is meaningful.

## How to deal with metadata privacy

Assuming full e2ee with forward secrecy and post-comprimosie security, the achievable goal is not to eliminate all metadata, but to eliminate any efficiently verifiable linkage and leave observers with only statistical inference whose quality depends on traffic volume and side information.

Put differently, once deterministic recipient discovery is removed from the transport, or recipient filtering happens client-side rather than at the RPC layer, an observer falls back to heuristics. A simple way to express that is: let `C(e')` be the set of earlier events that are not cryptographically ruled out as possible predecessors of a target event `e'`. Then

`Pr[e ↔ e' | view] = w(e, e') / Σx∈C(e') w(x, e')`

where `w(e, e')` is a heuristic weight derived from timing, visible sender activity, traffic sparsity and any other side information available to the observer. So what should disappear is any public rule that makes one candidate pair dominate the distribution with near certainty. This, of course, matters differently at the public chain observer level and at the RPC or indexer level. that also see client queries.

### Mitigation options

If this proposal says anything about metadata privacy, I think it should explicitly acknowledge the main mitigation choices and their tradeoffs: 

- **Keep `recipientHash`, but require client-side scanning**. Clients scan handshake events locally instead of querying an RPC or indexer with recipient-specific filters. This removes the bootstrap leak to a malicious RPC, but it does not hide attempted first contact from public observers who can dictionary-match `recipientHash`. Also it can get heavy recipient-side with `O(N)` scanning.

- **Remove `recipientHash` from the public handshake selector**. Instead of publishing a deterministic recipient selector, the sender includes recipient-targeting material inside an encrypted payload. Recipients then scan handshake events and keep only the ones they can decrypt. This is arguably better, but it still requires linear client-side scanning at least for handshake discovery.

- **Use private signaling with a TEE-assisted indexer**. Another option is to hide recipient interest from the indexing service, following the private-signaling direction explored in [this paper](https://eprint.iacr.org/2021/853.pdf): the sender posts a public mailbox entry while recipient-targeting material is processed inside a TEE, and only the intended recipient learns the match. The tradeoff is extra infrastructure, hardware assumptions, and scalability limits that are very different from the other approaches.


My current view is that the ERC should probably avoid over-standardizing this layer, but it would still be useful to be explicit about which privacy model it assumes.

## Resistance to HNDL 

Message content confidentiality should not face the threat of harvest now decrypt later. A future attacker should not be able to record traffic today and later use stronger capabilities to recover message contents, link handshake responses to later traffic, or link later ratcheted topics from stored traces alone.

The current construction tries to enforce that with a hybrid bootstrap based on `X25519 + ML-KEM 768`, a handshake response tag derived from both classical and PQ secret material, and topic derivation salted by a hybrid root key. My intent is that the PQ story should cover both confidentiality and linkage resistance, not only message decryption.


## What I would most like feedback on

1. Is this the right layer to standardize, or is it still too application-specific to benefit from an ERC?
2. Is the privacy model coherent, especially the distinction between public-observer privacy and query privacy against RPCs or indexers?
3. Of the mitigation options above, which one feels realistic for an interoperable standard, if any?
4. Does the non-repudiation property feel useful here, or is it more likely to be a reason not to pursue this design?
5. Is the current scope narrow enough, or am I still standardizing too much of the messaging stack?

I would especially value pushback on the privacy and security model. For more details on the contract the sdk, you can find some work in progress docs [here](https://docs.verbeth.xyz/docs/).

Thanks
