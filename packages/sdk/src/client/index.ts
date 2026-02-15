// packages/sdk/src/client/index.ts

export { VerbethClient } from './VerbethClient.js';
export { VerbethClientBuilder, createVerbethClient } from './VerbethClientBuilder.js';
export { matchHsrToContact } from './hsrMatcher.js';

export type {
  CreateVerbethClientOptions,
} from './VerbethClientBuilder.js';

export type {
  PendingContactEntry,
} from './hsrMatcher.js';

export type {
  VerbethClientConfig,
  VerbethClientCallbacks,
  TopicRatchetEvent,
  MessageDecryptedEvent,

  HandshakeResult,
  HandshakeResponseResult,

  SessionStore,
  PendingStore,

  PreparedMessage,
  DecryptedMessage,
  PendingMessage,
  PendingStatus,

  SendResult,
  ConfirmResult,

  SerializedSessionInfo,
  HsrEventData,
  CreateInitiatorSessionFromHsrParams,
} from './types.js';

export type {
  CreateInitiatorSessionParams,
  CreateResponderSessionParams,
} from './VerbethClient.js';