// src/hooks/useInitIdentity.ts
import { useState, useEffect, useCallback, useMemo } from 'react';
import { BrowserProvider, Contract } from 'ethers';
import {
  VERBETH_ABI,
  IExecutor,
  ExecutorFactory,
  deriveIdentityKeys,
  createBindingProof,
  DerivedIdentityKeys,
  IdentityKeyPair,
  IdentityProof,
} from '@verbeth/sdk';
import { dbService } from '../services/DbService.js';
import {
  VERBETH_SINGLETON_ADDR,
  StoredIdentity,
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
  const [contract, setContract] = useState<Contract | null>(null);
  const [identitySigner, setIdentitySigner] = useState<any>(null);
  const [currentAccount, setCurrentAccount] = useState<string | null>(null);
  const [needsIdentityCreation, setNeedsIdentityCreation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reinitTrigger, setReinitTrigger] = useState(0);
  const [signingStep, setSigningStep] = useState<1 | 2 | null>(null);
  const [emitterAddress, setEmitterAddress] = useState<string | null>(null);

  const rpId = globalThis.location?.host ?? '';
  const identityContext = useMemo(() => ({ chainId, rpId }), [chainId, rpId]);

  const resetState = useCallback(() => {
    setCurrentAccount(null);
    setIdentityKeyPair(null);
    setIdentityProof(null);
    setIdentitySigner(null);
    setContract(null);
    setExecutor(null);
    setEmitterAddress(null);
    setNeedsIdentityCreation(false);
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
      setEmitterAddress(storedIdentity.emitterAddress ?? newAddress);
      setNeedsIdentityCreation(false);
    } else {
      setNeedsIdentityCreation(true);
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

    setEmitterAddress(storedIdentity.emitterAddress ?? address);

    const contractInstance = new Contract(VERBETH_SINGLETON_ADDR, VERBETH_ABI, ethersSigner as any);
    const executorInstance = ExecutorFactory.createEOA(contractInstance);

    setExecutor(executorInstance);
    setContract(contractInstance);
  }, [walletClient, address, currentAccount, chainId, readProvider, switchToAccount]);

  const createIdentity = useCallback(async () => {
    if (!identitySigner || !address || !walletClient) {
      return;
    }

    setSigningStep(1);
    setLoading(true);

    try {
      // Step 1: Derive keys
      const derivedKeys: DerivedIdentityKeys = await deriveIdentityKeys(
        identitySigner,
        address
      );

      console.log(`[verbeth] keys derived, session signer: ${derivedKeys.sessionAddress}`);

      // Step 2: Emitter is the EOA itself
      const emitter = address;

      // Step 3: Create binding proof
      setSigningStep(2);

      const proof = await createBindingProof(
        identitySigner,
        address,
        derivedKeys,
        emitter,
        identityContext
      );

      // Step 4: Store identity
      const identityToStore: StoredIdentity = {
        address: address,
        keyPair: derivedKeys.keyPair,
        derivedAt: Date.now(),
        proof: proof,
        sessionPrivateKey: derivedKeys.sessionPrivateKey,
        sessionAddress: derivedKeys.sessionAddress,
        executionMode: 'classic',
        emitterAddress: emitter,
      };

      await dbService.saveIdentity(identityToStore);

      setIdentityKeyPair(derivedKeys.keyPair);
      setIdentityProof(proof);
      setEmitterAddress(emitter);
      setNeedsIdentityCreation(false);
      setSigningStep(null);

      console.log(`[verbeth] identity created for ${address.slice(0, 10)}...`);

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
  }, [identitySigner, address, walletClient, identityContext, onIdentityCreated]);

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
    identityKeyPair,
    identityProof,
    executor,
    contract,
    identitySigner,
    needsIdentityCreation,
    identityLoading: loading,
    identityContext,
    signingStep,
    emitterAddress,
    createIdentity,
    resetState,
    triggerReinit: () => setReinitTrigger((t) => t + 1),
  };
}
