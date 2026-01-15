// src/services/safeAccount.ts
import SafeDefault from '@safe-global/protocol-kit'
import SafeApiKitDefault from '@safe-global/api-kit'
import { getAddress, Interface } from 'ethers'
import { SAFE_MODULE_ADDRESS, LOGCHAIN_SINGLETON_ADDR } from '../types.js'

// Handle ESM/CJS interop - safe libs export default differently
const Safe = (SafeDefault as any).default ?? SafeDefault
const SafeApiKit = (SafeApiKitDefault as any).default ?? SafeApiKitDefault

const SAFE_API_KEY = import.meta.env.VITE_SAFE_API_KEY as string

const MODULE_SETUP_HELPER_ADDRESS: Record<number, `0x${string}`> = {
  84532: '0xbd59Fea46D308eDF3b75C22a6f64AC68feFc731A',
  8453: '0xc022F74924BDB4b62D830234d89b066359bF67c0',
}

export interface SessionConfig {
  sessionSigner: string
  target: string
}

export async function predictVerbEthSafeAddress(params: {
  chainId: number
  ownerAddress: `0x${string}`
  sessionSignerAddr: string
  providerEip1193: any
  contractNetworks?: any
}): Promise<`0x${string}`> {
  const { chainId, ownerAddress, sessionSignerAddr, providerEip1193, contractNetworks } = params

  const sessionConfig: SessionConfig = {
    sessionSigner: sessionSignerAddr,
    target: LOGCHAIN_SINGLETON_ADDR,
  }

  const safeAccountConfig = buildSafeAccountConfig(
    getAddress(ownerAddress),
    chainId,
    sessionConfig
  )

  const predictedSafe = {
    safeAccountConfig,
    safeDeploymentConfig: { saltNonce: '0' },
  }

  const maybeNetworks = contractNetworks ? { contractNetworks } : {}

  const tempKit = await Safe.init({
    provider: providerEip1193,
    signer: ownerAddress,
    predictedSafe,
    ...maybeNetworks,
  })

  return (await tempKit.getAddress()) as `0x${string}`
}

export async function checkSafeOnChainStatus(params: {
  safeAddress: `0x${string}`
  providerEip1193: any
  ownerAddress: `0x${string}`
  contractNetworks?: any
}): Promise<{
  isDeployed: boolean
  moduleEnabled: boolean
}> {
  const { safeAddress, providerEip1193, ownerAddress, contractNetworks } = params
  const maybeNetworks = contractNetworks ? { contractNetworks } : {}

  try {
    const protocolKit = await Safe.init({
      provider: providerEip1193,
      signer: ownerAddress,
      safeAddress,
      ...maybeNetworks,
    })

    const isDeployed = await protocolKit.isSafeDeployed()
    if (!isDeployed) {
      return { isDeployed: false, moduleEnabled: false }
    }

    const moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)
    return { isDeployed: true, moduleEnabled }
  } catch {
    return { isDeployed: false, moduleEnabled: false }
  }
}

