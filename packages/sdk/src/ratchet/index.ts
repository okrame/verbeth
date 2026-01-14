// packages/sdk/src/ratchet/index.ts

export {
  MAX_SKIP_PER_MESSAGE,
  MAX_STORED_SKIPPED_KEYS,
  MAX_SKIPPED_KEYS_AGE_MS,
  SYNC_BATCH_SIZE,
  RATCHET_VERSION_V1,
  TOPIC_TRANSITION_WINDOW_MS,
  
  type RatchetSession,
  type SkippedKey,
  type MessageHeader,
  
  type EncryptResult,
  type DecryptResult,
  type ParsedRatchetPayload,
  
  type InitResponderParams,
  type InitInitiatorParams,
} from './types.js';

export {
  kdfRootKey,
  kdfChainKey,
  dh,
  generateDHKeyPair,
  deriveTopicFromDH,
} from './kdf.js';

export {
  initSessionAsResponder,
  initSessionAsInitiator,
  computeConversationId,
} from './session.js';

export {
  ratchetEncrypt,
  encodeHeader,
} from './encrypt.js';

export {
  ratchetDecrypt,
  pruneExpiredSkippedKeys,
  matchesSessionTopic,
} from './decrypt.js';

export {
  packageRatchetPayload,
  parseRatchetPayload,
  isRatchetPayload,
  isRatchetPayloadHex,
  hexToBytes,
  bytesToHex,
} from './codec.js';

export {
  verifyMessageSignature,
  signMessage,
  isValidPayloadFormat,
} from './auth.js';