interface IdentityCreationProps {
    loading: boolean;
    onCreateIdentity: () => void;
    onImportIdentity?: () => void;
    address: string;
}

export function IdentityCreation({
    loading,
    onCreateIdentity,
    onImportIdentity,
    address,
}: IdentityCreationProps) {
    return (
        <div className="flex items-center justify-center min-h-[60vh]">
            <div className="border border-gray-800 rounded-lg p-8 w-full max-w-md">
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
                    <p className="text-sm text-gray-400 mt-2">
                        Choose how to set up your encrypted messaging identity:
                    </p>
                </div>

                <div className="space-y-4">
                    <button
                        onClick={onCreateIdentity}
                        disabled={loading}
                        className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium"
                    >
                        {loading ? "Creating..." : "Create New Identity (2 signatures)"}
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