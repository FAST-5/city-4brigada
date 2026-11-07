/* Военный Конспект — автономный режим. No external libraries required. */
(() => {
  "use strict";

  const DB_NAME = "voenny-konspekt-offline";
  const DB_VERSION = 1;
  const STORE_MATERIALS = "materials";
  const STORE_DRAFTS = "drafts";
  const STORE_DOCS = "documents";
  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  let dbPromise;
  let deferredInstallPrompt = null;
  const byId = id => document.getElementById(id);
  const safeText = value => String(value ?? "");
  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("Этот браузер не поддерживает локальное хранилище IndexedDB."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_MATERIALS)) database.createObjectStore(STORE_MATERIALS, { keyPath: "id" });
        if (!database.objectStoreNames.contains(STORE_DRAFTS)) database.createObjectStore(STORE_DRAFTS, { keyPath: "id" });
        if (!database.objectStoreNames.contains(STORE_DOCS)) database.createObjectStore(STORE_DOCS, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Не удалось открыть локальное хранилище."));
      request.onblocked = () => reject(new Error("Закройте другие вкладки этого сайта и повторите попытку."));
    });
    return dbPromise;
  }

  async function dbRequest(storeName, mode, action) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      try { request = action(store); }
      catch (error) { reject(error); return; }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Ошибка локального хранилища."));
      tx.onabort = () => reject(tx.error || new Error("Операция с локальными данными отменена."));
    });
  }
  const getAll = store => dbRequest(store, "readonly", s => s.getAll());
  const put = (store, value) => dbRequest(store, "readwrite", s => s.put(value));
  const remove = (store, id) => dbRequest(store, "readwrite", s => s.delete(id));

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  function formatDate(value) {
    try { return new Date(value).toLocaleString("ru-RU"); }
    catch { return ""; }
  }
  function emptyLine(text) {
    const div = document.createElement("div");
    div.className = "offline-empty";
    div.textContent = text;
    return div;
  }
  function makeAction(label, kind, id) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === "delete" ? "btn danger small" : "btn secondary small";
    button.textContent = label;
    button.dataset.action = kind;
    button.dataset.id = id;
    return button;
  }
  function makeEntry(title, detail, actions) {
    const row = document.createElement("div");
    row.className = "offline-file";
    const info = document.createElement("div");
    info.className = "offline-file-info";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = detail;
    info.append(strong, span);
    const actionBox = document.createElement("div");
    actionBox.className = "offline-actions";
    actions.forEach(action => actionBox.appendChild(action));
    row.append(info, actionBox);
    return row;
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "document";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function currentPayload() {
    const value = id => byId(id)?.value?.trim() || "";
    return {
      discipline: value("discipline"),
      lesson_type: value("lessonType"),
      topic_number: value("topicNum"),
      lesson_number: value("lessonNum"),
      topic: value("topic"),
      lesson_title: value("lessonTitle"),
      audience: value("audience"),
      duration: value("duration"),
      location: value("place"),
      manuals: value("manuals"),
      materials: value("materials"),
      rank: value("rank"),
      full_name: value("fullName"),
      goals: "",
      approval_position: "Командир артиллерийского дивизиона"
    };
  }

  async function refreshStats() {
    const [materials, drafts, docs] = await Promise.all([
      getAll(STORE_MATERIALS), getAll(STORE_DRAFTS), getAll(STORE_DOCS)
    ]);
    byId("offlineMaterialCount").textContent = materials.length;
    byId("offlineDraftCount").textContent = drafts.length;
    byId("offlineDocCount").textContent = docs.length;
    byId("offlineModeLabel").textContent = "Готов";
    byId("offlineModeNote").textContent = "Локальные функции";
  }

  async function renderMaterials() {
    const box = byId("offlineMaterialsList");
    const query = byId("offlineSearch").value.trim().toLocaleLowerCase("ru");
    const items = (await getAll(STORE_MATERIALS)).sort((a, b) => b.savedAt - a.savedAt);
    box.replaceChildren();
    const filtered = items.filter(item => {
      const haystack = `${item.name} ${item.category} ${item.textContent || ""}`.toLocaleLowerCase("ru");
      return !query || haystack.includes(query);
    });
    if (!filtered.length) {
      box.appendChild(emptyLine(items.length ? "По этому запросу ничего не найдено." : "Пока нет материалов. Выберите файлы выше."));
      return;
    }
    for (const item of filtered) {
      const actions = [
        makeAction(item.extension === ".pdf" ? "Открыть" : "Скачать", "open-material", item.id),
        makeAction("Удалить", "delete-material", item.id)
      ];
      box.appendChild(makeEntry(
        item.name,
        `${item.category} · ${item.extension.toUpperCase().replace(".", "")} · ${formatBytes(item.size)} · ${formatDate(item.savedAt)}`,
        actions
      ));
    }
  }

  async function renderDocs() {
    const box = byId("offlineDocumentsList");
    const items = (await getAll(STORE_DOCS)).sort((a, b) => b.createdAt - a.createdAt);
    box.replaceChildren();
    if (!items.length) { box.appendChild(emptyLine("Документов пока нет.")); return; }
    for (const item of items) {
      box.appendChild(makeEntry(
        item.name,
        `${formatDate(item.createdAt)} · ${formatBytes(item.blob.size)}`,
        [makeAction("Скачать", "download-doc", item.id), makeAction("Удалить", "delete-doc", item.id)]
      ));
    }
  }

  async function renderDrafts() {
    const box = byId("offlineDraftsList");
    const items = (await getAll(STORE_DRAFTS)).sort((a, b) => b.updatedAt - a.updatedAt);
    box.replaceChildren();
    if (!items.length) { box.appendChild(emptyLine("Черновиков пока нет.")); return; }
    for (const item of items) {
      box.appendChild(makeEntry(
        item.title || "Черновик занятия",
        `${item.payload.discipline || "Дисциплина не указана"} · ${formatDate(item.updatedAt)}`,
        [makeAction("Открыть", "restore-draft", item.id), makeAction("Удалить", "delete-draft", item.id)]
      ));
    }
  }

  async function refreshAll() {
    try {
      await Promise.all([refreshStats(), renderMaterials(), renderDocs(), renderDrafts()]);
    } catch (error) {
      byId("offlineModeLabel").textContent = "Ошибка";
      byId("offlineModeNote").textContent = error.message;
      console.error("Offline storage:", error);
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const category = byId("offlineCategory").value;
    for (const file of files) {
      const extension = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      if (![".pdf", ".docx", ".txt"].includes(extension)) {
        window.toast?.(`Формат ${extension || "файла"} не поддерживается.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        window.toast?.(`${file.name}: файл больше 30 МБ, пропущен.`);
        continue;
      }
      let textContent = "";
      if (extension === ".txt") {
        try { textContent = (await file.text()).slice(0, 500000); } catch { textContent = ""; }
      }
      try {
        await put(STORE_MATERIALS, {
          id: makeId(), name: file.name, extension, category,
          mimeType: file.type || "application/octet-stream",
          size: file.size, savedAt: Date.now(), blob: file, textContent
        });
      } catch (error) {
        throw new Error(`Не удалось сохранить ${file.name}. Возможно, закончилось место в браузере. ${error.message || ""}`);
      }
    }
    byId("offlineFiles").value = "";
    await refreshAll();
    window.toast?.("Локальная библиотека обновлена.");
  }

  function xmlEscape(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function wordParagraph(text, bold = false, centered = false) {
    const pPr = centered ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : "";
    const rPr = bold ? '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>' : "";
    const safe = xmlEscape(text).replace(/\r?\n/g, "</w:t><w:br/><w:t>");
    return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
  }
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  function createStoredZip(files) {
    const encoder = new TextEncoder();
    const localParts = [], centralParts = [];
    let offset = 0;
    const date = new Date();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    for (const [name, content] of Object.entries(files)) {
      const nameBytes = encoder.encode(name);
      const data = typeof content === "string" ? encoder.encode(content) : content;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); local.set(nameBytes, 30);
      localParts.push(local, data);
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true); cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true); central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length + data.length;
    }
    const centralBytes = concatBytes(centralParts);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);
    return concatBytes([...localParts, centralBytes, end]);
  }

  function escapeWordXml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r\n|\r|\n/g, "</w:t><w:br/><w:t>");
  }

  async function makeDocx(payload) {
    if (!window.JSZip) {
      throw new Error("Не загрузился локальный модуль Word. Обновите приложение при подключённом интернете.");
    }
    const response = await fetch("/offline-template.docx", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Не найден локальный Word-шаблон. Проверьте публикацию файла offline-template.docx.");
    }
    const zip = await window.JSZip.loadAsync(await response.arrayBuffer());
    const documentFile = zip.file("word/document.xml");
    if (!documentFile) throw new Error("В Word-шаблоне отсутствует основной документ.");
    let xml = await documentFile.async("string");

    const today = new Date();
    const dateText = today.toLocaleDateString("ru-RU");
    const durationText = String(payload.duration || "45 минут").trim();
    const durationNumber = Number.parseFloat(durationText.replace(",", ".")) || 45;
    const totalMinutes = Math.max(1, /час/i.test(durationText) ? Math.round(durationNumber * 60) : Math.round(durationNumber));
    const intro = Math.max(5, Math.round(totalMinutes * 0.15));
    const ending = Math.max(5, Math.round(totalMinutes * 0.15));
    const main = Math.max(1, totalMinutes - intro - ending);
    const disciplineForms = {
      "строевая подготовка": "строевой подготовке",
      "военно-медицинская подготовка": "военно-медицинской подготовке",
      "физическая подготовка": "физической подготовке",
      "общевоинские уставы": "общевоинским уставам",
      "государственно-правовая подготовка": "государственно-правовой подготовке",
      "психологическая подготовка": "психологической подготовке"
    };
    const disciplineKey = String(payload.discipline || "").trim().toLocaleLowerCase("ru");
    const disciplineForLine = disciplineForms[disciplineKey] || payload.discipline;
    let audienceForLine = String(payload.audience || "").trim();
    if (/^личный\s+состав/i.test(audienceForLine)) audienceForLine = audienceForLine.replace(/^личный\s+состав/i, "личным составом");
    else if (/^топогеодезисты$/i.test(audienceForLine)) audienceForLine = "топогеодезистами";
    else if (/^сержанты$/i.test(audienceForLine)) audienceForLine = "сержантами";
    else if (/^солдаты$/i.test(audienceForLine)) audienceForLine = "солдатами";
    else if (/^офицеры$/i.test(audienceForLine)) audienceForLine = "офицерами";
    const replacements = {
      RANK: payload.rank,
      FULL_NAME: payload.full_name,
      DATE: dateText,
      DISCIPLINE: disciplineForLine,
      AUDIENCE: audienceForLine,
      TOPIC_NUMBER: payload.topic_number,
      TOPIC: payload.topic,
      LESSON_NUMBER: payload.lesson_number,
      LESSON_TITLE: payload.lesson_title,
      DURATION: durationText,
      LOCATION: payload.location,
      LESSON_TYPE: payload.lesson_type,
      MANUALS: payload.manuals,
      MATERIALS: payload.materials,
      INTRO_TIME: String(intro),
      MAIN_TIME: String(main),
      END_TIME: String(ending)
    };
    for (const [key, value] of Object.entries(replacements)) {
      xml = xml.split(`{{${key}}}`).join(escapeWordXml(value));
    }
    // Do not leave raw markers in the downloaded document if an optional field was blank.
    xml = xml.replace(/\{\{[A-Z0-9_]+\}\}/g, "");
    zip.file("word/document.xml", xml);
    return await zip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }

  async function createOfflineDoc() {
    const form = byId("createForm");
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const payload = currentPayload();
    if (!payload.topic || !payload.lesson_title || !payload.rank || !payload.full_name) {
      window.toast?.("Заполните тему, занятие, звание и ФИО.");
      return;
    }
    const blob = await makeDocx(payload);
    const name = `Конспект_${payload.lesson_number || "офлайн"}_${new Date().toISOString().slice(0,10)}.docx`;
    await put(STORE_DOCS, {
      id: makeId(), name, title: payload.lesson_title, createdAt: Date.now(), payload, blob
    });
    saveBlob(blob, name);
    await refreshAll();
    window.toast?.("Офлайн Word создан и сохранён на устройстве.");
  }

  async function saveCurrentDraft() {
    const payload = currentPayload();
    if (!payload.topic && !payload.lesson_title) {
      window.toast?.("Сначала заполните форму занятия.");
      return;
    }
    const draft = {
      id: makeId(), title: payload.lesson_title || payload.topic || "Черновик",
      updatedAt: Date.now(), payload
    };
    await put(STORE_DRAFTS, draft);
    await refreshAll();
    window.toast?.("Черновик сохранён на этом устройстве.");
  }

  function fillForm(payload) {
    const map = {
      discipline: "discipline", lesson_type: "lessonType", topic_number: "topicNum",
      lesson_number: "lessonNum", topic: "topic", lesson_title: "lessonTitle",
      audience: "audience", duration: "duration", location: "place",
      manuals: "manuals", materials: "materials", rank: "rank", full_name: "fullName"
    };
    Object.entries(map).forEach(([key, id]) => {
      const field = byId(id);
      if (field && payload[key] != null) field.value = payload[key];
    });
    if (typeof go === "function") go("create");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function exportDraftBackup() {
    const drafts = await getAll(STORE_DRAFTS);
    const backup = {
      format: "voenny-konspekt-drafts",
      version: 1,
      exportedAt: new Date().toISOString(),
      drafts
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    saveBlob(blob, `voenny-konspekt-drafts-${new Date().toISOString().slice(0,10)}.json`);
  }
  async function importDraftBackup(file) {
    const data = JSON.parse(await file.text());
    if (data.format !== "voenny-konspekt-drafts" || !Array.isArray(data.drafts)) {
      throw new Error("Это не резервная копия черновиков Военного Конспекта.");
    }
    for (const draft of data.drafts) {
      if (draft && draft.payload && typeof draft.payload === "object") {
        await put(STORE_DRAFTS, {
          id: makeId(),
          title: safeText(draft.title || "Импортированный черновик").slice(0, 160),
          updatedAt: Date.now(),
          payload: draft.payload
        });
      }
    }
    await refreshAll();
    window.toast?.("Черновики импортированы.");
  }

  async function handleListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    try {
      if (action === "delete-material") {
        await remove(STORE_MATERIALS, id); await renderMaterials(); await refreshStats();
      } else if (action === "open-material") {
        const item = (await getAll(STORE_MATERIALS)).find(x => x.id === id);
        if (item) {
          if (item.extension === ".pdf") {
            const url = URL.createObjectURL(item.blob);
            const tab = window.open(url, "_blank", "noopener");
            if (!tab) saveBlob(item.blob, item.name);
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          } else {
            saveBlob(item.blob, item.name);
          }
        }
      } else if (action === "delete-doc") {
        await remove(STORE_DOCS, id); await renderDocs(); await refreshStats();
      } else if (action === "download-doc") {
        const item = (await getAll(STORE_DOCS)).find(x => x.id === id);
        if (item) saveBlob(item.blob, item.name);
      } else if (action === "restore-draft") {
        const item = (await getAll(STORE_DRAFTS)).find(x => x.id === id);
        if (item) fillForm(item.payload);
      } else if (action === "delete-draft") {
        await remove(STORE_DRAFTS, id); await renderDrafts(); await refreshStats();
      }
    } catch (error) {
      window.modal?.("Ошибка локального режима", error.message);
    }
  }

  function updateConnection() {
    const online = navigator.onLine;
    const label = byId("offlineConnection");
    if (label) {
      label.textContent = online ? "Интернет есть · локальные функции доступны" : "Нет интернета · работает локальное хранилище";
      label.classList.toggle("offline", !online);
    }
  }

  function openOfflineMode() {
    const overlay = byId("loginOverlay");
    if (overlay) overlay.style.display = "none";
    const app = byId("app");
    if (app) app.style.display = "block";
    if (typeof go === "function") go("offline");
    refreshAll().catch(error => window.modal?.("Офлайн-хранилище", error.message));
  }

  async function installPwa() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      return;
    }
    window.modal?.("Установка приложения", "В Chrome откройте меню ⋮ → Трансляция, сохранение и отправка → Установить страницу как приложение (название пункта может отличаться). Перед первой работой откройте сайт с интернетом, чтобы он сохранил офлайн-файлы.");
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(reg => reg.update().catch(() => {}))
        .catch(error => console.warn("Не удалось зарегистрировать Service Worker:", error));
    }, { once: true });
  }

  function setupEvents() {
    byId("openOfflineFromLogin")?.addEventListener("click", openOfflineMode);
    byId("offlineFiles")?.addEventListener("change", event => {
      handleFiles(event.target.files).catch(error => window.modal?.("Не удалось сохранить материалы", error.message));
    });
    byId("offlineSearch")?.addEventListener("input", () => renderMaterials().catch(console.error));
    byId("offlineRefresh")?.addEventListener("click", () => refreshAll().catch(console.error));
    byId("offlineSaveDraft")?.addEventListener("click", () => saveCurrentDraft().catch(error => window.modal?.("Черновик не сохранён", error.message)));
    byId("offlineCreateDocx")?.addEventListener("click", () => createOfflineDoc().catch(error => window.modal?.("Не удалось создать Word", error.message)));
    byId("offlineMaterialsList")?.addEventListener("click", handleListClick);
    byId("offlineDocumentsList")?.addEventListener("click", handleListClick);
    byId("offlineDraftsList")?.addEventListener("click", handleListClick);
    byId("offlineBackupExport")?.addEventListener("click", () => exportDraftBackup().catch(error => window.modal?.("Экспорт не удался", error.message)));
    byId("offlineBackupImport")?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) importDraftBackup(file).catch(error => window.modal?.("Импорт не удался", error.message));
      event.target.value = "";
    });
    byId("installPwaButton")?.addEventListener("click", installPwa);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      const button = byId("installPwaButton");
      if (button) button.textContent = "Установить приложение";
    });
  }

  async function init() {
    try { titleMap.offline = ["Офлайн-центр", "Локальная работа без сети"]; } catch (_) {}
    updateConnection();
    setupEvents();
    registerServiceWorker();
    if (location.protocol === "file:") {
      byId("offlineModeNote").textContent = "PWA работает после публикации по HTTPS, а локальные материалы работают только внутри установленного сайта.";
    }
    try { await refreshAll(); }
    catch (error) {
      console.warn("Офлайн-хранилище пока недоступно:", error);
      byId("offlineModeLabel").textContent = "Недоступен";
      byId("offlineModeNote").textContent = error.message;
    }
  }

  window.VoennyOffline = { open: openOfflineMode, refresh: refreshAll };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
