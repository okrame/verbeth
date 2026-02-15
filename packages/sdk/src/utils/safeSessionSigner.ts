// packages/sdk/src/utils/safeSessionSigner.ts
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
  moduleAddress: string;
  verbEthAddress: string;
  sessionSigner: Signer;
}

const MODULE_ABI = [
  "function execute(address safe, address to, uint256 value, bytes data, uint8 operation) returns (bool)",
  "function isValidSession(address safe, address signer) view returns (bool)",
  "function sessionExpiry(address safe, address signer) view returns (uint256)",
  "function isAllowedTarget(address safe, address target) view returns (bool)",
] as const;

export class SafeSessionSigner extends AbstractSigner {
  private module: Contract;
  private opts: SafeSessionSignerOptions;

  constructor(opts: SafeSessionSignerOptions) {
    super(opts.provider);
    this.opts = opts;

    if (!opts.sessionSigner.provider) {
      throw new Error(
        "SafeSessionSigner: sessionSigner must be connected to a Provider."
      );
    }

    this.module = new Contract(
      opts.moduleAddress,
      MODULE_ABI as any,
      opts.sessionSigner
    );
  }

  override async getAddress(): Promise<string> {
    return this.opts.safeAddress;
  }

  async getSessionSignerAddress(): Promise<string> {
    return this.opts.sessionSigner.getAddress();
  }

  async isSessionValid(): Promise<boolean> {
    const signerAddr = await this.opts.sessionSigner.getAddress();
    return this.module.isValidSession(this.opts.safeAddress, signerAddr);
  }

  async isTargetAllowed(): Promise<boolean> {
    return this.module.isAllowedTarget(this.opts.safeAddress, this.opts.verbEthAddress);
  }

  override async signMessage(message: string | Uint8Array): Promise<string> {
    return this.opts.sessionSigner.signMessage(message);
  }

  override async signTransaction(_tx: TransactionRequest): Promise<string> {
    throw new Error("SafeSessionSigner: use sendTransaction() instead.");
  }

  override async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, any>
  ): Promise<string> {
    const anySigner = this.opts.sessionSigner as any;
    if (typeof anySigner.signTypedData === "function") {
      return anySigner.signTypedData(domain, types, value);
    }
    throw new Error("SafeSessionSigner: signTypedData not supported.");
  }

  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    if (!tx.to) throw new Error("SafeSessionSigner: tx.to required");

    const to = String(tx.to).toLowerCase();
    const verbEth = this.opts.verbEthAddress.toLowerCase();

    if (to !== verbEth) {
      throw new Error(`SafeSessionSigner: only verbEth txs allowed. Got ${tx.to}`);
    }

    const data = tx.data ?? "0x";
    
    // execute(safe, to, value, data, operation)
    return this.module.execute(
      this.opts.safeAddress,
      this.opts.verbEthAddress,
      0n,
      data,
      0 
    );
  }

  override connect(provider: Provider): SafeSessionSigner {
    return new SafeSessionSigner({ ...this.opts, provider });
  }
}