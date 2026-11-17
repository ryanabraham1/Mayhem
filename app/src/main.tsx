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

