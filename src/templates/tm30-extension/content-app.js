window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  const message = event.data;
  if (!message || message.source !== "tm30-web-app" || message.type !== "TM30_EXTENSION_REQUEST") {
    return;
  }

  chrome.runtime.sendMessage(message.payload, (response) => {
    const runtimeError = chrome.runtime.lastError;

    window.postMessage(
      {
        source: "tm30-extension",
        type: "TM30_EXTENSION_RESPONSE",
        requestId: message.requestId,
        payload: runtimeError
          ? { ok: false, error: runtimeError.message }
          : response || { ok: false, error: "No response from extension" }
      },
      "*"
    );
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "TM30_STATUS_UPDATE") return;

  window.postMessage(
    {
      source: "tm30-extension",
      type: "TM30_STATUS_UPDATE",
      payload: message.payload
    },
    "*"
  );
});
