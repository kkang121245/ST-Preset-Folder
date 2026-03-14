import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { Popup, POPUP_RESULT, POPUP_TYPE } from "/scripts/popup.js";
import { getPresetManager } from "/scripts/preset-manager.js";
import {
    getSanitizedFilename,
    equalsIgnoreCaseAndAccents,
} from "/scripts/utils.js";

const EXTENSION_KEY = "ST-Preset-Folder";
const ALL_FOLDER_ID = "__all__";
const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";
const autoAssignSuppressNames = new Set();
let knownPresetNames = new Set();
const autoAssignQueue = [];
let autoAssignProcessing = false;
let openaiRenameInProgress = false;

function suppressAutoAssignForName(presetName) {
    if (!presetName) return;
    autoAssignSuppressNames.add(presetName);

    const queueIndex = autoAssignQueue.indexOf(presetName);
    if (queueIndex >= 0) {
        autoAssignQueue.splice(queueIndex, 1);
    }
}

if (!globalThis.__stPresetFolderLoaded) {
    globalThis.__stPresetFolderLoaded = true;
    void initialize();
}

async function initialize() {
    await waitForOpenAIPresetUI();

    ensureState();
    normalizeState();

    ensureFolderManageButton();
    ensureFolderFilterSelect();
    applyPresetFilter(true);
    attachPresetSelectObserver();
    attachRenameInterceptor();
    attachEvents();

    setInterval(() => {
        ensureFolderManageButton();
        ensureFolderFilterSelect();
        applyPresetFilter(false);
    }, 1500);

    console.log("[ST-Preset-Folder] initialized");
}

function ensureState() {
    if (
        !extension_settings[EXTENSION_KEY] ||
        typeof extension_settings[EXTENSION_KEY] !== "object"
    ) {
        extension_settings[EXTENSION_KEY] = {
            folders: [],
            assignments: {},
            selectedFolderId: ALL_FOLDER_ID,
        };
    }

    const state = extension_settings[EXTENSION_KEY];
    state.folders = Array.isArray(state.folders) ? state.folders : [];
    state.assignments =
        state.assignments && typeof state.assignments === "object"
            ? state.assignments
            : {};
    state.selectedFolderId =
        typeof state.selectedFolderId === "string"
            ? state.selectedFolderId
            : ALL_FOLDER_ID;
}

function getState() {
    ensureState();
    return extension_settings[EXTENSION_KEY];
}

function saveState() {
    saveSettingsDebounced();
}

function normalizeState() {
    const state = getState();
    const existingFolderIds = new Set(state.folders.map((folder) => folder.id));
    const presetNames = new Set(getOpenAIPresetNames());

    for (const key of Object.keys(state.assignments)) {
        const folderId = state.assignments[key];
        const hasFolder = !!folderId && existingFolderIds.has(folderId);
        const hasPreset = presetNames.has(key);

        if (!hasPreset || !hasFolder) {
            delete state.assignments[key];
        }
    }

    if (
        state.selectedFolderId !== ALL_FOLDER_ID &&
        state.selectedFolderId !== UNCATEGORIZED_FOLDER_ID &&
        !existingFolderIds.has(state.selectedFolderId)
    ) {
        state.selectedFolderId = ALL_FOLDER_ID;
    }

    saveState();
}

function getOpenAIPresetSelect() {
    return document.querySelector("#settings_preset_openai");
}

function getOpenAIPresetNames() {
    const select = getOpenAIPresetSelect();
    if (!select) return [];

    return Array.from(select.options)
        .map((option) => String(option.textContent || "").trim())
        .filter(Boolean);
}

function selectOpenAIPresetByName(presetName, triggerChange = true) {
    const select = getOpenAIPresetSelect();
    if (!select || !presetName) return false;

    for (const option of Array.from(select.options)) {
        const optionName = String(option.textContent || "").trim();
        if (optionName !== presetName) continue;

        select.value = option.value;
        option.selected = true;

        if (triggerChange) {
            $(select).trigger("change");
        }

        return true;
    }

    return false;
}

function getAssignedFolderId(presetName) {
    const state = getState();
    return state.assignments[presetName] || "";
}

function setAssignedFolderId(presetName, folderId) {
    const state = getState();
    const isValidFolder = state.folders.some(
        (folder) => folder.id === folderId,
    );

    if (!folderId || folderId === UNCATEGORIZED_FOLDER_ID || !isValidFolder) {
        delete state.assignments[presetName];
    } else {
        state.assignments[presetName] = folderId;
    }

    saveState();
}

function createFolder(name) {
    const state = getState();
    state.folders.push({
        id: makeFolderId(),
        name,
    });
    saveState();
}

