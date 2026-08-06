<script lang="ts">
    import { onMount } from "svelte"
    import { sttBibleVersions, sttDebugLogPath, sttModels, sttSettings, sttStatus } from "./sttStore"
    import { downloadModel, deleteModel, getMicrophones, refreshBibleVersions, requestModels, setModel } from "./sttManager"
    import { requestSttDebugLogPath } from "./sttDebug"

    let microphones: MediaDeviceInfo[] = []
    const importMetaEnv = import.meta as unknown as { env?: { DEV?: boolean } }

    onMount(async () => {
        requestModels()
        refreshBibleVersions()
        requestSttDebugLogPath()
        try {
            microphones = await getMicrophones()
        } catch {
            microphones = []
        }
    })

    function handleModelChange(e: Event) {
        const modelId = (e.target as HTMLSelectElement).value
        setModel(modelId)
    }

    function handleMicChange(e: Event) {
        const micId = (e.target as HTMLSelectElement).value
        sttSettings.update((s) => ({ ...s, microphoneId: micId }))
    }

    function handleThresholdChange(e: Event) {
        const value = parseFloat((e.target as HTMLInputElement).value)
        sttSettings.update((s) => ({ ...s, confidenceThreshold: value }))
    }

    function handleQuoteThresholdChange(e: Event) {
        const value = parseFloat((e.target as HTMLInputElement).value)
        sttSettings.update((s) => ({ ...s, autoShowQuoteMinConfidence: value }))
    }

    function handleBibleVersionChange(e: Event) {
        const versionId = (e.target as HTMLSelectElement).value
        sttSettings.update((s) => ({ ...s, bibleVersionId: versionId }))
    }

    function toggleBibleAutoShow() {
        sttSettings.update((s) => ({ ...s, autoShowBible: !s.autoShowBible }))
    }

    function toggleMatchQuotedVerseText() {
        sttSettings.update((s) => ({ ...s, matchQuotedVerseText: !s.matchQuotedVerseText }))
    }

    function toggleDebugLogging() {
        sttSettings.update((s) => ({ ...s, debugLogging: !s.debugLogging }))
        if (!$sttDebugLogPath) requestSttDebugLogPath()
    }

    function handleDownload(modelId: string) {
        downloadModel(modelId)
    }

    function handleDelete(modelId: string) {
        if (confirm(`Are you sure you want to delete the ${modelId} model?`)) {
            deleteModel(modelId)
        }
    }

    $: activeModel = $sttModels.find((m) => m.id === $sttSettings.model)
    $: currentModelDownloaded = activeModel?.downloaded || false
    $: downloadPercent = $sttStatus.downloadTotal > 0 ? Math.min(100, Math.round(($sttStatus.downloadProgress / $sttStatus.downloadTotal) * 100)) : 0
    $: isDev = !!importMetaEnv.env?.DEV
</script>

