import { motion, AnimatePresence } from 'framer-motion';
import { ExecutionMode } from '../types.js';
import { useState } from 'react';


interface IdentityCreationProps {
    loading: boolean;
    onCreateIdentity: (mode: ExecutionMode) => void;
    onImportIdentity?: () => void;
    address: string;
    signingStep?: 1 | 2 | null;
    needsModeSelection: boolean;
    fastModeAvailable: boolean;
    fastModeUnavailableReason?: string;
    chainId: number;
}

function Spinner() {
    return (
        <svg className="animate-spin h-5 w-5 text-blue-400" viewBox="0 0 24 24">
            <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
            />
            <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
        </svg>
    );
}

function StepIndicator({ step }: { step: 1 | 2 }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mb-6"
        >
            <div className="flex justify-center mb-4">
                <Spinner />
            </div>

            <div className="flex items-center justify-center gap-3">
                <div className="flex items-center gap-2">
                    <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors duration-300 ${
                            step === 1
                                ? 'bg-blue-600 text-white'
                                : 'bg-green-600 text-white'
                        }`}
                    >
                        {step > 1 ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        ) : (
                            '1'
                        )}
                    </div>
                    <span className={`text-sm ${step === 1 ? 'text-white' : 'text-gray-400'}`}>
                        Derive keys
                    </span>
                </div>

                <div className="w-8 h-px bg-gray-700 relative overflow-hidden">
                    {step >= 1 && (
                        <motion.div
                            initial={{ width: '0%' }}
                            animate={{ width: step > 1 ? '100%' : '50%' }}
                            transition={{ duration: 0.3 }}
                            className="absolute inset-y-0 left-0 bg-blue-600"
                        />
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors duration-300 ${
                            step === 2
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-700 text-gray-400'
                        }`}
                    >
                        2
                    </div>
                    <span className={`text-sm ${step === 2 ? 'text-white' : 'text-gray-400'}`}>
                        Create proof
                    </span>
                </div>
            </div>
        </motion.div>
    );
}

function ModeCard({
    mode,
    title,
    description,
    details,
    recommended,
    disabled,
    disabledReason,
    comingSoon,
    onClick,
}: {
    mode: ExecutionMode;
    title: string;
    description: string;
    details: string[];
    recommended?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    comingSoon?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled || comingSoon}
            className={`w-full text-left p-4 rounded-lg border transition-all ${
                disabled || comingSoon
                    ? 'border-gray-700 bg-gray-800/50 opacity-60 cursor-not-allowed'
                    : 'border-gray-700 hover:border-blue-500 hover:bg-gray-800'
            }`}
        >
            <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-white">{title}</span>
                {recommended && (
                    <span className="text-xs px-2 py-0.5 bg-blue-600 rounded-full">
                        Recommended
                    </span>
                )}
                {comingSoon && (
                    <span className="text-xs px-2 py-0.5 bg-gray-600 rounded-full">
                        Coming Soon
                    </span>
                )}
            </div>
            <p className="text-sm text-gray-400 mb-2">{description}</p>
            <ul className="text-xs text-gray-500 space-y-1">
                {details.map((detail, i) => (
                    <li key={i}>• {detail}</li>
                ))}
            </ul>
            {disabledReason && (
                <p className="text-xs text-yellow-500 mt-2">{disabledReason}</p>
            )}
        </button>
    );
}

