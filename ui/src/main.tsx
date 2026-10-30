import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/global.css";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Porthole: #root container is missing in index.html");
}

// Remove the pre-hydration fallback so it can never flash under the desktop.
container.innerHTML = "";

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
