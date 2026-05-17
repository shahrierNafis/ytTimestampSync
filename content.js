/**
 * YouTube Timestamp Sync
 *
 * Persists playback position per video in chrome.storage.local and prompts
 * the user to resume when they return to a watch page.
 *
 * Extra behaviour:
 *   - Throttles storage writes to once every `SAVE_INTERVAL_MS` milliseconds.
 *   - Re-initialises automatically when YouTube's SPA navigation swaps the
 *     DOM (e.g. clicking a related video).
 */

/** How often (ms) the saved position may be written to storage. */
const SAVE_INTERVAL_MS = 1;

/** Minimum saved position (seconds) before showing the resume prompt. */
const MIN_RESUME_SECONDS = 5;

/** Storage key for the map of videoId → { seconds, updatedAt }. */
const STORAGE_KEY = "positions";

/** Timestamp (ms) of the last storage write; used for throttling. */
let lastSave = 0;

/** Video ID for which the resume prompt has already been shown this session. */
let promptShownFor = null;

/** Last video element we attached listeners to. */
let boundVideo = null;

/** Last video ID we initialised for (SPA may reuse the same element). */
let lastVideoId = null;

/**
 * Returns the current watch-page video ID, or null when not on a watch page.
 *
 * @returns {string|null}
 */
function getVideoId() {
    const id = new URL(window.location.href).searchParams.get("v");
    return id || null;
}

/**
 * Formats seconds as M:SS or H:MM:SS for display.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @param {string} videoId
 * @returns {Promise<{ seconds: number, updatedAt: number }|null>}
 */
function loadPosition(videoId) {
    return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (data) => {
            const positions = data[STORAGE_KEY] || {};
            resolve(positions[videoId] ?? null);
        });
    });
}

/**
 * @param {string} videoId
 * @param {number} seconds
 */
function savePosition(videoId, seconds) {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
        const positions = data[STORAGE_KEY] || {};
        positions[videoId] = { seconds, updatedAt: Date.now() };
        chrome.storage.local.set({ [STORAGE_KEY]: positions });
        console.debug(`[timestamp-sync] Saved position ${seconds}s for ${videoId}`);
    });
}

/**
 * @param {string} videoId
 */
function clearPosition(videoId) {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
        const positions = data[STORAGE_KEY] || {};
        delete positions[videoId];
        chrome.storage.local.set({ [STORAGE_KEY]: positions });
    });
}

/**
 * Shows a bottom banner asking whether to resume from a saved position.
 *
 * @param {HTMLVideoElement} video
 * @param {string} videoId
 * @param {number} seconds
 */
function showResumePrompt(video, videoId, seconds) {
    if (promptShownFor === videoId) return;
    promptShownFor = videoId;

    const banner = document.createElement("ts-resume-banner");
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Resume playback");
    banner.innerHTML = `
        <span class="ts-message">Continue from <strong>${formatTime(seconds)}</strong> where you left off?</span>
        <span class="ts-actions">
            <button type="button" class="ts-btn ts-btn-primary" data-action="resume">Continue</button>
            <button type="button" class="ts-btn" data-action="dismiss">Start over</button>
        </span>
    `;

    const style = document.createElement("style");
    style.textContent = `
        ts-resume-banner {
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 10000;
            display: flex;
            align-items: center;
            gap: 16px;
            flex-wrap: wrap;
            justify-content: center;
            max-width: min(640px, calc(100vw - 32px));
            padding: 12px 20px;
            border-radius: 12px;
            background: rgba(28, 28, 28, 0.95);
            color: #f1f1f1;
            font: 500 14px/1.4 "Roboto", "Arial", sans-serif;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        ts-resume-banner .ts-message strong { color: #3ea6ff; font-weight: 600; }
        ts-resume-banner .ts-actions { display: flex; gap: 8px; flex-shrink: 0; }
        ts-resume-banner .ts-btn {
            cursor: pointer;
            border: none;
            border-radius: 18px;
            padding: 8px 16px;
            font: inherit;
            font-weight: 500;
            background: rgba(255, 255, 255, 0.1);
            color: #f1f1f1;
        }
        ts-resume-banner .ts-btn:hover { background: rgba(255, 255, 255, 0.18); }
        ts-resume-banner .ts-btn-primary { background: #fff; color: #0f0f0f; }
        ts-resume-banner .ts-btn-primary:hover { background: #e5e5e5; }
    `;

    function removeBanner() {
        banner.remove();
        style.remove();
    }

    banner.addEventListener("click", (e) => {
        const action = e.target.closest("[data-action]")?.dataset.action;
        if (!action) return;

        if (action === "resume") {
            video.currentTime = seconds;
        } else {
            clearPosition(videoId);
        }
        removeBanner();
    });

    document.head.appendChild(style);
    document.body.appendChild(banner);
    console.debug(`[timestamp-sync] Resume prompt shown at ${seconds}s`);
}

/**
 * If a saved position exists for the current video, prompts the user once.
 *
 * @param {HTMLVideoElement} video
 */
async function maybePromptResume(video) {
    const videoId = getVideoId();
    if (!videoId) return;

    const saved = await loadPosition(videoId);
    if (!saved || saved.seconds < MIN_RESUME_SECONDS) return;

    // Already past the saved point — no need to interrupt.
    if (video.currentTime >= saved.seconds - 2) return;

    showResumePrompt(video, videoId, saved.seconds);
}

/**
 * Persists the current playback position for this video.
 */
function persistPlaybackTime() {
    const videoId = getVideoId();
    if (!videoId) return;

    const video = document.querySelector("video.video-stream.html5-main-video")
        || document.querySelector("video");
    if (!video) return;

    const now = Date.now();
    if (now - lastSave < SAVE_INTERVAL_MS) return;
    lastSave = now;

    const seconds = Math.floor(video.currentTime);
    if (seconds < MIN_RESUME_SECONDS) return;

    savePosition(videoId, seconds);
}

/**
 * Attaches listeners to the active video element and wires resume prompting.
 */
function init() {
    const video = document.querySelector("video");
    const videoId = getVideoId();
    if (!video || !videoId) return;

    if (videoId === lastVideoId && video === boundVideo) return;

    if (videoId !== lastVideoId) {
        promptShownFor = null;
        lastVideoId = videoId;
    }

    if (video !== boundVideo) {
        if (boundVideo) {
            boundVideo.removeEventListener("timeupdate", persistPlaybackTime);
        }
        boundVideo = video;
        video.addEventListener("timeupdate", persistPlaybackTime);
        console.debug("[timestamp-sync] Listener attached to video element.");
    }

    maybePromptResume(video);
}

// Attach listener to whatever video element exists right now (if any).
init();

// Re-run init whenever YouTube's SPA mutates the DOM (new video page).
const _observer = new MutationObserver(init);
_observer.observe(document.body, { childList: true, subtree: true });

console.log("[timestamp-sync] Script loaded.");
