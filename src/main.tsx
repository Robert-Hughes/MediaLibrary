import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import App from "./App";
import { setupConsoleLogging } from "./consoleLogger";

// Setup console logging to forward to Rust stdout — must happen before any
// log we want to see in the Rust stdout pipe.
setupConsoleLogging();

const __startupT0 = Date.now();
const __w = window as unknown as {
  __startupT0: number;
  __htmlHeadT?: number;
  __bodyParsedT?: number;
  __splashPaintedT?: number;
};
__w.__startupT0 = __startupT0;
console.log(
  `[startup] main.tsx module-eval start wall=${__startupT0} htmlHead=${__w.__htmlHeadT ?? "?"} bodyParsed=${__w.__bodyParsedT ?? "?"} splashPainted=${__w.__splashPaintedT ?? "?"}`,
);
console.log(`[startup] imports resolved +${Date.now() - __startupT0}ms`);
console.log(
  `[startup] before createRoot.render +${Date.now() - __startupT0}ms`,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

console.log(
  `[startup] after createRoot.render call +${Date.now() - __startupT0}ms`,
);
