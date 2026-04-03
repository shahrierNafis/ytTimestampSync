/**
 * YouTube Timestamp URL Sync
 *
 * Keeps the ?t= query parameter in sync with the current video playback
 * position so that copying the URL always yields a timestamped link.
 *
 * Extra behaviour:
 *   - Strips ?t=0 on page load to avoid overwriting a saved timestamp with
 *     zero before the video has had a chance to seek to the stored position.
 *   - Throttles URL writes to once every `UPDATE_INTERVAL_MS` milliseconds to
 *     avoid flooding the browser history API.
 *   - Re-initialises automatically when YouTube's SPA navigation swaps the
 *     DOM (e.g. clicking a related video).
 */

/** How often (ms) the ?t= parameter may be written to the URL. */
const UPDATE_INTERVAL_MS = 5000;

/** Timestamp (ms) of the last URL write; used for throttling. */
let lastUpdate = 0;

/**
 * Returns true when the current page is a YouTube watch page
 * (i.e. the URL contains a `v` query parameter).
 *
 * @returns {boolean}
 */
function isWatchPage() {
    return new URL(window.location.href).searchParams.has("v");
}

/**
 * Removes a ?t=0 parameter from the URL if present.
 *
 * YouTube occasionally appends `t=0` to a URL (e.g. via share links or
 * history entries). Leaving it in place would cause the player to seek back
 * to the beginning, discarding any previously saved position.  Calling this
 * once on load (before the video starts) silently drops the parameter so the
 * player behaves as if no timestamp was specified.
 */
function stripZeroTimestamp() {
    const url = new URL(window.location.href);
    if (url.searchParams.get("t") === "0") {
        url.searchParams.delete("t");
        history.replaceState(null, "", url.toString());
        console.debug("[timestamp-sync] Stripped ?t=0 from URL.");
    }
}

/**
 * Reads the current video playback position and writes it to the `?t=`
 * query parameter via `history.replaceState` (no page reload).
 *
 * Skipped when:
 *   - No YouTube video element is found in the DOM.
 *   - The page is not a watch page.
 *   - The call falls within the throttle window.
 *   - The video is at position 0 (avoids overwriting a real timestamp during
 *     the brief moment before the player seeks to a stored ?t= value).
 */
function updateUrlTime() {
    if (!isWatchPage()) return;

    const video = document.querySelector("video.video-stream.html5-main-video");
    if (!video) return;

    const now = Date.now();
    if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
    lastUpdate = now;

    const seconds = Math.floor(video.currentTime);

    // Do not write t=0 – it would clobber a legitimate saved timestamp that the
    // player may not yet have seeked to.
    if (seconds === 0) return;

    const url = new URL(window.location.href);
    url.searchParams.set("t", seconds);
    history.replaceState(null, "", url.toString());
    console.debug(`[timestamp-sync] Updated ?t=${seconds}`);
}

/**
 * Attaches the `timeupdate` listener to the first `<video>` element found in
 * the document.
 *
 * Safe to call multiple times – if a listener is already registered on the
 * same element a second registration is harmless (the browser deduplicates
 * identical event-listener / function pairs).
 */
function init() {
    const video = document.querySelector("video");
    if (!video) return;

    video.addEventListener("timeupdate", updateUrlTime);
    console.debug("[timestamp-sync] Listener attached to video element.");
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

// Strip ?t=0 before anything else runs so the player never seeks to zero.
stripZeroTimestamp();

// Attach listener to whatever video element exists right now (if any).
init();

// Re-run init whenever YouTube's SPA mutates the DOM (new video page).
const _observer = new MutationObserver(init);
_observer.observe(document.body, { childList: true, subtree: true });

console.log("[timestamp-sync] Script loaded.");