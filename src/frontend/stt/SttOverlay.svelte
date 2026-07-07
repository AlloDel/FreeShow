<script lang="ts">
    import { onMount } from "svelte"
    import { sttDetections, sttEnabled, sttOverlayVisible, sttMinimized, sttPartialTranscript, sttSettings, sttSettingsOpen, sttSongDetections, sttStatus, sttTranscript, sttError, sttActiveTab, sttModels } from "./sttStore"
    import { clearBibleDetections, clearSongDetections, dismissDetection, dismissSongDetection, stopStt, toggleStt, showSongDetection, downloadModel, deleteModel, requestModels, setModel } from "./sttManager"
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

    function toggleSongDetection() {
        sttSettings.update((settings) => {
            const songDetection = !settings.songDetection
            return { ...settings, songDetection, autoShowSongs: songDetection ? settings.autoShowSongs : false }
        })
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

    function clearSongHistory() {
        clearSongDetections()
    }

    let displayTranscript: string;
    let downloadPercent: number;
    let statusLabel: string;
    let transcriptPlaceholder: string;
    let songTabDisabled: boolean;
    let activeModel: any;
    let currentModelDownloaded: boolean;
        let sttActive: boolean;
        let sttStarting: boolean;

    $: displayTranscript = $sttPartialTranscript || $sttTranscript
    $: downloadPercent = $sttStatus.downloadTotal > 0 ? Math.round(($sttStatus.downloadProgress / $sttStatus.downloadTotal) * 100) : 0
        $: sttActive = $sttEnabled || $sttStatus.connected
        $: sttStarting = $sttEnabled && !$sttStatus.connected
        $: statusLabel = $sttStatus.isDownloading ? "Downloading" : sttStarting ? "Starting" : $sttStatus.connected ? "Listening" : "Idle"
    $: transcriptPlaceholder =
        $sttStatus.isDownloading
            ? "Model download in progress..."
                        : sttStarting
                            ? "Starting speech recognition..."
                            : $sttStatus.connected
              ? "Listening for scripture references and song lyrics..."
              : "Press Start to begin listening."
              
    $: songTabDisabled = !$sttSettings.songDetection && !$sttSongDetections.length
    $: if (songTabDisabled && $sttActiveTab === "songs") {
        sttActiveTab.set("bible")
    }

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
            <button 
                class="stt-btn-header-action" 
                class:active={sttActive} 
                disabled={$sttStatus.isDownloading} 
                on:click={toggleStt}
                title={sttActive ? "Stop Listening" : "Start Listening"}
            >
                {sttActive ? "⏹ Stop" : "▶ Start"}
            </button>
            <button class="stt-btn-icon" title="Settings" on:click={() => sttSettingsOpen.update(v => !v)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
            </button>
            <button class="stt-btn-icon" title={$sttMinimized ? "Expand" : "Minimize"} on:click={() => sttMinimized.update(v => !v)}>
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

            <!-- MAIN CONTROLS -->
            <section class="stt-section">
                <div class="stt-toggles-grid">
                    <label class="stt-toggle-item" title="Enable listening for song lyrics">
                        <input type="checkbox" checked={$sttSettings.songDetection} on:change={toggleSongDetection} />
                        Enable Song Matches
                    </label>
                </div>
            </section>

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

            <!-- RESULTS AREA -->
            <section class="stt-section results-section">
                <div class="stt-tabs-header">
                    <button class="stt-tab-btn" class:active={$sttActiveTab === "bible"} on:click={() => sttActiveTab.set("bible")}>
                        Bible <span class="stt-badge">{$sttDetections.length}</span>
                    </button>
                    <button class="stt-tab-btn" class:active={$sttActiveTab === "songs"} disabled={songTabDisabled} on:click={() => sttActiveTab.set("songs")}>
                        Songs <span class="stt-badge song">{$sttSongDetections.length}</span>
                    </button>
                </div>
                
                <div class="stt-results-container">
                    {#if $sttActiveTab === "bible"}
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
                    {:else}
                        {#if !$sttSettings.songDetection}
                            <div class="stt-empty-state">Song recognition is disabled.</div>
                        {:else if $sttSongDetections.length > 0}
                            <div class="stt-results-actions">
                                <button class="stt-btn-secondary outline" on:click={clearSongHistory}>Clear all</button>
                            </div>
                            <div class="stt-list">
                                {#each $sttSongDetections as song (song.id)}
                                    <div class="stt-list-item song-item">
                                        <div class="stt-item-header">
                                            <strong class="stt-item-title">{song.showName}{song.slideIndex !== undefined ? ` - Slide ${song.slideIndex + 1}` : ""}</strong>
                                            <span class="stt-item-conf song">{formatConfidence(song.confidence)}</span>
                                        </div>
                                        {#if song.slideText || song.matchedText}
                                            <p class="stt-item-desc">"{song.slideText || song.matchedText}"</p>
                                        {/if}
                                        <div class="stt-item-actions">
                                            <button class="stt-btn-secondary outline" on:click={() => dismissSongDetection(song.id)}>Dismiss</button>
                                            <button class="stt-btn-secondary song-btn" on:click={() => showSongDetection(song)}>Project</button>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {:else}
                            <div class="stt-empty-state">Looking for lyric matches in database...</div>
                        {/if}
                    {/if}
                </div>
            </section>

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
    /* VARIABLES & RESET */
    .stt-overlay-container {
        --overlay-bg: rgba(24, 31, 40, 0.74);
        --overlay-header: rgba(12, 17, 24, 0.74);
        --overlay-border: rgba(255, 255, 255, 0.08);
        --overlay-highlight: rgba(255, 255, 255, 0.1);
        --text-main: #f1f5f9;
        --text-sub: #94a3b8;
        --accent-blue: #fbbf24;
        --accent-blue-hover: #f59e0b;
        --accent-red: #ef4444;
        --accent-red-hover: #dc2626;
        --accent-green: #10b981;
        --accent-green-hover: #059669;
        --accent-song: #8b5cf6;
        
        position: fixed;
        z-index: 10000;
        width: clamp(320px, 28vw, 388px);
        min-width: 320px;
        max-width: min(calc(100vw - 24px), 388px);
        max-height: min(calc(100vh - 24px), 58vh);
        background:
            radial-gradient(circle at top left, rgba(251, 191, 36, 0.08), transparent 28%),
            linear-gradient(180deg, rgba(35, 42, 52, 0.78) 0%, rgba(14, 18, 25, 0.88) 100%);
        border: 1px solid var(--overlay-border);
        border-radius: 18px;
        box-shadow: 0 18px 48px rgba(2, 6, 23, 0.42), inset 0 1px 0 var(--overlay-highlight);
        backdrop-filter: blur(20px) saturate(145%);
        -webkit-backdrop-filter: blur(20px) saturate(145%);
        color: var(--text-main);
        font-family: inherit;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: width 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
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
        background: linear-gradient(180deg, rgba(10, 14, 19, 0.62), rgba(10, 14, 19, 0.2));
        padding: 12px 14px;
        cursor: grab;
        user-select: none;
        border-bottom: 1px solid var(--overlay-border);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
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
        background-color: var(--text-sub);
        box-shadow: 0 0 5px rgba(0,0,0,0.5);
    }
    .stt-status-dot.active {
        background-color: var(--accent-red);
        animation: pulse 2s infinite;
    }
    @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
        70% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
        100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
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
        color: var(--text-sub);
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
        color: var(--text-sub);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: background 0.2s, color 0.2s;
    }
    .stt-btn-icon:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--text-main);
    }
    .stt-btn-icon.close-btn:hover {
        background: rgba(239, 68, 68, 0.2);
        color: var(--accent-red);
    }

    .stt-btn-header-action {
        background: var(--accent-blue);
        color: #22150a;
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
        background: var(--accent-blue-hover);
        transform: translateY(-1px);
    }
    .stt-btn-header-action.active {
        background: rgba(239, 68, 68, 0.2);
        color: var(--accent-red);
        border: 1px solid rgba(239, 68, 68, 0.4);
    }
    .stt-btn-header-action.active:hover {
        background: rgba(239, 68, 68, 0.3);
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
        border-bottom: 1px solid var(--overlay-border);
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
        border-bottom: 1px solid var(--overlay-border);
    }
    .stt-notification.error {
        background: rgba(239, 68, 68, 0.15);
        color: #fca5a5;
    }
    .stt-notification.info {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        background: rgba(59, 130, 246, 0.1);
    }
    .stt-progress-container {
        height: 4px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        overflow: hidden;
    }
    .stt-progress-container.compact {
        height: 5px;
    }
    .stt-progress-bar {
        height: 100%;
        background: var(--accent-blue);
        transition: width 0.3s;
    }
    .stt-progress-text {
        font-size: 11px;
        color: var(--text-sub);
        text-align: right;
    }

    /* CONTROLS */
    .stt-toggles-grid {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: rgba(7, 10, 15, 0.28);
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .stt-toggle-item {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--text-main);
        cursor: pointer;
        user-select: none;
    }
    .stt-toggle-item input[type="checkbox"] {
        -webkit-appearance: none;
        appearance: none;
        width: 32px;
        height: 18px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 10px;
        position: relative;
        cursor: pointer;
        outline: none;
        transition: background 0.3s;
        flex-shrink: 0;
    }
    .stt-toggle-item input[type="checkbox"]::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        background: white;
        border-radius: 50%;
        transition: transform 0.3s;
    }
    .stt-toggle-item input[type="checkbox"]:checked {
        background: var(--accent-green);
    }
    .stt-toggle-item input[type="checkbox"]:checked::after {
        transform: translateX(14px);
    }

    /* TRANSCRIPT */
    .stt-transcript-box {
        background: linear-gradient(180deg, rgba(7, 10, 15, 0.34), rgba(7, 10, 15, 0.2));
        border: 1px solid var(--overlay-border);
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
        color: var(--text-main);
        word-wrap: break-word;
        overflow-wrap: break-word;
        white-space: pre-wrap;
    }
    .stt-transcript-empty {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-sub);
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
    .stt-tabs-header {
        display: flex;
        border-bottom: 1px solid var(--overlay-border);
        background: rgba(10, 14, 19, 0.26);
        position: relative;
    }
    .stt-tab-btn {
        flex: 1;
        background: transparent;
        border: none;
        padding: 12px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-sub);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 0.2s;
    }
    .stt-tab-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.05);
        color: var(--text-main);
    }
    .stt-tab-btn.active {
        color: var(--text-main);
        border-bottom-color: var(--accent-blue);
        background: rgba(255, 255, 255, 0.04);
    }
    .stt-tab-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }

    .stt-badge {
        background: rgba(255, 255, 255, 0.1);
        padding: 2px 6px;
        border-radius: 12px;
        font-size: 10px;
    }
    .stt-tab-btn.active .stt-badge {
        background: var(--accent-blue);
        color: white;
    }
    .stt-tab-btn.active .stt-badge.song {
        background: var(--accent-song);
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
        color: var(--text-sub);
        font-size: 12px;
        padding: 20px 0;
    }

    .stt-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .stt-list-item {
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.025));
        border: 1px solid var(--overlay-border);
        border-radius: 14px;
        padding: 13px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .stt-list-item.song-item {
        border-color: rgba(139, 92, 246, 0.22);
        background:
            radial-gradient(circle at top right, rgba(139, 92, 246, 0.12), transparent 38%),
            linear-gradient(180deg, rgba(71, 34, 116, 0.15), rgba(18, 24, 39, 0.2));
    }
    .stt-item-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
    }
    .stt-item-title {
        font-size: 13px;
        color: var(--text-main);
        word-break: break-word;
    }
    .stt-item-conf {
        font-size: 11px;
        color: #f59e0b; /* Amber */
        background: rgba(245, 158, 11, 0.1);
        padding: 2px 6px;
        border-radius: 4px;
    }
    .stt-item-conf.song {
        color: var(--accent-song);
        background: rgba(139, 92, 246, 0.15);
    }
    .stt-item-desc {
        margin: 0;
        font-size: 11px;
        color: var(--text-sub);
        line-height: 1.4;
    }
    .stt-item-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;
    }
    
    .stt-btn-secondary {
        background: rgba(59, 130, 246, 0.2);
        color: #93c5fd;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
    }
    .stt-btn-secondary:hover {
        background: rgba(59, 130, 246, 0.3);
    }
    .stt-btn-secondary.outline {
        background: transparent;
        border: 1px solid var(--overlay-border);
        color: var(--text-sub);
    }
    .stt-btn-secondary.outline:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--text-main);
    }
    .stt-btn-secondary.song-btn {
        background: rgba(139, 92, 246, 0.2);
        color: #c4b5fd;
    }
    .stt-btn-secondary.song-btn:hover {
        background: rgba(139, 92, 246, 0.3);
    }

    /* DEV PANEL */
    .stt-dev-panel {
        background: rgba(0, 0, 0, 0.4);
        padding: 12px 14px;
        border-top: 1px solid var(--overlay-border);
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
        color: #fbbf24; /* Amber */
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .stt-btn-success {
        background: rgba(16, 185, 129, 0.2);
        color: #6ee7b7;
        border: none;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
    }
    .stt-btn-success:hover { background: rgba(16, 185, 129, 0.3); }
    
    .stt-btn-danger {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
        border: none;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
    }
    .stt-btn-danger:hover { background: rgba(239, 68, 68, 0.3); }

    .stt-dev-select {
        width: 100%;
        background: rgba(255, 255, 255, 0.05);
        color: var(--text-main);
        border: 1px solid var(--overlay-border);
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
    }
    .stt-dev-select:focus {
        outline: 1px solid rgba(251, 191, 36, 0.5);
    }
    .stt-dev-progress {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .stt-dev-progress-text {
        font-size: 11px;
        color: var(--text-sub);
        text-align: right;
    }
</style>