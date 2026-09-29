// SoundDB Extension for TurboWarp & PenguinMod
// Captures loudness (dBFS) from either the microphone OR a browser tab/app.

(function (Scratch) {
  "use strict";

  // Shared audio state 
  let audioContext = null;
  let analyser     = null;
  let dataArray    = null;
  let currentDB    = -Infinity;
  let threshold    = -30;

  // Per-source stream handles
  let micStream    = null;   // getUserMedia stream
  let tabStream    = null;   // getDisplayMedia stream

  // Source tracking
  // "none" | "mic" | "tab"
  let activeSource = "none";

  // Helpers 

  function rmsToDb(rms) {
    if (rms === 0) return -Infinity;
    return 20 * Math.log10(rms);
  }

  // Only re-sample once per frame (~16 ms). Multiple block reads reuse the cached value.
  let lastSampleTime = -1;

  function sampleLoudness() {
    if (!analyser || !dataArray) return;
    const now = performance.now();
    if (now - lastSampleTime < 16) return; // already sampled this frame
    lastSampleTime = now;
    analyser.getFloatTimeDomainData(dataArray);
    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sumSq += dataArray[i] * dataArray[i];
    }
    currentDB = rmsToDb(Math.sqrt(sumSq / dataArray.length));
  }

  /**
   * Create (or reuse) an AudioContext, build a fresh analyser,
   * and connect the given MediaStream to it.
   */
  function connectStream(stream) {
    // Reuse existing context if still running
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Disconnect & rebuild analyser so old nodes don't linger
    analyser  = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    dataArray = new Float32Array(analyser.fftSize);

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
  }

  /** Release a stream's tracks and null the reference. */
  function releaseStream(streamRef) {
    if (streamRef) streamRef.getTracks().forEach((t) => t.stop());
  }

  /** Full teardown â stops all sources and closes the audio graph. */
  function stopAll() {
    releaseStream(micStream); micStream = null;
    releaseStream(tabStream); tabStream = null;
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser     = null;
    dataArray    = null;
    activeSource = "none";
    currentDB    = -Infinity;
  }

  // Extension class 
  class soundDB_client {
    getInfo() {
      return {
        id:     "soundDB",
        name:   "Sound dB",
        color1: "#1e88e5",
        color2: "#1565c0",
        color3: "#0d47a1",
        blocks: [

          // Microphone 
          { blockType: Scratch.BlockType.LABEL, text: "Microphone" },
          {
            opcode:    "startMic",
            blockType: Scratch.BlockType.COMMAND,
            text:      "start listening to microphone",
          },
          {
            opcode:    "stopMic",
            blockType: Scratch.BlockType.COMMAND,
            text:      "stop microphone",
          },

          // Tab / App audio 
          { blockType: Scratch.BlockType.LABEL, text: "Browser tab / app audio" },
          {
            opcode:    "startTab",
            blockType: Scratch.BlockType.COMMAND,
            text:      "start capturing application/tab audio",
          },
          {
            opcode:    "stopTab",
            blockType: Scratch.BlockType.COMMAND,
            text:      "stop capturing application/tab audio",
          },

          // Stop all 
          {
            opcode:    "stopAll",
            blockType: Scratch.BlockType.COMMAND,
            text:      "stop all audio capture sources",
          },

          // Reporters 
          { blockType: Scratch.BlockType.LABEL, text: "Loudness" },
          {
            opcode:          "getLoudnessDB",
            blockType:       Scratch.BlockType.REPORTER,
            text:            "loudness (dB)",
            disableMonitor:  false,
          },
          {
            opcode:          "getLoudnessDBRounded",
            blockType:       Scratch.BlockType.REPORTER,
            text:            "loudness (dB) rounded",
            disableMonitor:  false,
          },
          {
            opcode:          "getActiveSource",
            blockType:       Scratch.BlockType.REPORTER,
            text:            "currentactive source",
            disableMonitor:  false,
          },

          // Booleans 
          { blockType: Scratch.BlockType.LABEL, text: "Boolean checks" },
          {
            opcode:    "isLoud",
            blockType: Scratch.BlockType.BOOLEAN,
            text:      "loudness above [THRESHOLD] dB?",
            arguments: {
              THRESHOLD: { type: Scratch.ArgumentType.NUMBER, defaultValue: -30 },
            },
          },
          {
            opcode:    "isSilent",
            blockType: Scratch.BlockType.BOOLEAN,
            text:      "is silent? (below [THRESHOLD] dB)",
            arguments: {
              THRESHOLD: { type: Scratch.ArgumentType.NUMBER, defaultValue: -60 },
            },
          },
          {
            opcode:    "isMicActive",
            blockType: Scratch.BlockType.BOOLEAN,
            text:      "microphone is active?",
          },
          {
            opcode:    "isTabActive",
            blockType: Scratch.BlockType.BOOLEAN,
            text:      "tab capture is active?",
          },
          {
            opcode:    "isAnyActive",
            blockType: Scratch.BlockType.BOOLEAN,
            text:      "any audio source is active?",
          },

          // Threshold 
          { blockType: Scratch.BlockType.LABEL, text: "Threshold" },
          {
            opcode:    "setThreshold",
            blockType: Scratch.BlockType.COMMAND,
            text:      "set default threshold to [THRESHOLD] dB",
            arguments: {
              THRESHOLD: { type: Scratch.ArgumentType.NUMBER, defaultValue: -30 },
            },
          },
          {
            opcode:         "getThreshold",
            blockType:      Scratch.BlockType.REPORTER,
            text:           "default threshold (dB)",
            disableMonitor: false,
          },
        ],
      };
    }

    // Microphone 

    async startMic() {
      if (activeSource === "mic") return; // already running

      // Stop tab capture if it was running, but keep the audio context
      if (tabStream) { releaseStream(tabStream); tabStream = null; }

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (err) {
        console.warn("[SoundDB] Mic access denied:", err);
        return;
      }

      connectStream(micStream);
      activeSource = "mic";

      // Auto-stop when the user physically unplugs / revokes the mic
      micStream.getAudioTracks()[0].addEventListener("ended", () => {
        if (activeSource === "mic") {
          micStream = null;
          activeSource = "none";
          currentDB = -Infinity;
        }
      });
    }

    stopMic() {
      if (activeSource !== "mic") return;
      releaseStream(micStream); micStream = null;
      if (!tabStream) {
        if (audioContext) { audioContext.close(); audioContext = null; }
        analyser = null; dataArray = null;
      }
      activeSource = "none";
      currentDB = -Infinity;
    }

    // Tab / App audio 

    async startTab() {
      if (activeSource === "tab") return;

      // Stop mic capture if running
      if (micStream) { releaseStream(micStream); micStream = null; }

      let stream;
      try {
        // The browser will show its own share-picker; user must pick a tab/window/screen.
        // preferCurrentTab is a hint supported in some Chromium builds.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,   // required by spec â we discard the video track below
          audio: {
            suppressLocalAudioPlayback: false,
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 44100,
          },
          // NOTE: do NOT set preferCurrentTab â it hides the Window/Screen tabs
        });
      } catch (err) {
        console.warn("[SoundDB] Tab capture denied or cancelled:", err);
        return;
      }

      // Drop the video track â we only need audio
      stream.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn("[SoundDB] Selected source has no audio. Make sure 'Share tab audio' is ticked.");
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      tabStream = stream;
      connectStream(tabStream);
      activeSource = "tab";

      // Auto-stop when the user clicks "Stop sharing" in the browser UI
      audioTracks[0].addEventListener("ended", () => {
        if (activeSource === "tab") {
          tabStream = null;
          activeSource = "none";
          currentDB = -Infinity;
        }
      });
    }

    stopTab() {
      if (activeSource !== "tab") return;
      releaseStream(tabStream); tabStream = null;
      if (!micStream) {
        if (audioContext) { audioContext.close(); audioContext = null; }
        analyser = null; dataArray = null;
      }
      activeSource = "none";
      currentDB = -Infinity;
    }

    stopAll() {
      stopAll();
    }

    // Reporters 

    getLoudnessDB() {
      sampleLoudness();
      return isFinite(currentDB) ? Math.round(currentDB * 100) / 100 : -Infinity;
    }

    getLoudnessDBRounded() {
      sampleLoudness();
      return isFinite(currentDB) ? Math.round(currentDB) : -Infinity;
    }

    /** Returns "mic", "tab", or "none" */
    getActiveSource() {
      return activeSource;
    }

    // Booleans 

    isLoud({ THRESHOLD }) {
      sampleLoudness();
      return isFinite(currentDB) && currentDB > Number(THRESHOLD);
    }

    isSilent({ THRESHOLD }) {
      sampleLoudness();
      return !isFinite(currentDB) || currentDB < Number(THRESHOLD);
    }

    isMicActive() { return activeSource === "mic"; }
    isTabActive()  { return activeSource === "tab"; }
    isAnyActive()  { return activeSource !== "none"; }

    // Threshold 

    setThreshold({ THRESHOLD }) { threshold = Number(THRESHOLD); }
    getThreshold()              { return threshold; }
  }

  Scratch.extensions.register(new soundDB_client());
})(Scratch);
