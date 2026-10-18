import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudioApp } from "./components/StudioApp.tsx";
import "./styles.css";
import "./am.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <StudioApp />
  </StrictMode>,
);
