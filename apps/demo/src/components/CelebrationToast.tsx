import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface CelebrationToastProps {
  show: boolean;
  onClose: () => void;
}

export function CelebrationToast({ show, onClose }: CelebrationToastProps) {
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [show, onClose]);

  const width = 320;
  const margin = 16;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ x: width + margin }}
          animate={{ x: 0 }}
          exit={{
            opacity: 0,
            x: width + margin,
            transition: {
              opacity: { duration: 0.2 },
              x: { duration: 0.3 }
            }
          }}
          transition={{
            type: "spring",
            mass: 1,
            damping: 30,
            stiffness: 200
          }}
          className="fixed top-[72px] right-4 z-[9999] bg-gray-900 border border-gray-700 rounded-2xl shadow-xl px-6 py-4 flex items-center gap-3"
          style={{ width, WebkitTapHighlightColor: "transparent" }}
        >
          <span className="inline-block">
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24">
              <g>
                <path d="M7 21L3 17L13.5 6.5C13.7761 6.22386 14.2239 6.22386 14.5 6.5L17.5 9.5C17.7761 9.77614 17.7761 10.2239 17.5 10.5L7 21Z" fill="#3b82f6" />
                <circle cx="19" cy="5" r="1.5" fill="#fbbf24" />
                <circle cx="15" cy="3" r="1" fill="#34d399" />
                <circle cx="21" cy="11" r="1" fill="#f472b6" />
              </g>
            </svg>
          </span>
          <div>
            <div className="text-base font-semibold text-white">Identity Ready!</div>
            <div className="text-xs text-gray-300">Keys successfully created 🎉</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}