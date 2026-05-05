importScripts("utils.js");

const TM30_PORTAL_URL = "https://tm30.immigration.go.th/tm30/#/login";
const TASK_KEY_PREFIX = "tm30-task:";

function getTaskStorageKey(taskId) {
  return `${TASK_KEY_PREFIX}${taskId}`;
}

async function saveTask(task) {
  await chrome.storage.local.set({
    [getTaskStorageKey(task.taskId)]: task
  });
}

async function getTask(taskId) {
  const result = await chrome.storage.local.get(getTaskStorageKey(taskId));
  return result[getTaskStorageKey(taskId)] || null;
}

async function updateTask(taskId, patch) {
  const task = await getTask(taskId);
  if (!task) return null;

  const nextTask = {
    ...task,
    ...patch
  };

  await saveTask(nextTask);
  return nextTask;
}

async function notifyApp(task, status, message = "") {
  if (!task?.appTabId) return;

  try {
    await chrome.tabs.sendMessage(task.appTabId, {
      type: "TM30_STATUS_UPDATE",
      payload: {
        taskId: task.taskId,
        status,
        message
      }
    });
  } catch (error) {
    console.warn("Unable to notify app tab:", error);
  }
}

async function postTaskStatus(task, status, message = "") {
  const nextTask = await updateTask(task.taskId, {
    status,
    message
  });

  try {
    await fetch(`${task.backendBaseUrl}/api/tm30/tasks/${task.taskId}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tm30-task-token": task.token
      },
      body: JSON.stringify({ status, message })
    });
  } catch (error) {
    console.warn("Failed to post TM30 task status:", error);
  }

  await notifyApp(nextTask || task, status, message);
}

async function openTm30Tab(task) {
  let popupBounds = {
    width: 390,
    height: 844,
    left: 80,
    top: 80
  };

  if (task.appTabId) {
    try {
      const appTab = await chrome.tabs.get(task.appTabId);
      if (appTab.windowId !== chrome.windows.WINDOW_ID_NONE) {
        const appWindow = await chrome.windows.get(appTab.windowId);
        const baseLeft = typeof appWindow.left === "number" ? appWindow.left : 0;
        const baseTop = typeof appWindow.top === "number" ? appWindow.top : 0;
        const baseWidth = typeof appWindow.width === "number" ? appWindow.width : 1440;
        const baseHeight = typeof appWindow.height === "number" ? appWindow.height : 900;

        popupBounds = {
          width: Math.min(390, Math.max(360, baseWidth - 160)),
          height: Math.min(844, Math.max(700, baseHeight - 120)),
          left: baseLeft + Math.max(24, baseWidth - 414),
          top: baseTop + 48
        };
      }
    } catch (error) {
      console.warn("Could not derive popup bounds from app window:", error);
    }
  }

  const createdWindow = await chrome.windows.create({
    url: task.portalUrl || TM30_PORTAL_URL,
    type: "popup",
    focused: true,
    state: "normal",
    width: popupBounds.width,
    height: popupBounds.height,
    left: popupBounds.left,
    top: popupBounds.top
  });

  const createdTab = createdWindow.tabs?.[0];
  if (!createdTab?.id) {
    throw new Error("TM30 popup window could not be created");
  }

  if (createdWindow.id) {
    try {
      await chrome.windows.update(createdWindow.id, {
        focused: true,
        state: "normal",
        width: popupBounds.width,
        height: popupBounds.height,
        left: popupBounds.left,
        top: popupBounds.top
      });
    } catch (error) {
      console.warn("Could not force TM30 popup bounds after creation:", error);
    }
  }

  const nextTask = await updateTask(task.taskId, {
    tm30TabId: createdTab.id
  });

  await postTaskStatus(nextTask || task, "OPENING_TM30", "Opening the TM30 portal in a compact popup window.");
}

async function dispatchTaskToTm30Tab(tabId) {
  const storage = await chrome.storage.local.get(null);
  const task = Object.values(storage).find(
    (value) => value && value.tm30TabId === tabId && value.taskId
  );

  if (!task) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TM30_EXECUTE_TASK",
      payload: task
    });
  } catch (error) {
    console.warn("TM30 content script not ready yet:", error);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!String(tab.url || "").startsWith("https://tm30.immigration.go.th")) return;
  void dispatchTaskToTm30Tab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({
      ok: true,
      status: "EXTENSION_CONNECTED",
      version: "0.1.0"
    });
    return;
  }

  if (message?.type === "START_TM30_UPLOAD") {
    const appTabId = sender.tab?.id;
    const task = {
      ...message.payload,
      appTabId,
      portalUrl: message.payload.portalUrl || TM30_PORTAL_URL,
      status: "STARTING",
      message: "Extension accepted the TM30 task."
    };

    void (async () => {
      await saveTask(task);
      await postTaskStatus(task, "STARTING", "Task accepted by the extension.");
      await openTm30Tab(task);
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "DOWNLOAD_TM30_EXCEL") {
    void (async () => {
      const downloadUrl = new URL(message.payload.excelUrl);
      const queryToken = downloadUrl.searchParams.get("token");
      const candidateRequests = [
        {
          url: downloadUrl.toString(),
          headers: message.payload.authToken
            ? { Authorization: `Bearer ${message.payload.authToken}` }
            : {}
        },
        {
          url: downloadUrl.toString(),
          headers: {
            ...(message.payload.authToken ? { Authorization: `Bearer ${message.payload.authToken}` } : {}),
            "x-tm30-task-token": message.payload.token
          }
        },
        queryToken
          ? {
              url: downloadUrl.toString(),
              headers: {
                ...(message.payload.authToken ? { Authorization: `Bearer ${message.payload.authToken}` } : {}),
                "x-tm30-task-token": queryToken
              }
            }
          : null,
        queryToken
          ? {
              url: (() => {
                const nextUrl = new URL(downloadUrl.toString());
                nextUrl.searchParams.set("token", decodeURIComponent(queryToken));
                return nextUrl.toString();
              })(),
              headers: message.payload.authToken
                ? { Authorization: `Bearer ${message.payload.authToken}` }
                : {}
            }
          : null
      ].filter(Boolean);

      let response = null;
      let lastErrorMessage = "";

      for (const request of candidateRequests) {
        response = await fetch(request.url, {
          headers: request.headers || {}
        });

        if (response.ok) {
          break;
        }

        try {
          const errorText = await response.text();
          lastErrorMessage = errorText || `Excel download failed with ${response.status}`;
        } catch {
          lastErrorMessage = `Excel download failed with ${response.status}`;
        }
      }

      if (!response || !response.ok) {
        throw new Error(lastErrorMessage || `Excel download failed with ${response?.status || 0}`);
      }

      const blob = await response.blob();
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const disposition = response.headers.get("content-disposition") || "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);

      sendResponse({
        ok: true,
        fileName: fileNameMatch?.[1] || "tm30-upload.xlsx",
        mimeType: blob.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes
      });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "TM30_TAB_READY") {
    const tabId = sender.tab?.id;

    void (async () => {
      if (!tabId) {
        throw new Error("TM30 tab id is missing");
      }

      await dispatchTaskToTm30Tab(tabId);
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "TM30_REPORT_STATUS") {
    void (async () => {
      const task = await getTask(message.payload.taskId);
      if (!task) {
        throw new Error("TM30 task not found in extension storage");
      }

      await postTaskStatus(task, message.payload.status, message.payload.message || "");
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "TM30_CLOSE_TAB") {
    void (async () => {
      const task = await getTask(message.payload.taskId);
      if (!task) {
        throw new Error("TM30 task not found in extension storage");
      }

      const tm30TabId = sender.tab?.id || task.tm30TabId;
      if (task.appTabId) {
        try {
          await chrome.tabs.update(task.appTabId, { active: true });
          const appTab = await chrome.tabs.get(task.appTabId);
          if (appTab.windowId !== chrome.windows.WINDOW_ID_NONE) {
            await chrome.windows.update(appTab.windowId, { focused: true });
          }
        } catch (error) {
          console.warn("Could not focus app tab after TM30 completion:", error);
        }
      }

      if (tm30TabId) {
        try {
          await chrome.tabs.remove(tm30TabId);
        } catch (error) {
          console.warn("Could not close TM30 tab after completion:", error);
        }
      }

      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }
});
