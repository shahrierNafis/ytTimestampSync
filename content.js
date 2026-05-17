/**
 * YouTube Timestamp Sync
 *
 * Persists playback position per video in chrome.storage.local and uses a
 * blocking native confirm() to offer resuming. Accepting sets ?t= on the URL
 * and reloads so YouTube seeks reliably via its own timestamp handling.
 */

/** How often (ms) the saved position may be written to storage. */
const SAVE_INTERVAL_MS = 1000;

/** Minimum saved position (seconds) before showing the resume prompt. */
const MIN_RESUME_SECONDS = 5;

/** Storage key for the map of videoId → { seconds, updatedAt }. */
const STORAGE_KEY = "positions";

let lastSave = 0;
let promptShownFor = null;
let promptInProgress = false;
let boundVideo = null;
let lastVideoId = null;

function getVideoId() {
    const id = new URL(window.location.href).searchParams.get("v");
    return id || null;
}

/**
 * Parses the `t` query parameter as whole seconds, or null when absent/invalid.
 *
 * @returns {number|null}
 */
function urlTimestampSeconds() {
    const t = new URL(window.location.href).searchParams.get("t");
    if (t === null || t === "") return null;
    const seconds = parseInt(t, 10);
    return Number.isNaN(seconds) ? null : seconds;
}

/**
 * Removes ?t=0 so YouTube does not force a seek to the start on load.
 */
function stripZeroTimestamp() {
    const url = new URL(window.location.href);
    if (url.searchParams.get("t") !== "0") return;
    url.searchParams.delete("t");
    history.replaceState(null, "", url.toString());
    console.debug("[timestamp-sync] Stripped ?t=0 from URL.");
}

/**
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
 * Navigates to the same watch URL with ?t= set (full page load).
 *
 * @param {number} seconds
 */
function reloadWithTimestamp(seconds) {
    const url = new URL(window.location.href);
    url.searchParams.set("t", String(seconds));
    window.location.href = url.toString();
}

/**
 * Pauses every video element on the page before a blocking dialog.
 */
function pauseAllVideos() {
    for (const video of document.querySelectorAll("video")) {
        try {
            video.pause();
        } catch (_) {
            /* ignore */
        }
    }
}

/**
 * Blocking native confirm — pauses the main thread until the user responds.
 * On accept, sets ?t= and reloads; on decline, clears the saved position.
 *
 * @param {string} videoId
 * @param {number} seconds
 */
function showResumePrompt(videoId, seconds) {
    if (promptShownFor === videoId || promptInProgress) return;

    promptInProgress = true;
    promptShownFor = videoId;

    pauseAllVideos();

    const resume = confirm(
        `Continue from ${formatTime(seconds)} where you left off?`
    );

    if (resume) {
        console.debug(`[timestamp-sync] Reloading with ?t=${seconds}`);
        reloadWithTimestamp(seconds);
        return;
    }

    clearPosition(videoId);
    promptInProgress = false;
    console.debug("[timestamp-sync] User declined resume; cleared saved position.");
}

/**
 * @param {HTMLVideoElement} [video]
 */
async function maybePromptResume(video) {
    const videoId = getVideoId();
    if (!videoId || promptShownFor === videoId || promptInProgress) return;

    const saved = await loadPosition(videoId);
    if (!saved || saved.seconds < MIN_RESUME_SECONDS) return;

    const urlT = urlTimestampSeconds();
    if (urlT !== null && urlT >= saved.seconds - 2) return;

    if (video && video.currentTime >= saved.seconds - 2) return;

    showResumePrompt(videoId, saved.seconds);
}

function persistPlaybackTime() {
    const videoId = getVideoId();
    if (!videoId || promptInProgress) return;

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

function init() {
    const video = document.querySelector("video");
    const videoId = getVideoId();
    if (!videoId) return;

    if (videoId !== lastVideoId) {
        promptShownFor = null;
        lastVideoId = videoId;
    }

    if (video) {
        if (video !== boundVideo) {
            if (boundVideo) {
                boundVideo.removeEventListener("timeupdate", persistPlaybackTime);
            }
            boundVideo = video;
            video.addEventListener("timeupdate", persistPlaybackTime);
            console.debug("[timestamp-sync] Listener attached to video element.");
        }
        maybePromptResume(video);
    } else {
        maybePromptResume();
    }
}

stripZeroTimestamp();
init();

const _observer = new MutationObserver(init);
_observer.observe(document.body, { childList: true, subtree: true });

console.log("[timestamp-sync] Script loaded.");