<div class="stt-settings">
    <div class="stt-setting-row model-manager">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <span class="stt-setting-label model-label">{isDev ? "[DEV] Model Manager" : "Model"}</span>
            {#if currentModelDownloaded}
                {#if isDev}
                    <button class="stt-btn-download danger" on:click={() => handleDelete($sttSettings.model)}>Delete</button>
                {:else}
                    <span class="stt-model-status">Downloaded</span>
                {/if}
            {:else if !$sttStatus.isDownloading}
                <button class="stt-btn-download" on:click={() => handleDownload($sttSettings.model)}>Download</button>
            {/if}
        </div>
        <select class="stt-select" value={$sttSettings.model} on:change={handleModelChange}>
            {#each $sttModels as model}
                <option value={model.id}>{model.downloaded ? "✓ " : ""}{model.displayName} — {model.description}</option>
            {/each}
            {#if $sttModels.length === 0}
                <option value="nemotron-en-int8">NVIDIA Nemotron (English)</option>
            {/if}
        </select>
    </div>

    <!-- Progress bar shown when auto-downloading -->
    {#if $sttStatus.isDownloading}
        <div class="stt-setting-row" style="flex-direction: column; align-items: stretch; gap: 8px;">
            <div class="stt-download-container">
                <div class="stt-download-bar">
                    <div class="stt-download-fill" style="width: {downloadPercent}%"></div>
                </div>
                <span class="stt-download-text">Downloading {$sttSettings.model}... {downloadPercent}%</span>
            </div>
        </div>
    {/if}

    <!-- Bible version -->
    {#if $sttBibleVersions.length > 0}
        <div class="stt-setting-row">
            <label class="stt-setting-label" for="stt-bible-version">Bible Version</label>
            <select id="stt-bible-version" class="stt-select" value={$sttSettings.bibleVersionId} on:change={handleBibleVersionChange}>
                <option value="">Auto (active)</option>
                {#each $sttBibleVersions as version}
                    <option value={version.id}>{version.name}</option>
                {/each}
            </select>
        </div>
    {/if}

    <div class="stt-setting-row header-like">Automation</div>

    <div class="stt-setting-row">
        <label class="stt-setting-label" for="auto-show-bible">Auto-project Verses</label>
        <input type="checkbox" id="auto-show-bible" class="stt-checkbox" checked={$sttSettings.autoShowBible} on:change={toggleBibleAutoShow} />
    </div>

    <div class="stt-setting-row">
        <label class="stt-setting-label" for="match-quoted-verse" title="Match spoken verse wording against your Bible translation (default off — enable when you want quote-by-content; quotations need higher confidence)">Match quoted verse text</label>
        <input type="checkbox" id="match-quoted-verse" class="stt-checkbox" checked={$sttSettings.matchQuotedVerseText} on:change={toggleMatchQuotedVerseText} />
    </div>

    <div class="stt-setting-row">
        <label class="stt-setting-label" for="stt-debug-logging" title="Write structured STT events to stt-debug.log for bible testing (default on)">Debug logging</label>
        <input type="checkbox" id="stt-debug-logging" class="stt-checkbox" checked={$sttSettings.debugLogging} on:change={toggleDebugLogging} />
    </div>
    {#if $sttSettings.debugLogging && $sttDebugLogPath}
        <div class="stt-debug-path" title={$sttDebugLogPath}>Writing to: {$sttDebugLogPath}</div>
    {/if}

    <!-- Microphone -->
    <div class="stt-setting-row">
        <label class="stt-setting-label" for="stt-microphone">Microphone</label>
        <select id="stt-microphone" class="stt-select" value={$sttSettings.microphoneId} on:change={handleMicChange}>
            <option value="">Default</option>
            {#each microphones as mic}
                <option value={mic.deviceId}>{mic.label || "Microphone " + mic.deviceId.slice(0, 8)}</option>
            {/each}
        </select>
    </div>

    <!-- Confidence threshold (spoken refs) -->
    <div class="stt-setting-row">
        <label class="stt-setting-label" for="stt-confidence" title="Minimum confidence for spoken references (direct/contextual)">Min. Confidence (refs)</label>
        <div class="stt-slider-container">
            <input id="stt-confidence" type="range" class="stt-slider" min="0.5" max="1.0" step="0.05" value={$sttSettings.confidenceThreshold} on:input={handleThresholdChange} />
            <span class="stt-slider-value">{Math.round($sttSettings.confidenceThreshold * 100)}%</span>
        </div>
    </div>

    <!-- Quote confidence (source-aware, higher default) -->
    <div class="stt-setting-row">
        <label class="stt-setting-label" for="stt-quote-confidence" title="Quotations need a higher bar than spoken refs (default 90%)">Min. Confidence (quotes)</label>
        <div class="stt-slider-container">
            <input id="stt-quote-confidence" type="range" class="stt-slider" min="0.7" max="1.0" step="0.05" value={$sttSettings.autoShowQuoteMinConfidence} on:input={handleQuoteThresholdChange} />
            <span class="stt-slider-value">{Math.round($sttSettings.autoShowQuoteMinConfidence * 100)}%</span>
        </div>
    </div>
</div>

<style>
    .stt-settings {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-family: var(--font-family);
    }

    .stt-setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .stt-setting-row.model-manager {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
        background-color: var(--primary-darker);
        padding: 12px;
        border-radius: 8px;
    }

    .stt-setting-row.header-like {
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 10px;
        color: var(--secondary);
        margin-top: 10px;
        border-bottom: 1px solid var(--primary-lighter);
        padding-bottom: 4px;
    }

    .stt-checkbox {
        width: 14px;
        height: 14px;
        cursor: pointer;
    }

    .stt-setting-label {
        font-size: 11px;
        color: var(--text);
        opacity: 0.8;
        white-space: nowrap;
    }

    .stt-setting-label.model-label {
        color: var(--secondary);
        opacity: 1;
    }

    .stt-model-status {
        font-size: 11px;
        color: var(--connected);
        opacity: 0.9;
    }

    .stt-model-warn {
        font-size: 10px;
        color: var(--text);
        opacity: 0.7;
        line-height: 1.35;
        margin-top: 2px;
    }

    .stt-debug-path {
        font-size: 10px;
        color: var(--text);
        opacity: 0.55;
        word-break: break-all;
        line-height: 1.35;
        margin-top: -4px;
        padding: 0 2px 4px;
    }

    .stt-select {
        flex: 1;
        min-width: 0;
        padding: 4px 6px;
        font-size: 11px;
        background-color: var(--primary);
        border: 1px solid var(--primary-lighter);
        border-radius: 6px;
        color: var(--text);
        cursor: pointer;
        font-family: inherit;
    }
    .stt-select:focus {
        outline: 1px solid var(--secondary);
    }

    .stt-slider-container {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
    }
    .stt-slider {
        flex: 1;
        height: 4px;
        -webkit-appearance: none;
        appearance: none;
        background: var(--hover);
        border-radius: 2px;
        outline: none;
    }
    .stt-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--secondary);
        cursor: pointer;
    }
    .stt-slider-value {
        font-size: 10px;
        color: var(--text);
        opacity: 0.7;
        min-width: 30px;
        text-align: right;
    }

    .stt-btn-download {
        padding: 4px 12px;
        border: none;
        border-radius: 6px;
        background: var(--secondary-opacity);
        color: var(--text);
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
    }
    .stt-btn-download:hover:not(:disabled) {
        background: var(--secondary);
    }
    .stt-btn-download.danger {
        background: var(--disconnected);
        color: var(--text);
    }
    .stt-btn-download.danger:hover:not(:disabled) {
        filter: brightness(1.15);
    }
    .stt-btn-download:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .stt-download-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-top: 4px;
    }
    .stt-download-bar {
        height: 6px;
        background: var(--hover);
        border-radius: 3px;
        overflow: hidden;
    }
    .stt-download-fill {
        height: 100%;
        background: var(--secondary);
        transition: width 0.3s;
        border-radius: 3px;
    }
    .stt-download-text {
        font-size: 0.75rem;
        color: var(--text);
        opacity: 0.7;
        text-align: right;
    }
</style>
