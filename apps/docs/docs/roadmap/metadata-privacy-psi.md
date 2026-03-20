---
sidebar_position: 1
title: Private Append-Only Mailbox Sync (wip) 
---

# Private Append-Only Mailbox Sync

:::note Planned feature
This page describes a planned extension that is not yet implemented.
:::

## Problem

When a client calls `eth_getLogs` to fetch messages, the RPC provider learns:

- which topic hashes the client subscribes to
- polling frequency and timing
- IP address (unless routed through Tor/VPN)

Even though topic hashes are not directly reversible to identities, a malicious or compromised provider can correlate query patterns with message emission timing to probabilistically link senders and recipients.
