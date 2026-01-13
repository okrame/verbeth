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
    if (response.trim()) {
      onAccept(handshake, response.trim());
    }
  };

  const shortAddress = `${handshake.sender.slice(0, 6)}...${handshake.sender.slice(-4)}`;

  return (
    <div className="sticky bottom-0 bg-gradient-to-t from-gray-900 via-gray-900/95 to-transparent pt-6 pb-2 -mx-2 px-2 mt-4">
      <div className="bg-amber-950/60 border border-amber-700/40 rounded-lg overflow-hidden">
        <div 
          className="p-3 cursor-pointer hover:bg-amber-900/20 transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-3">
            <span className="text-lg">⚠️</span>
            <div className="flex-1 min-w-0">
              <p className="text-amber-200 text-sm font-medium">
                {shortAddress} requests a new handshake
              </p>
              <p className="text-amber-400/60 text-xs mt-0.5">
                Your session was reset. Please accept to re-establish secure communication.
              </p>
            </div>
            <span className="text-amber-500 text-sm">
              {isExpanded ? '▼' : '▶'}
            </span>
          </div>
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-1 border-t border-amber-800/30">
            <p className="text-amber-300/80 text-xs mb-3 italic">
              "{handshake.message}"
            </p>

            <div className="flex gap-2">
              <input
                type="text"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="La tua risposta..."
                className="flex-1 px-3 py-1.5 bg-gray-900/80 border border-amber-800/40 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-600"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && response.trim()) {
                    handleAccept();
                  }
                }}
              />
              <button
                onClick={handleAccept}
                disabled={!response.trim()}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded transition-colors"
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