// packages/sdk/src/safeSessionSigner.ts
import {
  AbstractSigner,
  Contract,
  type Provider,
  type Signer,
  type TransactionRequest,
  type TransactionResponse,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

export interface SafeSessionSignerOptions {
  provider: Provider;
  safeAddress: string;
  /** Safe module enabled on the Safe */
  moduleAddress: string;
  /** only allowed target */
  logChainAddress: string;
  /** The EOA session signer (pays gas, calls the module). Must be connected to a provider. */
  sessionSigner: Signer;

  /** Default: execute(address,uint256,bytes,uint8) */
  moduleAbi?: readonly string[];
  /** Default: "execute" */
  executeMethod?: string;
}

const DEFAULT_ABI = [
  "function execute(address to, uint256 value, bytes data, uint8 operation)",
] as const;

/**
 * Ethers v6 Signer adapter:
 * - Exposes address = Safe
 * - Intercepts txs to LogChain and routes them through the Safe module
 *
 * sessionSigner is an EOA that directly sends the module tx.
 */
export class SafeSessionSigner extends AbstractSigner {
  private module: Contract;
  private executeMethod: string;

  private opts: SafeSessionSignerOptions;

  constructor(opts: SafeSessionSignerOptions) {
    super(opts.provider);
    this.opts = opts;

    if (!opts.sessionSigner.provider) {
      throw new Error(
        "SafeSessionSigner: sessionSigner must be connected to a Provider (e.g., new Wallet(pk, provider))."
      );
    }

    this.module = new Contract(
      opts.moduleAddress,
      (opts.moduleAbi ?? DEFAULT_ABI) as any,
      opts.sessionSigner
    );
    this.executeMethod = opts.executeMethod ?? "execute";
  }

  override async getAddress(): Promise<string> {
    return this.opts.safeAddress;
  }

  override async signMessage(message: string | Uint8Array): Promise<string> {
    return this.opts.sessionSigner.signMessage(message);
  }

  override async signTransaction(_tx: TransactionRequest): Promise<string> {
    throw new Error("SafeSessionSigner: signTransaction not supported; use sendTransaction().");
  }

  override async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, any>
  ): Promise<string> {
    // delegate
    const anySigner = this.opts.sessionSigner as any;
    if (typeof anySigner.signTypedData === "function") {
      return anySigner.signTypedData(domain, types, value);
    }
    throw new Error("SafeSessionSigner: underlying sessionSigner does not support signTypedData.");
  }

  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    if (!tx.to) throw new Error("SafeSessionSigner: tx.to is required");

    const to = String(tx.to).toLowerCase();
    const logChain = this.opts.logChainAddress.toLowerCase();

    if (to !== logChain) {
      throw new Error(`SafeSessionSigner: only LogChain txs are supported. Got to=${tx.to}`);
    }

    const data = tx.data ?? "0x";
    const fn: any = (this.module as any)[this.executeMethod];
    if (typeof fn !== "function") {
      throw new Error(
        `SafeSessionSigner: module execute method "${this.executeMethod}" not found on ${this.opts.moduleAddress}`
      );
    }

    // operation: 0 = CALL, value: 0
    return fn(this.opts.logChainAddress, 0n, data, 0);
  }

  override connect(provider: Provider): SafeSessionSigner {
    return new SafeSessionSigner({ ...this.opts, provider });
  }
}
