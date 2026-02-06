import { createContext, useContext, useEffect, useState, useMemo } from "react";
import { JsonRpcProvider } from "ethers";
import { createPublicClient, http, webSocket, fallback } from "viem";
import { baseSepolia } from "viem/chains";


const WS_URL = import.meta.env.VITE_RPC_WS_URL as string | undefined;
const ALCHEMY_HTTP_URL = WS_URL?.replace(/^wss:\/\//, "https://");

const PUBLIC_HTTP_1 = "https://sepolia.base.org";
const PUBLIC_HTTP_2 = "https://base-sepolia-rpc.publicnode.com";

/** Best available HTTP URL – Alchemy when configured, otherwise public. */
export const BASESEPOLIA_HTTP_URL = ALCHEMY_HTTP_URL ?? PUBLIC_HTTP_1;

export type TransportStatus =
  | "ws"
  | "http-alchemy"
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
      const urls = ALCHEMY_HTTP_URL
        ? [ALCHEMY_HTTP_URL, PUBLIC_HTTP_1, PUBLIC_HTTP_2]
        : [PUBLIC_HTTP_1, PUBLIC_HTTP_2];

      for (const url of urls) {
        try {
          const p = new JsonRpcProvider(url, undefined, {
            polling: true,
            pollingInterval: 3000,
          });
          await p.getBlockNumber();
          if (mounted) {
            setEthersProvider(p);
            if (!WS_URL) {
              setTransportStatus(
                url === ALCHEMY_HTTP_URL ? "http-alchemy" : "http-public"
              );
            }
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
    const transports = [];

    if (WS_URL) {
      transports.push(
        webSocket(WS_URL, {
          reconnect: { attempts: 5, delay: 2_000 },
        })
      );
    }
    if (ALCHEMY_HTTP_URL) {
      transports.push(http(ALCHEMY_HTTP_URL));
    }
    transports.push(http(PUBLIC_HTTP_1));
    transports.push(http(PUBLIC_HTTP_2));

    return createPublicClient({
      chain: baseSepolia,
      transport: fallback(transports),
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

export function useRpcStatus() {
  const ctx = useContext(RpcCtx);
  return {
    isConnected: ctx !== null && ctx.ethers !== null,
    transportStatus: ctx?.transportStatus ?? "disconnected",
    provider: ctx,
  };
}
