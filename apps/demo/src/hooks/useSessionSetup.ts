// src/hooks/useSessionSetup.ts
import { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Contract } from "ethers";
import {
  getOrCreateSafeForOwner,
  ensureModuleEnabled,
} from "../services/safeAccount.js";
import { LOGCHAIN_SINGLETON_ADDR, SAFE_MODULE_ADDRESS, ExecutionMode } from "../types.js";

interface UseSessionSetupParams {
  walletClient: any;
  address: string | undefined;
  safeAddr: string | null;
  sessionSignerAddr: string | null;
  chainId: number;
  readProvider: any;
  addLog: (message: string) => void;
  // State from useInitIdentity
  isSafeDeployed: boolean;
  isModuleEnabled: boolean;
  setIsSafeDeployed: (deployed: boolean) => void;
  setIsModuleEnabled: (enabled: boolean) => void;
  setNeedsSessionSetup: (needs: boolean) => void;
  executionMode: ExecutionMode | null;
}

export function useSessionSetup({
  walletClient,
  address,
  safeAddr,
  sessionSignerAddr,
  chainId,
  readProvider,
  addLog,
  isSafeDeployed,
  isModuleEnabled,
  setIsSafeDeployed,
  setIsModuleEnabled,
  setNeedsSessionSetup,
  executionMode,
}: UseSessionSetupParams) {
  const [sessionSignerBalance, setSessionSignerBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);

  const isClassicMode = executionMode === 'classic';

  // Refresh session signer balance (only for fast mode)
  useEffect(() => {
    if (isClassicMode || !sessionSignerAddr || !readProvider) return;

    const refreshBalance = async () => {
      try {
        const balance = await readProvider.getBalance(sessionSignerAddr);
        setSessionSignerBalance(balance);
      } catch (err) {
        console.error("Failed to refresh balance:", err);
      }
    };

    refreshBalance();
    const interval = setInterval(refreshBalance, 10000);
    return () => clearInterval(interval);
  }, [sessionSignerAddr, readProvider, isClassicMode]);

  const refreshSessionBalance = useCallback(async () => {
    if (isClassicMode || !sessionSignerAddr || !readProvider) return;
    try {
      const balance = await readProvider.getBalance(sessionSignerAddr);
      console.log(`🔄 Balance: ${Number(balance) / 1e18} ETH`);
      setSessionSignerBalance(balance);
    } catch (err) {
      console.error("Failed to refresh balance:", err);
    }
  }, [sessionSignerAddr, readProvider, isClassicMode]);

  const setupSession = useCallback(async () => {
    //Guard for classic mode
    if (isClassicMode) {
      addLog("Classic mode: no session setup needed");
      return;
    }

    if (!walletClient || !address || !safeAddr || !sessionSignerAddr) {
      addLog("Missing requirements for session setup");
      return;
    }

    setLoading(true);
    try {
      const ethersProvider = new BrowserProvider(walletClient.transport);
      const ethersSigner = await ethersProvider.getSigner();

      console.log(`\n========== SETTING UP SESSION (Fast Mode) ==========`);
      console.log(`VerbEth Safe: ${safeAddr}`);
      console.log(`Deployed: ${isSafeDeployed}`);
      console.log(`Module enabled: ${isModuleEnabled}`);
      console.log(`Session signer: ${sessionSignerAddr}`);

      // Case 1: Safe not deployed → Deploy + enable + configure (1 tx via helper)
      if (!isSafeDeployed) {
        addLog("Deploying VerbEth Safe + enabling module + configuring session...");

        const { isDeployed, moduleEnabled, sessionConfigured } = await getOrCreateSafeForOwner({
          chainId,
          ownerAddress: address as `0x${string}`,
          providerEip1193: walletClient.transport,
          ethersSigner,
          deployIfMissing: true,
          sessionConfig: {
            sessionSigner: sessionSignerAddr,
            target: LOGCHAIN_SINGLETON_ADDR,
          },
          useApiLookup: false, 
        });

        if (!isDeployed) {
          throw new Error("Safe deployment failed");
        }

        setIsSafeDeployed(true);
        setIsModuleEnabled(moduleEnabled);

        if (sessionConfigured) {
          console.log(`✅ All configured in 1 tx`);
          addLog("✓ Setup complete!");
          setIsModuleEnabled(true);
          setNeedsSessionSetup(false);
          // Don't call onSessionSetupComplete - state already updated via setters.
          // Calling reinit would read stale RPC data and overwrite correct state.
          return;
        }

        console.warn("Session not configured during deploy, falling back...");
      }

      // Case 2: Safe exists but module not enabled
      if (!isModuleEnabled) {
        addLog("Enabling session module...");

        const { protocolKit } = await getOrCreateSafeForOwner({
          chainId,
          ownerAddress: address as `0x${string}`,
          providerEip1193: walletClient.transport,
          ethersSigner,
          deployIfMissing: false,
          sessionConfig: {
            sessionSigner: sessionSignerAddr,
            target: LOGCHAIN_SINGLETON_ADDR,
          },
          useApiLookup: false,
        });

        await ensureModuleEnabled(protocolKit);
        setIsModuleEnabled(true);
        console.log(`✅ Module enabled`);
      }

      // Case 3: Safe + module exist → Just setup session
      const moduleContract = new Contract(
        SAFE_MODULE_ADDRESS,
        ["function setupSession(address safe, address signer, uint256 expiry, address target)"],
        ethersSigner
      );

      addLog("Setting up session...");
      const tx = await moduleContract.setupSession(
        safeAddr,
        sessionSignerAddr,
        BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        LOGCHAIN_SINGLETON_ADDR
      );
      console.log(`TX: ${tx.hash}`);
      await tx.wait();
      console.log(`✅ Session configured`);

      addLog("✓ Session setup complete!");
      console.log(`=====================================================\n`);
      setNeedsSessionSetup(false);

    } catch (err: any) {
      console.error(`Session setup error:`, err);
      addLog(`✗ Session setup failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [
    walletClient,
    address,
    safeAddr,
    sessionSignerAddr,
    isSafeDeployed,
    isModuleEnabled,
    chainId,
    isClassicMode,
    addLog,
    setIsSafeDeployed,
    setIsModuleEnabled,
    setNeedsSessionSetup,
  ]);

  //Return null values for classic mode
  if (isClassicMode) {
    return {
      sessionSignerBalance: null,
      sessionLoading: false,
      refreshSessionBalance: async () => {},
      setupSession: async () => {},
    };
  }

  return {
    sessionSignerBalance,
    sessionLoading: loading,
    refreshSessionBalance,
    setupSession,
  };
}