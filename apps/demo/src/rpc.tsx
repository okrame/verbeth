import { createContext, useContext, useEffect, useState, useMemo } from "react";
import { JsonRpcProvider } from "ethers";
import { createPublicClient, http, webSocket, fallback } from "viem";
import { baseSepolia } from "viem/chains";


const WS_URL = import.meta.env.VITE_RPC_WS_URL as string | undefined;

const PUBLIC_HTTP_1 = "https://sepolia.base.org";
const PUBLIC_HTTP_2 = "https://base-sepolia-rpc.publicnode.com";

const PUBLIC_HTTP_URLS: readonly string[] = [PUBLIC_HTTP_1, PUBLIC_HTTP_2];

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

export function RpcProvider({ children }: { children: React.ReactNode }) {
  const [ethersProvider, setEthersProvider] = useState<JsonRpcProvider | null>(null);
  const [transportStatus, setTransportStatus] = useState<TransportStatus>(
    WS_URL ? "ws" : "http-public"
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      for (const url of PUBLIC_HTTP_URLS) {
        try {
          const p = new JsonRpcProvider(url, 84532, {
            staticNetwork: true,
          });
          await p.getBlockNumber();
          if (mounted) {
            setEthersProvider(p);
            if (!WS_URL) setTransportStatus("http-public");
          }
          return;
        } catch (e) {
          console.warn(`Ethers RPC failed for ${url}:`, e);
        }
      }
      if (mounted) {
        console.error("All ethers RPC endpoints failed");
        setTransportStatus("disconnected");
      }
    })();
    return () => { mounted = false; };
  }, []);

  const viemClient = useMemo(() => {
    if (WS_URL) {
      // WS-only: viem is used exclusively for block-tip subscriptions
      return createPublicClient({
        chain: baseSepolia,
        transport: webSocket(WS_URL, {
          reconnect: { attempts: 5, delay: 2_000 },
        }),
      });
    }

    // No WS: fall back to HTTP polling for watchBlockNumber
    return createPublicClient({
      chain: baseSepolia,
      transport: fallback([http(PUBLIC_HTTP_1), http(PUBLIC_HTTP_2)]),
    });
  }, []);

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
