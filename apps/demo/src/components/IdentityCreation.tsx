import { motion, AnimatePresence } from 'framer-motion';

interface IdentityCreationProps {
    loading: boolean;
    onCreateIdentity: () => void;
    onImportIdentity?: () => void;
    address: string;
    /** Current signing step: 1 = first signature, 2 = second signature, undefined = not started */
    signingStep?: 1 | 2 | null;
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
            {/* Spinner on top */}
            <div className="flex justify-center mb-4">
                <Spinner />
            </div>

            {/* Step indicators */}
            <div className="flex items-center justify-center gap-3">
                {/* Step 1 */}
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

                {/* Connector */}
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

                {/* Step 2 */}
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

export function IdentityCreation({
    loading,
    onCreateIdentity,
    onImportIdentity,
    address,
    signingStep,
}: IdentityCreationProps) {
    return (
        <div className="flex items-center justify-center min-h-[60vh]">
            <div className="border border-gray-800 rounded-lg p-8 w-full max-w-md">
                {/* Step indicator - shows during signing */}
                <AnimatePresence>
                    {signingStep && <StepIndicator step={signingStep} />}
                </AnimatePresence>

                <div className="text-center mb-6">
                    {/* Connected as...*/}
                    <p className={`mb-4 font-semibold ${address ? "text-lg text-blue-300" : "text-base text-gray-400"}`}>
                        {address
                            ? <>Hello, <span className="font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span></>
                            : "Not connected"}
                    </p>
                    <h2 className="text-2xl font-semibold mb-2">
                        Create Your Identity
                    </h2>
                </div>

                <div className="space-y-4">
                    <button
                        onClick={onCreateIdentity}
                        disabled={loading}
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
                </div>

                <div className="mt-6 text-xs text-gray-500 text-center">
                    <p>
                        You will be asked to sign two messages.
                        The first signature deterministically derives your identity keys.
                        The second signature creates an Identity Proof that binds the generated public keys
                        to your wallet address, the current chain, and this dapp origin.
                        Keys are stored locally and never leave your device.
                    </p>
                </div>
            </div>
        </div>
    );
}