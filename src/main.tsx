const __startupT0 = Date.now();
(window as unknown as { __startupT0: number }).__startupT0 = __startupT0;
console.log(`[startup] main.tsx module-eval start wall=${__startupT0}`);

import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import App from "./App";
import { setupConsoleLogging } from "./consoleLogger";

console.log(`[startup] imports resolved +${Date.now() - __startupT0}ms`);

// Setup console logging to forward to Rust stdout
setupConsoleLogging();

console.log(`[startup] before createRoot.render +${Date.now() - __startupT0}ms`);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

console.log(`[startup] after createRoot.render call +${Date.now() - __startupT0}ms`);
