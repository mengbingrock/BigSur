import React from "react";
import ReactDOM from "react-dom/client";
import {
  RouterProvider,
  createBrowserHistory,
  createHashHistory,
} from "@tanstack/react-router";
import "@xyflow/react/dist/style.css";
import "./index.css";
import { isElectron } from "./env";
import { getRouter } from "./router";

// Electron loads from a file shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();
const router = getRouter(history);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
