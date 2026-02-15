// src/services/index.ts

/**
 * Services for VerbEth messaging app.
 */

export { dbService } from './DbService.js';
export { configureClientStorage } from './StorageAdapters.js';
export {
  processHandshakeEvent,
  processHandshakeResponseEvent,
  processMessageEvent,
  generateMessageId,
} from './EventProcessorService.js';