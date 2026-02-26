import { createContext, useContext, useEffect, useState, useMemo } from "react";
import { JsonRpcProvider } from "ethers";
import { createPublicClient, http, webSocket, fallback } from "viem";
import { getHttpUrlsForChain, getChainById, getWsUrlForChain } from "./chain.js";

export type TransportStatus =
  | "ws"
  | "http-public"
  | "disconnected";

type RpcState = {
  ethers: JsonRpcProvider | null;
  viem: ReturnType<typeof createPublicClient> | null;
  transportStatus: TransportStatus;
};

const RpcCtx = createContext<RpcState | null>(null);

export function RpcProvider({ chainId, children }: { chainId: number; children: React.ReactNode }) {
  const [ethersProvider, setEthersProvider] = useState<JsonRpcProvider | null>(null);

  const httpUrls = useMemo(() => getHttpUrlsForChain(chainId), [chainId]);
  const wsUrl = useMemo(() => getWsUrlForChain(chainId), [chainId]);
  const chain = useMemo(() => getChainById(chainId), [chainId]);

  const [transportStatus, setTransportStatus] = useState<TransportStatus>(
    wsUrl ? "ws" : "http-public"
  );

  useEffect(() => {
    let mounted = true;

    (async () => {
      for (const url of httpUrls) {
        let p: JsonRpcProvider | undefined;
        try {
          p = new JsonRpcProvider(url, chainId, {
            staticNetwork: true,
          });
          await p.getBlockNumber();
          if (mounted) {
            setEthersProvider(p);
            if (!wsUrl) setTransportStatus("http-public");
          }
          return;
        } catch (e) {
          console.warn(`Ethers RPC failed for ${url}:`, e);
          p?.destroy();
        }
      }

      if (mounted) {
        console.error("All ethers RPC endpoints failed");
        setTransportStatus("disconnected");
      }
    })();
    return () => {
      mounted = false;
      setEthersProvider((prev) => { prev?.destroy(); return null; });
    };
  }, [chainId, httpUrls, wsUrl]);

  const viemClient = useMemo(() => {
    if (!chain) return null;

    if (wsUrl) {
      return createPublicClient({
        chain,
        transport: webSocket(wsUrl, {
          reconnect: { attempts: 5, delay: 2_000 },
        }),
      });
    }

    return createPublicClient({
      chain,
      transport: fallback(httpUrls.map((url) => http(url))),
    });
  }, [chainId, chain, httpUrls, wsUrl]);

  return (
    <RpcCtx.Provider
      value={{
        ethers: ethersProvider,
        viem: viemClient as any,
        transportStatus,
      }}
    >
      {children}
    </RpcCtx.Provider>
  );
}

export function useRpcClients() {
  const ctx = useContext(RpcCtx);
  if (!ctx) throw new Error("useRpcClients must be used inside RpcProvider");
  return ctx;
}
