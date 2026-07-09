<script lang="ts">
    import { onMount } from "svelte"
    import { sttActiveTab, sttDetections, sttEnabled, sttOverlayVisible, sttMinimized, sttPartialTranscript, sttSettings, sttSettingsOpen, sttSongDetections, sttSongLockState, sttStatus, sttTranscript, sttError, sttModels } from "./sttStore"
    import { clearBibleDetections, clearSongDetections, dismissDetection, dismissSongDetection, projectLockedSlide, showSongDetection, stepLockedSlide, stopStt, toggleStt, unlockSong, downloadModel, deleteModel, requestModels, setModel } from "./sttManager"
    import { showDetection } from "./sttScriptureHelper"
    import SttSettings from "./SttSettings.svelte"

    let posX = 20
    let posY = 80
    let dragging = false
    let dragOffset = { x: 0, y: 0 }

    const importMetaEnv = import.meta as unknown as { env?: { DEV?: boolean } }
    $: isDev = !!importMetaEnv.env?.DEV

    onMount(() => {
        if (importMetaEnv.env?.DEV) {
            requestModels()
        }
    })

    function startDrag(e: MouseEvent) {
        if ((e.target as HTMLElement).closest("button, input, select, textarea, .stt-settings-panel, .stt-dev-panel, .stt-transcript-scroll")) return
        dragging = true
        dragOffset = { x: e.clientX - posX, y: e.clientY - posY }
    }

    function onMouseMove(e: MouseEvent) {
        if (!dragging) return
        posX = e.clientX - dragOffset.x
        posY = e.clientY - dragOffset.y
    }

    function onMouseUp() {
        dragging = false
    }

    function formatConfidence(confidence: number): string {
        return Math.round(confidence * 100) + "%"
    }

    function handleShowVerse(detection: any) {
        showDetection(detection)
    }

    function handleCloseOverlay() {
        stopStt()
        sttOverlayVisible.set(false)
    }

    function handleModelChange(e: Event) {
        const modelId = (e.target as HTMLSelectElement).value
        setModel(modelId)
    }

    function clearBibleHistory() {
        clearBibleDetections()
    }

    let displayTranscript: string
    let downloadPercent: number
    let statusLabel: string
    let transcriptPlaceholder: string
    let activeModel: any
    let currentModelDownloaded: boolean
    let sttActive: boolean
    let sttStarting: boolean

    $: displayTranscript = $sttPartialTranscript || $sttTranscript
    $: downloadPercent = $sttStatus.downloadTotal > 0 ? Math.round(($sttStatus.downloadProgress / $sttStatus.downloadTotal) * 100) : 0
    $: sttActive = $sttEnabled || $sttStatus.connected
    $: sttStarting = $sttEnabled && !$sttStatus.connected
    $: statusLabel = $sttStatus.isDownloading ? "Downloading" : sttStarting ? "Starting" : $sttStatus.connected ? "Listening" : "Idle"
    $: transcriptPlaceholder = $sttStatus.isDownloading ? "Model download in progress..." : sttStarting ? "Starting speech recognition..." : $sttStatus.connected ? ($sttSettings.songDetection ? "Listening for scripture references and song lyrics..." : "Listening for scripture references...") : "Press Start to begin listening."

    $: activeModel = $sttModels.find((m) => m.id === $sttSettings.model)
    $: currentModelDownloaded = activeModel?.downloaded || false
</script>

<svelte:window on:mousemove={onMouseMove} on:mouseup={onMouseUp} />

