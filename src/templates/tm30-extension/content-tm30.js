const utils = globalThis.TM30ExtensionUtils;
let activeTaskId = null;
const LOGIN_STAGE_PREFIX = "tm30-login-stage:";
const DEFAULT_PROPERTY_NAME = "Phangan Arena";

function getLoginStageKey(taskId) {
  return `${LOGIN_STAGE_PREFIX}${taskId}`;
}

function readLoginStage(taskId) {
  try {
    return window.sessionStorage.getItem(getLoginStageKey(taskId)) || "";
  } catch {
    return "";
  }
}

function writeLoginStage(taskId, value) {
  try {
    window.sessionStorage.setItem(getLoginStageKey(taskId), value);
  } catch {
    // ignore sessionStorage failures
  }
}

function clearLoginStage(taskId) {
  try {
    window.sessionStorage.removeItem(getLoginStageKey(taskId));
  } catch {
    // ignore sessionStorage failures
  }
}

function getButtonByText(candidates, texts) {
  for (const selector of candidates) {
    const elements = Array.from(document.querySelectorAll(selector));
    const match = elements.find((element) =>
      texts.some((text) =>
        String(element.textContent || "").trim().toLowerCase().includes(text.toLowerCase())
      )
    );

    if (match) return match;
  }

  return null;
}

async function reportStatus(taskId, status, message) {
  await utils.runtimeSendMessage({
    type: "TM30_REPORT_STATUS",
    payload: { taskId, status, message }
  });
}

async function waitForImportScreen(task, timeoutMs = 20000) {
  const start = Date.now();
  let didReportWaiting = false;

  while (Date.now() - start < timeoutMs) {
    if (window.location.hash === "#/external/ifa/import") {
      return utils.queryFirst([
        "app-inform-accom-import",
        "[sit-element='btn-browse-file']",
        "[sit-element='input-name-file']"
      ]) || document.body;
    }

    if (window.location.hash === "#/external/ifa/search") {
      window.location.hash = "#/external/ifa/import";
      await utils.sleep(1500);
    }

    const importButton = utils.queryFirst([
      "button[sit-element='btn-import']",
      "[sit-element='btn-import']",
      "app-inform-accom-search button[sit-element='btn-import']",
      "app-inform-accom-search [sit-element='btn-import']"
    ]) || getButtonByText(
      ["app-inform-accom-search button", "button", ".mat-button", ".btn"],
      ["import excel", "นำเข้า excel", "import excel"]
    );

    if (importButton) {
      return importButton;
    }

    const searchPageMarker = utils.queryFirst([
      "app-inform-accom-search",
      "[sit-element='current-system']",
      "[sit-element='btn-search']"
    ]);

    if (searchPageMarker && !didReportWaiting) {
      await reportStatus(
        task.taskId,
        "OPENING_TM30",
        "TM30 search screen loaded. Waiting for the Import Excel button."
      ).catch(() => {});
      didReportWaiting = true;
    }

    await utils.sleep(300);
  }

  throw utils.createActionRequiredError("Import Excel button not found on the TM30 search screen.");
}

async function closeBlockingModal() {
  const modal = document.querySelector(".mat-dialog-container");
  if (!modal) return;

  const closeButton = utils.queryFirst(
    [
      ".mat-dialog-container button[aria-label='Close']",
      ".mat-dialog-container .close",
      ".mat-dialog-container button"
    ],
    modal
  );

  if (closeButton) {
    utils.clickElement(closeButton);
    await utils.sleep(500);
  }
}

async function confirmOverrideIfPresent(task) {
  const waitStart = Date.now();
  const waitTimeoutMs = 15000;
  let didReportWaiting = false;

  while (Date.now() - waitStart < waitTimeoutMs) {
    const overrideButton = document.querySelector(
      "#confirmOverride.show #btnConfimOverride, .modal.show #btnConfimOverride, #btnConfimOverride"
    );
    if (overrideButton) {
      if (!didReportWaiting) {
        await reportStatus(task.taskId, "LOGGING_IN", "Override confirmation detected. Confirming the active TM30 session.");
        didReportWaiting = true;
      }

      overrideButton.focus();
      overrideButton.click();
      overrideButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      writeLoginStage(task.taskId, "override-confirmed");
      await utils.sleep(2000);
      return true;
    }

    const cancelButton = document.querySelector(
      "#confirmOverride.show #cancelConfimOverride, .modal.show #cancelConfimOverride, #cancelConfimOverride"
    );
    if (cancelButton) {
      if (!didReportWaiting) {
        await reportStatus(task.taskId, "LOGGING_IN", "Waiting for TM30 override confirmation dialog.");
        didReportWaiting = true;
      }

      await utils.sleep(250);
      continue;
    }

    await utils.sleep(250);
  }

  return false;
}

