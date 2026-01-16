// packages/sdk/src/client/index.ts

export { VerbethClient } from './VerbethClient.js';
export { SessionManager } from './SessionManager.js';
export { PendingManager } from './PendingManager.js';

export type { 
  VerbethClientConfig,
  
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
} from './types.js';