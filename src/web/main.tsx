import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { AppErrorBoundary } from "./AppErrorBoundary.tsx";
import { RuntimeClient } from "./runtimeClient.ts";
import "./styles.css";
import "./workspace-layout.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("The page is missing the application mount point");
}

const runtimeClient = new RuntimeClient();

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App client={runtimeClient} />
    </AppErrorBoundary>
  </StrictMode>,
);
