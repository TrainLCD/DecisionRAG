"use strict";
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      let applying = false;
      const banner = document.createElement("aside");
      banner.className = "pwa-update";
      banner.setAttribute("aria-label", "アプリの更新");
      banner.hidden = true;
      const text = document.createElement("span");
      text.textContent = "更新があります。更新すると入力内容・検索結果・利用キーは消去されます。";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "更新する";
      banner.append(text, button);
      document.body.append(banner);
      const showUpdate = () => { banner.hidden = !registration.waiting; };
      button.addEventListener("click", () => {
        if (!registration.waiting) return;
        applying = true;
        button.disabled = true;
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (applying) window.location.reload();
        else showUpdate();
      });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate();
        });
      });
      showUpdate();
      // Check when returning to the app and periodically during long sessions.
      const check = () => {
        if (document.visibilityState === "visible") registration.update().catch(console.warn);
      };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("online", check);
      window.setInterval(check, 60 * 60 * 1000);
    } catch (error) {
      console.warn("PWA registration failed", error);
    }
  });
}
