import { AbiCoder, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { matchHsrToContact, type PendingContactEntry } from "@verbeth/sdk";
import {
  EVENT_SIGNATURES,
  VERBETH_SINGLETON_ADDR,
  type Contact,
  type EventType,
  type ProcessedEvent,
} from "../../types.js";

type RpcFilter = Record<string, unknown>;

export interface ScanQueryContext {
  address: string;
  emitterAddress?: string;
  activeTopics: string[];
  pendingContacts: Contact[];
}

interface QuerySpec {
  id: string;
  eventType: EventType;
  buildFilter: (ctx: ScanQueryContext) => RpcFilter | null;
  mapLog?: (
    log: any,
    ctx: ScanQueryContext
  ) => { matchedContactAddress?: string } | null;
}

function toLogIndex(log: any): number {
  const value = typeof log.logIndex !== "undefined" ? log.logIndex : log.index;
  return Number(value ?? 0);
}

function userRecipientHash(address: string): string {
  return keccak256(toUtf8Bytes(`contact:${address.toLowerCase()}`));
}

function findMatchingContact(log: any, pendingContacts: Contact[]): Contact | null {
  const inResponseTo = log.topics[1] as `0x${string}`;
  const abiCoder = new AbiCoder();
  const [responderEphemeralRBytes, ciphertextBytes] = abiCoder.decode(
    ["bytes32", "bytes"],
    log.data
  );
  const responderEphemeralR = getBytes(responderEphemeralRBytes);
  const encryptedPayload = new TextDecoder().decode(getBytes(ciphertextBytes));

  const entries: PendingContactEntry[] = pendingContacts
    .filter(
      (contact): contact is Contact & {
        handshakeEphemeralSecret: string;
        handshakeKemSecret: string;
      } => !!contact.handshakeEphemeralSecret && !!contact.handshakeKemSecret
    )
    .map((contact) => ({
      address: contact.address,
      handshakeEphemeralSecret: getBytes(contact.handshakeEphemeralSecret),
      kemSecretKey: getBytes(contact.handshakeKemSecret),
    }));

  const matchedAddress = matchHsrToContact(
    entries,
    inResponseTo,
    responderEphemeralR,
    encryptedPayload
  );
  if (!matchedAddress) return null;

  return (
    pendingContacts.find(
      (contact) => contact.address.toLowerCase() === matchedAddress.toLowerCase()
    ) ?? null
  );
}

function getQuerySpecs(): QuerySpec[] {
  return [
    {
      id: "handshake",
      eventType: "handshake",
      buildFilter: (ctx) => ({
        address: VERBETH_SINGLETON_ADDR,
        topics: [EVENT_SIGNATURES.Handshake, userRecipientHash(ctx.address)],
      }),
    },
    {
      id: "handshake_response",
      eventType: "handshake_response",
      buildFilter: (ctx) => {
        if (ctx.pendingContacts.length === 0) return null;
        return {
          address: VERBETH_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.HandshakeResponse],
        };
      },
      mapLog: (log, ctx) => {
        const match = findMatchingContact(log, ctx.pendingContacts);
        if (!match) return null;
        return { matchedContactAddress: match.address };
      },
    },
    {
      id: "message_inbound",
      eventType: "message",
      buildFilter: (ctx) => {
        if (ctx.activeTopics.length === 0) return null;
        return {
          address: VERBETH_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.MessageSent, null, ctx.activeTopics],
        };
      },
    },
    {
      id: "message_outbound_confirmation",
      eventType: "message",
      buildFilter: (ctx) => {
        const emitter = ctx.emitterAddress ?? ctx.address;
        if (!emitter) return null;
        const senderTopic =
          "0x000000000000000000000000" + emitter.slice(2).toLowerCase();
        return {
          address: VERBETH_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.MessageSent, senderTopic],
        };
      },
    },
  ];
}

function toProcessedEvent(
  log: any,
  eventType: EventType,
  extra: { matchedContactAddress?: string } | null
): ProcessedEvent | null {
  if (extra === null) return null;
  const txHash = log.transactionHash as string;
  const logIndex = toLogIndex(log);
  const logKey = `${txHash}-${logIndex}`;

  return {
    logKey,
    eventType,
    rawLog: log,
    txHash,
    logIndex,
    blockNumber: Number(log.blockNumber ?? 0),
    timestamp: Date.now(),
    matchedContactAddress: extra?.matchedContactAddress,
  };
}

export async function collectEventsForRange(params: {
  fromBlock: number;
  toBlock: number;
  context: ScanQueryContext;
  getLogs: (filter: RpcFilter, fromBlock: number, toBlock: number) => Promise<any[]>;
}): Promise<ProcessedEvent[]> {
  const { fromBlock, toBlock, context, getLogs } = params;
  const specs = getQuerySpecs();
  const eventsByKey = new Map<string, ProcessedEvent>();

  for (const spec of specs) {
    const filter = spec.buildFilter(context);
    if (!filter) continue;

    const logs = await getLogs(filter, fromBlock, toBlock);
    for (const log of logs) {
      const extra = spec.mapLog ? spec.mapLog(log, context) : {};
      const event = toProcessedEvent(log, spec.eventType, extra);
      if (!event) continue;

      const key = `${event.eventType}:${event.logKey}`;
      if (!eventsByKey.has(key)) {
        eventsByKey.set(key, event);
      }
    }
  }

  return Array.from(eventsByKey.values()).sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });
}
