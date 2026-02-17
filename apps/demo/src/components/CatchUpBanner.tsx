import { motion, AnimatePresence } from "framer-motion";
import type { SyncProgress } from "../types.js";

interface CatchUpBannerProps {
  syncProgress: SyncProgress | null;
}

export function CatchUpBanner({ syncProgress }: CatchUpBannerProps) {
  const visible = syncProgress !== null && syncProgress.phase === "catch-up";
  const percent = syncProgress && syncProgress.total > 0
    ? Math.min(100, Math.round((syncProgress.current / syncProgress.total) * 100))
    : 0;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -20, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="bg-gray-900/95 border border-gray-800 rounded mb-2"
        >
          <div className="px-3 py-1 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-300">
              <span>Catching up... {percent}%</span>
              {syncProgress!.failedChunks > 0 && (
                <span className="text-yellow-400 text-xs">
                  ({syncProgress!.failedChunks} {syncProgress!.failedChunks === 1 ? "area" : "areas"} waiting to retry)
                </span>
              )}
            </div>
          </div>
          <motion.div
            className="h-[2px] bg-blue-500 rounded-b"
            initial={{ width: "0%" }}
            animate={{ width: `${percent}%` }}
            transition={{ ease: "easeOut", duration: 0.3 }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