async function closeLoginInformPopupIfPresent(task) {
  const waitStart = Date.now();
  const waitTimeoutMs = 10000;
  let didReport = false;

  while (Date.now() - waitStart < waitTimeoutMs) {
    const closeButton = getButtonByText(
      [
        ".dialogSystemInform .btn-dialog-close",
        ".dialogSystemInform button",
        ".popup .btn-dialog-close",
        ".popup button",
        ".mat-dialog-container button",
        "button"
      ],
      ["close", "ปิดหน้าจอ", "ปิด"]
    );

    if (closeButton) {
      if (!didReport && task?.taskId) {
        await reportStatus(
          task.taskId,
          "LOGGING_IN",
          "Closing post-login information dialog."
        ).catch(() => {});
        didReport = true;
      }

      closeButton.focus();
      closeButton.click();
      closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      await utils.sleep(1500);
      return true;
    }

    await utils.sleep(250);
  }

  return false;
}

async function ensureLoggedIn(task) {
  if (window.location.hash === "#/external/ifa/search") {
    clearLoginStage(task.taskId);
    return;
  }

  if (window.location.hash === "#/external/ifa/import") {
    clearLoginStage(task.taskId);
    return;
  }

  const importButton = utils.queryFirst([
    "button[sit-element='btn-import']",
    "[sit-element='btn-import']"
  ]);
  if (importButton) {
    clearLoginStage(task.taskId);
    return;
  }

  if (!task.credentials?.email || !task.credentials?.password) {
    throw utils.createActionRequiredError("TM30 credentials are missing. Please add them in TM30 Flow.");
  }

  await reportStatus(task.taskId, "LOGGING_IN", "Logging into the TM30 portal.");
  const loginInformClosed = await closeLoginInformPopupIfPresent(task);

  if (loginInformClosed) {
    await utils.sleep(1000);

    if (window.location.hash === "#/external/ifa/search" || window.location.hash === "#/external/ifa/import") {
      clearLoginStage(task.taskId);
      return;
    }

    const importButtonAfterClosingPopup = utils.queryFirst([
      "button[sit-element='btn-import']",
      "[sit-element='btn-import']"
    ]);

    if (importButtonAfterClosingPopup) {
      clearLoginStage(task.taskId);
      return;
    }
  }

  const emailSelectors = [
    "#user",
    "#email",
    "input[type='email']",
    "input[name='username']",
    "input[name='email']",
    "input[formcontrolname='email']",
    "input[autocomplete='username']",
    "input[placeholder*='email' i]",
    "input[id*='email' i]",
    "input[name*='user' i]",
    "input[placeholder*='user' i]",
    "input[type='text']"
  ];

  const passwordSelectors = [
    "#pass",
    "#password",
    "input[type='password']",
    "input[name='password']",
    "input[formcontrolname='password']",
    "input[autocomplete='current-password']",
    "input[placeholder*='password' i]",
    "input[id*='password' i]"
  ];

  const emailInput = await utils.waitForSelector(emailSelectors, {
    timeoutMs: 20000
  });
  const passwordInput = await utils.waitForSelector(passwordSelectors, {
    timeoutMs: 20000
  });

  utils.setInputValue(emailInput, task.credentials.email);
  utils.setInputValue(passwordInput, task.credentials.password);

  const submitButton = getButtonByText(
    [".btn-login", "button", "[type='submit']", ".mat-button", ".btn"],
    ["login", "sign in", "submit"]
  );

  if (!submitButton) {
    throw utils.createActionRequiredError("Login button not found in TM30. Update selectors in content-tm30.js.");
  }

  const hasTurnstile = Boolean(document.querySelector(".cf-turnstile, iframe[src*='challenges.cloudflare.com']"));

  const isLoginDisabled = () =>
    submitButton.hasAttribute("disabled") ||
    submitButton.getAttribute("aria-disabled") === "true" ||
    submitButton.disabled === true;

  if (hasTurnstile && isLoginDisabled()) {
    await reportStatus(
      task.taskId,
      "WAITING_CLOUDFLARE",
      "Waiting for the login button to be enabled after Cloudflare verification."
    );

    const waitStart = Date.now();
    const waitTimeoutMs = 20000;

    while (Date.now() - waitStart < waitTimeoutMs) {
      if (!isLoginDisabled()) {
        break;
      }

      await utils.sleep(500);
    }
  }

  if (isLoginDisabled()) {
    throw utils.createActionRequiredError(
      "Cloudflare / Turnstile still requires confirmation. Complete the challenge in the TM30 tab until the Login button becomes active."
    );
  }

  const loginStage = readLoginStage(task.taskId);

  if (loginStage === "login-submitted" || loginStage === "override-confirmed") {
    await reportStatus(task.taskId, "LOGGING_IN", "Login already submitted. Waiting for TM30 to continue.");

    const importWaitStart = Date.now();
    const importWaitTimeoutMs = 12000;

    while (Date.now() - importWaitStart < importWaitTimeoutMs) {
      const importButtonAfterSubmittedLogin = getButtonByText(
        ["button[sit-element='btn-import']", "[sit-element='btn-import']", "button", ".btn", ".mat-button"],
        ["import excel", "นำเข้า excel", "import"]
      );

      if (importButtonAfterSubmittedLogin) {
        clearLoginStage(task.taskId);
        return;
      }

      const overrideHandled = await confirmOverrideIfPresent(task);
      if (overrideHandled) {
        await utils.sleep(1500);
      }

      const loginInformClosed = await closeLoginInformPopupIfPresent(task);
      if (loginInformClosed) {
        await utils.sleep(1500);
      }

      await utils.sleep(500);
    }
  }

  writeLoginStage(task.taskId, "login-submitted");
  utils.clickElement(submitButton);
  await utils.sleep(3000);
  await confirmOverrideIfPresent(task);
  await closeLoginInformPopupIfPresent(task);

  await utils.sleep(1500);
  await waitForImportScreen(task, 25000);

  clearLoginStage(task.taskId);
}

