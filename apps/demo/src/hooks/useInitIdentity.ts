// src/hooks/useInitIdentity.ts
import { useState, useEffect, useCallback, useMemo } from 'react';
import { BrowserProvider, Wallet } from 'ethers';
import {
  VerbethV1__factory,
  type VerbethV1,
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
import {
  getOrCreateSafeForOwner,
  predictVerbEthSafeAddress,
  isHelperAvailable,
} from '../services/safeAccount.js';
import {
  VERBETH_SINGLETON_ADDR,
  getSafeModuleAddressOrThrow,
  hasSafeModuleAddress,
  StoredIdentity,
  ExecutionMode,
} from '../types.js';

interface UseInitIdentityParams {
  walletClient: any;
  address: string | undefined;
  chainId: number;
  readProvider: any;
  ready: boolean;
  onIdentityCreated?: () => void;
  onReset?: () => void;
}

export function useInitIdentity({
  walletClient,
  address,
  chainId,
  readProvider,
  ready,
  onIdentityCreated,
  onReset,
}: UseInitIdentityParams) {
  const [identityKeyPair, setIdentityKeyPair] = useState<IdentityKeyPair | null>(null);
  const [identityProof, setIdentityProof] = useState<IdentityProof | null>(null);
  const [executor, setExecutor] = useState<IExecutor | null>(null);
  const [contract, setContract] = useState<VerbethV1 | null>(null);
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

  // Execution mode state
  const [executionMode, setExecutionMode] = useState<ExecutionMode | null>(null);
  const [needsModeSelection, setNeedsModeSelection] = useState(false);
  const [emitterAddress, setEmitterAddress] = useState<string | null>(null);

  const rpId = globalThis.location?.host ?? '';
  const identityContext = useMemo(() => ({ chainId, rpId }), [chainId, rpId]);

  // Check if fast mode is available on this chain
  const fastModeAvailable = useMemo(
    () => isHelperAvailable(chainId) && hasSafeModuleAddress(),
    [chainId]
  );
  const fastModeUnavailableReason = useMemo(() => {
    if (!isHelperAvailable(chainId)) {
      return `Helper not deployed on chain ${chainId}`;
    }
    if (!hasSafeModuleAddress()) {
      return 'Missing VITE_SAFE_SESSION_MODULE';
    }
    return undefined;
  }, [chainId]);

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
    setExecutionMode(null);
    setNeedsModeSelection(false);
    setEmitterAddress(null);
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
      // Restore mode from storage
      setExecutionMode(storedIdentity.executionMode ?? 'fast'); // default to fast for legacy
      setEmitterAddress(storedIdentity.emitterAddress ?? null);
      setNeedsIdentityCreation(false);
      setNeedsModeSelection(false);
    } else if (storedIdentity && !storedIdentity.sessionPrivateKey) {
      setNeedsModeSelection(true);
    } else {
      // Need mode selection before identity creation
      setNeedsModeSelection(true);
    }
  }, []);

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
      console.error(`[verbeth] wrong network: connected to chain ${Number(net.chainId)}, expected ${chainId}`);
      return;
    }

    const storedIdentity = await dbService.getIdentity(address);

    if (!storedIdentity || !storedIdentity.sessionPrivateKey) {
      return;
    }

    const currentMode = storedIdentity.executionMode ?? 'fast';
    setExecutionMode(currentMode);
    setEmitterAddress(storedIdentity.emitterAddress ?? address);

    // =========================================================================
    // CLASSIC MODE: EOA executor, no Safe setup needed
    // =========================================================================
    if (currentMode === 'classic') {

      const contractInstance = VerbethV1__factory.connect(VERBETH_SINGLETON_ADDR, ethersSigner as any);
      const executorInstance = ExecutorFactory.createEOA(contractInstance);

      setExecutor(executorInstance);
      setContract(contractInstance);
      setTxSigner(ethersSigner);
      setSafeAddr(null);
      setNeedsSessionSetup(false);
      return;
    }

    // =========================================================================
    // FAST MODE: VerbEth Safe + session signer
    // =========================================================================
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
        target: VERBETH_SINGLETON_ADDR,
      },
      // Never use API for fast mode
      useApiLookup: false,
    });

    setSafeAddr(safeAddress);
    setIsSafeDeployed(isDeployed);
    setIsModuleEnabled(moduleEnabled ?? false);
    if (!isDeployed || !(moduleEnabled ?? false)) {
      setNeedsSessionSetup(true);
    }

    console.log(`\n========== SAFE & SESSION INFO (Fast Mode) ==========`);
    console.log(`Connected EOA wallet: ${address}`);
    console.log(`VerbEth Safe address: ${safeAddress}`);
    console.log(`   Safe deployed: ${isDeployed}`);
    console.log(`   Module enabled: ${moduleEnabled}`);
    console.log(`   Chain ID: ${chainId}`);
    console.log(`   Session signer: ${sessionAddr}`);

    const balance = await readProvider.getBalance(sessionAddr);
    console.log(`   Session signer balance: ${Number(balance) / 1e18} ETH`);

    const safeSessionSigner = new SafeSessionSigner({
      provider: readProvider,
      safeAddress,
      moduleAddress: getSafeModuleAddressOrThrow(),
      verbEthAddress: VERBETH_SINGLETON_ADDR,
      sessionSigner: sessionWallet,
    });
    setTxSigner(safeSessionSigner);

    if (isDeployed) {
      const isValid = await safeSessionSigner.isSessionValid();
      const isTargetAllowed = await safeSessionSigner.isTargetAllowed();
      console.log(`   Session valid: ${isValid}`);
      console.log(`   Target allowed: ${isTargetAllowed}`);
      setNeedsSessionSetup(!isValid || !isTargetAllowed);
    }

    console.log(`=====================================================\n`);

    const contractInstance = VerbethV1__factory.connect(VERBETH_SINGLETON_ADDR, safeSessionSigner as any);
    const executorInstance = ExecutorFactory.createEOA(contractInstance);

    setExecutor(executorInstance);
    setContract(contractInstance);
  }, [walletClient, address, currentAccount, chainId, readProvider, switchToAccount]);

  const createIdentity = useCallback(async (selectedMode: ExecutionMode) => {
    if (!identitySigner || !address || !walletClient) {
      return;
    }

    if (selectedMode === 'custom') {
      return;
    }

    setSigningStep(1);
    setLoading(true);

    try {
      // ================================================================
      // Step 1: Derive keys (same for all modes)
      // ================================================================

      const derivedKeys: DerivedIdentityKeys = await deriveIdentityKeys(
        identitySigner,
        address
      );

      console.log(`✓ Keys derived, session signer: ${derivedKeys.sessionAddress}`);

      // ================================================================
      // Step 2: Determine emitter address based on mode
      // ================================================================
      let emitter: string;

      if (selectedMode === 'classic') {
        // Classic mode: EOA is the emitter
        emitter = address;
        console.log(`✓ Classic mode: emitter = EOA (${address})`);
      } else {
        // Fast mode: Predict VerbEth Safe address (deterministic, no API)
        emitter = await predictVerbEthSafeAddress({
          chainId,
          ownerAddress: address as `0x${string}`,
          sessionSignerAddr: derivedKeys.sessionAddress,
          providerEip1193: walletClient.transport,
        });
        console.log(`✓ Fast mode: emitter = VerbEth Safe (${emitter})`);
      }

      // ================================================================
      // Step 3: Create binding proof with correct emitter
      // ================================================================
      setSigningStep(2);

      const proof = await createBindingProof(
        identitySigner,
        address,
        derivedKeys,
        emitter,
        identityContext
      );

      // ================================================================
      // Step 4: Store identity with mode info
      // ================================================================
      const identityToStore: StoredIdentity = {
        address: address,
        keyPair: derivedKeys.keyPair,
        derivedAt: Date.now(),
        proof: proof,
        sessionPrivateKey: derivedKeys.sessionPrivateKey,
        sessionAddress: derivedKeys.sessionAddress,
        // Store mode and emitter
        executionMode: selectedMode,
        emitterAddress: emitter,
      };

      await dbService.saveIdentity(identityToStore);

      setIdentityKeyPair(derivedKeys.keyPair);
      setIdentityProof(proof);
      setExecutionMode(selectedMode);
      setEmitterAddress(emitter);
      setNeedsIdentityCreation(false);
      setNeedsModeSelection(false);
      setSigningStep(null);

      console.log(`[verbeth] identity created in ${selectedMode} mode for ${address.slice(0, 10)}...`);

      onIdentityCreated?.();
      setReinitTrigger((t) => t + 1);

    } catch (signError: any) {
      if (signError.code !== 4001) {
        console.error('[verbeth] identity creation failed:', signError);
      }
    } finally {
      setLoading(false);
      setSigningStep(null);
    }
  }, [identitySigner, address, walletClient, chainId, identityContext, onIdentityCreated]);

  // Handle initialization
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
        console.error('[verbeth] initialization failed:', error);
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

    // Mode state
    executionMode,
    needsModeSelection,
    emitterAddress,
    fastModeAvailable,
    fastModeUnavailableReason,
    setExecutionMode,

    // Session state
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
