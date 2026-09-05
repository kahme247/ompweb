import React from "react";
import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";
import { SettingsWindow } from "./SettingsWindow";

const boot = new URLSearchParams(window.location.search).get("boot");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {boot === "settings" ? <SettingsWindow /> : <DesktopApp />}
  </React.StrictMode>,
);