async function openImportDialog() {
  const waitForImportView = () => utils.waitForSelector([
    "app-inform-accom-import",
    "[sit-element='btn-browse-file']",
    "[sit-element='input-name-file']"
  ], { timeoutMs: 4000 });

  const isImportViewOpen = () => Boolean(utils.queryFirst([
    "app-inform-accom-import",
    "[sit-element='btn-browse-file']",
    "[sit-element='input-name-file']"
  ]));

  if (isImportViewOpen()) {
    await utils.sleep(500);
    return;
  }

  const currentUrl = new URL(window.location.href);
  if (currentUrl.hash === "#/external/ifa/search") {
    currentUrl.hash = "#/external/ifa/import";
    window.location.href = currentUrl.toString();
    await utils.sleep(2000);

    try {
      await utils.waitForSelector([
        "app-inform-accom-import",
        "[sit-element='btn-browse-file']",
        "[sit-element='input-name-file']"
      ], { timeoutMs: 12000 });
      await utils.sleep(1000);
      return;
    } catch {
      // fallback to button interaction below if direct route change did not render the import view
    }
  }

  const importButton = await utils.waitForSelector([
    "button[sit-element='btn-import']",
    "[sit-element='btn-import']",
    "app-inform-accom-search button[sit-element='btn-import']",
    ".btn-import",
    "#btn-import",
    "[data-testid='btn-import']"
  ], { timeoutMs: 25000 });

  const importTargets = [
    importButton,
    importButton.querySelector?.(".mat-button-wrapper"),
    importButton.querySelector?.("mat-icon"),
    importButton.querySelector?.(".mat-button-focus-overlay"),
    importButton.closest?.("button"),
    importButton.parentElement
  ].filter(Boolean);

  let didOpenImportScreen = false;

  for (const target of importTargets) {
    await utils.sleep(350);
    utils.clickElement(target);
    utils.clickAtElementCenter(importButton);

    try {
      await waitForImportView();
      didOpenImportScreen = true;
      break;
    } catch {
      // try the next click target
    }
  }

  if (!didOpenImportScreen) {
    const currentHash = String(window.location.hash || "");
    const routeCandidates = Array.from(new Set([
      "#/external/ifa/import",
      currentHash.replace(/search/gi, "import"),
      currentHash.replace(/search/gi, "import-excel"),
      currentHash.replace(/inform-accom-search/gi, "inform-accom-import"),
      currentHash.replace(/inform-accom-search/gi, "inform-accom-import-excel"),
      "#/inform-accom-import",
      "#/inform-accom-import-excel",
      "#/import-excel",
      "#/import"
    ].filter((value) => value && value !== currentHash)));

    for (const nextHash of routeCandidates) {
      try {
        window.location.hash = nextHash;
        await utils.sleep(1500);
        await waitForImportView();
        didOpenImportScreen = true;
        break;
      } catch {
        // try next route candidate
      }
    }
  }

  if (!didOpenImportScreen) {
    throw utils.createActionRequiredError("Import Excel button was found, but TM30 did not open the import screen after clicking it.");
  }

  await utils.sleep(1000);
}

