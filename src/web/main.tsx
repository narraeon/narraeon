import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { RuntimeClient } from "./runtimeClient.ts";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("The page is missing the application mount point");
}

const runtimeClient = new RuntimeClient();

createRoot(root).render(
  <StrictMode>
    <App client={runtimeClient} />
  </StrictMode>,
);
