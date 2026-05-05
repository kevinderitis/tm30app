(function () {
  const DEFAULT_TIMEOUT_MS = 30000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function textIncludes(target, values) {
    const haystack = String(target || "").toLowerCase();
    return values.some((value) => haystack.includes(String(value).toLowerCase()));
  }

  function queryFirst(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  async function waitForSelector(selectors, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const root = options.root || document;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const node = queryFirst(selectors, root);
      if (node) return node;
      await sleep(250);
    }

    throw new Error(`Selector not found: ${selectors.join(", ")}`);
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setInputValue(element, value) {
    element.focus();
    element.value = value;
    dispatchInputEvents(element);
  }

  function isVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function dispatchMouseSequence(element) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.max(1, Math.min(rect.width / 2, rect.width - 1));
    const clientY = rect.top + Math.max(1, Math.min(rect.height / 2, rect.height - 1));
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY };

    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 }));
    }

    element.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }));

    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0 }));
    }

    element.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...base, button: 0, buttons: 0 }));
  }

  function clickAtElementCenter(element) {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + (rect.width / 2);
    const clientY = rect.top + (rect.height / 2);
    const targetAtPoint = document.elementFromPoint(clientX, clientY);

    if (!targetAtPoint) return false;

    const clickableTarget =
      targetAtPoint.closest?.("button, [role='button'], .mat-button-base, .mat-radio-button, label") ||
      targetAtPoint;

    clickableTarget.focus?.({ preventScroll: true });

    try {
      dispatchMouseSequence(clickableTarget);
    } catch {
      // ignore event synthesis failures and continue with native click fallback
    }

    try {
      clickableTarget.click?.();
    } catch {
      // ignore click fallback failures
    }

    return true;
  }

  function clickElement(element) {
    if (!element) return false;

    const target =
      element.closest?.("button, [role='button'], .mat-button-base, .mat-radio-button, label") || element;

    target.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
    target.focus?.({ preventScroll: true });

    try {
      dispatchMouseSequence(target);
    } catch {
      // ignore event synthesis failures and continue with native click fallback
    }

    try {
      target.click?.();
    } catch {
      // ignore click fallback failures
    }

    return isVisible(target);
  }

  function createActionRequiredError(message) {
    const error = new Error(message);
    error.isActionRequired = true;
    return error;
  }

  async function waitForCloudflareToClear(reportStatus) {
    const challengeHints = [
      "just a moment",
      "checking your browser",
      "cloudflare"
    ];

    const timeoutMs = 60000;
    const start = Date.now();
    let didReport = false;

    while (Date.now() - start < timeoutMs) {
      const bodyText = document.body?.innerText || "";
      const titleText = document.title || "";
      const hasChallenge = textIncludes(bodyText, challengeHints) || textIncludes(titleText, challengeHints);

      if (!hasChallenge) {
        return;
      }

      if (!didReport && typeof reportStatus === "function") {
        reportStatus("WAITING_CLOUDFLARE", "Waiting for Cloudflare to finish.");
        didReport = true;
      }

      await sleep(1000);
    }

    throw createActionRequiredError("Cloudflare challenge did not clear automatically.");
  }

  async function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          if (response?.ok === false) {
            reject(new Error(response.error || "Extension request failed"));
            return;
          }

          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  globalThis.TM30ExtensionUtils = {
    DEFAULT_TIMEOUT_MS,
    sleep,
    queryFirst,
    waitForSelector,
    dispatchInputEvents,
    setInputValue,
    isVisible,
    clickAtElementCenter,
    clickElement,
    createActionRequiredError,
    waitForCloudflareToClear,
    runtimeSendMessage,
    textIncludes
  };
})();
