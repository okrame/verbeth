import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.js";
import { Providers } from "./providers.js";
import { Buffer } from "buffer";

if (!(window as any).Buffer) (window as any).Buffer = Buffer;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <Providers>
    <App />
  </Providers>
);