function renameFolder(folderId, name) {
    const state = getState();
    const folder = state.folders.find((item) => item.id === folderId);
    if (!folder) return;

    folder.name = name;
    saveState();
}

function deleteFolder(folderId) {
    const state = getState();
    state.folders = state.folders.filter((folder) => folder.id !== folderId);

    for (const presetName of Object.keys(state.assignments)) {
        if (state.assignments[presetName] === folderId) {
            delete state.assignments[presetName];
        }
    }

    if (state.selectedFolderId === folderId) {
        state.selectedFolderId = ALL_FOLDER_ID;
    }

    saveState();
}

function moveFolderByIndex(index, offset) {
    const state = getState();
    const targetIndex = index + offset;

    if (
        index < 0 ||
        targetIndex < 0 ||
        index >= state.folders.length ||
        targetIndex >= state.folders.length
    ) {
        return false;
    }

    const [folder] = state.folders.splice(index, 1);
    state.folders.splice(targetIndex, 0, folder);
    saveState();
    return true;
}

function makeFolderId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `folder_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function ensureFolderManageButton() {
    if (document.querySelector("#stpf-manage-folders-btn")) {
        return;
    }

    const bindLabel = document.querySelector(
        'label[for="bind_preset_to_connection"]',
    );
    if (!bindLabel || !bindLabel.parentElement) {
        return;
    }

    const button = document.createElement("div");
    button.id = "stpf-manage-folders-btn";
    button.className = "margin0 menu_button menu_button_icon";
    button.title = "프리셋 폴더 관리";
    button.innerHTML = '<i class="fa-fw fa-solid fa-folder-tree"></i>';

    button.addEventListener("click", () => {
        void openFolderManagerPopup();
    });

    bindLabel.parentElement.insertBefore(button, bindLabel);
}

function ensureFolderFilterSelect() {
    const select = getOpenAIPresetSelect();
    if (!select || !select.parentElement) {
        return;
    }

    select.parentElement.classList.add("stpf-filter-select-wrap");

    let folderFilter = document.querySelector("#stpf-folder-filter");

    if (!folderFilter) {
        folderFilter = document.createElement("select");
        folderFilter.id = "stpf-folder-filter";
        folderFilter.className = "text_pole stpf-folder-filter marginRight5";
        folderFilter.addEventListener("change", () => {
            const state = getState();
            state.selectedFolderId = folderFilter.value;
            saveState();
            applyPresetFilter(true);
        });
    }

    if (folderFilter.parentElement !== select.parentElement) {
        select.parentElement.insertBefore(folderFilter, select);
    }

    populateFolderFilterSelect(folderFilter);
}

function populateFolderFilterSelect(selectElement) {
    const state = getState();
    const previousValue = state.selectedFolderId || ALL_FOLDER_ID;

    const options = [
        { value: ALL_FOLDER_ID, label: "전체 폴더" },
        ...state.folders.map((folder) => ({
            value: folder.id,
            label: folder.name,
        })),
        { value: UNCATEGORIZED_FOLDER_ID, label: "미분류" },
    ];

    selectElement.innerHTML = "";

    for (const optionData of options) {
        const option = document.createElement("option");
        option.value = optionData.value;
        option.textContent = optionData.label;
        selectElement.appendChild(option);
    }

    const availableValues = new Set(options.map((option) => option.value));
    if (!availableValues.has(previousValue)) {
        state.selectedFolderId = ALL_FOLDER_ID;
    }

    selectElement.value = state.selectedFolderId;
}

function applyPresetFilter(triggerChangeIfNeeded) {
    if (openaiRenameInProgress) {
        return;
    }

    const select = getOpenAIPresetSelect();
    const folderFilter = document.querySelector("#stpf-folder-filter");
    if (!select || !folderFilter) {
        return;
    }

    normalizeState();

    const state = getState();
    const selectedFolderId = folderFilter.value || ALL_FOLDER_ID;
    const existingFolderIds = new Set(state.folders.map((folder) => folder.id));

    let firstVisibleOption = null;
    for (const option of Array.from(select.options)) {
        const presetName = String(option.textContent || "").trim();
        const assignedFolderId = state.assignments[presetName] || "";
        const isAssignedFolderValid =
            assignedFolderId && existingFolderIds.has(assignedFolderId);
        const normalizedAssignedFolderId = isAssignedFolderValid
            ? assignedFolderId
            : "";

        let shouldShow = true;
        if (selectedFolderId === UNCATEGORIZED_FOLDER_ID) {
            shouldShow = !normalizedAssignedFolderId;
        } else if (selectedFolderId !== ALL_FOLDER_ID) {
            shouldShow = normalizedAssignedFolderId === selectedFolderId;
        }

        option.hidden = !shouldShow;
        option.disabled = !shouldShow;
        option.style.display = shouldShow ? "" : "none";
        if (shouldShow && !firstVisibleOption) {
            firstVisibleOption = option;
        }
    }

    const selectedOption = select.selectedOptions?.[0] || null;
    if (triggerChangeIfNeeded && selectedOption?.hidden && firstVisibleOption) {
        firstVisibleOption.selected = true;
        $(select).trigger("change");
    }
}

let presetSelectObserverAttached = false;
function attachPresetSelectObserver() {
    if (presetSelectObserverAttached) return;

    const select = getOpenAIPresetSelect();
    if (!select) return;

    knownPresetNames = new Set(getOpenAIPresetNames());

    const observer = new MutationObserver(() => {
        ensureFolderFilterSelect();
        normalizeState();
        applyPresetFilter(true);
        queueAutoAssignForNewPresets();
    });

    observer.observe(select, { childList: true, subtree: false });

    presetSelectObserverAttached = true;
}

let renameInterceptorAttached = false;
function attachRenameInterceptor() {
    if (renameInterceptorAttached) return;

    document.addEventListener(
        "click",
        (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;

            const renameButton = target.closest(
                '[data-preset-manager-rename="openai"]',
            );
            if (!renameButton) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            void openRenamePresetWithFolderPopup();
        },
        true,
    );

    renameInterceptorAttached = true;
}

function attachEvents() {
    eventSource.on(
        event_types.PRESET_RENAMED,
        ({ apiId, oldName, newName }) => {
            if (apiId !== "openai") return;

            suppressAutoAssignForName(newName);
            knownPresetNames.delete(oldName);
            knownPresetNames.add(newName);

            const state = getState();
            const oldFolderId = state.assignments[oldName];

            if (oldFolderId) {
                state.assignments[newName] = oldFolderId;
                delete state.assignments[oldName];
                saveState();
            }

            applyPresetFilter(true);
        },
    );

    eventSource.on(event_types.PRESET_DELETED, ({ apiId, name }) => {
        if (apiId !== "openai") return;

        knownPresetNames.delete(name);

        const state = getState();
        if (state.assignments[name]) {
            delete state.assignments[name];
            saveState();
        }

        applyPresetFilter(true);
    });

    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        applyPresetFilter(false);
    });
}

function queueAutoAssignForNewPresets() {
    const currentPresetNames = getOpenAIPresetNames();
    const currentSet = new Set(currentPresetNames);
    const addedPresetNames = currentPresetNames.filter(
        (name) => !knownPresetNames.has(name),
    );
    knownPresetNames = currentSet;

    if (!addedPresetNames.length) {
        return;
    }

    for (const presetName of addedPresetNames) {
        if (!presetName) continue;

        if (autoAssignSuppressNames.has(presetName)) {
            autoAssignSuppressNames.delete(presetName);
            continue;
        }

        if (getAssignedFolderId(presetName)) {
            continue;
        }

        autoAssignQueue.push(presetName);
    }

    void processAutoAssignQueue();
}

async function processAutoAssignQueue() {
    if (autoAssignProcessing) return;
    autoAssignProcessing = true;

    try {
        while (autoAssignQueue.length > 0) {
            const presetName = autoAssignQueue.shift();
            if (!presetName) continue;

            const exists = getOpenAIPresetNames().includes(presetName);
            if (!exists) continue;

            const folderId = await showStpfPresetAssignCard(presetName);
            const resolvedFolderId =
                folderId === null ? UNCATEGORIZED_FOLDER_ID : folderId;

            setAssignedFolderId(presetName, resolvedFolderId);
            applyPresetFilter(true);
        }
    } finally {
        autoAssignProcessing = false;
    }
}

function showStpfPresetAssignCard(presetName) {
    return new Promise((resolve) => {
        const state = getState();
        const defaultFolderId = state.folders[0]?.id || UNCATEGORIZED_FOLDER_ID;

        const overlay = document.createElement("div");
        overlay.className = "stpf-mini-overlay";
        overlay.innerHTML = `
            <div class="stpf-mini-card stpf-mini-assign-card" role="dialog" aria-modal="true">
                <div class="stpf-mini-title">프리셋 폴더 분류</div>
                <div class="stpf-mini-message">신규 프리셋이 등록되었습니다. 폴더를 선택하세요.</div>
                <div class="stpf-mini-preset-name">${presetName}</div>
                <select class="text_pole stpf-mini-select" id="stpf-mini-assign-select"></select>
                <div class="stpf-mini-actions">
                    <button type="button" class="menu_button stpf-mini-cancel">취소</button>
                    <button type="button" class="menu_button stpf-mini-confirm">저장</button>
                </div>
            </div>
        `;

        const select = overlay.querySelector("#stpf-mini-assign-select");
        const cancelBtn = overlay.querySelector(".stpf-mini-cancel");
        const confirmBtn = overlay.querySelector(".stpf-mini-confirm");
        populateFolderSelect(select, defaultFolderId, true);

        const finish = (value) => {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
            resolve(value);
        };

        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
            }
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                finish(select.value);
            }
        };

        cancelBtn.addEventListener("click", () => finish(null));
        confirmBtn.addEventListener("click", () => finish(select.value));

        document.addEventListener("keydown", onKeyDown, true);
        document.body.appendChild(overlay);
        select.focus();
    });
}

async function openRenamePresetWithFolderPopup() {
    const presetManager = getPresetManager("openai");
    if (!presetManager) {
        toastr.error("OpenAI 프리셋 매니저를 찾을 수 없습니다.");
        return;
    }

    const oldName = presetManager.getSelectedPresetName();
    if (!oldName) {
        toastr.warning("선택된 프리셋이 없습니다.");
        return;
    }

    const state = getState();
    const currentFolderId = getAssignedFolderId(oldName);

    const content = document.createElement("div");
    content.className = "stpf-rename-popup";
    content.innerHTML = `
        <div class="stpf-field-row">
            <label class="stpf-field-label" for="stpf-rename-name">프리셋 이름</label>
            <input id="stpf-rename-name" class="text_pole" type="text" />
        </div>
        <div class="stpf-field-row">
            <label class="stpf-field-label" for="stpf-rename-folder">폴더</label>
            <select id="stpf-rename-folder" class="text_pole"></select>
        </div>
    `;

    const nameInput = content.querySelector("#stpf-rename-name");
    const folderSelect = content.querySelector("#stpf-rename-folder");

    nameInput.value = oldName;
    populateFolderSelect(
        folderSelect,
        currentFolderId || UNCATEGORIZED_FOLDER_ID,
        true,
    );

    const popup = new Popup(content, POPUP_TYPE.TEXT, "", {
        okButton: "적용",
        cancelButton: "취소",
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const requestedName = await getSanitizedFilename(
        String(nameInput.value || "").trim(),
    );
    if (!requestedName) {
        toastr.warning("이름이 비어 있습니다.");
        return;
    }

    const selectedFolderId = folderSelect.value;
    let finalPresetName = oldName;
    let didRename = false;

    if (requestedName !== oldName) {
        openaiRenameInProgress = true;

        if (equalsIgnoreCaseAndAccents(oldName, requestedName)) {
            openaiRenameInProgress = false;
            toastr.warning("대소문자/악센트를 제외하면 같은 이름입니다.");
            return;
        }

        suppressAutoAssignForName(requestedName);

        try {
            await eventSource.emit(event_types.PRESET_RENAMED_BEFORE, {
                apiId: "openai",
                oldName,
                newName: requestedName,
            });

            const extensions = presetManager.readPresetExtensionField({
                name: oldName,
                path: "",
            });
            await presetManager.renamePreset(requestedName);
            await presetManager.writePresetExtensionField({
                name: requestedName,
                path: "",
                value: extensions,
            });
            await eventSource.emit(event_types.PRESET_RENAMED, {
                apiId: "openai",
                oldName,
                newName: requestedName,
            });

            finalPresetName = requestedName;
            didRename = true;
        } finally {
            openaiRenameInProgress = false;
        }
    }

    setAssignedFolderId(finalPresetName, selectedFolderId);

    if (didRename) {
        selectOpenAIPresetByName(finalPresetName, true);
        $("#update_oai_preset").trigger("click");
    }

    ensureFolderFilterSelect();
    applyPresetFilter(true);
}

async function openFolderManagerPopup() {
    const existingPopup = document.getElementById("stpf-folder-popup-root");
    if (existingPopup) {
        existingPopup.remove();
    }

    const content = document.createElement("div");
    content.id = "stpf-folder-popup-root";
    content.className = "stpf-folder-popup";
    content.innerHTML = `
        <div class="stpf-hero">
            <div class="stpf-hero-icon"><i class="fa-solid fa-folder-tree"></i></div>
            <div class="stpf-hero-texts">
                <div class="stpf-hero-title">Preset Folder Manager</div>
                <div class="stpf-hero-sub">프리셋을 폴더로 분류하고 관리하세요!</div>
            </div>
        </div>

        <div class="stpf-tab-row" role="tablist" aria-label="카테고리">
            <button type="button" class="menu_button stpf-tab-button is-active" data-tab="folder" role="tab" aria-selected="true">폴더 관리</button>
            <button type="button" class="menu_button stpf-tab-button" data-tab="preset" role="tab" aria-selected="false">프리셋 분류</button>
        </div>

        <div class="stpf-folder-manager-grid">
            <section class="stpf-card stpf-folder-controls stpf-tab-panel is-active" data-panel="folder" role="tabpanel">
                <div class="stpf-section-title">
                    <i class="fa-solid fa-folder-open"></i>
                    <span>폴더 관리</span>
                </div>
                <div class="stpf-folder-picker-row">
                    <select id="stpf-folder-list" class="text_pole" aria-label="폴더 선택"></select>
                    <div class="stpf-folder-actions">
                        <button type="button" class="menu_button stpf-add-folder"><i class="fa-solid fa-plus"></i></button>
                        <button type="button" class="menu_button stpf-rename-folder"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="menu_button stpf-delete-folder"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>

                <div class="stpf-folder-order-inline">
                    <div class="stpf-section-title">
                        <i class="fa-solid fa-bars"></i>
                        <span>폴더 순서 변경</span>
                    </div>
                    <div class="stpf-folder-order-list stpf-folder-order-inline-list" id="stpf-folder-order-list"></div>
                </div>
            </section>

            <section class="stpf-card stpf-preset-controls stpf-tab-panel" data-panel="preset" role="tabpanel" hidden>
                <div class="stpf-section-title-row">
                    <div class="stpf-section-title">
                        <i class="fa-solid fa-list-check"></i>
                        <span>프리셋 분류</span>
                    </div>
                    <span class="stpf-result-count" id="stpf-result-count">0 / 0</span>
                </div>

                <div class="stpf-search-row">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="stpf-preset-search" class="text_pole" type="text" placeholder="프리셋 이름 검색" />
                </div>

                <div class="stpf-bulk-row">
                    <div class="stpf-bulk-left">
                        <button type="button" class="menu_button stpf-check-all"><i class="fa-solid fa-check-double"></i></button>
                        <button type="button" class="menu_button stpf-uncheck-all"><i class="fa-solid fa-x"></i></button>
                    </div>
                    <div class="stpf-bulk-right">
                        <select id="stpf-bulk-folder" class="text_pole stpf-bulk-folder"></select>                      
                        <div class="stpf-bulk-actions">
                          <button type="button" class="menu_button stpf-preview-folder">
                            <i class="fa-solid fa-magnifying-glass"></i>
                          </button>
                          <button type="button" class="menu_button stpf-refresh-list" title="목록 새로고침" aria-label="목록 새로고침">
                              <i class="fa-solid fa-rotate-right"></i>
                          </button>
                          <button type="button" class="menu_button stpf-apply-bulk"><i class="fa-solid fa-wand-sparkles"></i></button>
                        </div>
                    </div>
                </div>

                <div class="stpf-preset-list" id="stpf-preset-list"></div>
            </section>
        </div>

        <div class="stpf-popup-footer">
            <button type="button" class="menu_button stpf-close-popup"><i class="fa-solid fa-xmark"></i>닫기</button>
        </div>
    `;

    const folderList = content.querySelector("#stpf-folder-list");
    const presetSearchInput = content.querySelector("#stpf-preset-search");
    const bulkFolderSelect = content.querySelector("#stpf-bulk-folder");
    const resultCount = content.querySelector("#stpf-result-count");
    const presetList = content.querySelector("#stpf-preset-list");
    const folderOrderList = content.querySelector("#stpf-folder-order-list");
    const tabRow = content.querySelector(".stpf-tab-row");
    const tabButtons = Array.from(content.querySelectorAll(".stpf-tab-button"));
    const tabPanels = Array.from(content.querySelectorAll(".stpf-tab-panel"));
    let previewFolderId = "";

    function setActiveTab(tabName) {
        for (const button of tabButtons) {
            const isActive = button.dataset.tab === tabName;
            button.classList.toggle("is-active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        }

        for (const panel of tabPanels) {
            const isActive = panel.dataset.panel === tabName;
            panel.classList.toggle("is-active", isActive);
            panel.hidden = !isActive;
        }
    }

    function getSearchKeyword() {
        return String(presetSearchInput?.value || "").toLowerCase();
    }

    function refreshFolderControls(selectedFolderId = "") {
        const state = getState();

        folderList.innerHTML = "";
        for (const folder of state.folders) {
            const option = document.createElement("option");
            option.value = folder.id;
            option.textContent = folder.name;
            folderList.appendChild(option);
        }

        if (state.folders.length > 0) {
            const fallbackId = state.folders[0].id;
            folderList.value =
                selectedFolderId &&
                state.folders.some((folder) => folder.id === selectedFolderId)
                    ? selectedFolderId
                    : fallbackId;
        }

        populateFolderSelect(bulkFolderSelect, ALL_FOLDER_ID, true, true);
        refreshFolderOrderList();
    }

    function refreshFolderOrderList() {
        const folders = getState().folders;
        folderOrderList.innerHTML = "";

        if (!folders.length) {
            const empty = document.createElement("div");
            empty.className = "stpf-folder-order-empty";
            empty.textContent = "등록된 폴더가 없습니다.";
            folderOrderList.appendChild(empty);
            return;
        }

        for (let index = 0; index < folders.length; index++) {
            const folder = folders[index];
            const row = document.createElement("div");
            row.className = "stpf-folder-order-row";

            const name = document.createElement("div");
            name.className = "stpf-folder-order-name";
            name.textContent = folder.name;

            const actions = document.createElement("div");
            actions.className = "stpf-folder-order-actions";

            const upButton = document.createElement("button");
            upButton.type = "button";
            upButton.className = "menu_button stpf-folder-order-up";
            upButton.innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
            upButton.disabled = index === 0;

            const downButton = document.createElement("button");
            downButton.type = "button";
            downButton.className = "menu_button stpf-folder-order-down";
            downButton.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
            downButton.disabled = index === folders.length - 1;

            upButton.addEventListener("click", () => {
                if (moveFolderByIndex(index, -1)) {
                    refreshFolderControls(folder.id);
                    refreshPresetList();
                    ensureFolderFilterSelect();
                    applyPresetFilter(false);
                }
            });

            downButton.addEventListener("click", () => {
                if (moveFolderByIndex(index, 1)) {
                    refreshFolderControls(folder.id);
                    refreshPresetList();
                    ensureFolderFilterSelect();
                    applyPresetFilter(false);
                }
            });

            actions.appendChild(upButton);
            actions.appendChild(downButton);
            row.appendChild(name);
            row.appendChild(actions);
            folderOrderList.appendChild(row);
        }
    }

    function isDuplicateFolderName(name, excludeFolderId = "") {
        const state = getState();
        return state.folders.some((folder) => {
            if (excludeFolderId && folder.id === excludeFolderId) return false;
            return equalsIgnoreCaseAndAccents(folder.name, name);
        });
    }

    function refreshPresetList() {
        const keyword = getSearchKeyword();
        const allPresetNames = getOpenAIPresetNames();
        const scopedPresetNames = previewFolderId
            ? allPresetNames.filter((name) => {
                  const assignedFolderId =
                      getAssignedFolderId(name) || UNCATEGORIZED_FOLDER_ID;
                  return assignedFolderId === previewFolderId;
              })
            : allPresetNames;

        const presetNames = scopedPresetNames.filter((name) => {
            if (!keyword) return true;
            return name.toLowerCase().includes(keyword);
        });

        if (resultCount) {
            resultCount.textContent = `${presetNames.length} / ${scopedPresetNames.length}`;
        }

        presetList.innerHTML = "";

        if (!presetNames.length) {
            const empty = document.createElement("div");
            empty.className = "stpf-empty";
            empty.textContent = keyword
                ? "검색 결과가 없습니다."
                : "표시할 프리셋이 없습니다.";
            presetList.appendChild(empty);
            return;
        }

        for (const presetName of presetNames) {
            const row = document.createElement("div");
            row.className = "stpf-preset-row";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "stpf-row-check";
            checkbox.dataset.presetName = presetName;

            const name = document.createElement("div");
            name.className = "stpf-preset-name";
            name.textContent = presetName;

            const folderSelect = document.createElement("select");
            folderSelect.className = "text_pole stpf-row-folder";
            folderSelect.dataset.presetName = presetName;
            populateFolderSelect(
                folderSelect,
                getAssignedFolderId(presetName) || UNCATEGORIZED_FOLDER_ID,
                true,
            );

            folderSelect.addEventListener("change", () => {
                setAssignedFolderId(presetName, folderSelect.value);
                applyPresetFilter(false);
            });

            row.appendChild(checkbox);
            row.appendChild(name);
            row.appendChild(folderSelect);
            presetList.appendChild(row);
        }
    }

    content
        .querySelector(".stpf-add-folder")
        .addEventListener("click", async () => {
            const name = String(
                (await showStpfInputCard({
                    title: "폴더 추가",
                    message: "이름을 입력하고 저장하세요.",
                    defaultValue: "",
                    confirmText: "저장",
                    cancelText: "취소",
                })) || "",
            ).trim();

            if (!name) {
                toastr.warning("폴더 이름을 입력하세요.");
                return;
            }

            if (isDuplicateFolderName(name)) {
                toastr.warning("동일한 폴더 이름이 있습니다.");
                return;
            }

            const state = getState();
            createFolder(name);
            refreshFolderControls(
                state.folders[state.folders.length - 1]?.id || "",
            );
            refreshPresetList();
            ensureFolderFilterSelect();
            applyPresetFilter(false);
        });

    presetSearchInput.addEventListener("input", () => {
        refreshPresetList();
    });

    content.querySelector(".stpf-check-all").addEventListener("click", () => {
        const checkboxes = Array.from(
            content.querySelectorAll(".stpf-row-check"),
        );
        for (const checkbox of checkboxes) {
            checkbox.checked = true;
        }
    });

    content.querySelector(".stpf-uncheck-all").addEventListener("click", () => {
        const checkboxes = Array.from(
            content.querySelectorAll(".stpf-row-check"),
        );
        for (const checkbox of checkboxes) {
            checkbox.checked = false;
        }
    });

    content
        .querySelector(".stpf-rename-folder")
        .addEventListener("click", async () => {
            const selectedFolderId = folderList.value;
            if (!selectedFolderId) {
                toastr.warning("수정할 폴더를 선택하세요.");
                return;
            }

            const selectedFolder = getState().folders.find(
                (folder) => folder.id === selectedFolderId,
            );
            const newName = String(
                (await showStpfInputCard({
                    title: "폴더 수정",
                    message: "새 이름을 입력하고 저장하세요.",
                    defaultValue: selectedFolder?.name || "",
                    confirmText: "저장",
                    cancelText: "취소",
                })) || "",
            ).trim();

            if (!newName) {
                toastr.warning("폴더 이름을 입력하세요.");
                return;
            }

            if (isDuplicateFolderName(newName, selectedFolderId)) {
                toastr.warning("동일한 폴더 이름이 있습니다.");
                return;
            }

            renameFolder(selectedFolderId, newName);
            refreshFolderControls(selectedFolderId);
            refreshPresetList();
            ensureFolderFilterSelect();
            applyPresetFilter(false);
        });

    content
        .querySelector(".stpf-delete-folder")
        .addEventListener("click", async () => {
            const selectedFolderId = folderList.value;
            if (!selectedFolderId) {
                toastr.warning("삭제할 폴더를 선택하세요.");
                return;
            }

            const selectedFolder = getState().folders.find(
                (folder) => folder.id === selectedFolderId,
            );
            const confirmed = await showStpfConfirmCard({
                title: "폴더 삭제",
                message: `<b>${selectedFolder?.name || "선택한 폴더"}</b> 폴더를 삭제하시겠습니까?<br>해당 폴더에 속한 프리셋은 미분류로 전환됩니다.`,
                confirmText: "삭제",
                cancelText: "취소",
            });

            if (!confirmed) {
                return;
            }

            deleteFolder(selectedFolderId);
            refreshFolderControls();
            refreshPresetList();
            ensureFolderFilterSelect();
            applyPresetFilter(true);
        });

    tabRow?.addEventListener("click", (event) => {
        const button = event.target?.closest(".stpf-tab-button");
        if (!button) return;
        setActiveTab(button.dataset.tab || "folder");
    });

    content.querySelector(".stpf-apply-bulk").addEventListener("click", () => {
        const folderId = bulkFolderSelect.value;

        if (folderId === ALL_FOLDER_ID) {
            toastr.info(
                "전체 폴더는 보기 전용입니다. 적용할 폴더를 선택하세요.",
            );
            return;
        }

        const checkedRows = Array.from(
            content.querySelectorAll(".stpf-row-check:checked"),
        );

        if (!checkedRows.length) {
            toastr.info("체크된 프리셋이 없습니다.");
            return;
        }

        for (const checkbox of checkedRows) {
            const presetName = checkbox.dataset.presetName;
            if (presetName) {
                setAssignedFolderId(presetName, folderId);
            }

            const row = checkbox.closest(".stpf-preset-row");
            const rowFolderSelect = row?.querySelector(".stpf-row-folder");
            if (rowFolderSelect) {
                rowFolderSelect.value = folderId;
            }
        }

        applyPresetFilter(false);
    });

    content
        .querySelector(".stpf-preview-folder")
        .addEventListener("click", () => {
            const selectedFolderId = bulkFolderSelect.value || "";
            previewFolderId =
                selectedFolderId === ALL_FOLDER_ID ? "" : selectedFolderId;
            refreshPresetList();
        });

    content
        .querySelector(".stpf-refresh-list")
        .addEventListener("click", () => {
            refreshPresetList();
        });

    refreshFolderControls();
    refreshPresetList();
    setActiveTab("folder");

    const closePopup = () => {
        document.removeEventListener("keydown", onEscClose);
        document
            .querySelectorAll(".stpf-mini-overlay")
            .forEach((node) => node.remove());
        content.remove();
    };

    const onEscClose = (event) => {
        if (event.key === "Escape") {
            if (document.querySelector(".stpf-mini-overlay")) {
                return;
            }
            closePopup();
        }
    };

    content
        .querySelector(".stpf-close-popup")
        .addEventListener("click", closePopup);

    document.addEventListener("keydown", onEscClose);
    document.body.appendChild(content);

    ensureFolderFilterSelect();
    applyPresetFilter(true);
}

function showStpfInputCard({
    title,
    message,
    defaultValue = "",
    confirmText = "저장",
    cancelText = "취소",
}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "stpf-mini-overlay";
        overlay.innerHTML = `
            <div class="stpf-mini-card stpf-mini-input-card" role="dialog" aria-modal="true">
                <div class="stpf-mini-title">${title}</div>
                <div class="stpf-mini-message">${message}</div>
                <input class="text_pole stpf-mini-input" type="text" />
                <div class="stpf-mini-actions">
                    <button type="button" class="menu_button stpf-mini-cancel">${cancelText}</button>
                    <button type="button" class="menu_button stpf-mini-confirm">${confirmText}</button>
                </div>
            </div>
        `;

        const input = overlay.querySelector(".stpf-mini-input");
        const cancelBtn = overlay.querySelector(".stpf-mini-cancel");
        const confirmBtn = overlay.querySelector(".stpf-mini-confirm");

        input.value = defaultValue;

        const finish = (value) => {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
            resolve(value);
        };

        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
            }
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                finish(String(input.value || "").trim());
            }
        };

        cancelBtn.addEventListener("click", () => finish(null));
        confirmBtn.addEventListener("click", () =>
            finish(String(input.value || "").trim()),
        );

        document.addEventListener("keydown", onKeyDown, true);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
}

function showStpfConfirmCard({
    title,
    message,
    confirmText = "삭제",
    cancelText = "취소",
}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "stpf-mini-overlay";
        overlay.innerHTML = `
            <div class="stpf-mini-card stpf-mini-confirm-card" role="dialog" aria-modal="true">
                <div class="stpf-mini-title">${title}</div>
                <div class="stpf-mini-message">${message}</div>
                <div class="stpf-mini-actions">
                    <button type="button" class="menu_button stpf-mini-cancel">${cancelText}</button>
                    <button type="button" class="menu_button stpf-mini-danger">${confirmText}</button>
                </div>
            </div>
        `;

        const cancelBtn = overlay.querySelector(".stpf-mini-cancel");
        const confirmBtn = overlay.querySelector(".stpf-mini-danger");

        const finish = (value) => {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
            resolve(value);
        };

        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                finish(true);
            }
        };

        cancelBtn.addEventListener("click", () => finish(false));
        confirmBtn.addEventListener("click", () => finish(true));

        document.addEventListener("keydown", onKeyDown, true);
        document.body.appendChild(overlay);
        confirmBtn.focus();
    });
}

function populateFolderSelect(
    selectElement,
    selectedValue,
    includeUncategorized,
    includeAllTop = false,
) {
    const state = getState();
    selectElement.innerHTML = "";

    if (includeAllTop) {
        const allOption = document.createElement("option");
        allOption.value = ALL_FOLDER_ID;
        allOption.textContent = "전체 폴더";
        selectElement.appendChild(allOption);
    }

    for (const folder of state.folders) {
        const option = document.createElement("option");
        option.value = folder.id;
        option.textContent = folder.name;
        selectElement.appendChild(option);
    }

    if (includeUncategorized) {
        const noneOption = document.createElement("option");
        noneOption.value = UNCATEGORIZED_FOLDER_ID;
        noneOption.textContent = "미분류";
        selectElement.appendChild(noneOption);
    }

    const values = new Set(
        Array.from(selectElement.options).map((option) => option.value),
    );
    if (values.has(selectedValue)) {
        selectElement.value = selectedValue;
    } else if (values.has(UNCATEGORIZED_FOLDER_ID)) {
        selectElement.value = UNCATEGORIZED_FOLDER_ID;
    } else if (selectElement.options.length > 0) {
        selectElement.selectedIndex = 0;
    }
}

async function waitForOpenAIPresetUI() {
    const timeoutMs = 30000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (
            getOpenAIPresetSelect() &&
            document.querySelector('[data-preset-manager-rename="openai"]')
        ) {
            return;
        }

        await delay(150);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
