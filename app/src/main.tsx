import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./suite/SuiteApp";
import { SuiteErrorBoundary } from "./suite/SuiteErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SuiteErrorBoundary>
      <App />
    </SuiteErrorBoundary>
  </StrictMode>,
);

if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has("legacyDebug")
) {
  // handy for debugging from the devtools console
  import("./store").then(({ useStore }) =>
    Object.assign(window, { __mayhem: useStore }),
  );
}
