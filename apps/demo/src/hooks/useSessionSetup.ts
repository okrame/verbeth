// src/hooks/useSessionSetup.ts
import { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Contract } from "ethers";
import {
  getOrCreateSafeForOwner,
  ensureModuleEnabled,
} from "../services/safeAccount.js";
import { LOGCHAIN_SINGLETON_ADDR, SAFE_MODULE_ADDRESS } from "../types.js";

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
  // Callbacks
  onSessionSetupComplete?: () => void;
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
  onSessionSetupComplete,
}: UseSessionSetupParams) {
  const [sessionSignerBalance, setSessionSignerBalance] = useState<
    bigint | null
  >(null);
  const [loading, setLoading] = useState(false);

  // Refresh session signer balance periodically
  useEffect(() => {
    if (!sessionSignerAddr || !readProvider) return;

    const refreshBalance = async () => {
      try {
        const balance = await readProvider.getBalance(sessionSignerAddr);
        console.log(`🔄 Balance refresh: ${Number(balance) / 1e18} ETH`);
        setSessionSignerBalance(balance);
      } catch (err) {
        console.error("Failed to refresh balance:", err);
      }
    };

    refreshBalance();
    const interval = setInterval(refreshBalance, 10000);
    return () => clearInterval(interval);
  }, [sessionSignerAddr, readProvider]);

  const refreshSessionBalance = useCallback(async () => {
    if (!sessionSignerAddr || !readProvider) return;
    try {
      const balance = await readProvider.getBalance(sessionSignerAddr);
      console.log(`🔄 Manual balance refresh: ${Number(balance) / 1e18} ETH`);
      setSessionSignerBalance(balance);
    } catch (err) {
      console.error("Failed to refresh balance:", err);
    }
  }, [sessionSignerAddr, readProvider]);

  const setupSession = useCallback(async () => {
    if (!walletClient || !address || !safeAddr || !sessionSignerAddr) {
      addLog("Missing requirements for session setup");
      return;
    }

    setLoading(true);
    try {
      const ethersProvider = new BrowserProvider(walletClient.transport);
      const ethersSigner = await ethersProvider.getSigner();

      console.log(`\n========== SETTING UP SESSION ==========`);
      console.log(`Safe: ${safeAddr}`);
      console.log(`Safe deployed: ${isSafeDeployed}`);
      console.log(`Module enabled: ${isModuleEnabled}`);
      console.log(`Session signer: ${sessionSignerAddr}`);
      console.log(`Target (LogChain): ${LOGCHAIN_SINGLETON_ADDR}`);

      // ============================================================
      // CASE 1: Safe not deployed → Single TX (deploy + module + session)
      // ============================================================
      if (!isSafeDeployed) {
        addLog("Deploying Safe + enabling module + configuring session (1 tx)...");

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
        });

        if (!isDeployed) {
          throw new Error("Safe deployment failed");
        }

        setIsSafeDeployed(true);
        setIsModuleEnabled(moduleEnabled);

        if (sessionConfigured) {
          console.log(`✅ Safe deployed + module enabled + session configured in 1 tx`);
          addLog("✓ Setup complete (1 tx)!");
          console.log(`==========================================\n`);
          setNeedsSessionSetup(false);
          // Allow RPC state propagation before reinit
          await new Promise(resolve => setTimeout(resolve, 1500));
          onSessionSetupComplete?.();
          return;
        }


        // Fallback: helper didn't configure session, need separate tx
        console.warn("Session not configured during deploy, falling back to separate tx");
      }

      // ============================================================
      // CASE 2: Safe exists but module not enabled → Enable module first
      // ============================================================
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
        });

        await ensureModuleEnabled(protocolKit);
        setIsModuleEnabled(true);
        console.log(`✅ Module enabled`);
      }

      // ============================================================
      // CASE 3: Safe + module exist → Just setup session
      // ============================================================
      const moduleContract = new Contract(
        SAFE_MODULE_ADDRESS,
        ["function setupSession(address safe, address signer, uint256 expiry, address target)"],
        ethersSigner
      );

      addLog("Setting up session (signer + target)...");
      const tx = await moduleContract.setupSession(
        safeAddr,
        sessionSignerAddr,
        BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"), // no expiry
        LOGCHAIN_SINGLETON_ADDR
      );
      console.log(`TX hash: ${tx.hash}`);
      await tx.wait();
      console.log(`✅ Session signer authorized + LogChain target allowed`);

      addLog("✓ Session setup complete!");
      console.log(`==========================================\n`);
      setNeedsSessionSetup(false);
      onSessionSetupComplete?.();
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
    addLog,
    setIsSafeDeployed,
    setIsModuleEnabled,
    setNeedsSessionSetup,
    onSessionSetupComplete,
  ]);

  return {
    sessionSignerBalance,
    sessionLoading: loading,
    refreshSessionBalance,
    setupSession,
  };
}