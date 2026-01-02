interface SessionSetupPromptProps {
  sessionSignerAddr: string | null;
  sessionSignerBalance: bigint | null;
  needsSessionSetup: boolean;
  isSafeDeployed?: boolean;
  isModuleEnabled?: boolean;
  onSetupSession: () => void;
  onRefreshBalance?: () => void;
  loading: boolean;
}

export function SessionSetupPrompt({
  sessionSignerAddr,
  sessionSignerBalance,
  needsSessionSetup,
  isSafeDeployed = false,
  isModuleEnabled = false,
  onSetupSession,
  onRefreshBalance,
  loading,
}: SessionSetupPromptProps) {
  if (!sessionSignerAddr) return null;

  const balanceEth = sessionSignerBalance !== null ? Number(sessionSignerBalance) / 1e18 : 0;
  const needsFunding = sessionSignerBalance === null || sessionSignerBalance < BigInt(0.0001 * 1e18);

  if (!loading) {
    console.log(`[SessionSetupPrompt] balance: ${balanceEth} ETH, needsFunding: ${needsFunding}, needsSessionSetup: ${needsSessionSetup}, isSafeDeployed: ${isSafeDeployed}, isModuleEnabled: ${isModuleEnabled}`);
  }

  if (!needsFunding && !needsSessionSetup) {
    return (
      <div className="bg-green-900/30 border border-green-600 rounded-lg p-4 mb-6">
        <h3 className="text-green-400 font-semibold">
          ✅ Ready for gasless messaging!
        </h3>
        <p className="text-sm text-gray-300">
          Session balance: {balanceEth.toFixed(6)} ETH
        </p>
      </div>
    );
  }

  // Determine what setup is needed
  const getSetupInfo = () => {
    if (!isSafeDeployed) {
      return {
        txCount: "1 tx",
        title: "Deploy & Authorize",
        description: "One-time setup: deploy your Safe wallet, enable the session module, and authorize gasless messaging — all in a single transaction.",
        steps: [
          "Deploy your Safe smart wallet",
          "Enable session module",
          "Register session signer + allow LogChain target",
        ],
      };
    } else if (!isModuleEnabled) {
      // Safe exists but module not enabled
      return {
        txCount: "2 txs",
        title: "Enable Module & Authorize",
        description: "Enable the session module on your existing Safe and authorize gasless messaging.",
        steps: [
          "Enable session module on Safe",
          "Register session signer + allow LogChain target",
        ],
      };
    } else {
      // Safe + module exist, just need session setup
      return {
        txCount: "1 tx",
        title: "Authorize Session",
        description: "One-time setup: authorize your session wallet to send messages without popups.",
        steps: [
          "Register session signer + allow LogChain target",
        ],
      };
    }
  };

  const setupInfo = getSetupInfo();

  return (
    <div className="space-y-4 mb-6">
      {/* Funding prompt */}
      {needsFunding && (
        <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-4">
          <h3 className="text-yellow-400 font-semibold mb-2">
            ⛽ Step 1: Fund Session Wallet
          </h3>
          <p className="text-sm text-gray-300 mb-3">
            Send a small amount of ETH to this address to pay for gas:
          </p>
          <div className="bg-black/50 rounded p-2 font-mono text-xs sm:text-sm break-all mb-3 select-all">
            {sessionSignerAddr}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-gray-400">
              Balance: {balanceEth.toFixed(6)} ETH
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(sessionSignerAddr)}
              className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              📋 Copy
            </button>
            {onRefreshBalance && (
              <button
                onClick={onRefreshBalance}
                className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                🔄 Refresh
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Recommended: 0.001 - 0.005 ETH (~20-100 messages on Base)
          </p>
        </div>
      )}

      {/* Session setup prompt - only show when funded */}
      {!needsFunding && needsSessionSetup && (
        <div className="bg-blue-900/30 border border-blue-600 rounded-lg p-4">
          <h3 className="text-blue-400 font-semibold mb-2">
            🔑 Step 2: {setupInfo.title}
          </h3>
          <p className="text-sm text-gray-300 mb-3">
            {setupInfo.description}
          </p>
          
          {/* Show what will happen */}
          <div className="bg-black/30 rounded p-2 mb-3 text-xs text-gray-400">
            <p className="font-semibold text-gray-300 mb-1">What happens:</p>
            <ol className="list-decimal list-inside space-y-0.5">
              {setupInfo.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>

          <button
            onClick={onSetupSession}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin">⏳</span> Setting up...
              </span>
            ) : (
              `${setupInfo.title} (${setupInfo.txCount})`
            )}
          </button>
        </div>
      )}
    </div>
  );
}