export async function getOrCreateSafeForOwner(params: {
  chainId: number
  ownerAddress: `0x${string}`
  providerEip1193: any
  ethersSigner: any
  deployIfMissing?: boolean
  sessionConfig: SessionConfig
  contractNetworks?: any
  /**
   * Only set to true for "custom" mode (import existing Safe)
   * Default: false (deterministic VerbEth Safe only)
   */
  useApiLookup?: boolean
}) {
  const {
    chainId,
    ownerAddress: rawOwnerAddress,
    providerEip1193,
    ethersSigner,
    deployIfMissing = false,
    sessionConfig,
    contractNetworks,
    useApiLookup = false, 
  } = params

  const ownerAddress = getAddress(rawOwnerAddress) as `0x${string}`
  const maybeNetworks = contractNetworks ? { contractNetworks } : {}

  // 1) ALWAYS build deterministic config first
  const safeAccountConfig = buildSafeAccountConfig(ownerAddress, chainId, sessionConfig)
  const predictedSafe = {
    safeAccountConfig,
    safeDeploymentConfig: { saltNonce: '0' },
  }

  // 2) Compute deterministic VerbEth Safe address
  const tempKit = await Safe.init({
    provider: providerEip1193,
    signer: ownerAddress,
    predictedSafe,
    ...maybeNetworks,
  })
  const verbEthSafeAddress = (await tempKit.getAddress()) as `0x${string}`

  // 3) Check if OUR deterministic Safe exists on-chain
  const isDeployedOnChain = await tempKit.isSafeDeployed()

  if (isDeployedOnChain) {
    // Our VerbEth Safe exists - use it
    const protocolKit = await Safe.init({
      provider: providerEip1193,
      signer: ownerAddress,
      safeAddress: verbEthSafeAddress,
      ...maybeNetworks,
    })

    const moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)

    console.log(`Found VerbEth Safe on-chain at ${verbEthSafeAddress}`)
    return {
      safeAddress: verbEthSafeAddress,
      protocolKit,
      isDeployed: true,
      moduleEnabled,
      sessionConfigured: moduleEnabled, // If module enabled via helper, session is configured
    }
  }

  // 4) OPTIONAL: API lookup for custom mode only
  if (useApiLookup) {
    const apiKit = new SafeApiKit({
      chainId: BigInt(chainId),
      ...(SAFE_API_KEY ? { apiKey: SAFE_API_KEY } : {}),
    })

    try {
      const { safes } = await apiKit.getSafesByOwner(ownerAddress)
      if (safes?.length) {
        console.log(`API found ${safes.length} Safe(s) for owner (custom mode)`)
        // For custom mode, caller would handle Safe selection UI
        // This is placeholder for "coming soon" feature
      }
    } catch (e: any) {
      console.warn(`Safe API lookup failed: ${e?.message}`)
    }
  }

  // 5) VerbEth Safe not deployed yet - return predicted address
  if (!deployIfMissing) {
    return {
      safeAddress: verbEthSafeAddress,
      protocolKit: tempKit,
      isDeployed: false,
      moduleEnabled: false,
      sessionConfigured: false,
    }
  }

  // 6) Deploy the VerbEth Safe
  console.log(`🚀 Deploying VerbEth Safe with module + session configured...`)

  const deploymentTx = await tempKit.createSafeDeploymentTransaction()

  const txResp = await ethersSigner.sendTransaction({
    to: deploymentTx.to,
    data: deploymentTx.data,
    value: BigInt(deploymentTx.value),
  })
  const receipt = await txResp.wait()

  if (receipt?.status !== 1 && receipt?.status !== 1n) {
    throw new Error('Safe deployment reverted')
  }

  console.log(`✅ VerbEth Safe deployed at ${verbEthSafeAddress}`)

  const helperAddress = MODULE_SETUP_HELPER_ADDRESS[chainId]
  if (helperAddress && sessionConfig) {
    console.log(`   Module enabled: true (via helper)`)
    console.log(`   Session configured: true (via helper)`)

    return {
      safeAddress: verbEthSafeAddress,
      protocolKit: null,
      isDeployed: true,
      moduleEnabled: true,
      sessionConfigured: true,
    }
  }

  // Fallback for chains without helper
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const protocolKit = await Safe.init({
    provider: providerEip1193,
    signer: ownerAddress,
    safeAddress: verbEthSafeAddress,
    ...maybeNetworks,
  })

  const moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)

  return {
    safeAddress: verbEthSafeAddress,
    protocolKit,
    isDeployed: true,
    moduleEnabled,
    sessionConfigured: false,
  }
}

/**
 * Build SafeAccountConfig with module + session setup callback.
 * This MUST be used consistently for both prediction and deployment
 * to ensure the same Safe address.
 */
function buildSafeAccountConfig(
  ownerAddress: string,
  chainId: number,
  sessionConfig: SessionConfig
): any {
  const baseConfig = {
    owners: [ownerAddress],
    threshold: 1,
  }

  const helperAddress = MODULE_SETUP_HELPER_ADDRESS[chainId]
  if (!helperAddress) {
    console.warn(`⚠️ ModuleSetupHelper not deployed on chain ${chainId}, using base config`)
    return baseConfig
  }

  // Encode enableModuleWithSession call for the helper contract
  const helperInterface = new Interface([
    'function enableModuleWithSession(address module, address sessionSigner, uint256 expiry, address target)',
  ])

  const NO_EXPIRY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  const setupData = helperInterface.encodeFunctionData('enableModuleWithSession', [
    SAFE_MODULE_ADDRESS,
    sessionConfig.sessionSigner,
    NO_EXPIRY,
    sessionConfig.target,
  ])

  return {
    ...baseConfig,
    to: helperAddress,
    data: setupData,
  }
}

export function isHelperAvailable(chainId: number): boolean {
  return !!MODULE_SETUP_HELPER_ADDRESS[chainId]
}

/**
 * Enable module on an already-deployed Safe (separate tx, for legacy Safes)
 */
export async function ensureModuleEnabled(protocolKit: any): Promise<boolean> {
  const moduleAddress = getAddress(SAFE_MODULE_ADDRESS)
  const enabled = await protocolKit.isModuleEnabled(moduleAddress)
  if (enabled) {
    console.log(`Module already enabled`)
    return true
  }

  console.log(`Enabling module ${moduleAddress}...`)
  const enableTx = await protocolKit.createEnableModuleTx(moduleAddress)
  const signed = await protocolKit.signTransaction(enableTx)
  const exec = await protocolKit.executeTransaction(signed)
  await exec.transactionResponse?.wait()
  console.log(`✅ Module enabled`)
  return true
}