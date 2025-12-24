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
  deriveIdentityKeys,
  createBindingProof,
  DerivedIdentityKeys,
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
  
  const [sessionSignerAddr, setSessionSignerAddr] = useState<string | null>(null);
  const [needsSessionSetup, setNeedsSessionSetup] = useState(false);
  const [isSafeDeployed, setIsSafeDeployed] = useState(false);
  const [isModuleEnabled, setIsModuleEnabled] = useState(false);
  const [signingStep, setSigningStep] = useState<1 | 2 | null>(null);

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
    setSafeAddr(null);
    setSessionSignerAddr(null);
    setNeedsIdentityCreation(false);
    setNeedsSessionSetup(false);
    setIsSafeDeployed(false);
    setIsModuleEnabled(false);
    onReset?.();
  }, [onReset]);

  const switchToAccount = useCallback(async (newAddress: string) => {
    setIdentityKeyPair(null);
    setIdentityProof(null);

    await dbService.switchAccount(newAddress);
    setCurrentAccount(newAddress);

    const storedIdentity = await dbService.getIdentity(newAddress);
    if (storedIdentity && storedIdentity.sessionPrivateKey) {
      setIdentityKeyPair(storedIdentity.keyPair);
      setIdentityProof(storedIdentity.proof ?? null);
      setNeedsIdentityCreation(false);
      addLog(`Identity keys restored from database`);
    } else if (storedIdentity && !storedIdentity.sessionPrivateKey) {
      setNeedsIdentityCreation(true);
      addLog(`Identity upgrade required (to derive session key)`);
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

    const storedIdentity = await dbService.getIdentity(address);
    
    if (!storedIdentity || !storedIdentity.sessionPrivateKey) {
      addLog(`Awaiting identity creation...`);
      return;
    }

    const sessionPrivKey = storedIdentity.sessionPrivateKey;
    const sessionWallet = new Wallet(sessionPrivKey, readProvider);
    const sessionAddr = storedIdentity.sessionAddress ?? await sessionWallet.getAddress();
    setSessionSignerAddr(sessionAddr);

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
    console.log(`   Session signer address: ${sessionAddr}`);

    // Check session signer balance
    const balance = await readProvider.getBalance(sessionAddr);
    const balanceEth = Number(balance) / 1e18;
    console.log(`Session signer balance: ${balanceEth.toFixed(6)} ETH (${balance.toString()} wei)`);

    if (balance === 0n) {
      addLog(`Session signer needs funding: ${sessionAddr}`);
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
    if (isDeployed) {
      const isValid = await safeSessionSigner.isSessionValid();
      const isTargetAllowed = await safeSessionSigner.isTargetAllowed();
      console.log(`Session valid on module: ${isValid}`);
      console.log(`LogChain target allowed: ${isTargetAllowed}`);
      setNeedsSessionSetup(!isValid || !isTargetAllowed);

      if (!isValid || !isTargetAllowed) {
        addLog(`Session needs setup on module (valid: ${isValid}, target: ${isTargetAllowed})`);
      }
    }

    console.log(`==========================================\n`);

    const contractInstance = LogChainV1__factory.connect(LOGCHAIN_SINGLETON_ADDR, safeSessionSigner as any);
    const executorInstance = ExecutorFactory.createEOA(contractInstance);

    setExecutor(executorInstance);
    setContract(contractInstance);
  }, [walletClient, address, currentAccount, chainId, readProvider, addLog, switchToAccount]);

  const createIdentity = useCallback(async () => {
    if (!identitySigner || !address || !walletClient) {
      addLog('✗ Missing signer/provider or address for identity creation');
      return;
    }
    setSigningStep(1);
    setLoading(true);
    try {
      // ================================================================
      // Derive all keys from seed signature (1 signature)
      // ================================================================
      addLog('Deriving identity keys (signature 1/2)...');

      const derivedKeys: DerivedIdentityKeys = await deriveIdentityKeys(
        identitySigner,
        address
      );

      console.log(`✓ Verbeth keys derived:`);
      console.log(`   Session signer: ${derivedKeys.sessionAddress}`);

      // ================================================================
      // PREDICT SAFE ADDRESS (no signature needed)
      // ================================================================
      const ethersProvider = new BrowserProvider(walletClient.transport);
      const ethersSigner = await ethersProvider.getSigner();

      const { safeAddress: predictedSafe } = await getOrCreateSafeForOwner({
        chainId,
        ownerAddress: address as `0x${string}`,
        providerEip1193: walletClient.transport,
        ethersSigner,
        deployIfMissing: false,
        sessionConfig: {
          sessionSigner: derivedKeys.sessionAddress,
          target: LOGCHAIN_SINGLETON_ADDR,
        },
      });

      console.log(`✓ Predicted Safe: ${predictedSafe}`);

      // ================================================================
      // Create binding proof with Safe address (1 signature)
      // ================================================================
      addLog('Creating binding proof (signature 2/2)...');
      setSigningStep(2);

      const proof = await createBindingProof(
        identitySigner,
        address,
        derivedKeys,
        predictedSafe,
        identityContext
      );

      // ================================================================
      // STORE IDENTITY
      // ================================================================
      setIdentityKeyPair(derivedKeys.keyPair);
      setIdentityProof(proof);

      const identityToStore: StoredIdentity = {
        address: address,
        keyPair: derivedKeys.keyPair,
        derivedAt: Date.now(),
        proof: proof,
        sessionPrivateKey: derivedKeys.sessionPrivateKey,
        sessionAddress: derivedKeys.sessionAddress,
      };

      await dbService.saveIdentity(identityToStore);
      addLog(`✓ Identity created with derived session key`);
      addLog(`  Session signer: ${derivedKeys.sessionAddress}`);
      setNeedsIdentityCreation(false);
      setSigningStep(null);
      onIdentityCreated?.();

      // Trigger re-initialization to complete Safe setup
      setReinitTrigger((t) => t + 1);
    } catch (signError: any) {
      if (signError.code === 4001) {
        addLog('User rejected signing request.');
      } else {
        console.error('Identity creation error:', signError);
        addLog(`✗ Failed to derive identity: ${signError.message}`);
      }
    } finally {
      setLoading(false);
    }
  }, [identitySigner, address, walletClient, chainId, identityContext, addLog, onIdentityCreated]);

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
    signingStep,
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