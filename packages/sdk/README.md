# @verbeth/sdk

End-to-end encrypted messaging over public EVM blockchains.

### Install
```bash
npm install @verbeth/sdk
```

### Quickstart
```ts
import {
  createVerbethClient,
  deriveIdentityKeyPairWithProof,
  ExecutorFactory,
  getVerbethAddress
} from '@verbeth/sdk';
import { ethers } from 'ethers';

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const address = await signer.getAddress();

const { identityKeyPair, identityProof } = await deriveIdentityKeyPairWithProof(signer, address);

const contract = new ethers.Contract(getVerbethAddress(), VerbethABI, signer);
const client = createVerbethClient({
  address,
  signer,
  identityKeyPair,
  identityProof,
  executor: ExecutorFactory.createEOA(contract),
});

await client.sendMessage(conversationId, 'Hello, encrypted world!');
```

## Documentation

For detailed protocol documentation, see [docs.verbeth.xyz](https://docs.verbeth.xyz).

## License

MPL-2.0

## Links

- [GitHub Repository](https://github.com/okrame/verbeth-sdk)
- [Demo App](https://verbeth-demo.vercel.app/)
- [Contract Source](https://github.com/okrame/verbeth-sdk/tree/main/packages/contracts)

---

**Questions or feedback?** Open an issue on [GitHub](https://github.com/okrame/verbeth-sdk/issues).