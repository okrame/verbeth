import { motion, AnimatePresence } from "framer-motion";
import { Clock, Archive, Loader2 } from "lucide-react";
import type { SyncProgress } from "../types.js";

interface HistoryScannerProps {
  canLoadMore: boolean;
  isLoadingMore: boolean;
  backfillCooldown: boolean;
  syncProgress: SyncProgress | null;
  oldestScannedBlock: number | null;
  oldestScannedDate: Date | null;
  onLoadMore: () => void;
}

export function HistoryScanner({
  canLoadMore,
  isLoadingMore,
  backfillCooldown,
  syncProgress,
  oldestScannedBlock,
  oldestScannedDate,
  onLoadMore,
}: HistoryScannerProps) {
  const isDisabled = isLoadingMore || backfillCooldown || !canLoadMore;
  const reachedGenesis = !canLoadMore;

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="flex flex-col items-center gap-2 py-3">
      <AnimatePresence mode="wait">
        {isLoadingMore ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-300"
          >
            <Loader2 size={14} className="animate-spin text-blue-400" />
            <span>Digging back...</span>
            {syncProgress && syncProgress.total > 0 && (
              <span className="text-gray-500">
                {Math.round((syncProgress.current / syncProgress.total) * 100)}%
              </span>
            )}
          </motion.div>
        ) : reachedGenesis ? (
          <motion.div
            key="genesis"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500"
          >
            <Archive size={12} />
            <span>Reached Verbeth genesis</span>
          </motion.div>
        ) : (
          <motion.button
            key="button"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            onClick={onLoadMore}
            disabled={isDisabled}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors
              bg-gray-800/40 border border-gray-700/60 text-gray-400
              hover:bg-gray-800/70 hover:text-gray-200 hover:border-gray-600
              disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800/40 disabled:hover:text-gray-400 disabled:hover:border-gray-700/60"
            whileHover={!isDisabled ? { scale: 1.02 } : undefined}
            whileTap={!isDisabled ? { scale: 0.98 } : undefined}
          >
            <Clock size={14} />
            <span>Discover older inbox</span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Date badge */}
      <AnimatePresence>
        {oldestScannedDate && !reachedGenesis && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="text-xs text-gray-600"
          >
            Scanned to: {formatDate(oldestScannedDate)}
            {oldestScannedBlock && (
              <span className="text-gray-700 ml-1">(#{oldestScannedBlock.toLocaleString()})</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
