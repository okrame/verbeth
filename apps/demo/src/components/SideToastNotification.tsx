import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckIcon, PlusIcon, Trash2Icon, MinusIcon, BellIcon } from "lucide-react";

function TwitterBlueCheckIcon({ size = 18, className = "" }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            className={className}
            style={{ display: "inline-block", verticalAlign: "middle" }}
        >
            <circle cx="12" cy="12" r="12" fill="#1D9BF0" />
            <path
                d="M12 6.5l1.176 3.62h3.806l-3.08 2.238 1.176 3.62L12 13.74l-3.078 2.238 1.176-3.62-3.08-2.238h3.806L12 6.5z"
                fill="#fff"
            />
        </svg>
    );
}

interface SideToastNotificationsProps {
    notifications: {
        id: string;
        sender: string;
        message: string;
        verified: boolean;
        isExistingContact?: boolean;
        onAccept: (msg: string) => void;
        onReject: () => void;
    }[];
    removeNotification: (id: string) => void;
}

export function SideToastNotifications({
    notifications,
    removeNotification,
}: SideToastNotificationsProps) {
    const [shrunk, setShrunk] = useState<{ [id: string]: boolean }>({});
    const [expanded, setExpanded] = useState<{ [id: string]: boolean }>({});
    const [isAnyHovered, setIsAnyHovered] = useState(false);
    const [mobileVisible, setMobileVisible] = useState(false);

    let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

    // Notifications always arrive collapsed
    useEffect(() => {
        setShrunk((prev) => {
            const updated = { ...prev };

            notifications.forEach((notif) => {
                if (!(notif.id in updated)) {
                    updated[notif.id] = true; // collapsed by default
                }
            });

            // Remove state for old notifications
            Object.keys(updated).forEach((id) => {
                if (!notifications.find((n) => n.id === id)) {
                    delete updated[id];
                }
            });

            return updated;
        });

        setExpanded((prev) => {
            const updated = { ...prev };
            Object.keys(updated).forEach((id) => {
                if (!notifications.find((n) => n.id === id)) {
                    delete updated[id];
                }
            });
            return updated;
        });
    }, [notifications]);

    const handleExpand = (id: string) => {
        setExpanded((prev) => ({ ...prev, [id]: true }));
    };

    const handleShrink = (id: string) => {
        setExpanded((prev) => ({ ...prev, [id]: false }));
    };

    const handleMouseEnter = () => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
        setIsAnyHovered(true);
    };

    const handleMouseLeave = () => {
        hoverTimeout = setTimeout(() => setIsAnyHovered(false), 80);
    };

    const toggleMobileVisibility = () => {
        setMobileVisible(!mobileVisible);
    };

    const compressStack = !isAnyHovered && notifications.length > 1;
    const overlapOffset = compressStack ? "-28px" : "16px"; // negative margin to compress stack

    // Show notifications if: desktop (sm+) OR mobile with mobileVisible true
    const shouldShowNotifications = notifications.length > 0;

    return (
        <>
            {/* Mobile toggle button - only visible on mobile when there are notifications */}
            {shouldShowNotifications && (
                <button
                    onClick={toggleMobileVisibility}
                    className="fixed top-14 right-4 z-[10000] sm:hidden bg-blue-600 hover:bg-blue-700 text-white rounded-full w-9 h-9 flex items-center justify-center shadow-lg transition-colors"
                >
                    <BellIcon size={16} />
                    {notifications.length > 0 && (
                        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 text-[10px] flex items-center justify-center">
                            {notifications.length}
                        </span>
                    )}
                </button>
            )}

            {/* Notifications container */}
            <div
                className={`fixed left-1/2 z-[9999] w-full flex flex-col items-center pointer-events-none transition-opacity duration-300 ${shouldShowNotifications && (mobileVisible || window.innerWidth >= 640) ? 'opacity-100' : 'opacity-0 sm:opacity-100'
                    }`}
                style={{
                    top: "5px",
                    transform: "translateX(-50%)",
                    visibility: shouldShowNotifications && (mobileVisible || window.innerWidth >= 640) ? 'visible' : 'hidden'
                }}
            >
                <div
                    className="flex flex-col items-center pointer-events-auto w-fit mx-auto"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                    style={{ paddingTop: "16px", paddingBottom: "16px" }}
                >
                    <AnimatePresence>
                        {notifications.map((notif, idx) => {
                            const isShrunk = shrunk[notif.id] && !expanded[notif.id];
                            const zIndex = isAnyHovered ? 100 + idx : 10 + idx;

                            return (
                                <motion.div
                                    key={notif.id}
                                    initial={{ y: -80, opacity: 0 }}
                                    animate={{ y: 0, opacity: 1 }}
                                    exit={{ y: -80, opacity: 0 }}
                                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                                    className={
                                        (isShrunk
                                            ? "bg-blue-900/95 border border-blue-700 shadow-xl rounded-lg px-4 py-1 flex items-center min-w-[220px] max-w-[90vw] sm:max-w-full h-[36px] overflow-hidden pointer-events-auto"
                                            : "bg-blue-900/95 border border-blue-700 shadow-xl rounded-lg p-4 flex flex-col min-w-[280px] sm:min-w-[320px] max-w-[90vw] sm:max-w-full pointer-events-auto") +
                                        (compressStack ? " compress-toast" : " gap-4")
                                    }
                                    style={{
                                        minHeight: isShrunk ? 36 : undefined,
                                        maxHeight: isShrunk ? 36 : undefined,
                                        marginTop: idx !== 0 ? overlapOffset : 0,
                                        zIndex,
                                        transition: "all 0.4s cubic-bezier(.4,2,.6,1)",
                                    }}
                                >
                                    {isShrunk ? (
                                        <div className="flex justify-between items-center w-full">
                                            <span className="font-medium truncate text-sm sm:text-base">
                                                Request from {notif.sender.slice(0, 6)}...{notif.sender.slice(-6)}
                                            </span>
                                            <button
                                                className="text-gray-400 hover:text-white ml-2"
                                                onClick={() => handleExpand(notif.id)}
                                                aria-label="Expand"
                                            >
                                                <PlusIcon size={16} />
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex justify-between items-start">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="font-medium text-sm sm:text-base">
                                                            Request from{" "}
                                                            <a
                                                                href={`https://basescan.org/address/${notif.sender}`}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="underline decoration-dotted underline-offset-2 hover:text-blue-200 transition"
                                                            >
                                                                {notif.sender.slice(0, 6)}...{notif.sender.slice(-6)}
                                                            </a>
                                                        </span>
                                                        {notif.verified ? (
                                                            <span className="relative group flex items-center">
                                                                <TwitterBlueCheckIcon size={16} />
                                                                <span
                                                                    className="absolute left-1/2 -top-8 -translate-x-1/2 px-2 py-1 bg-blue-900 text-blue-200 text-xs rounded shadow opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 whitespace-nowrap"
                                                                    style={{ zIndex: 100 }}
                                                                >
                                                                    Verified user
                                                                </span>
                                                            </span>
                                                        ) : (
                                                            <span className="text-xs text-yellow-400 flex items-center gap-1">
                                                                <span className="text-sm">⚠️</span> Unverified
                                                            </span>
                                                        )}
                                                        {notif.isExistingContact && (
                                                            <span className="px-2 py-0.5 text-xs bg-blue-600/40 text-blue-200 rounded-full border border-blue-500/50">
                                                                🔄 Session reset
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-xs sm:text-sm text-gray-200 mb-2">"{notif.message}"</p>
                                                </div>
                                                {shrunk[notif.id] && expanded[notif.id] && (
                                                    <button
                                                        className="ml-3 text-gray-400 hover:text-white"
                                                        onClick={() => handleShrink(notif.id)}
                                                        aria-label="Collapse"
                                                    >
                                                        <MinusIcon size={16} />
                                                    </button>
                                                )}
                                            </div>
                                            <div className="flex gap-2 mt-2">
                                                <input
                                                    type="text"
                                                    placeholder="Add a note"
                                                    className="flex-1 px-2 sm:px-3 py-1 bg-gray-800 border border-gray-600 rounded text-xs sm:text-sm"
                                                    id={`side-toast-response-${notif.id}`}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter" && e.currentTarget.value.trim()) {
                                                            notif.onAccept(e.currentTarget.value.trim());
                                                            e.currentTarget.value = "";
                                                            removeNotification(notif.id);
                                                        }
                                                    }}
                                                />
                                                <button
                                                    onClick={() => {
                                                        const input = document.getElementById(
                                                            `side-toast-response-${notif.id}`
                                                        ) as HTMLInputElement;
                                                        const note = input?.value ?? "";
                                                        notif.onAccept(note.trim());
                                                        if (input) input.value = "";
                                                        removeNotification(notif.id);
                                                    }}
                                                    className="px-2 sm:px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-xs sm:text-sm flex items-center gap-1"
                                                >
                                                    <CheckIcon size={12} />
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        notif.onReject();
                                                        removeNotification(notif.id);
                                                    }}
                                                    className="px-2 sm:px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-xs sm:text-sm flex items-center gap-1"
                                                >
                                                    <Trash2Icon size={12} />
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>
                </div>
            </div>
        </>
    );
}