async function selectProperty(task) {
  const propertyName = String(task.credentials?.propertyName || DEFAULT_PROPERTY_NAME).trim();

  if (!propertyName) {
    throw utils.createActionRequiredError("Property selection requires a configured property name.");
  }

  const importPageMarker = utils.queryFirst([
    "app-inform-accom-import",
    "[sit-element='btn-browse-file']",
    "[sit-element='check-in-date']"
  ]);

  if (importPageMarker) {
    const addressRadio = Array.from(document.querySelectorAll("[sit-element='address-radio'], mat-radio-button"))
      .find((node) =>
        String(node.textContent || "").trim().toLowerCase().includes(propertyName.toLowerCase())
      );

    if (!addressRadio) {
      throw utils.createActionRequiredError(`Address "${propertyName}" was not found in TM30 Import Excel.`);
    }

    await reportStatus(task.taskId, "UPLOADING", `Selecting TM30 address: ${propertyName}.`).catch(() => {});

    const addressInput = addressRadio.querySelector("input[type='radio']");
    const addressLabel = addressRadio.querySelector("label");
    const checkedSetter = addressInput
      ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")?.set
      : null;
    const isSelected = () =>
      addressRadio.classList.contains("mat-radio-checked") ||
      Boolean(addressInput?.checked);

    const markSelected = () => {
      if (addressInput) {
        checkedSetter?.call(addressInput, true);
        addressInput.dispatchEvent(new Event("input", { bubbles: true }));
        addressInput.dispatchEvent(new Event("change", { bubbles: true }));
        addressInput.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        addressInput.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        addressInput.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    };

    const attemptSelection = () => {
      markSelected();

      if (addressInput) {
        addressInput.focus?.({ preventScroll: true });
        addressInput.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }

      if (addressLabel) {
        utils.clickElement(addressLabel);
        utils.clickAtElementCenter(addressLabel);
        addressLabel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }

      utils.clickElement(addressRadio);
      utils.clickAtElementCenter(addressRadio);
      addressRadio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    };

    addressRadio.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      attemptSelection();
      await utils.sleep(750);

      if (isSelected()) {
        break;
      }
    }

    if (!isSelected()) {
      throw utils.createActionRequiredError(`Address "${propertyName}" was found, but TM30 did not leave it selected.`);
    }

    addressRadio.classList.add("cdk-program-focused");
    await utils.sleep(1000);
    return;
  }

  const propertyTrigger = utils.queryFirst([
    "#property",
    "[formcontrolname='property']",
    ".property-select",
    "mat-select[name='property']"
  ]);

  if (!propertyTrigger) {
    return;
  }

  utils.clickElement(propertyTrigger);
  await utils.sleep(500);

  const option = Array.from(document.querySelectorAll("mat-option, option, .mat-option"))
    .find((node) => String(node.textContent || "").trim().toLowerCase().includes(propertyName.toLowerCase()));

  if (!option) {
    throw utils.createActionRequiredError(`Property "${propertyName}" was not found in TM30.`);
  }

  utils.clickElement(option);
  await utils.sleep(500);
}

