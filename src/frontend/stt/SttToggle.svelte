<script lang="ts">
    import { sttOverlayVisible, sttStatus } from "./sttStore"

    function toggleOverlay() {
        sttOverlayVisible.update((v) => !v)
    }
</script>

<button
    class="stt-toggle-btn"
    class:active={$sttOverlayVisible}
    title="Open Speech Detection (AI)"
    on:click={toggleOverlay}
>
    <div class="icon-container">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
        </svg>
        <span class="ai-badge">AI</span>
    </div>
    {#if $sttStatus.connected}
        <span class="stt-toggle-dot"></span>
    {/if}
</button>

<style>
    .stt-toggle-btn {
        position: relative;
        width: 38px;
        height: 38px;
        border: none;
        background: transparent;
        color: var(--text, #aaa);
        cursor: pointer;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        opacity: 0.7;
    }
    .stt-toggle-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        opacity: 1;
    }
    .stt-toggle-btn.active {
        background: rgba(255, 255, 255, 0.12);
        color: var(--primary, #6366f1);
        opacity: 1;
    }

    .icon-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
    }

    .ai-badge {
        font-size: 8px;
        font-weight: bold;
        letter-spacing: 0.5px;
        line-height: 1;
        opacity: 0.9;
    }

    .stt-toggle-dot {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #22c55e;
    }
</style>
