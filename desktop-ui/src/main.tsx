import React from "react";
import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
