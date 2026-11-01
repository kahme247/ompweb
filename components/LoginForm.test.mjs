import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "./LoginForm";

const indexHtml = () => readFile(new URL("../app/index.html", import.meta.url), "utf8");

test("app/index.html carries LoginForm's first render as its static sign-in form", async () => {
  // The first render is English: useI18n switches to the stored or browser language in an effect.
  const html = (await indexHtml()).replace(/>\s+</g, "><");
  assert.ok(html.includes(`<template id="login-shell">${renderToStaticMarkup(createElement(LoginForm))}</template>`), "the static sign-in form differs from LoginForm");
});

test("/login shows the static sign-in form before any bundle runs, and Enter does not reload the page", async () => {
  // Inline scripts only: JSDOM loads neither the stylesheet nor the module script.
  const login = new JSDOM(await indexHtml(), { url: "http://localhost/login?next=%2F%3Fsession%3Dx", runScripts: "dangerously" }).window;
  const { document } = login;
  assert.equal(document.querySelector("#root h1")?.textContent, "Welcome back");
  assert.ok(document.querySelector("#root #web-password"), "no password field");
  assert.equal(document.querySelector("#root .route-fallback"), null);
  const submit = new login.Event("submit", { cancelable: true });
  document.querySelector("#root form").dispatchEvent(submit);
  assert.ok(submit.defaultPrevented, "a submit before the bundle runs would navigate");
  login.close();

  const app = new JSDOM(await indexHtml(), { url: "http://localhost/", runScripts: "dangerously" }).window;
  assert.equal(app.document.querySelector("#root #web-password"), null, "the sign-in form shows outside /login");
  app.close();
});

test("a password typed before the bundle ran is kept", () => {
  assert.match(renderToStaticMarkup(createElement(LoginForm, { initialPassword: "typed" })), /value="typed"/);
});
