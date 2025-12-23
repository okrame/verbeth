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

export async function getOrCreateSafeForOwner(params: {
  chainId: number
  ownerAddress: `0x${string}`
  providerEip1193: any
  ethersSigner: any
  /**
   * Deploy the Safe if it doesn't exist yet
   */
  deployIfMissing?: boolean
  /**
   * Session config - MUST be provided for consistent address prediction.
   * The Safe address is deterministic based on setup params including to/data.
   * Pass the same sessionConfig for both prediction and deployment.
   */
  sessionConfig: SessionConfig
  /**
   * Pass Safe contractNetworks if on a chain not bundled in this protocol-kit version
   */
  contractNetworks?: any
}) {
  const {
    chainId,
    ownerAddress: rawOwnerAddress,
    providerEip1193,
    ethersSigner,
    deployIfMissing = false,
    sessionConfig,
    contractNetworks,
  } = params

  const ownerAddress = getAddress(rawOwnerAddress) as `0x${string}`

  const apiKit = new SafeApiKit({
    chainId: BigInt(chainId),
    ...(SAFE_API_KEY ? { apiKey: SAFE_API_KEY } : {}),
  })

  let existingSafeAddress: `0x${string}` | undefined

  // 1) Try to find an existing Safe for owner via API
  //    Note: This may return a Safe with different config. We'll verify below.
  try {
    const { safes } = await apiKit.getSafesByOwner(ownerAddress)
    existingSafeAddress = safes?.[0] as `0x${string}` | undefined
  } catch (e: any) {
    const status =
      e?.response?.status ??
      e?.status ??
      e?.cause?.status ??
      (typeof e?.message === 'string' && e.message.includes('404') ? 404 : undefined)

    if (status === 404) {
      existingSafeAddress = undefined
    } else {
      throw new Error(`Safe Tx Service error: ${e?.message ?? String(e)}`)
    }
  }

  // Spread optional contractNetworks only if provided
  const maybeNetworks = contractNetworks ? { contractNetworks } : {}

  // 2) Build predicted safe config - ALWAYS include sessionConfig for consistent address
  const safeAccountConfig = buildSafeAccountConfig(ownerAddress, chainId, sessionConfig)

  const predictedSafe = {
    safeAccountConfig,
    safeDeploymentConfig: {
      saltNonce: '0',
    },
  }

  // 2b) If API didn't find a Safe, check on-chain at predicted address
  if (!existingSafeAddress) {
    const tempKit = await Safe.init({
      provider: providerEip1193,
      signer: ownerAddress,
      predictedSafe,
      ...maybeNetworks,
    })
    const predictedAddress = await tempKit.getAddress()
    const isDeployedOnChain = await tempKit.isSafeDeployed()

    if (isDeployedOnChain) {
      existingSafeAddress = predictedAddress as `0x${string}`
      console.log(`Safe not in API but found on-chain at ${predictedAddress}`)
    }
  }

  // 3) If existing Safe found, use it (may have been deployed with different config)
  if (existingSafeAddress) {
    const protocolKit = await Safe.init({
      provider: providerEip1193,
      signer: ownerAddress,
      safeAddress: existingSafeAddress,
      ...maybeNetworks,
    })

    const moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)

    return {
      safeAddress: existingSafeAddress,
      protocolKit,
      isDeployed: true,
      moduleEnabled,
      sessionConfigured: false, // Can't know without checking module state
    }
  }

  // 4) No existing Safe - predict address with our config
  let protocolKit = await Safe.init({
    provider: providerEip1193,
    signer: ownerAddress,
    predictedSafe,
    ...maybeNetworks,
  })

  const safeAddress = (await protocolKit.getAddress()) as `0x${string}`

  if (!deployIfMissing) {
    return {
      safeAddress,
      protocolKit,
      isDeployed: false,
      moduleEnabled: false,
      sessionConfigured: false,
    }
  }

  // 5) Deploy (createProxyWithNonce tx)
  console.log(`🚀 Deploying Safe with module + session configured...`)

  const deploymentTx = await protocolKit.createSafeDeploymentTransaction()

  const txResp = await ethersSigner.sendTransaction({
    to: deploymentTx.to,
    data: deploymentTx.data,
    value: BigInt(deploymentTx.value),
  })
  const receipt = await txResp.wait()

  const statusOk = receipt?.status === 1 || receipt?.status === 1n
  if (!statusOk) {
    throw new Error('Safe deployment reverted')
  }

  console.log(`✅ Safe deployed at ${safeAddress}`)

  // If we used the helper with sessionConfig, module + session are already configured
  // Skip verification to avoid timing issues with RPC propagation
  const helperAddress = MODULE_SETUP_HELPER_ADDRESS[chainId]
  if (helperAddress && sessionConfig) {
    console.log(`   Module enabled: true (via helper)`)
    console.log(`   Session configured: true (via helper)`)

    return {
      safeAddress,
      protocolKit: null, // Not needed - caller should trigger reinit
      isDeployed: true,
      moduleEnabled: true,
      sessionConfigured: true,
    }
  }

  // Fallback: re-init and verify (for chains without helper)
  // Add small delay to allow RPC propagation
  await new Promise((resolve) => setTimeout(resolve, 2000))

  protocolKit = await Safe.init({
    provider: providerEip1193,
    signer: ownerAddress,
    safeAddress,
    ...maybeNetworks,
  })

  const moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)
  const sessionConfigured = false // Helper wasn't used

  console.log(`   Module enabled: ${moduleEnabled}`)
  console.log(`   Session configured: ${sessionConfigured}`)

  return {
    safeAddress,
    protocolKit,
    isDeployed: true,
    moduleEnabled,
    sessionConfigured,
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