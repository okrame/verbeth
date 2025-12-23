// src/hooks/useInitIdentity.ts
import { useState, useEffect, useCallback, useMemo } from 'react';
import { BrowserProvider, Wallet } from 'ethers';
import {
  LogChainV1__factory,
  type LogChainV1,
} from '@verbeth/contracts/typechain-types/index.js';
import {
  IExecutor,
  ExecutorFactory,
  deriveIdentityKeyPairWithProof,
  IdentityKeyPair,
  IdentityProof,
  SafeSessionSigner,
} from '@verbeth/sdk';
import { dbService } from '../services/DbService.js';
import { getOrCreateSafeForOwner } from '../services/safeAccount.js';
import { LOGCHAIN_SINGLETON_ADDR, SAFE_MODULE_ADDRESS, StoredIdentity } from '../types.js';

interface UseInitIdentityParams {
  walletClient: any;
  address: string | undefined;
  chainId: number;
  readProvider: any;
  ready: boolean;
  addLog: (message: string) => void;
  // Callbacks
  onIdentityCreated?: () => void;
  onReset?: () => void;
}

export function useInitIdentity({
  walletClient,
  address,
  chainId,
  readProvider,
  ready,
  addLog,
  onIdentityCreated,
  onReset,
}: UseInitIdentityParams) {
  const [identityKeyPair, setIdentityKeyPair] = useState<IdentityKeyPair | null>(null);
  const [identityProof, setIdentityProof] = useState<IdentityProof | null>(null);
  const [executor, setExecutor] = useState<IExecutor | null>(null);
  const [contract, setContract] = useState<LogChainV1 | null>(null);
  const [identitySigner, setIdentitySigner] = useState<any>(null);
  const [txSigner, setTxSigner] = useState<any>(null);
  const [safeAddr, setSafeAddr] = useState<string | null>(null);
  const [currentAccount, setCurrentAccount] = useState<string | null>(null);
  const [needsIdentityCreation, setNeedsIdentityCreation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reinitTrigger, setReinitTrigger] = useState(0);
  
  // Session-related state (initialized here, used by useSessionSetup)
  const [sessionSignerAddr, setSessionSignerAddr] = useState<string | null>(null);
  const [needsSessionSetup, setNeedsSessionSetup] = useState(false);
  const [isSafeDeployed, setIsSafeDeployed] = useState(false);
  const [isModuleEnabled, setIsModuleEnabled] = useState(false);

  const rpId = globalThis.location?.host ?? '';
  const identityContext = useMemo(() => ({ chainId, rpId }), [chainId, rpId]);

  const resetState = useCallback(() => {
    setCurrentAccount(null);
    setIdentityKeyPair(null);
    setIdentityProof(null);
    setIdentitySigner(null);
    setTxSigner(null);
    setContract(null);
    setExecutor(null);
    setNeedsIdentityCreation(false);
    onReset?.();
  }, [onReset]);

  const switchToAccount = useCallback(async (newAddress: string) => {
    setIdentityKeyPair(null);
    setIdentityProof(null);

    await dbService.switchAccount(newAddress);
    setCurrentAccount(newAddress);

    const storedIdentity = await dbService.getIdentity(newAddress);
    if (storedIdentity) {
      setIdentityKeyPair(storedIdentity.keyPair);
      setIdentityProof(storedIdentity.proof ?? null);
      setNeedsIdentityCreation(false);
      addLog(`Identity keys restored from database`);
    } else {
      setNeedsIdentityCreation(true);
    }
  }, [addLog]);

  const initializeWagmiAccount = useCallback(async () => {
    if (!walletClient || !address || !readProvider) return;

    const ethersProvider = new BrowserProvider(walletClient.transport);
    const ethersSigner = await ethersProvider.getSigner();
    setIdentitySigner(ethersSigner);

    if (address !== currentAccount) {
      await switchToAccount(address);
    }

    const net = await ethersProvider.getNetwork();
    if (Number(net.chainId) !== chainId) {
      addLog(`Wrong network: connected to chain ${Number(net.chainId)}, expected ${chainId}. Please switch network in your wallet.`);
      return;
    }

    // ============================================================
    // KEY CHANGE: Get session key FIRST, based on EOA (not Safe)
    // This ensures consistent Safe address prediction
    // ============================================================
    const sessionPrivKey = await dbService.getSessionPrivKey(address, chainId);
    const sessionWallet = new Wallet(sessionPrivKey, readProvider);
    const sessionAddr = await sessionWallet.getAddress();
    setSessionSignerAddr(sessionAddr);

    // Now predict/get Safe with sessionConfig included
    // This ensures prediction matches what will be deployed
    const { safeAddress, isDeployed, moduleEnabled } = await getOrCreateSafeForOwner({
      chainId,
      ownerAddress: address as `0x${string}`,
      providerEip1193: walletClient.transport,
      ethersSigner,
      deployIfMissing: false,
      sessionConfig: {
        sessionSigner: sessionAddr,
        target: LOGCHAIN_SINGLETON_ADDR,
      },
    });

    setSafeAddr(safeAddress);
    setIsSafeDeployed(isDeployed);
    setIsModuleEnabled(moduleEnabled ?? false);
    if (!isDeployed || !(moduleEnabled ?? false)) {
      setNeedsSessionSetup(true);
    }

    console.log(`\n========== SAFE & SESSION INFO ==========`);
    console.log(`Connected EOA wallet: ${address}`);
    console.log(`Associated Safe address: ${safeAddress}`);
    console.log(`   Safe deployed: ${isDeployed}`);
    console.log(`   Module enabled: ${moduleEnabled}`);
    console.log(`   Chain ID: ${chainId}`);
    console.log(`📍 Session signer address: ${sessionAddr}`);

    // Check session signer balance
    const balance = await readProvider.getBalance(sessionAddr);
    const balanceEth = Number(balance) / 1e18;
    console.log(`💰 Session signer balance: ${balanceEth.toFixed(6)} ETH (${balance.toString()} wei)`);

    if (balance === 0n) {
      addLog(`Session signer needs funding: ${sessionAddr}`);
    }

    // Check if identity exists - if not, stop here and wait for identity creation
    const storedIdentity = await dbService.getIdentity(address);
    if (!storedIdentity) {
      addLog(`Counterfactual Safe address: ${safeAddress.slice(0, 10)}... - awaiting identity creation`);
      return;
    }

    // Create SafeSessionSigner for transaction signing
    const safeSessionSigner = new SafeSessionSigner({
      provider: readProvider,
      safeAddress,
      moduleAddress: SAFE_MODULE_ADDRESS,
      logChainAddress: LOGCHAIN_SINGLETON_ADDR,
      sessionSigner: sessionWallet,
    });
    setTxSigner(safeSessionSigner);

    // Check if session is properly configured on the module
    const isValid = await safeSessionSigner.isSessionValid();
    const isTargetAllowed = await safeSessionSigner.isTargetAllowed();
    console.log(`Session valid on module: ${isValid}`);
    console.log(`LogChain target allowed: ${isTargetAllowed}`);
    setNeedsSessionSetup(!isValid || !isTargetAllowed);

    if (!isValid || !isTargetAllowed) {
      addLog(`⚠️ Session needs setup on module (valid: ${isValid}, target: ${isTargetAllowed})`);
    }

    const contractInstance = LogChainV1__factory.connect(LOGCHAIN_SINGLETON_ADDR, safeSessionSigner as any);
    const executorInstance = ExecutorFactory.createEOA(contractInstance);

    setExecutor(executorInstance);
    setContract(contractInstance);
  }, [walletClient, address, currentAccount, chainId, readProvider, addLog, switchToAccount]);

  const createIdentity = useCallback(async () => {
    if (!identitySigner || !address || !safeAddr) {
      addLog('✗ Missing signer/provider or address for identity creation');
      return;
    }

    setLoading(true);
    try {
      addLog('Deriving new identity key (2 signatures)...');

      const result = await deriveIdentityKeyPairWithProof(identitySigner, address, safeAddr, identityContext);

      setIdentityKeyPair(result.keyPair);
      setIdentityProof(result.identityProof);

      const identityToStore: StoredIdentity = {
        address: address,
        keyPair: result.keyPair,
        derivedAt: Date.now(),
        proof: result.identityProof,
      };

      await dbService.saveIdentity(identityToStore);
      addLog(`New identity key derived and saved for EOA`);
      setNeedsIdentityCreation(false);
      onIdentityCreated?.();

      // Trigger re-initialization to complete Safe setup
      setReinitTrigger((t) => t + 1);
    } catch (signError: any) {
      if (signError.code === 4001) {
        addLog('User rejected signing request.');
      } else {
        addLog(`✗ Failed to derive identity: ${signError.message}`);
      }
    } finally {
      setLoading(false);
    }
  }, [identitySigner, address, safeAddr, identityContext, addLog, onIdentityCreated]);

  // Handle initialization on ready/wallet/address/reinit changes
  useEffect(() => {
    const handleInit = async () => {
      try {
        if (ready && readProvider && walletClient && address) {
          await initializeWagmiAccount();
          return;
        }
        if (!address) {
          resetState();
        }
      } catch (error) {
        console.error('Failed to initialize:', error);
        addLog(`✗ Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    };
    handleInit();
  }, [ready, readProvider, walletClient, address, reinitTrigger]);

  return {
    // Identity state
    identityKeyPair,
    identityProof,
    executor,
    contract,
    identitySigner,
    txSigner,
    safeAddr,
    currentAccount,
    needsIdentityCreation,
    identityLoading: loading,
    identityContext,
    // Session state (owned here, used by useSessionSetup)
    sessionSignerAddr,
    needsSessionSetup,
    isSafeDeployed,
    isModuleEnabled,
    setSessionSignerAddr,
    setNeedsSessionSetup,
    setIsSafeDeployed,
    setIsModuleEnabled,
    // Actions
    createIdentity,
    resetState,
    triggerReinit: () => setReinitTrigger((t) => t + 1),
  };
}