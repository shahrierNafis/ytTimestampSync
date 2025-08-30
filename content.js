(function () {
    let lastUpdate = 0;
    const updateInterval = 2000; // update every 2 seconds

    function updateUrlTime() {
        const video = document.querySelector("video.video-stream.html5-main-video");
        if (!video) return;

        const now = Date.now();
        if (now - lastUpdate < updateInterval) return; // limit updates
        lastUpdate = now;

        const seconds = Math.floor(video.currentTime);

        // Current URL
        const url = new URL(window.location.href);

        // Update ?t= parameter
        url.searchParams.set("t", seconds);

        // Use replaceState so the page doesn’t reload
        history.replaceState(null, "", url.toString());
    }

    function init() {
        const video = document.querySelector("video");
        if (!video) return;

        video.addEventListener("timeupdate", updateUrlTime);
    }

    // Run once at start and also if navigation happens (YouTube SPA)
    init();
    const observer = new MutationObserver(init);
    observer.observe(document.body, { childList: true, subtree: true });
})();
