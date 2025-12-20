// src/hooks/useSessionSetup.ts
import { useState, useEffect, useCallback } from 'react';
import { BrowserProvider, Contract } from 'ethers';
import { getOrCreateSafeForOwner, ensureModuleEnabled } from '../services/safeAccount.js';
import { LOGCHAIN_SINGLETON_ADDR, SAFE_MODULE_ADDRESS } from '../types.js';

interface UseSessionSetupParams {
  walletClient: any;
  address: `0x${string}` | undefined;
  safeAddr: string | null;
  chainId: number;
  readProvider: any;
  addLog: (message: string) => void;
  onSessionSetupComplete?: () => void;
}

export function useSessionSetup({
  walletClient,
  address,
  safeAddr,
  chainId,
  readProvider,
  addLog,
  onSessionSetupComplete,
}: UseSessionSetupParams) {
  const [sessionSignerAddr, setSessionSignerAddr] = useState<string | null>(null);
  const [sessionSignerBalance, setSessionSignerBalance] = useState<bigint | null>(null);
  const [needsSessionSetup, setNeedsSessionSetup] = useState(false);
  const [isSafeDeployed, setIsSafeDeployed] = useState(false);
  const [isModuleEnabled, setIsModuleEnabled] = useState(false);
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

      let currentModuleEnabled = isModuleEnabled;

      // Step 1: Deploy Safe + Enable Module in one transaction
      if (!isSafeDeployed) {
        addLog("Deploying Safe + enabling module (tx 1)...");

        const { isDeployed, moduleEnabled } = await getOrCreateSafeForOwner({
          chainId,
          ownerAddress: address as `0x${string}`,
          providerEip1193: walletClient.transport,
          ethersSigner,
          deployIfMissing: true,
          enableModuleDuringDeploy: true,
        });

        if (!isDeployed) {
          throw new Error("Safe deployment failed");
        }

        console.log(`✅ Safe deployed at ${safeAddr}`);
        setIsSafeDeployed(true);

        currentModuleEnabled = moduleEnabled ?? false;
        setIsModuleEnabled(currentModuleEnabled);

        if (currentModuleEnabled) {
          console.log(`✅ Module enabled during deployment`);
        }
      }

      // Step 2: Enable module separately if deployment didn't include it
      if (!currentModuleEnabled) {
        addLog("Enabling session module (tx 2)...");

        const { protocolKit } = await getOrCreateSafeForOwner({
          chainId,
          ownerAddress: address as `0x${string}`,
          providerEip1193: walletClient.transport,
          ethersSigner,
          deployIfMissing: false,
        });

        await ensureModuleEnabled(protocolKit);
        setIsModuleEnabled(true);
        console.log(`Module enabled`);
      }

      // Step 3: Register session signer
      const moduleContract = new Contract(
        SAFE_MODULE_ADDRESS,
        [
          "function setSession(address safe, address signer, uint256 expiry)",
          "function setTarget(address safe, address target, bool allowed)",
        ],
        ethersSigner
      );

      addLog("Registering session signer...");
      const tx1 = await moduleContract.setSession(
        safeAddr,
        sessionSignerAddr,
        BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
      );
      console.log(`TX hash: ${tx1.hash}`);
      await tx1.wait();
      console.log(`✅ Session signer authorized`);

      // Step 4: Allow LogChain target
      addLog("Allowing LogChain target...");
      const tx2 = await moduleContract.setTarget(
        safeAddr,
        LOGCHAIN_SINGLETON_ADDR,
        true
      );
      console.log(`TX hash: ${tx2.hash}`);
      await tx2.wait();
      console.log(`✅ LogChain target allowed`);

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
  }, [walletClient, address, safeAddr, sessionSignerAddr, isSafeDeployed, isModuleEnabled, chainId, addLog, onSessionSetupComplete]);

  return {
    // State
    sessionSignerAddr,
    sessionSignerBalance,
    needsSessionSetup,
    isSafeDeployed,
    isModuleEnabled,
    sessionLoading: loading,
    // Setters (needed by initializeWagmiAccount)
    setSessionSignerAddr,
    setSessionSignerBalance,
    setNeedsSessionSetup,
    setIsSafeDeployed,
    setIsModuleEnabled,
    // Actions
    refreshSessionBalance,
    setupSession,
  };
}