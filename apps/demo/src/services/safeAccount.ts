// src/services/safeAccount.ts
import SafeDefault from '@safe-global/protocol-kit'
import SafeApiKitDefault from '@safe-global/api-kit'
import { getAddress, Interface } from 'ethers'
import { SAFE_MODULE_ADDRESS } from '../types.js'

// Handle ESM/CJS interop - safe libs export default differently
const Safe = (SafeDefault as any).default ?? SafeDefault
const SafeApiKit = (SafeApiKitDefault as any).default ?? SafeApiKitDefault

const SAFE_API_KEY = import.meta.env.VITE_SAFE_API_KEY as string

const MODULE_SETUP_HELPER_ADDRESS: Record<number, `0x${string}`> = {
  84532: '0xc022F74924BDB4b62D830234d89b066359bF67c0',
  8453: '0xc022F74924BDB4b62D830234d89b066359bF67c0',  
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
   * Enable the session module during deployment (only works with deployIfMissing=true)
   */
  enableModuleDuringDeploy?: boolean
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
    enableModuleDuringDeploy = false,
    contractNetworks,
  } = params

  const ownerAddress = getAddress(rawOwnerAddress) as `0x${string}`

  const apiKit = new SafeApiKit({
    chainId: BigInt(chainId),
    ...(SAFE_API_KEY ? { apiKey: SAFE_API_KEY } : {}),
  })

  let safeAddress: `0x${string}` | undefined

  // 1) Try to find an existing Safe for owner
  try {
    const { safes } = await apiKit.getSafesByOwner(ownerAddress)
    safeAddress = safes?.[0] as `0x${string}` | undefined
  } catch (e: any) {
    const status =
      e?.response?.status ??
      e?.status ??
      e?.cause?.status ??
      (typeof e?.message === 'string' && e.message.includes('404') ? 404 : undefined)

    if (status === 404) {
      safeAddress = undefined
    } else {
      throw new Error(`Safe Tx Service error: ${e?.message ?? String(e)}`)
    }
  }

  // Spread optional contractNetworks only if provided
  const maybeNetworks = contractNetworks ? { contractNetworks } : {}

  // 2) If not found, build predicted safe (deploy only if deployIfMissing=true)
  if (!safeAddress) {
    // Build the predicted safe configuration
    // If enableModuleDuringDeploy=true, include the setup callback
    const safeAccountConfig = buildSafeAccountConfig(
      ownerAddress,
      chainId,
      enableModuleDuringDeploy && deployIfMissing
    )

    const predictedSafe = {
      safeAccountConfig,
      safeDeploymentConfig: {
        saltNonce: '0',
      },
    }

    let protocolKit = await Safe.init({
      provider: providerEip1193,
      signer: ownerAddress,
      predictedSafe,
      ...maybeNetworks,
    })

    safeAddress = (await protocolKit.getAddress()) as `0x${string}`

    if (!deployIfMissing) {
      return { safeAddress, protocolKit, isDeployed: false, moduleEnabled: false }
    }

    // Deploy (createProxyWithNonce tx)
    console.log(`🚀 Deploying Safe${enableModuleDuringDeploy ? ' with module enabled' : ''}...`)
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

    console.log(`Safe deployed at ${safeAddress}`)

    // Re-init on the deployed address
    protocolKit = await Safe.init({
      provider: providerEip1193,
      signer: ownerAddress,
      safeAddress,
      ...maybeNetworks,
    })

    // Verify module is enabled if we tried to enable it
    let moduleEnabled = false
    if (enableModuleDuringDeploy) {
      moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)
      console.log(`Module enabled during deploy: ${moduleEnabled}`)
    }

    return { safeAddress, protocolKit, isDeployed: true, moduleEnabled }
  }

  // 3) Safe already exists
  const protocolKit = await Safe.init({
    provider: providerEip1193,
    signer: ownerAddress,
    safeAddress,
    ...maybeNetworks,
  })

  const moduleEnabled = await protocolKit.isModuleEnabled(SAFE_MODULE_ADDRESS)

  return { safeAddress, protocolKit, isDeployed: true, moduleEnabled }
}

/**
 * Build SafeAccountConfig, optionally including module setup callback
 */
function buildSafeAccountConfig(
  ownerAddress: string,
  chainId: number,
  includeModuleSetup: boolean
): any {
  const baseConfig = {
    owners: [ownerAddress],
    threshold: 1,
  }

  if (!includeModuleSetup) {
    return baseConfig
  }

  const helperAddress = MODULE_SETUP_HELPER_ADDRESS[chainId]
  if (!helperAddress || helperAddress === '0x...') {
    console.warn(`⚠️ ModuleSetupHelper not deployed on chain ${chainId}, falling back to separate tx`)
    return baseConfig
  }

  // Encode the enableModule call for the helper contract
  const helperInterface = new Interface(['function enableModule(address module)'])
  const enableModuleData = helperInterface.encodeFunctionData('enableModule', [
    SAFE_MODULE_ADDRESS,
  ])

  return {
    ...baseConfig,
    to: helperAddress,      
    data: enableModuleData, 
  }
}

/**
 * Enable module on an already-deployed Safe
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
  console.log(`Module enabled`)
  return true
}