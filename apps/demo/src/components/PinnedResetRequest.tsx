// src/components/PinnedResetRequest.tsx

import { useState } from 'react';
import type { PendingHandshake } from '../types.js';

interface PinnedResetRequestProps {
  handshake: PendingHandshake;
  onAccept: (handshake: PendingHandshake, message: string) => void;
}

export function PinnedResetRequest({ handshake, onAccept }: PinnedResetRequestProps) {
  const [response, setResponse] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  const handleAccept = () => {
    onAccept(handshake, response.trim());
  };

  const shortAddress = `${handshake.sender.slice(0, 6)}...${handshake.sender.slice(-4)}`;

  return (
    <div className="sticky bottom-0 bg-gradient-to-t from-gray-900 via-gray-900/95 to-transparent pt-6 pb-2 -mx-2 px-2 mt-4">
      <div className="border-l-2 border-amber-500/40 bg-white/[0.02] rounded-r-lg overflow-hidden">
        <div
          className="p-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-amber-300/80 text-sm font-mono">
                {shortAddress} requests a new handshake
              </p>
              <p className="text-amber-500/50 text-xs mt-0.5">
                Session was reset — accept to re-establish secure communication.
              </p>
            </div>
            <span className="text-white/30 text-sm font-mono select-none">
              {isExpanded ? '−' : '+'}
            </span>
          </div>
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-1 border-t border-white/5">
            {handshake.message && (
              <p className="text-gray-500 text-xs mb-3 italic">
                "{handshake.message}"
              </p>
            )}

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="note (optional)"
                className="flex-1 py-1 bg-transparent border-b border-white/10 focus:border-white/25 text-xs text-white placeholder-white/20 focus:outline-none transition-colors"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAccept();
                  }
                }}
              />
              <button
                onClick={handleAccept}
                className="px-2 py-1 text-xs text-white/70 hover:text-white border border-white/10 hover:border-white/20 rounded transition-colors"
              >
                Accept
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}