export function IdentityCreation({
    loading,
    onCreateIdentity,
    onImportIdentity,
    address,
    signingStep,
    needsModeSelection,
    fastModeAvailable,
    fastModeUnavailableReason,
    chainId,
}: IdentityCreationProps) {
    //Track selected mode locally before identity creation starts
    const [selectedMode, setSelectedMode] = useState<ExecutionMode | null>(null);

    const handleModeSelect = (mode: ExecutionMode) => {
        setSelectedMode(mode);
    };

    const handleCreateIdentity = () => {
        if (selectedMode) {
            onCreateIdentity(selectedMode);
        }
    };

    return (
        <div className="flex items-center justify-center min-h-[60vh]">
            <div className="border border-gray-800 rounded-lg p-8 w-full max-w-md">
                {/* Step indicator - shows during signing */}
                <AnimatePresence>
                    {signingStep && <StepIndicator step={signingStep} />}
                </AnimatePresence>

                <div className="text-center mb-6">
                    <p className={`mb-4 font-semibold ${address ? "text-lg text-blue-300" : "text-base text-gray-400"}`}>
                        {address
                            ? <>Hello, <span className="font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span></>
                            : "Not connected"}
                    </p>
                    <h2 className="text-2xl font-semibold mb-2">
                        {needsModeSelection && !selectedMode
                            ? "Choose Your Experience"
                            : "Create Your Identity"}
                    </h2>
                </div>

                {/* Mode Selection (before identity creation) */}
                {needsModeSelection && !selectedMode && !signingStep && (
                    <div className="space-y-3 mb-6">
                        <ModeCard
                            mode="fast"
                            title="⚡ Fast Mode"
                            description="No wallet popups after setup"
                            details={[
                                "One-time setup transaction",
                                "Fund session signer (~0.001 ETH)",
                                "All future messages are instant",
                            ]}
                            recommended={fastModeAvailable}
                            disabled={!fastModeAvailable}
                            disabledReason={!fastModeAvailable ? (fastModeUnavailableReason ?? `Helper not deployed on chain ${chainId}`) : undefined}
                            onClick={() => handleModeSelect('fast')}
                        />

                        <ModeCard
                            mode="classic"
                            title="🔐 Classic Mode"
                            description="Simple & minimal"
                            details={[
                                "No setup required",
                                "No funding required",
                                "Each message requires wallet confirmation",
                            ]}
                            onClick={() => handleModeSelect('classic')}
                        />

                        <ModeCard
                            mode="custom"
                            title="⚙️ Custom Mode"
                            description="Use your existing Safe"
                            details={[
                                "Import any Safe you control (1/1 threshold)",
                                "On-chain verification of requirements",
                            ]}
                            comingSoon
                            onClick={() => {}}
                        />
                    </div>
                )}

                {/* Mode selected badge */}
                {selectedMode && !signingStep && (
                    <div className="mb-4 flex items-center justify-between">
                        <span className={`px-3 py-1 rounded-full text-sm ${
                            selectedMode === 'fast' ? 'bg-blue-900 text-blue-200' : 'bg-gray-700 text-gray-300'
                        }`}>
                            {selectedMode === 'fast' ? '⚡ Fast Mode' : '🔐 Classic Mode'}
                        </span>
                        <button
                            onClick={() => setSelectedMode(null)}
                            className="text-xs text-gray-500 hover:text-gray-300"
                        >
                            Change
                        </button>
                    </div>
                )}

                {/* Create Identity button (after mode selection) */}
                {selectedMode && (
                    <div className="space-y-4">
                        <button
                            onClick={handleCreateIdentity}
                            disabled={loading}
                            className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                        >
                            {loading ? "Creating..." : "Create Identity"}
                        </button>

                        {/* Mode-specific info */}
                        <div className="text-xs text-gray-500 text-center">
                            {selectedMode === 'classic' ? (
                                <p>
                                    You'll sign two messages to derive your identity keys.
                                    Each future message will require wallet confirmation.
                                </p>
                            ) : (
                                <p>
                                    You'll sign two messages to derive your identity keys.
                                    After a one-time setup, messages are sent without popups.
                                </p>
                            )}
                        </div>
                    </div>
                )}

                {/* Back to mode selection if not started */}
                {!needsModeSelection && !selectedMode && !signingStep && (
                    <div className="space-y-4">
                        <button
                            onClick={() => onCreateIdentity('fast')}
                            disabled={loading || !fastModeAvailable}
                            className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                        >
                            {loading ? "Creating..." : "Create New"}
                        </button>

                        <button
                            onClick={onImportIdentity}
                            disabled={true}
                            className="w-full px-4 py-3 bg-gray-600 cursor-not-allowed rounded font-medium opacity-50"
                        >
                            Import Previous Identity (Coming Soon)
                        </button>

                        <div className="text-xs text-gray-500 text-center">
                            <p>
                                You will be asked to sign two messages.
                                The first signature deterministically derives your identity keys.
                                The second signature creates an Identity Proof.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
