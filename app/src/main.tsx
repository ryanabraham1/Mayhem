import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.DEV) {
  // handy for debugging from the devtools console
  import("./store").then(({ useStore }) => Object.assign(window, { __mayhem: useStore }));
}
