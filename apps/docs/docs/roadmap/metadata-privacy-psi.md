---
sidebar_position: 1
title: Private Set Intersection for Topic Queries
---

# Private Set Intersection for Topic Queries

:::note Planned feature
This page describes a planned extension that is not yet implemented. The design is stable enough to document; the implementation timeline is not fixed.
:::

## Problem

When a client calls `eth_getLogs` to fetch messages, the RPC provider learns:

- which topic hashes the client subscribes to
- polling frequency and timing
- IP address (unless routed through Tor/VPN)

Even though topic hashes are not directly reversible to identities, a malicious or compromised provider can correlate query patterns with message emission timing to probabilistically link senders and recipients.

## Labeled APSI

work in progres...

## References

- [Microsoft APSI library](https://github.com/microsoft/APSI)
- [Labeled PSI paper — Chen et al. 2021](https://eprint.iacr.org/2021/1116)
