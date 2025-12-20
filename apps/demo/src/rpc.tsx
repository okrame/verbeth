import { createContext, useContext, useEffect, useState, useMemo } from "react";
import { JsonRpcProvider } from "ethers";
import { createPublicClient, http, fallback } from "viem";
import { base, baseSepolia } from "viem/chains";


type RpcState = {
  ethers: JsonRpcProvider | null;
  viem: ReturnType<typeof createPublicClient> | null;  
};


const RpcCtx = createContext<RpcState | null>(null);

export function RpcProvider({ children }: { children: React.ReactNode }) {
  const [ethersProvider, setEthersProvider] = useState<JsonRpcProvider | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = new JsonRpcProvider("https://sepolia.base.org", undefined, { 
          polling: true,
          pollingInterval: 3000,
        });
        await p.getBlockNumber(); 
        if (mounted) setEthersProvider(p);
      } catch (e) {
        console.error("Ethers RPC failed:", e);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const viemClient = useMemo(
    () =>
      createPublicClient({
        chain: baseSepolia,  
        transport: fallback([
          http("https://sepolia.base.org"),             
          http("https://base-sepolia-rpc.publicnode.com"), 
        ]),
      }),
    []
  );

  return (
    <RpcCtx.Provider value={{ ethers: ethersProvider, viem: viemClient as any }}>
      {children}
    </RpcCtx.Provider>
  );
}

export function useRpcClients() {
  const ctx = useContext(RpcCtx);
  if (!ctx) throw new Error("useRpcClients must be used inside RpcProvider");
  return ctx;
}

export function useRpcStatus() {
  const provider = useContext(RpcCtx);
  return {
    isConnected: provider !== null,
    provider
  };
}