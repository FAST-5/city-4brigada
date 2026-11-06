/* Offline workspace for Военный Конспект. No external libraries are required. */
(() => {
  "use strict";

  const DB_NAME = "voenny-konspekt-offline";
  const DB_VERSION = 1;
  const MAX_FILE_SIZE = 40 * 1024 * 1024;
  const SAFE_EXTENSIONS = new Set(["pdf", "docx", "txt"]);
  let dbPromise;
  let deferredInstallPrompt = null;
  let offlineWorkspace = false;
  let localSearchText = "";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("Этот браузер не поддерживает локальное хранилище IndexedDB."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("materials")) database.createObjectStore("materials", { keyPath: "id" });
        if (!database.objectStoreNames.contains("documents")) database.createObjectStore("documents", { keyPath: "id" });
        if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Не удалось открыть локальное хранилище."));
    });
    return dbPromise;
  }

  async function storeRequest(storeName, mode, action) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      try { request = action(store); }
      catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error || new Error("Ошибка локального хранилища."));
      transaction.onabort = () => reject(transaction.error || new Error("Операция сохранения отменена."));
    });
  }

  const putItem = (name, value) => storeRequest(name, "readwrite", store => store.put(value));
  const getAll = name => storeRequest(name, "readonly", store => store.getAll());
  const deleteItem = (name, id) => storeRequest(name, "readwrite", store => store.delete(id));

  function notify(message) {
    if (typeof window.toast === "function") window.toast(message);
    else console.info("Военный Конспект:", message);
  }

  function safeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function makeId() {
    return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function css() {
    const style = document.createElement("style");
    style.textContent = `
      .offline-badge{display:inline-flex;align-items:center;gap:7px;margin:12px 0 0;padding:7px 10px;border-radius:999px;background:rgba(105,220,255,.1);border:1px solid rgba(105,220,255,.25);color:#8de8ff;font-size:10px;font-weight:800}
      .offline-badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#59e2a6;box-shadow:0 0 10px #59e2a6}
      .offline-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:12px}
      .offline-row:last-child{border-bottom:0}.offline-row small{display:block;color:var(--muted);font-size:10px;margin-top:4px;overflow-wrap:anywhere}
      .offline-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.offline-actions button{white-space:nowrap}
      .offline-local-only{font-size:10px;color:var(--muted);line-height:1.5;margin-top:10px}
      #openOfflineMode{width:100%;margin-top:12px}
      #offlineMaterialList,#localDocumentList,#localDraftList{margin-top:12px}
      #localMaterialFiles{padding:10px}
      .offline-empty{padding:14px 0;color:var(--muted);font-size:11px}
      #offlinePage{display:none}.section#page-offline{display:none}.section#page-offline.active{display:block}
      @media(max-width:680px){.offline-row{align-items:flex-start;flex-direction:column}.offline-actions{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function installNavigation() {
    const nav = $("#nav");
    if (!nav || $("[data-page='offline']")) return;
    const button = document.createElement("button");
    button.dataset.page = "offline";
    button.innerHTML = '<span class="nav-icon">⌁</span>Офлайн-центр';
    button.addEventListener("click", () => navigate("offline"));
    const books = $("[data-page='books']", nav);
    if (books) books.after(button); else nav.appendChild(button);
  }

  function pageMarkup() {
    const page = document.createElement("section");
    page.className = "section";
    page.id = "page-offline";
    page.innerHTML = `
      <div class="page-head"><div><div class="eyebrow">ЛОКАЛЬНОЕ ХРАНИЛИЩЕ</div><h1>Офлайн-центр</h1><p class="lead">Сохранённые материалы, черновики и Word-документы доступны в браузере на этом устройстве.</p><div id="offlineConnectionBadge" class="offline-badge">Проверка соединения</div></div><button class="btn" id="offlineInstall" type="button">Установить приложение</button></div>
      <div class="notice"><strong>Локальные данные:</strong> остаются в этом браузере и не синхронизируются с другими устройствами. Не очищайте данные сайта без резервной копии. Загружайте только общие учебные материалы, не содержащие прикладных инструкций по опасным действиям.</div>
      <div class="stats" style="margin-top:18px"><div class="card stat"><div class="stat-top"><span>Материалы</span><span class="stat-icon">▤</span></div><div class="stat-value" id="offlineMaterialCount">0</div><div class="stat-note">Локальная библиотека</div></div><div class="card stat"><div class="stat-top"><span>Word-документы</span><span class="stat-icon">▧</span></div><div class="stat-value" id="offlineDocumentCount">0</div><div class="stat-note">Сохранено на устройстве</div></div><div class="card stat"><div class="stat-top"><span>Черновики</span><span class="stat-icon">✎</span></div><div class="stat-value" id="offlineDraftCount">0</div><div class="stat-note">Локальные записи</div></div><div class="card stat"><div class="stat-top"><span>Режим</span><span class="stat-icon">⌁</span></div><div class="stat-value" id="offlineModeValue" style="font-size:20px">Готов</div><div class="stat-note">Работа без сервера</div></div></div>
      <div class="main-grid">
        <div class="card panel"><div class="panel-head"><div><h2>Локальная библиотека</h2><div class="panel-sub">Добавьте учебные PDF, DOCX или TXT заранее, пока интернет доступен.</div></div><span class="badge">Только это устройство</span></div>
          <div class="form-grid"><div class="field"><label for="offlineMaterialCategory">Категория</label><select id="offlineMaterialCategory"><option>Общие учебные материалы</option><option>Первая помощь и здоровье</option><option>Общевоинские уставы</option><option>Физическая подготовка</option><option>Право и психология</option></select></div><div class="field"><label for="offlineMaterialFiles">Файлы (PDF, DOCX, TXT)</label><input id="offlineMaterialFiles" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" multiple></div></div>
          <div class="searchrow"><input id="offlineMaterialSearch" placeholder="Поиск по имени файла и категории…"><button class="btn secondary" id="offlineClearSearch" type="button">Очистить</button></div><div id="offlineMaterialList"><div class="offline-empty">Пока нет материалов. Добавьте файлы выше.</div></div>
        </div>
        <div class="card panel"><h2>Черновик и конструктор Word</h2><div class="panel-sub">Заполните форму в разделе «Создать конспект», затем сохраните черновик или создайте DOCX без интернета.</div><div class="offline-actions" style="margin-top:16px"><button class="btn secondary" id="offlineSaveDraft" type="button">Сохранить черновик</button><button class="btn" id="offlineCreateDocx" type="button">Создать Word офлайн</button></div><div class="offline-local-only">Используется встроенный шаблон плана-конспекта. Сервер и AI для создания файла не требуются. Текст учебного содержания заполняется пользователем.</div><div class="preview-paper" style="margin-top:18px"><h3>Сохранённые Word-документы</h3><div id="offlineDocumentList"><div class="offline-empty">Пока нет документов.</div></div></div><div style="margin-top:18px"><h3 style="font-size:13px">Черновики</h3><div id="offlineDraftList"><div class="offline-empty">Пока нет черновиков.</div></div></div></div>
      </div>`;
    const pageHost = $(".page");
    const footer = $(".footer-note", pageHost);
    if (footer) footer.before(page); else pageHost.appendChild(page);
  }

  function authOfflineButton() {
    const panel = $("#authEmail");
    if (!panel || $("#openOfflineMode")) return;
    const button = document.createElement("button");
    button.id = "openOfflineMode";
    button.type = "button";
    button.className = "btn secondary";
    button.textContent = "Открыть офлайн-режим на этом устройстве";
    button.addEventListener("click", openOfflineWorkspace);
    const form = $("#telegramLoginForm", panel);
    if (form) form.after(button); else panel.appendChild(button);
    const note = $(".auth-note");
    if (note) note.textContent = "Для входа на сервер используйте Telegram ID и код /sitecode. Для локальных учебных материалов, черновиков и автономного Word можно открыть офлайн-режим без сервера.";
  }

  function openOfflineWorkspace() {
    offlineWorkspace = true;
    const gate = $("#authGate");
    const app = $("#app");
    if (gate) gate.style.display = "none";
    if (app) app.style.display = "block";
    const name = $(".user-name");
    const role = $(".user-role");
    const avatar = $(".avatar");
    if (name) name.textContent = "Локальное устройство";
    if (role) role.textContent = "Офлайн-режим · без сервера";
    if (avatar) avatar.textContent = "ОФ";
    const owner = $("[data-page='owner']");
    if (owner) owner.style.display = "none";
    navigate("offline");
    refreshOfflineCenter().catch(error => notify(error.message));
  }

  function navigate(page) {
    if (typeof window.go === "function") window.go(page);
    else {
      $$(".section").forEach(section => section.classList.toggle("active", section.id === `page-${page}`));
    }
    const label = $("#crumb");
    const title = $("#topTitle");
    if (page === "offline") {
      if (label) label.textContent = "Офлайн-центр";
      if (title) title.textContent = "Локальная библиотека и документы";
      refreshOfflineCenter().catch(error => notify(error.message));
    }
  }

  function setOfflineBadge() {
    const badge = $("#offlineConnectionBadge");
    if (!badge) return;
    badge.textContent = navigator.onLine ? "Интернет доступен · локальные данные готовы" : "Нет интернета · локальный режим";
    badge.style.color = navigator.onLine ? "#80e5ad" : "#8de8ff";
  }

  async function refreshOfflineCenter() {
    const [materials, documents, drafts] = await Promise.all([getAll("materials"), getAll("documents"), getAll("drafts")]);
    const setText = (id, value) => { const element = $(`#${id}`); if (element) element.textContent = String(value); };
    setText("offlineMaterialCount", materials.length);
    setText("offlineDocumentCount", documents.length);
    setText("offlineDraftCount", drafts.length);
    setText("offlineModeValue", navigator.onLine ? "Готов" : "Офлайн");
    setOfflineBadge();
    renderMaterials(materials);
    renderDocuments(documents);
    renderDrafts(drafts);
  }

  function renderMaterials(items) {
    const list = $("#offlineMaterialList");
    if (!list) return;
    const q = localSearchText.toLocaleLowerCase("ru");
    const filtered = items.filter(item => `${item.name} ${item.category}`.toLocaleLowerCase("ru").includes(q));
    list.innerHTML = "";
    if (!filtered.length) { list.innerHTML = '<div class="offline-empty">Материалы не найдены.</div>'; return; }
    for (const item of filtered) {
      const row = document.createElement("div"); row.className = "offline-row";
      const info = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = item.name;
      const meta = document.createElement("small"); meta.textContent = `${item.category} · ${formatSize(item.size)} · ${item.type || item.extension.toUpperCase()}`;
      info.append(title, meta);
      const actions = document.createElement("div"); actions.className = "offline-actions";
      const open = document.createElement("button"); open.className = "btn secondary small"; open.textContent = item.extension === "pdf" ? "Открыть" : "Скачать";
      open.addEventListener("click", () => openMaterial(item));
      const remove = document.createElement("button"); remove.className = "btn danger small"; remove.textContent = "Удалить";
      remove.addEventListener("click", async () => { await deleteItem("materials", item.id); await refreshOfflineCenter(); notify("Материал удалён из локальной библиотеки."); });
      actions.append(open, remove); row.append(info, actions); list.appendChild(row);
    }
  }

  function renderDocuments(items) {
    const list = $("#offlineDocumentList"); if (!list) return;
    list.innerHTML = "";
    if (!items.length) { list.innerHTML = '<div class="offline-empty">Пока нет документов. Создайте Word из заполненной формы.</div>'; return; }
    items.sort((a, b) => b.createdAt - a.createdAt);
    for (const item of items) {
      const row = document.createElement("div"); row.className = "offline-row";
      const info = document.createElement("div"); const title = document.createElement("strong"); title.textContent = item.title;
      const meta = document.createElement("small"); meta.textContent = `${item.discipline} · ${new Date(item.createdAt).toLocaleString("ru-RU")}`; info.append(title, meta);
      const actions = document.createElement("div"); actions.className = "offline-actions";
      const download = document.createElement("button"); download.className = "btn secondary small"; download.textContent = "Скачать"; download.addEventListener("click", () => downloadBlob(item.blob, item.filename));
      const remove = document.createElement("button"); remove.className = "btn danger small"; remove.textContent = "Удалить"; remove.addEventListener("click", async () => { await deleteItem("documents", item.id); await refreshOfflineCenter(); });
      actions.append(download, remove); row.append(info, actions); list.appendChild(row);
    }
  }

  function renderDrafts(items) {
    const list = $("#offlineDraftList"); if (!list) return;
    list.innerHTML = "";
    if (!items.length) { list.innerHTML = '<div class="offline-empty">Черновиков пока нет.</div>'; return; }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of items) {
      const row = document.createElement("div"); row.className = "offline-row";
      const info = document.createElement("div"); const title = document.createElement("strong"); title.textContent = item.title || "Черновик занятия";
      const meta = document.createElement("small"); meta.textContent = new Date(item.updatedAt).toLocaleString("ru-RU"); info.append(title, meta);
      const actions = document.createElement("div"); actions.className = "offline-actions";
      const load = document.createElement("button"); load.className = "btn secondary small"; load.textContent = "Открыть"; load.addEventListener("click", () => restoreDraft(item));
      const remove = document.createElement("button"); remove.className = "btn danger small"; remove.textContent = "Удалить"; remove.addEventListener("click", async () => { await deleteItem("drafts", item.id); await refreshOfflineCenter(); });
      actions.append(load, remove); row.append(info, actions); list.appendChild(row);
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  async function openMaterial(item) {
    const url = URL.createObjectURL(item.blob);
    if (item.extension === "pdf") {
      const tab = window.open(url, "_blank", "noopener");
      if (!tab) downloadBlob(item.blob, item.name);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else downloadBlob(item.blob, item.name);
  }

  async function addMaterials(fileList) {
    const category = $("#offlineMaterialCategory")?.value || "Общие учебные материалы";
    for (const file of fileList) {
      const extension = (file.name.split(".").pop() || "").toLowerCase();
      if (!SAFE_EXTENSIONS.has(extension)) { notify(`Формат ${extension || "неизвестен"} не поддерживается.`); continue; }
      if (file.size > MAX_FILE_SIZE) { notify(`${file.name}: файл больше 40 МБ и не добавлен.`); continue; }
      await putItem("materials", { id: makeId(), name: file.name, extension, type: file.type, category, size: file.size, addedAt: Date.now(), blob: file });
    }
    await refreshOfflineCenter();
    notify("Материалы сохранены на этом устройстве.");
  }

  function ensureOfflineFields() {
    const form = $("#createForm");
    if (!form) throw new Error("На этой версии сайта не найдена форма создания конспекта.");
    const grid = $(".form-grid", form) || form;
    const addField = (id, label, value, placeholder) => {
      if ($(`#${id}`)) return;
      const wrapper = document.createElement("div"); wrapper.className = "field";
      const caption = document.createElement("label"); caption.htmlFor = id; caption.textContent = label;
      const input = document.createElement("input"); input.id = id; input.value = value; input.placeholder = placeholder;
      wrapper.append(caption, input); grid.appendChild(wrapper);
    };
    addField("realLessonTitle", "Название занятия", "Общие положения и требования", "Название занятия");
    addField("realRank", "Звание руководителя", "", "Например, лейтенант");
    addField("realFullName", "ФИО руководителя", "", "Фамилия Имя Отчество");
    addField("realGoals", "Цели занятия", "", "Укажите учебные цели");
    const discipline = $("#discipline");
    if (discipline) {
      const safeOptions = ["Строевая подготовка", "Военно-медицинская подготовка", "Физическая подготовка", "Общевоинские уставы", "Государственно-правовая подготовка", "Психологическая подготовка"];
      const current = discipline.value;
      discipline.innerHTML = safeOptions.map(value => `<option>${safeText(value)}</option>`).join("");
      if (safeOptions.includes(current)) discipline.value = current;
    }
  }

  function currentPayload() {
    ensureOfflineFields();
    if (typeof window.collectDocPayload === "function") return window.collectDocPayload();
    const value = id => $("#" + id)?.value?.trim() || "";
    return {
      discipline: value("discipline") || "Строевая подготовка",
      topic_number: value("topicNum") || "1",
      lesson_number: value("lessonNum") || "1",
      topic: value("topic"),
      lesson_title: value("realLessonTitle") || value("topic"),
      lesson_type: value("lessonType") || "Практическое занятие",
      audience: value("audience"),
      duration: value("duration"),
      location: value("place"),
      goals: value("realGoals"),
      manuals: value("manuals"),
      materials: value("materials"),
      rank: value("realRank"),
      full_name: value("realFullName"),
      approval_position: "Командир подразделения"
    };
  }

  function payloadTitle(payload) {
    return String(payload.lesson_title || payload.topic || "План-конспект").slice(0, 120);
  }

  async function saveDraftFromForm() {
    const payload = currentPayload();
    await putItem("drafts", { id: makeId(), title: payloadTitle(payload), updatedAt: Date.now(), payload });
    await refreshOfflineCenter();
    notify("Черновик сохранён локально.");
  }

  async function restoreDraft(item) {
    if (typeof window.go === "function") window.go("create");
    if (typeof window.buildRealDocPreview === "function" && !$("#realLessonTitle")) window.buildRealDocPreview();
    const payload = item.payload || {};
    for (const [key, id] of Object.entries({ discipline: "discipline", topic_number: "topicNum", lesson_number: "lessonNum", topic: "topic", lesson_title: "realLessonTitle", lesson_type: "lessonType", audience: "audience", duration: "duration", location: "place", manuals: "manuals", materials: "materials", goals: "realGoals", rank: "realRank", full_name: "realFullName" })) {
      const field = document.getElementById(id);
      if (field && payload[key] !== undefined) field.value = payload[key];
    }
    notify("Черновик открыт в форме создания занятия.");
  }

  async function saveOfflineWord(payload) {
    const blob = makeDocxBlob(payload);
    const title = payloadTitle(payload);
    const filename = `Конспект_${title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 55) || "offline"}.docx`;
    const entry = { id: makeId(), title, discipline: payload.discipline || "Общие учебные материалы", filename, createdAt: Date.now(), blob };
    await putItem("documents", entry);
    downloadBlob(blob, filename);
    await refreshOfflineCenter();
    notify("Word-документ создан без интернета и сохранён локально.");
  }

  function xmlEscape(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function wordParagraph(text, options = {}) {
    const { bold = false, center = false, size = 24, after = 120 } = options;
    const pPr = `<w:pPr><w:spacing w:after="${after}"/>${center ? '<w:jc w:val="center"/>' : ""}</w:pPr>`;
    const rPr = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/></w:rPr>`;
    return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeZip(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
      const crc = crc32(data);
      const local = new Uint8Array(30);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      localParts.push(local, name, data);
      const central = new Uint8Array(46);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      centralParts.push(central, name);
      offset += local.length + name.length + data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    return new Blob([...localParts, ...centralParts, end], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  function makeDocxBlob(payload) {
    const paragraphs = [];
    paragraphs.push(wordParagraph("УТВЕРЖДАЮ", { bold: true, center: true, size: 26, after: 80 }));
    paragraphs.push(wordParagraph(payload.approval_position || "Командир подразделения", { center: true, size: 22, after: 40 }));
    paragraphs.push(wordParagraph(`${payload.rank || "________________"} ${payload.full_name || "________________"}`, { center: true, size: 22, after: 40 }));
    paragraphs.push(wordParagraph("«____» ______________ 20____ г.", { center: true, size: 20, after: 320 }));
    paragraphs.push(wordParagraph("ПЛАН-КОНСПЕКТ", { bold: true, center: true, size: 32, after: 100 }));
    paragraphs.push(wordParagraph(`по дисциплине: ${payload.discipline || "________________"}`, { bold: true, center: true }));
    paragraphs.push(wordParagraph(`Тема № ${payload.topic_number || "___"}. ${payload.topic || "________________"}`, { bold: true, after: 100 }));
    paragraphs.push(wordParagraph(`Занятие № ${payload.lesson_number || "___"}. ${payload.lesson_title || payload.topic || "________________"}`, { bold: true, after: 180 }));
    const fields = [
      ["Вид занятия", payload.lesson_type], ["Категория обучаемых", payload.audience],
      ["Продолжительность", payload.duration], ["Место проведения", payload.location],
      ["Цели занятия", payload.goals], ["Руководства и пособия", payload.manuals],
      ["Материальное обеспечение", payload.materials]
    ];
    for (const [label, value] of fields) paragraphs.push(wordParagraph(`${label}: ${value || "____________________________________________"}`));
    paragraphs.push(wordParagraph("УЧЕБНЫЕ ВОПРОСЫ", { bold: true, size: 26, after: 100 }));
    paragraphs.push(wordParagraph("1. __________________________________________________________"));
    paragraphs.push(wordParagraph("2. __________________________________________________________"));
    paragraphs.push(wordParagraph("3. __________________________________________________________", { after: 220 }));
    paragraphs.push(wordParagraph("ХОД ЗАНЯТИЯ", { bold: true, center: true, size: 28, after: 160 }));
    paragraphs.push(wordParagraph("Вводная часть", { bold: true, size: 24 }));
    paragraphs.push(wordParagraph("Организационные вопросы и объявление темы занятия. Содержание заполнить руководителю по утверждённой учебной программе."));
    paragraphs.push(wordParagraph("Основная часть", { bold: true, size: 24 }));
    paragraphs.push(wordParagraph("Последовательно раскрыть учебные вопросы, используя разрешённые учебные материалы и методические пособия."));
    paragraphs.push(wordParagraph("Заключительная часть", { bold: true, size: 24 }));
    paragraphs.push(wordParagraph("Подведение итогов, ответы на вопросы, проверка усвоения материала и постановка задач для самостоятельной подготовки."));
    paragraphs.push(wordParagraph("", { after: 180 }));
    paragraphs.push(wordParagraph("Руководитель занятия: ______________________________"));
    paragraphs.push(wordParagraph(`${payload.rank || "________________"} ${payload.full_name || "________________"}`));

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
    const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
    const created = new Date().toISOString();
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(payloadTitle(payload))}</dc:title><dc:creator>Военный Конспект — локальный режим</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`;
    const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Военный Конспект</Application></Properties>`;
    return makeZip([
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: relationships },
      { name: "word/document.xml", data: documentXml },
      { name: "docProps/core.xml", data: core },
      { name: "docProps/app.xml", data: app }
    ]);
  }

  async function saveOfflineDocFromForm() {
    try {
      const payload = currentPayload();
      await saveOfflineWord(payload);
    } catch (error) { notify(error.message); }
  }

  async function renderOfflineHistory() {
    const body = $("#historyRows"); if (!body) return;
    const docs = (await getAll("documents")).sort((a, b) => b.createdAt - a.createdAt);
    const count = $("#historyCount"); if (count) count.textContent = `${docs.length} локальных документов`;
    body.innerHTML = "";
    if (!docs.length) { body.innerHTML = '<tr><td colspan="5" class="offline-empty">Локальных Word-документов пока нет.</td></tr>'; return; }
    for (const item of docs) {
      const row = document.createElement("tr");
      for (const value of [item.title, new Date(item.createdAt).toLocaleDateString("ru-RU"), "DOCX", item.discipline]) {
        const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell);
      }
      const action = document.createElement("td"); const button = document.createElement("button"); button.className = "btn secondary small"; button.textContent = "Скачать"; button.addEventListener("click", () => downloadBlob(item.blob, item.filename)); action.appendChild(button); row.appendChild(action); body.appendChild(row);
    }
  }

  async function renderOfflineBookSearch() {
    const query = $("#bookQuery")?.value.trim().toLocaleLowerCase("ru") || "";
    const resultBox = $("#bookResults"); if (!resultBox) return;
    const materials = await getAll("materials");
    const items = materials.filter(item => !query || `${item.name} ${item.category}`.toLocaleLowerCase("ru").includes(query));
    resultBox.innerHTML = "";
    if (!items.length) { resultBox.innerHTML = '<div class="offline-empty">В локальной библиотеке совпадений нет. Добавьте материалы в Офлайн-центре.</div>'; return; }
    for (const item of items) {
      const card = document.createElement("div"); card.className = "result";
      const title = document.createElement("div"); title.className = "result-title"; title.textContent = item.name;
      const meta = document.createElement("div"); meta.className = "result-meta"; meta.textContent = `${item.category} · ${formatSize(item.size)}`;
      const button = document.createElement("button"); button.className = "btn secondary small"; button.style.marginTop = "10px"; button.textContent = item.extension === "pdf" ? "Открыть" : "Скачать"; button.addEventListener("click", () => openMaterial(item));
      card.append(title, meta, button); resultBox.appendChild(card);
    }
  }

  async function renderOfflineDashboard() {
    const [docs, materials, drafts] = await Promise.all([getAll("documents"), getAll("materials"), getAll("drafts")]);
    const stats = $$("#page-home .stat-value");
    if (stats[0]) stats[0].textContent = docs.length;
    if (stats[1]) stats[1].textContent = materials.length;
    if (stats[2]) stats[2].textContent = drafts.length;
    if (stats[3]) { stats[3].textContent = "Офлайн"; stats[3].style.color = "#70dfff"; }
    let badge = $("#dashboardStatus");
    if (!badge) { badge = document.createElement("div"); badge.id = "dashboardStatus"; badge.className = "offline-badge"; $("#page-home .page-head")?.appendChild(badge); }
    badge.textContent = "Локальный режим · данные на этом устройстве";
  }

  function wireFormPersistence() {
    const form = $("#createForm"); if (!form || form.dataset.offlineWired === "1") return;
    form.dataset.offlineWired = "1";
    let pending;
    const persist = () => {
      clearTimeout(pending);
      pending = setTimeout(async () => {
        try {
          if (!$("#realLessonTitle")) return;
          const payload = currentPayload();
          await putItem("drafts", { id: "autosave", title: payloadTitle(payload), updatedAt: Date.now(), payload });
          const badge = $("#offlineModeStatus"); if (badge) badge.textContent = "Черновик автосохранён";
        } catch (error) { /* Ignore incomplete form while the user is typing. */ }
      }, 700);
    };
    form.addEventListener("input", persist);
    form.addEventListener("change", persist);
  }

  function installHooks() {
    const originalGo = window.go;
    if (typeof originalGo === "function" && !originalGo.__offlineWrapped) {
      const wrappedGo = function (page) {
        if (offlineWorkspace && page === "owner") { notify("Кабинет владельца доступен только при входе через Telegram и подключении к серверу."); return; }
        originalGo(page);
        if (page === "offline") refreshOfflineCenter().catch(error => notify(error.message));
        if (page === "history" && offlineWorkspace) renderOfflineHistory().catch(error => notify(error.message));
        if (page === "books" && offlineWorkspace) renderOfflineBookSearch().catch(error => notify(error.message));
        if (page === "create") { setTimeout(wireFormPersistence, 0); }
      };
      wrappedGo.__offlineWrapped = true;
      window.go = wrappedGo;
    }

    const originalHistory = window.loadHistory;
    if (typeof originalHistory === "function") window.loadHistory = function () { return offlineWorkspace ? renderOfflineHistory() : originalHistory(); };
    const originalDashboard = window.loadDashboard;
    if (typeof originalDashboard === "function") window.loadDashboard = function () { return offlineWorkspace ? renderOfflineDashboard() : originalDashboard(); };
    const originalSearch = window.searchRealBooks;
    if (typeof originalSearch === "function") window.searchRealBooks = function () { return offlineWorkspace ? renderOfflineBookSearch() : originalSearch(); };
  }

  function wireEvents() {
    const input = $("#offlineMaterialFiles");
    input?.addEventListener("change", async event => { try { await addMaterials([...event.target.files]); event.target.value = ""; } catch (error) { notify(error.message); } });
    $("#offlineMaterialSearch")?.addEventListener("input", async event => { localSearchText = event.target.value; await refreshOfflineCenter(); });
    $("#offlineClearSearch")?.addEventListener("click", async () => { localSearchText = ""; $("#offlineMaterialSearch").value = ""; await refreshOfflineCenter(); });
    $("#refreshLocalMaterials")?.addEventListener("click", () => refreshOfflineCenter().catch(error => notify(error.message)));
    $("#offlineSaveDraft")?.addEventListener("click", saveDraftFromForm);
    $("#offlineCreateDocx")?.addEventListener("click", saveOfflineDocFromForm);
    $("#offlineInstall")?.addEventListener("click", promptInstall);
    $("#createForm")?.addEventListener("submit", event => {
      if (!offlineWorkspace) return;
      event.preventDefault(); event.stopImmediatePropagation();
      try {
        const payload = currentPayload();
        const preview = $("#draft");
        if (preview) {
          $("#draftTitle").textContent = payloadTitle(payload);
          $("#draftMeta").textContent = `${payload.discipline} · тема ${payload.topic_number}, занятие ${payload.lesson_number}`;
          preview.dataset.payload = JSON.stringify(payload);
          preview.style.display = "block";
          preview.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } catch (error) { notify(error.message); }
    }, true);
    document.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest("#saveDraft") : null;
      if (!offlineWorkspace || !target) return;
      event.preventDefault(); event.stopImmediatePropagation();
      saveOfflineDocFromForm();
    }, true);
    window.addEventListener("online", setOfflineBadge);
    window.addEventListener("offline", setOfflineBadge);
  }

  async function promptInstall() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      return;
    }
    notify("В Chrome откройте меню ⋮ и выберите «Установить Военный Конспект» или «Трансляция, сохранение и общий доступ → Установить страницу как приложение».");
  }

  async function start() {
    css();
    installNavigation();
    pageMarkup();
    authOfflineButton();
    installHooks();
    wireEvents();
    const onlineButton = $("#installPwaButton");
    if (onlineButton) onlineButton.addEventListener("click", promptInstall);
    window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstallPrompt = event; });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(() => console.info("Офлайн-режим зарегистрирован.")).catch(error => console.warn("Не удалось зарегистрировать Service Worker:", error));
    }
    try { await refreshOfflineCenter(); } catch (error) { console.warn(error); }
    setOfflineBadge();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
