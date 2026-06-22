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

function rawUrlTimestamp() {
    const t = new URL(window.location.href).searchParams.get("t");
    return t === null ? null : t;
}

/**
 * Parses the `t` query parameter as whole seconds, or null when absent/invalid.
 *
 * @returns {number|null}
 */
function urlTimestampSeconds() {
    const raw = rawUrlTimestamp();
    if (raw === null || raw === "") return null;

    const normalized = raw.replace(/\s+/g, "");
    if (!/^\d+$/.test(normalized)) return null;

    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? seconds : null;
}

function isSpaceifiedUrlTimestamp(value) {
    return value !== null && /\s/.test(value);
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
 * Seeks the current video directly without rewriting the URL.
 *
 * @param {HTMLVideoElement} video
 * @param {number} seconds
 */
function seekToTimestamp(video, seconds) {
    try {
        video.currentTime = Math.max(0, seconds);
    } catch (_) {
        /* ignore */
    }
}

/**
 * Attempts to resume playback if the video is paused.
 *
 * @param {HTMLVideoElement} video
 */
function resumePlayback(video) {
    if (!video.paused) return;
    video.play().catch(() => {
        /* ignore */
    });
}

/**
 * Repeatedly seeks and resumes playback up to three times to handle delayed metadata.
 *
 * @param {HTMLVideoElement} video
 * @param {number} seconds
 */
function seekAndResume(video, seconds) {
    const attemptSeek = (attempt) => {
        seekToTimestamp(video, seconds);
        resumePlayback(video);

        if (attempt < 2 && Math.abs(video.currentTime - seconds) > 1) {
            setTimeout(() => attemptSeek(attempt + 1), 250);
        }
    };

    attemptSeek(0);
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
 * On accept, seeks the current video directly; on decline, clears the saved position.
 *
 * @param {string} videoId
 * @param {number} seconds
 * @param {HTMLVideoElement} video
 */
function showResumePrompt(videoId, seconds, video) {
    if (promptShownFor === videoId || promptInProgress) return;

    promptInProgress = true;
    promptShownFor = videoId;

    pauseAllVideos();

    const resume = confirm(
        `Continue from ${formatTime(seconds)} where you left off?`
    );

    if (resume) {
        console.debug(`[timestamp-sync] Seeking to ${seconds}s in the current video.`);
        seekAndResume(video, seconds);
        promptInProgress = false;
        return;
    }

    clearPosition(videoId);
    promptInProgress = false;
    console.debug("[timestamp-sync] User declined resume; cleared saved position.");
}

/**
 * @param {HTMLVideoElement} video
 */
async function maybePromptResume(video) {
    const videoId = getVideoId();
    if (!videoId || promptShownFor === videoId || promptInProgress) return;

    const raw = rawUrlTimestamp();
    if (isSpaceifiedUrlTimestamp(raw)) {
        const useUrlTimestamp = confirm(
            `The URL timestamp "${raw}" looks unusual. Use it or ignore it?`
        );
        if (useUrlTimestamp) {
            const parsed = urlTimestampSeconds();
            if (parsed !== null) {
                seekAndResume(video, parsed);
                return;
            }
        }
    }

    const saved = await loadPosition(videoId);
    if (!saved || saved.seconds < MIN_RESUME_SECONDS) return;

    const urlT = urlTimestampSeconds();
    if (urlT !== null && urlT >= saved.seconds) return;

    if (video.currentTime >= saved.seconds) return;

    showResumePrompt(videoId, saved.seconds, video);
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
    }
}

stripZeroTimestamp();
init();

const _observer = new MutationObserver(init);
_observer.observe(document.body, { childList: true, subtree: true });

console.log("[timestamp-sync] Script loaded.");