async function uploadExcelFile(task) {
  await reportStatus(task.taskId, "UPLOADING", "Uploading Excel file into TM30 import form.").catch(() => {});

  const response = await utils.runtimeSendMessage({
    type: "DOWNLOAD_TM30_EXCEL",
    payload: {
      excelUrl: task.excelUrl,
      token: task.token,
      authToken: task.authToken
    }
  });

  const uploadRoot =
    utils.queryFirst([
      "app-inform-accom-import [sit-element-group='import-excel']",
      "app-sit-upload-v2[sit-element-group='import-excel']",
      "app-sit-upload-v2",
      "app-inform-accom-import"
    ]) || document;

  const fileInputCandidates = Array.from(uploadRoot.querySelectorAll(
    "input[type='file']"
  ));
  const fileInput =
    fileInputCandidates.find((input) => !input.disabled) ||
    fileInputCandidates[0] ||
    await utils.waitForSelector([
      "app-inform-accom-import input[type='file']",
      "input#fileImport",
      "input[type='file']"
    ], {
      timeoutMs: 15000
    });

  const browseButton = utils.queryFirst([
    "button[sit-element='btn-browse-file']",
    "[sit-element='btn-browse-file']"
  ], uploadRoot);

  const resolvedMimeType = response.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const resolvedFileName = String(response.fileName || "tm30-upload.xlsx").endsWith(".xlsx")
    ? String(response.fileName || "tm30-upload.xlsx")
    : `${String(response.fileName || "tm30-upload")}.xlsx`;
  const blob = new Blob([new Uint8Array(response.bytes)], { type: resolvedMimeType });
  const file = new File([blob], resolvedFileName, { type: resolvedMimeType, lastModified: Date.now() });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const filesSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files")?.set;
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  fileInput.removeAttribute?.("disabled");
  fileInput.removeAttribute?.("aria-disabled");
  fileInput.removeAttribute?.("readonly");
  fileInput.classList.remove?.("d-none");
  fileInput.style.display = "block";
  fileInput.style.visibility = "visible";
  fileInput.style.opacity = "1";
  fileInput.style.position = "fixed";
  fileInput.style.left = "8px";
  fileInput.style.top = "8px";
  fileInput.style.zIndex = "2147483647";
  fileInput.style.width = "1px";
  fileInput.style.height = "1px";

  if (browseButton) {
    utils.clickElement(browseButton);
    await utils.sleep(250);
  }

  fileInput.focus?.({ preventScroll: true });
  try {
    filesSetter?.call(fileInput, dataTransfer.files);
  } catch {
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: dataTransfer.files
    });
  }

  // Avoid synthetic click on file inputs: Chrome can reject it even after files are injected.
  fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  fileInput.dispatchEvent(new Event("blur", { bubbles: true }));
  fileInput.parentElement?.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

  const fileNameInput = utils.queryFirst([
    "input[sit-element='input-name-file']",
    "[sit-element='input-name-file']"
  ], uploadRoot);

  if (fileNameInput) {
    fileNameInput.value = resolvedFileName;
    fileNameInput.setAttribute("value", resolvedFileName);
    fileNameInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    fileNameInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    utils.dispatchInputEvents(fileNameInput);
  }

  const waitStart = Date.now();
  while (Date.now() - waitStart < 6000) {
    const inputHasFile = Boolean(fileInput.files?.length);
    const loadedFileName = String(fileInput.files?.[0]?.name || "").trim();
    const visibleName = String(fileNameInput?.value || "").trim();
    const previewButton = utils.queryFirst([
      "button[sit-element='btn-view-file']",
      "[sit-element='btn-view-file']",
      "app-inform-accom-import button[sit-element='btn-view-file']"
    ]);

    const visibleNameMatches = Boolean(fileNameInput && visibleName.includes(resolvedFileName));
    const nativeFileMatches = inputHasFile && loadedFileName === resolvedFileName;
    const visibleNameLooksReady = Boolean(
      fileNameInput &&
      visibleName &&
      /\.xls(x)?$/i.test(visibleName)
    );
    const previewReady = Boolean(previewButton && !previewButton.disabled);

    if (nativeFileMatches || visibleNameMatches || (visibleNameLooksReady && previewReady)) {
      await utils.sleep(500);
      return;
    }

    await utils.sleep(250);
  }

  throw utils.createActionRequiredError("TM30 did not acknowledge the uploaded Excel file.");
}

async function clickByTextOrFail(texts, message) {
  const button = getButtonByText(
    [
      "button[sit-element='btn-view-file']",
      "button[sit-element='btn-show-file']",
      "button[sit-element='btn-show-data']",
      "button[sit-element='btn-save']",
      "button[sit-element='btn-dialog-confirm']",
      "button",
      ".btn",
      ".mat-button"
    ],
    texts
  );
  if (!button) {
    throw utils.createActionRequiredError(message);
  }

  utils.clickElement(button);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await utils.sleep(1000);
}