<div class="stt-overlay-container" class:collapsed={$sttMinimized} style="left: {posX}px; top: {posY}px;" on:mousedown={startDrag}>
    <!-- HEADER -->
    <header class="stt-overlay-header">
        <div class="stt-header-left">
            <div class="stt-status-dot" class:active={sttActive}></div>
            <div class="stt-title-block">
                <h1 class="stt-title">Speech Detection</h1>
                <span class="stt-subtitle">{statusLabel}</span>
            </div>
        </div>
        <div class="stt-header-right">
            <button class="stt-btn-header-action" class:active={sttActive} disabled={$sttStatus.isDownloading} on:click={toggleStt} title={sttActive ? "Stop Listening" : "Start Listening"}>
                {sttActive ? "⏹ Stop" : "▶ Start"}
            </button>
            <button class="stt-btn-icon" title="Settings" on:click={() => sttSettingsOpen.update((v) => !v)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path
                        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                    ></path>
                </svg>
            </button>
            <button class="stt-btn-icon" title={$sttMinimized ? "Expand" : "Minimize"} on:click={() => sttMinimized.update((v) => !v)}>
                {$sttMinimized ? "➕" : "➖"}
            </button>
            <button class="stt-btn-icon close-btn" title="Stop & Close" on:click={handleCloseOverlay}>✕</button>
        </div>
    </header>

    {#if !$sttMinimized}
        <div class="stt-overlay-body">
            <!-- Global Error -->
            {#if $sttError}
                <div class="stt-notification error">
                    <p>{$sttError}</p>
                    <button class="stt-btn-icon small" on:click={() => sttError.set("")}>✕</button>
                </div>
            {/if}

            <!-- Download Status -->
            {#if $sttStatus.isDownloading}
                <div class="stt-notification info">
                    <div class="stt-progress-container">
                        <div class="stt-progress-bar" style="width: {downloadPercent}%"></div>
                    </div>
                    <span class="stt-progress-text">Downloading model... {downloadPercent}%</span>
                </div>
            {/if}

            <!-- Settings Extensible Area -->
            {#if $sttSettingsOpen}
                <div class="stt-settings-panel">
                    <SttSettings />
                </div>
            {/if}

            <!-- TRANSCRIPT AREA -->
            <section class="stt-section">
                <div class="stt-transcript-box">
                    {#if displayTranscript}
                        <p class="stt-transcript-active">{displayTranscript}</p>
                    {:else}
                        <p class="stt-transcript-empty">{transcriptPlaceholder}</p>
                    {/if}
                </div>
            </section>

            <!-- MODE TABS -->
            <div class="stt-tabs" role="tablist">
                <button class="stt-tab" class:active={$sttActiveTab === "bible"} role="tab" aria-selected={$sttActiveTab === "bible"} on:click={() => sttActiveTab.set("bible")}>
                    Bible <span class="stt-badge">{$sttDetections.length}</span>
                </button>
                <button class="stt-tab" class:active={$sttActiveTab === "songs"} role="tab" aria-selected={$sttActiveTab === "songs"} on:click={() => sttActiveTab.set("songs")}>
                    Songs <span class="stt-badge">{$sttSongDetections.length}</span>
                </button>
            </div>

            <!-- RESULTS AREA -->
            {#if $sttActiveTab === "bible"}
                <section class="stt-section results-section">
                    <div class="stt-results-container">
                        {#if $sttDetections.length > 0}
                            <div class="stt-results-actions">
                                <button class="stt-btn-secondary outline" on:click={clearBibleHistory}>Clear all</button>
                            </div>
                            <div class="stt-list">
                                {#each $sttDetections as detection (detection.id)}
                                    <div class="stt-list-item">
                                        <div class="stt-item-header">
                                            <strong class="stt-item-title">{detection.bookName} {detection.chapter}:{detection.verseStart}{detection.verseEnd ? "-" + detection.verseEnd : ""}</strong>
                                            <span class="stt-item-conf">{formatConfidence(detection.confidence)}</span>
                                        </div>
                                        {#if detection.transcriptSnippet}
                                            <p class="stt-item-desc">"{detection.transcriptSnippet}"</p>
                                        {/if}
                                        <div class="stt-item-actions">
                                            <button class="stt-btn-secondary outline" on:click={() => dismissDetection(detection.id)}>Dismiss</button>
                                            <button class="stt-btn-secondary" on:click={() => handleShowVerse(detection)}>Project</button>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {:else}
                            <div class="stt-empty-state">Looking for scripture references...</div>
                        {/if}
                    </div>
                </section>
            {:else if !$sttSettings.songDetection}
                <section class="stt-section results-section">
                    <div class="stt-empty-state">Song detection is off — enable it in settings.</div>
                </section>
            {:else}
                <!-- SONGS -->
                {#if $sttSongLockState}
                    <section class="stt-section stt-lock-panel">
                        <div class="stt-section-title-row">
                            <span class="stt-section-title">🔒 {$sttSongLockState.showName}</span>
                            <span class="stt-item-conf">Slide {$sttSongLockState.slideIndex + 1}/{$sttSongLockState.slideCount}</span>
                        </div>
                        {#if $sttSongLockState.suggestedSlideIndex !== null && $sttSongLockState.suggestedSlideIndex !== $sttSongLockState.slideIndex}
                            <div class="stt-lock-suggestion">
                                <span>Singing slide {$sttSongLockState.suggestedSlideIndex + 1} ({formatConfidence($sttSongLockState.confidence)})</span>
                                <button class="stt-btn-secondary" on:click={() => projectLockedSlide($sttSongLockState?.suggestedSlideIndex ?? 0)}>Apply</button>
                            </div>
                        {/if}
                        <div class="stt-item-actions">
                            <button class="stt-btn-secondary outline" on:click={() => stepLockedSlide(-1)}>‹ Prev</button>
                            <button class="stt-btn-secondary outline" on:click={() => stepLockedSlide(1)}>Next ›</button>
                            <button class="stt-btn-secondary outline" on:click={unlockSong}>Unlock</button>
                        </div>
                    </section>
                {/if}

                <section class="stt-section results-section">
                    <div class="stt-results-container">
                        {#if $sttSongDetections.length > 0}
                            <div class="stt-results-actions">
                                <button class="stt-btn-secondary outline" on:click={clearSongDetections}>Clear all</button>
                            </div>
                            <div class="stt-list">
                                {#each $sttSongDetections as song (song.id)}
                                    <div class="stt-list-item">
                                        <div class="stt-item-header">
                                            <strong class="stt-item-title">{song.showName}{song.slideIndex !== undefined ? ` - Slide ${song.slideIndex + 1}` : ""}</strong>
                                            <span class="stt-item-conf">{formatConfidence(song.confidence)}</span>
                                        </div>
                                        {#if song.matchedText}
                                            <p class="stt-item-desc">"{song.matchedText}"</p>
                                        {/if}
                                        <div class="stt-item-actions">
                                            <button class="stt-btn-secondary outline" on:click={() => dismissSongDetection(song.id)}>Dismiss</button>
                                            <button class="stt-btn-secondary" on:click={() => showSongDetection(song)}>Project</button>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {:else}
                            <div class="stt-empty-state">Listening for song lyrics...</div>
                        {/if}
                    </div>
                </section>
            {/if}

            <!-- DEV MODE MODEL MANAGER -->
            {#if isDev}
                <section class="stt-dev-panel">
                    <div class="stt-dev-header">
                        <span class="stt-dev-title">🛠 Dev Model Manager</span>
                        {#if currentModelDownloaded}
                            <button class="stt-btn-danger" on:click={() => deleteModel($sttSettings.model)}>Delete Local</button>
                        {:else if !$sttStatus.isDownloading}
                            <button class="stt-btn-success" on:click={() => downloadModel($sttSettings.model)}>Download Now</button>
                        {/if}
                    </div>
                    <select class="stt-dev-select" value={$sttSettings.model} on:change={handleModelChange}>
                        {#each $sttModels as model}
                            <option value={model.id}>{model.downloaded ? "✓ " : ""}{model.displayName} - {model.description}</option>
                        {/each}
                        {#if $sttModels.length === 0}
                            <option value="small.en">Small (EN)</option>
                        {/if}
                    </select>
                    {#if $sttStatus.isDownloading}
                        <div class="stt-dev-progress">
                            <div class="stt-progress-container compact">
                                <div class="stt-progress-bar" style="width: {downloadPercent}%"></div>
                            </div>
                            <span class="stt-dev-progress-text">Downloading {$sttSettings.model}... {downloadPercent}%</span>
                        </div>
                    {/if}
                </section>
            {/if}
        </div>
    {/if}
</div>

<style>
    /* PANEL */
    .stt-overlay-container {
        position: fixed;
        z-index: 10000;
        width: clamp(320px, 28vw, 388px);
        min-width: 320px;
        max-width: min(calc(100vw - 24px), 388px);
        max-height: min(calc(100vh - 24px), 58vh);
        background-color: var(--primary-darker);
        border: 1px solid var(--primary-lighter);
        border-radius: 18px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
        color: var(--text);
        font-family: var(--font-family);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition:
            width 0.2s ease,
            box-shadow 0.2s ease,
            transform 0.2s ease;
    }

    .stt-overlay-container.collapsed {
        width: auto;
        min-width: fit-content;
    }

    /* HEADER */
    .stt-overlay-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background-color: var(--primary-darkest);
        padding: 12px 14px;
        cursor: grab;
        user-select: none;
        border-bottom: 1px solid var(--primary-lighter);
    }
    .stt-overlay-header:active {
        cursor: grabbing;
    }

    .stt-header-left {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .stt-status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background-color: var(--text);
        opacity: 0.7;
        box-shadow: 0 0 5px rgba(0, 0, 0, 0.5);
    }
    .stt-status-dot.active {
        background-color: var(--disconnected);
        opacity: 1;
        animation: pulse 2s infinite;
    }
    @keyframes pulse {
        0% {
            box-shadow: 0 0 0 0 rgba(168, 39, 39, 0.4);
        }
        70% {
            box-shadow: 0 0 0 6px rgba(168, 39, 39, 0);
        }
        100% {
            box-shadow: 0 0 0 0 rgba(168, 39, 39, 0);
        }
    }

    .stt-title-block {
        display: flex;
        flex-direction: column;
    }
    .stt-title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
    }
    .stt-subtitle {
        font-size: 11px;
        color: var(--text);
        opacity: 0.7;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .stt-header-right {
        display: flex;
        gap: 6px;
    }
    .stt-btn-icon {
        background: transparent;
        border: none;
        color: var(--text);
        opacity: 0.7;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition:
            background 0.2s,
            color 0.2s;
    }
    .stt-btn-icon:hover {
        background: var(--hover);
        color: var(--text);
        opacity: 1;
    }
    .stt-btn-icon:focus-visible {
        background: var(--focus);
        opacity: 1;
    }
    .stt-btn-icon.close-btn:hover {
        background: var(--disconnected);
        color: var(--text);
        opacity: 1;
    }

    .stt-btn-header-action {
        background: var(--secondary);
        color: var(--secondary-text);
        border: none;
        padding: 5px 11px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        transition: all 0.2s;
        margin-right: 4px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .stt-btn-header-action:hover:not(:disabled) {
        background: var(--secondary-opacity);
        transform: translateY(-1px);
    }
    .stt-btn-header-action.active {
        background: transparent;
        color: var(--disconnected);
        border: 1px solid var(--disconnected);
    }
    .stt-btn-header-action.active:hover {
        background: var(--hover);
    }
    .stt-btn-header-action:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    /* BODY */
    .stt-overlay-body {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
    }

    .stt-section {
        padding: 8px 14px;
        border-bottom: 1px solid var(--primary-lighter);
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .stt-section:last-child {
        border-bottom: none;
    }

    /* NOTIFICATIONS */
    .stt-notification {
        padding: 10px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        border-bottom: 1px solid var(--primary-lighter);
    }
    .stt-notification.error {
        background: var(--disconnected);
        color: var(--text);
    }
    .stt-notification.info {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        background: var(--primary-lighter);
    }
    .stt-progress-container {
        height: 4px;
        background: var(--hover);
        border-radius: 2px;
        overflow: hidden;
    }
    .stt-progress-container.compact {
        height: 5px;
    }
    .stt-progress-bar {
        height: 100%;
        background: var(--secondary);
        transition: width 0.3s;
    }
    .stt-progress-text {
        font-size: 11px;
        color: var(--text);
        opacity: 0.7;
        text-align: right;
    }

    /* TRANSCRIPT */
    .stt-transcript-box {
        background-color: var(--primary);
        border: 1px solid var(--primary-lighter);
        border-radius: 14px;
        padding: 12px;
        min-height: 64px;
        max-height: 104px;
        overflow-y: auto;
        word-break: break-word;
    }
    .stt-transcript-active {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text);
        word-wrap: break-word;
        overflow-wrap: break-word;
        white-space: pre-wrap;
    }
    .stt-transcript-empty {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text);
        opacity: 0.7;
        font-style: italic;
        text-align: center;
        margin-top: 10px;
    }

    /* RESULTS */
    .results-section {
        padding-top: 0;
        gap: 0;
        flex: 1;
        min-height: 0;
    }
    .stt-tabs {
        display: flex;
        gap: 4px;
        padding: 2px;
        background: var(--primary-darkest);
        border: 1px solid var(--primary-lighter);
        border-radius: 8px;
    }

    .stt-tab {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        opacity: 0.65;
        font-size: 0.85em;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
    }

    .stt-tab:hover {
        background: var(--hover);
        opacity: 0.9;
    }

    .stt-tab.active {
        background: var(--primary);
        opacity: 1;
        box-shadow: inset 0 0 0 1px var(--secondary-opacity);
    }

    .stt-lock-panel {
        border: 1px solid var(--secondary-opacity);
        border-radius: 8px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .stt-lock-suggestion {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.85em;
        color: var(--text);
    }

    .stt-section-title-row {
        display: flex;
        align-items: center;
        padding: 10px 2px;
        border-bottom: 1px solid var(--primary-lighter);
    }
    .stt-section-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .stt-badge {
        background: var(--secondary);
        color: var(--secondary-text);
        padding: 2px 6px;
        border-radius: 12px;
        font-size: 10px;
    }

    .stt-results-container {
        padding: 14px 16px 16px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
    }
    .stt-results-actions {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 10px;
    }
    .stt-empty-state {
        text-align: center;
        color: var(--text);
        opacity: 0.7;
        font-size: 12px;
        padding: 20px 0;
    }

    .stt-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .stt-list-item {
        background-color: var(--primary);
        border: 1px solid var(--primary-lighter);
        border-radius: 14px;
        padding: 13px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .stt-item-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
    }
    .stt-item-title {
        font-size: 13px;
        color: var(--text);
        word-break: break-word;
    }
    .stt-item-conf {
        font-size: 11px;
        color: var(--secondary);
        background: var(--secondary-opacity);
        padding: 2px 6px;
        border-radius: 4px;
    }
    .stt-item-desc {
        margin: 0;
        font-size: 11px;
        color: var(--text);
        opacity: 0.7;
        line-height: 1.4;
    }
    .stt-item-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;
    }

    .stt-btn-secondary {
        background: var(--secondary-opacity);
        color: var(--text);
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
    }
    .stt-btn-secondary:hover {
        background: var(--secondary);
    }
    .stt-btn-secondary.outline {
        background: transparent;
        border: 1px solid var(--primary-lighter);
        color: var(--text);
        opacity: 0.7;
    }
    .stt-btn-secondary.outline:hover {
        background: var(--hover);
        color: var(--text);
        opacity: 1;
    }
    /* DEV PANEL */
    .stt-dev-panel {
        background-color: var(--primary-darkest);
        padding: 12px 14px;
        border-top: 1px solid var(--primary-lighter);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .stt-dev-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .stt-dev-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .stt-btn-success {
        background: var(--connected);
        color: var(--text);
        border: none;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
    }
    .stt-btn-success:hover {
        filter: brightness(1.15);
    }

    .stt-btn-danger {
        background: var(--disconnected);
        color: var(--text);
        border: none;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
    }
    .stt-btn-danger:hover {
        filter: brightness(1.15);
    }

    .stt-dev-select {
        width: 100%;
        background: var(--primary);
        color: var(--text);
        border: 1px solid var(--primary-lighter);
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
    }
    .stt-dev-select:focus {
        outline: 1px solid var(--secondary);
    }
    .stt-dev-progress {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .stt-dev-progress-text {
        font-size: 11px;
        color: var(--text);
        opacity: 0.7;
        text-align: right;
    }
</style>
