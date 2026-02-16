import { createContext, useContext, useEffect, useState, useMemo } from "react";
import { JsonRpcProvider, WebSocketProvider } from "ethers";
import { createPublicClient, http, webSocket, fallback } from "viem";
import { APP_CHAIN, APP_CHAIN_ID, APP_WS_URL, getHttpUrlsForChain } from "./chain.js";

const HTTP_URLS = getHttpUrlsForChain(APP_CHAIN_ID);

/** Browser-safe read RPC URL for the active app chain. */
export const APP_HTTP_URL = HTTP_URLS[0];
export const APP_HTTP_URLS = HTTP_URLS;

function isAlchemyUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("alchemy.com");
  } catch {
    return false;
  }
}

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
  const [transportStatus, setTransportStatus] = useState<TransportStatus>("disconnected");

  useEffect(() => {
    let mounted = true;

    (async () => {
      // 1) Try WebSocket first
      if (APP_WS_URL) {
        try {
          const ws = new WebSocketProvider(APP_WS_URL, APP_CHAIN_ID);
          await ws.getBlockNumber();
          if (mounted) {
            setEthersProvider(ws as any);
            setTransportStatus("ws");
          } else {
            ws.destroy();
          }
          return;
        } catch (e) {
          console.warn(`Ethers WS failed for ${APP_WS_URL}:`, e);
        }
      }

      // 2) Try HTTP endpoints (Alchemy first if present, then public)
      for (const url of HTTP_URLS) {
        let p: JsonRpcProvider | undefined;
        try {
          p = new JsonRpcProvider(url, APP_CHAIN_ID, {
            staticNetwork: true,
            polling: true,
            pollingInterval: 4000,
          });
          await p.getBlockNumber();
          if (mounted) {
            setEthersProvider(p);
            setTransportStatus(isAlchemyUrl(url) ? "http-alchemy" : "http-public");
          } else {
            p.destroy();
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
  }, []);

  const viemClient = useMemo(() => {
    const transports = [];

    // WS transport first (if configured)
    if (APP_WS_URL) {
      transports.push(webSocket(APP_WS_URL));
    }

    // HTTP transports (Alchemy first if present, then public)
    for (const url of HTTP_URLS) {
      transports.push(http(url));
    }

    return createPublicClient({
      chain: APP_CHAIN,
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
