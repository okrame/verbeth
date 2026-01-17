// packages/sdk/src/index.ts

export * from './crypto.js';
export * from './payload.js';
export * from './send.js';
export * from './verify.js';
export * from './types.js';
export * from './utils.js';
export * from './identity.js';
export * from './executor.js';

export {
  encodeUnifiedPubKeys,
  decodeUnifiedPubKeys,
  createHandshakePayload,
  createHandshakeResponseContent,
  extractKeysFromHandshakePayload,
  extractKeysFromHandshakeResponse,
  parseHandshakeKeys
} from './payload.js';

export {
  decryptAndExtractHandshakeKeys,
  decryptHandshakeResponse
} from './crypto.js';

export {
  verifyIdentityProof,
  verifyAndExtractHandshakeKeys,
  verifyAndExtractHandshakeResponseKeys
} from './verify.js';

export {
  deriveIdentityKeyPairWithProof,
  deriveIdentityWithUnifiedKeys
} from './identity.js';

export {
  IExecutor,
  EOAExecutor,
  UserOpExecutor,
  DirectEntryPointExecutor,  
  ExecutorFactory
} from './executor.js';


export { getNextNonce } from './utils/nonce.js';
export { SafeSessionSigner } from "./utils/safeSessionSigner.js";
export type { SafeSessionSignerOptions } from "./utils/safeSessionSigner.js";

export { VerbethClient, SessionManager, PendingManager } from './client/index.js';

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
} from './client/index.js';

export * from './ratchet/index.js';
export { dh, deriveTopicFromDH } from './ratchet/kdf.js';