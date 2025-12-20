interface SessionSetupPromptProps {
  sessionSignerAddr: string | null;
  sessionSignerBalance: bigint | null;
  needsSessionSetup: boolean;
  isSafeDeployed?: boolean;
  onSetupSession: () => void;
  onRefreshBalance?: () => void;
  loading: boolean;
}

export function SessionSetupPrompt({
  sessionSignerAddr,
  sessionSignerBalance,
  needsSessionSetup,
  isSafeDeployed = false,
  onSetupSession,
  onRefreshBalance,
  loading,
}: SessionSetupPromptProps) {
  if (!sessionSignerAddr) return null;

  const balanceEth = sessionSignerBalance !== null ? Number(sessionSignerBalance) / 1e18 : 0;
  const needsFunding = sessionSignerBalance === null || sessionSignerBalance < BigInt(0.0001 * 1e18);

  console.log(`[SessionSetupPrompt] balance: ${balanceEth} ETH, needsFunding: ${needsFunding}, needsSessionSetup: ${needsSessionSetup}, isSafeDeployed: ${isSafeDeployed}`);

  // All good - show ready state
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

  // Determine transaction count for button text
  const getTxCount = () => {
    if (!isSafeDeployed) {
      // Deploy + Enable (batched) + setSession + setTarget = 3 txs
      return "3 txs: Deploy Safe + Authorize";
    }
    // setSession + setTarget = 2 txs
    return "2 txs";
  };

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
            🔑 Step 2: {!isSafeDeployed ? "Deploy & Authorize" : "Authorize Session"}
          </h3>
          <p className="text-sm text-gray-300 mb-3">
            {!isSafeDeployed ? (
              <>
                One-time setup: deploy your Safe wallet and authorize session-based messaging.
                <br />
                <span className="text-xs text-gray-400">
                  This batches Safe deployment + module setup into fewer transactions.
                </span>
              </>
            ) : (
              "One-time setup: authorize your session wallet to send messages without popups."
            )}
          </p>
          
          {/* Show what will happen */}
          <div className="bg-black/30 rounded p-2 mb-3 text-xs text-gray-400">
            <p className="font-semibold text-gray-300 mb-1">What happens:</p>
            <ol className="list-decimal list-inside space-y-0.5">
              {!isSafeDeployed && (
                <li>Deploy your Safe smart wallet + enable session module</li>
              )}
              <li>Register session signer on module</li>
              <li>Allow LogChain contract as target</li>
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
              `${!isSafeDeployed ? "Deploy & " : ""}Authorize Session (${getTxCount()})`
            )}
          </button>
        </div>
      )}
    </div>
  );
}