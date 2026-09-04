(function () {
  function formatTime(sec) {
    if (!isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  const cards = document.querySelectorAll(".audio-card");

  cards.forEach((card) => {
    const audio = card.querySelector("audio");
    const btn = card.querySelector(".play-btn");
    const bar = card.querySelector(".audio-progress-bar");
    const time = card.querySelector(".audio-time");

    if (!audio || !btn) return;

    btn.addEventListener("click", () => {
      const isPlaying = !audio.paused && !audio.ended;

      cards.forEach((other) => {
        if (other === card) return;
        const otherAudio = other.querySelector("audio");
        const otherBtn = other.querySelector(".play-btn");
        if (otherAudio && !otherAudio.paused) {
          otherAudio.pause();
          otherBtn.classList.remove("is-playing");
        }
      });

      if (isPlaying) {
        audio.pause();
      } else {
        audio.play();
      }
    });

    audio.addEventListener("play", () => btn.classList.add("is-playing"));
    audio.addEventListener("pause", () => btn.classList.remove("is-playing"));
    audio.addEventListener("ended", () => {
      btn.classList.remove("is-playing");
      if (bar) bar.style.width = "0%";
    });

    audio.addEventListener("timeupdate", () => {
      if (bar && audio.duration) {
        bar.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      }
      if (time) {
        time.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
      }
    });

    audio.addEventListener("loadedmetadata", () => {
      if (time) time.textContent = `0:00 / ${formatTime(audio.duration)}`;
    });
  });

  const introVideo = document.getElementById("intro-video");
  const introOverlay = document.querySelector(".facts-video-overlay");
  const introPlayBtn = document.querySelector(".facts-video-play");

  if (introVideo && introOverlay && introPlayBtn) {
    introPlayBtn.addEventListener("click", () => {
      introVideo.controls = true;
      introVideo.play();
      introOverlay.style.display = "none";
    });

    introVideo.addEventListener("ended", () => {
      introVideo.controls = false;
      introVideo.currentTime = 0;
      introOverlay.style.display = "flex";
    });
  }

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
