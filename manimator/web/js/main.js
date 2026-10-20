import { html, render } from "./lib.js";
import { App } from "./app.js";
import { boot } from "./store.js";
import { finishEmailLink, showFlash } from "./account.js";
import { openLinkedProject } from "./home.js";
import { centerButtons } from "./ui.js";

const root = document.getElementById("app");

boot()
  .then(() => {
    centerButtons();
    render(html`<${App} />`, root);
    showFlash();
    finishEmailLink();
    openLinkedProject();
  })
  .catch((err) => {
    root.innerHTML = "";
    const box = document.createElement("div");
    box.className = "boot";
    box.textContent = `Manimator couldn't start: ${err.message}`;
    root.appendChild(box);
  });
