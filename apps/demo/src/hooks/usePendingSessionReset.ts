// src/hooks/usePendingSessionReset.ts

import { useMemo } from 'react';
import type { Contact, PendingHandshake } from '../types.js';

interface PendingSessionReset {
  hasPendingReset: boolean;
  pendingHandshake: PendingHandshake | null;
  limboAfterTimestamp: number | null;
}

/**
 * Hook to detect if there's a pending session reset from the selected contact.
 */
export function usePendingSessionReset(
  selectedContact: Contact | null,
  pendingHandshakes: PendingHandshake[]
): PendingSessionReset {
  return useMemo(() => {
    if (!selectedContact) {
      return { hasPendingReset: false, pendingHandshake: null, limboAfterTimestamp: null };
    }

    const resetHandshake = pendingHandshakes.find(
      h => h.sender.toLowerCase() === selectedContact.address.toLowerCase() 
        && h.isExistingContact === true
    );

    if (!resetHandshake) {
      return { hasPendingReset: false, pendingHandshake: null, limboAfterTimestamp: null };
    }

    return {
      hasPendingReset: true,
      pendingHandshake: resetHandshake,
      limboAfterTimestamp: resetHandshake.timestamp,
    };
  }, [selectedContact, pendingHandshakes]);
}