async function openExcelPreview(task) {
  await reportStatus(task.taskId, "UPLOADING", "Opening TM30 Excel preview.").catch(() => {});

  const previewButton = await utils.waitForSelector([
    "button[sit-element='btn-view-file']",
    "[sit-element='btn-view-file']",
    "app-inform-accom-import button[sit-element='btn-view-file']"
  ], { timeoutMs: 10000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    utils.clickElement(previewButton);
    utils.clickAtElementCenter(previewButton);
    previewButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

    await utils.sleep(1500);

    const modalOrTable = utils.queryFirst([
      ".mat-dialog-container",
      ".cdk-overlay-pane .mat-dialog-container",
      "app-imform-accom-import-table table",
      "app-imform-accom-import-table .import-accom-table",
      "[sit-element='btn-save']:not(.mat-button-disabled)"
    ]);

    if (modalOrTable) {
      return;
    }
  }

  throw utils.createActionRequiredError("TM30 did not open the Excel preview after clicking Show data from Excel.");
}

async function waitForSuccessfulImportModal(task) {
  await reportStatus(task.taskId, "UPLOADING", "Waiting for TM30 import confirmation.").catch(() => {});

  const waitStart = Date.now();
  const waitTimeoutMs = 20000;

  while (Date.now() - waitStart < waitTimeoutMs) {
    const successDialog = utils.queryFirst([
      ".cdk-overlay-pane .mat-dialog-container",
      ".mat-dialog-container"
    ]);

    const dialogText = String(successDialog?.textContent || "").trim();
    const isSuccessDialog =
      successDialog &&
      (
        dialogText.includes("Successfully imported") ||
        dialogText.includes("นำเข้าสำเร็จ")
      );

    if (isSuccessDialog) {
      const okButton = getButtonByText(
        [
          ".cdk-overlay-pane .mat-dialog-container button",
          ".mat-dialog-container button",
          "button"
        ],
        ["ok", "ตกลง"]
      );

      if (okButton) {
        utils.clickElement(okButton);
        okButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }

      await utils.sleep(1000);
      return dialogText;
    }

    await utils.sleep(250);
  }

  throw utils.createActionRequiredError("TM30 did not show the successful import confirmation dialog.");
}

async function executeTask(task) {
  await utils.waitForCloudflareToClear((status, message) => reportStatus(task.taskId, status, message));
  await ensureLoggedIn(task);
  await closeBlockingModal();

  if (window.location.hash === "#/external/ifa/search") {
    await reportStatus(task.taskId, "UPLOADING", "TM30 search screen detected. Opening Import Excel directly.");
    window.location.hash = "#/external/ifa/import";
    await utils.sleep(2000);
  }

  await reportStatus(task.taskId, "UPLOADING", "Preparing the TM30 import flow.");
  await openImportDialog();
  await selectProperty(task);
  await uploadExcelFile(task);
  await openExcelPreview(task);
  await clickByTextOrFail(["save", "บันทึก"], "Save button not found in TM30.");
  await clickByTextOrFail(["confirm", "ยืนยัน"], "Confirm button not found in TM30.");
  const successMessage = await waitForSuccessfulImportModal(task);

  await reportStatus(task.taskId, "SUCCESS", successMessage || "TM30 import flow completed.");
  await utils.runtimeSendMessage({
    type: "TM30_CLOSE_TAB",
    payload: { taskId: task.taskId }
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TM30_EXECUTE_TASK") return;

  if (activeTaskId === message.payload.taskId) {
    sendResponse({ ok: true, skipped: true });
    return true;
  }

  activeTaskId = message.payload.taskId;
  void executeTask(message.payload)
    .then(() => {
      activeTaskId = null;
      sendResponse({ ok: true });
    })
    .catch(async (error) => {
      activeTaskId = null;
      const status = error?.isActionRequired ? "ACTION_REQUIRED" : "FAILED";
      const messageText = error?.message || "Unknown TM30 automation error";
      await reportStatus(message.payload.taskId, status, messageText);
      sendResponse({ ok: false, error: messageText });
    });

  return true;
});

void chrome.runtime.sendMessage({ type: "TM30_TAB_READY" }, () => {
  const runtimeError = chrome.runtime.lastError;
  if (runtimeError) {
    console.warn("TM30_TAB_READY failed:", runtimeError.message);
  }
});
