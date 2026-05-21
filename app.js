(() => {
  const defaults = {
    mode: "brightfield",
    channel: "luma",
    autoThreshold: true,
    threshold: 48,
    sensitivity: 1,
    backgroundRadius: 20,
    minDiameter: 6,
    maxDiameter: 58,
    minCircularity: 0.32,
    edgeMargin: 4,
    overlayOpacity: 0.62,
    zoom: 100,
    showLabels: false,
    manualDiameter: 12,
    micronPerPixel: 0,
  };

  const HISTORY_DB_NAME = "lipid-droplet-counter-history";
  const HISTORY_STORE = "analyses";
  const HISTORY_LIMIT = 20;

  const state = {
    source: null,
    signal: null,
    mask: null,
    histogram: null,
    autoObjects: [],
    manualObjects: [],
    suppressedObjects: [],
    objects: [],
    cellMask: null,
    cellContour: [],
    cellControlPoints: [],
    cellContourSource: "none",
    cellDrawMode: false,
    samPointMode: false,
    samBoxMode: false,
    samBusy: false,
    samBox: null,
    tempSamBox: null,
    drawingSamBox: false,
    samBoxStart: null,
    samHoverPoint: null,
    samHoverTimer: 0,
    samUnavailable: false,
    leftPanelCollapsed: false,
    rightPanelCollapsed: false,
    leftPanelWidth: 284,
    rightPanelWidth: 328,
    resizingPanel: null,
    viewerPanning: false,
    panStartX: 0,
    panStartY: 0,
    panStartScrollLeft: 0,
    panStartScrollTop: 0,
    suppressCanvasClick: false,
    backgroundEraseMask: null,
    maskEditMode: false,
    eraseBrushSize: 36,
    isErasingMask: false,
    didPaintMask: false,
    threshold: defaults.threshold,
    bounds: null,
    settings: { ...defaults },
    roi: null,
    roiMode: false,
    correctionMode: "none",
    drawingRoi: false,
    roiStart: null,
    tempRoi: null,
    correctionHistory: [],
    nextManualUid: 1,
    nextSuppressionUid: 1,
    currentHistoryId: null,
    historyRecords: [],
    historyDb: null,
    historySaveTimer: 0,
    suppressHistorySave: false,
    fitScale: 1,
    analyzeTimer: 0,
    busy: false,
  };

  const $ = (id) => document.getElementById(id);
  const els = {};

  const uiIds = [
    "fileInput",
    "fileMeta",
    "leftToggleButton",
    "rightToggleButton",
    "leftResizeHandle",
    "rightResizeHandle",
    "analyzeButton",
    "autoButton",
    "exportCsvButton",
    "exportPngButton",
    "channelSelect",
    "autoThresholdInput",
    "thresholdInput",
    "thresholdValue",
    "sensitivityInput",
    "sensitivityValue",
    "backgroundInput",
    "backgroundValue",
    "minDiameterInput",
    "maxDiameterInput",
    "circularityInput",
    "circularityValue",
    "edgeInput",
    "edgeValue",
    "roiButton",
    "clearRoiButton",
    "zoomInput",
    "zoomValue",
    "overlayInput",
    "overlayValue",
    "labelsInput",
    "manualBadge",
    "manualDiameterInput",
    "manualDiameterValue",
    "undoManualButton",
    "clearManualButton",
    "cellBadge",
    "autoCellButton",
    "samPointButton",
    "boxCellButton",
    "refineCellButton",
    "undoCellPointButton",
    "drawCellButton",
    "finishCellButton",
    "clearCellButton",
    "maskBadge",
    "maskEditButton",
    "clearMaskButton",
    "eraseBrushInput",
    "eraseBrushValue",
    "historyBadge",
    "saveHistoryButton",
    "clearHistoryButton",
    "historyList",
    "micronInput",
    "statusLine",
    "dropZone",
    "emptyState",
    "imageCanvas",
    "fitButton",
    "resetButton",
    "countMetric",
    "diameterMetric",
    "areaMetric",
    "densityMetric",
    "cellAreaMetric",
    "areaRatioMetric",
    "thresholdBadge",
    "histogramCanvas",
    "objectBadge",
    "objectTable",
  ];

  function init() {
    uiIds.forEach((id) => {
      els[id] = $(id);
    });

    bindEvents();
    applyPanelLayout();
    syncControlsFromState();
    updateButtonState();
    drawEmptyHistogram();
    initHistory();
  }

  function bindEvents() {
    els.fileInput.addEventListener("change", (event) => {
      const [file] = event.target.files || [];
      if (file) loadFile(file);
    });

    ["dragenter", "dragover"].forEach((type) => {
      els.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        els.dropZone.classList.add("dragging");
      });
    });

    ["dragleave", "drop"].forEach((type) => {
      els.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === "drop") {
          const [file] = event.dataTransfer.files || [];
          if (file) loadFile(file);
        }
        els.dropZone.classList.remove("dragging");
      });
    });

    document.querySelectorAll("[data-setting]").forEach((button) => {
      button.addEventListener("click", () => {
        state.settings[button.dataset.setting] = button.dataset.value;
        document
          .querySelectorAll(`[data-setting="${button.dataset.setting}"]`)
          .forEach((item) => item.classList.toggle("active", item === button));
        scheduleAnalyze();
      });
    });

    document.querySelectorAll("[data-correction-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        setCorrectionMode(button.dataset.correctionMode);
      });
    });

    els.channelSelect.addEventListener("change", () => {
      state.settings.channel = els.channelSelect.value;
      scheduleAnalyze();
    });

    els.autoThresholdInput.addEventListener("change", () => {
      state.settings.autoThreshold = els.autoThresholdInput.checked;
      els.thresholdInput.disabled = state.settings.autoThreshold;
      scheduleAnalyze();
    });

    els.thresholdInput.addEventListener("input", () => {
      state.settings.autoThreshold = false;
      els.autoThresholdInput.checked = false;
      els.thresholdInput.disabled = false;
      state.settings.threshold = Number(els.thresholdInput.value);
      els.thresholdValue.textContent = String(state.settings.threshold);
      scheduleAnalyze();
    });

    const analyzedInputs = [
      [els.sensitivityInput, "sensitivity", Number],
      [els.backgroundInput, "backgroundRadius", Number],
      [els.minDiameterInput, "minDiameter", Number],
      [els.maxDiameterInput, "maxDiameter", Number],
      [els.circularityInput, "minCircularity", Number],
      [els.edgeInput, "edgeMargin", Number],
      [els.micronInput, "micronPerPixel", Number],
    ];

    analyzedInputs.forEach(([input, key, caster]) => {
      input.addEventListener("input", () => {
        state.settings[key] = caster(input.value) || 0;
        syncReadouts();
        scheduleAnalyze();
      });
    });

    els.zoomInput.addEventListener("input", () => {
      state.settings.zoom = Number(els.zoomInput.value);
      syncReadouts();
      scaleCanvas(viewportCenterAnchor());
    });

    els.overlayInput.addEventListener("input", () => {
      state.settings.overlayOpacity = Number(els.overlayInput.value) / 100;
      syncReadouts();
      renderCanvas();
    });

    els.labelsInput.addEventListener("change", () => {
      state.settings.showLabels = els.labelsInput.checked;
      renderCanvas();
    });

    els.manualDiameterInput.addEventListener("input", () => {
      state.settings.manualDiameter = Number(els.manualDiameterInput.value) || defaults.manualDiameter;
      syncReadouts();
    });

    els.analyzeButton.addEventListener("click", () => analyzeImage());
    els.autoButton.addEventListener("click", () => {
      state.settings.autoThreshold = true;
      els.autoThresholdInput.checked = true;
      els.thresholdInput.disabled = true;
      analyzeImage();
    });

    els.exportCsvButton.addEventListener("click", exportCsv);
    els.exportPngButton.addEventListener("click", exportMarkedPng);

    els.roiButton.addEventListener("click", () => {
      state.roiMode = !state.roiMode;
      if (state.roiMode) {
        setCorrectionMode("none", false);
        setCellDrawMode(false, false);
        setSamPointMode(false, false);
        setSamBoxMode(false, false);
        setMaskEditMode(false, false);
      }
      els.roiButton.classList.toggle("active", state.roiMode);
      els.imageCanvas.classList.toggle("roi-mode", state.roiMode);
      setStatus(state.roiMode ? "拖动画布框选 ROI" : "ROI 框选关闭");
    });

    els.clearRoiButton.addEventListener("click", () => {
      state.roi = null;
      state.tempRoi = null;
      renderCanvas();
      updateButtonState();
      scheduleAnalyze();
    });

    els.undoManualButton.addEventListener("click", undoCorrection);
    els.clearManualButton.addEventListener("click", clearCorrections);
    els.autoCellButton.addEventListener("click", async () => {
      await autoDetectCell();
      saveHistoryDebounced();
    });
    els.samPointButton.addEventListener("click", () => setSamPointMode(!state.samPointMode));
    els.boxCellButton.addEventListener("click", () => setSamBoxMode(!state.samBoxMode));
    els.refineCellButton.addEventListener("click", () => runSamPrediction("button"));
    els.undoCellPointButton.addEventListener("click", undoCellPoint);
    els.drawCellButton.addEventListener("click", () => setCellDrawMode(!state.cellDrawMode));
    els.finishCellButton.addEventListener("click", finishCellContour);
    els.clearCellButton.addEventListener("click", () => {
      clearCellContour();
      saveHistoryDebounced();
    });
    els.maskEditButton.addEventListener("click", () => setMaskEditMode(!state.maskEditMode));
    els.clearMaskButton.addEventListener("click", clearBackgroundEraseMask);
    els.eraseBrushInput.addEventListener("input", () => {
      state.eraseBrushSize = Number(els.eraseBrushInput.value) || 36;
      syncReadouts();
    });
    els.saveHistoryButton.addEventListener("click", () => saveHistoryNow("已保存到历史记录"));
    els.clearHistoryButton.addEventListener("click", clearHistory);

    els.fitButton.addEventListener("click", () => {
      fitCanvasToStage();
    });

    els.resetButton.addEventListener("click", () => {
      const keepMicron = state.settings.micronPerPixel;
      state.settings = { ...defaults, micronPerPixel: keepMicron };
      state.roi = null;
      state.tempRoi = null;
      state.cellMask = null;
      state.cellContour = [];
      state.cellControlPoints = [];
      state.cellContourSource = "none";
      state.backgroundEraseMask = null;
      state.samBox = null;
      state.tempSamBox = null;
      state.samHoverPoint = null;
      setMaskEditMode(false, false);
      setSamPointMode(false, false);
      setSamBoxMode(false, false);
      setCellDrawMode(false, false);
      clearCorrections(false);
      setCorrectionMode("none", false);
      syncControlsFromState();
      scheduleAnalyze();
    });

    els.imageCanvas.addEventListener("pointerdown", handleCanvasPointerDown);
    els.imageCanvas.addEventListener("click", handleCanvasClick);
    els.imageCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
    els.dropZone.addEventListener("wheel", handleViewerWheel, { passive: false });
    els.dropZone.addEventListener("contextmenu", (event) => event.preventDefault());
    els.imageCanvas.addEventListener("pointerleave", () => window.clearTimeout(state.samHoverTimer));
    window.addEventListener("pointermove", handleCanvasPointerMove);
    window.addEventListener("pointerup", handleCanvasPointerUp);
    window.addEventListener("resize", () => {
      if (state.source) scaleCanvas(viewportCenterAnchor());
    });
    els.leftToggleButton.addEventListener("click", () => togglePanel("left"));
    els.rightToggleButton.addEventListener("click", () => togglePanel("right"));
    els.leftResizeHandle.addEventListener("pointerdown", (event) => startPanelResize("left", event));
    els.rightResizeHandle.addEventListener("pointerdown", (event) => startPanelResize("right", event));
  }

  async function loadFile(file) {
    try {
      setBusy(true, "正在读取图像...");
      await nextFrame();
      const decoded = await decodeImageFile(file);
      state.source = {
        name: file.name,
        size: file.size,
        width: decoded.width,
        height: decoded.height,
        imageData: decoded.imageData,
      };
      state.signal = null;
      state.mask = null;
      state.histogram = null;
      state.autoObjects = [];
      state.manualObjects = [];
      state.suppressedObjects = [];
      state.objects = [];
      state.cellMask = null;
      state.cellContour = [];
      state.cellControlPoints = [];
      state.cellContourSource = "none";
      state.backgroundEraseMask = null;
      state.samPointMode = false;
      state.samBoxMode = false;
      state.samBox = null;
      state.tempSamBox = null;
      state.samHoverPoint = null;
      state.samUnavailable = false;
      state.maskEditMode = false;
      state.currentHistoryId = null;
      state.roi = null;
      state.tempRoi = null;
      state.correctionHistory = [];
      state.nextManualUid = 1;
      state.nextSuppressionUid = 1;
      setSamPointMode(false, false);
      setSamBoxMode(false, false);
      setMaskEditMode(false, false);
      setCellDrawMode(false, false);
      setCorrectionMode("none", false);
      state.threshold = state.settings.threshold;

      els.imageCanvas.width = decoded.width;
      els.imageCanvas.height = decoded.height;
      els.imageCanvas.classList.add("ready");
      els.emptyState.style.display = "none";
      els.fileMeta.textContent = `${file.name} · ${decoded.width}×${decoded.height}`;

      updateButtonState();
      renderCanvas();
      scaleCanvas({ center: true });
      setBusy(false, "图像已读取，开始分析...");
      await analyzeImage();
    } catch (error) {
      console.error(error);
      setStatus(error.message || "图像读取失败");
      setBusy(false);
    }
  }

  async function decodeImageFile(file) {
    const isTiff = /\.(tif|tiff)$/i.test(file.name) || /tiff/i.test(file.type);
    if (isTiff) {
      const buffer = await file.arrayBuffer();
      return decodeTiff(buffer);
    }

    const bitmap = await createBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      imageData: ctx.getImageData(0, 0, bitmap.width, bitmap.height),
    };
  }

  async function createBitmap(file) {
    if ("createImageBitmap" in window) {
      return createImageBitmap(file);
    }

    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function analyzeImage() {
    if (!state.source || state.busy) return;

    const settings = sanitizeSettings();
    state.settings = settings;
    syncControlsFromState(false);

    try {
      setBusy(true, "正在分析脂滴...");
      await nextFrame();

      const { width, height, imageData } = state.source;
      const bounds = getAnalysisBounds(width, height, settings.edgeMargin);
      if (bounds.width < 2 || bounds.height < 2) {
        throw new Error("ROI 太小");
      }

      const intensity = buildIntensity(imageData.data, settings.channel);
      await nextFrame();
      const background = boxBlur(intensity, width, height, settings.backgroundRadius);
      await nextFrame();
      const signal = buildSignal(intensity, background, settings.mode);
      const histogram = buildHistogram(signal, width, bounds);
      const threshold = settings.autoThreshold
        ? autoThreshold(histogram, settings.mode, settings.sensitivity)
        : settings.threshold;
      const result = findObjects(signal, width, height, bounds, threshold, settings);

      state.signal = signal;
      state.mask = result.mask;
      state.autoObjects = result.objects.map((object) => ({ ...object, source: "auto" }));
      state.histogram = histogram;
      state.threshold = threshold;
      state.bounds = bounds;
      state.objects = composeObjects();
      refreshCellMaskAfterAnalysis();

      if (settings.autoThreshold) {
        state.settings.threshold = threshold;
        els.thresholdInput.value = String(threshold);
      }

      syncReadouts();
      renderCanvas();
      drawHistogram(histogram, threshold);
      updateResults();
      updateButtonState();
      setBusy(false, `完成：识别 ${state.autoObjects.length} 个对象，当前计数 ${state.objects.length} 个`);
      saveHistoryDebounced();
    } catch (error) {
      console.error(error);
      setBusy(false, error.message || "分析失败");
    }
  }

  function sanitizeSettings() {
    const settings = {
      ...state.settings,
      channel: els.channelSelect.value,
      autoThreshold: els.autoThresholdInput.checked,
      threshold: clamp(Math.round(Number(els.thresholdInput.value) || 0), 0, 255),
      sensitivity: clamp(Number(els.sensitivityInput.value) || defaults.sensitivity, 0.55, 1.55),
      backgroundRadius: clamp(Math.round(Number(els.backgroundInput.value) || defaults.backgroundRadius), 0, 90),
      minDiameter: Math.max(1, Number(els.minDiameterInput.value) || defaults.minDiameter),
      maxDiameter: Math.max(2, Number(els.maxDiameterInput.value) || defaults.maxDiameter),
      minCircularity: clamp(Number(els.circularityInput.value) || 0, 0, 1),
      edgeMargin: clamp(Math.round(Number(els.edgeInput.value) || 0), 0, 80),
      overlayOpacity: clamp(Number(els.overlayInput.value) / 100, 0, 1),
      zoom: clamp(Number(els.zoomInput.value) || 100, 10, 800),
      showLabels: els.labelsInput.checked,
      manualDiameter: clamp(Math.round(Number(els.manualDiameterInput.value) || defaults.manualDiameter), 3, 90),
      micronPerPixel: Math.max(0, Number(els.micronInput.value) || 0),
    };

    if (settings.maxDiameter < settings.minDiameter) {
      settings.maxDiameter = settings.minDiameter + 1;
    }

    return settings;
  }

  function scheduleAnalyze() {
    syncReadouts();
    if (!state.source) return;
    window.clearTimeout(state.analyzeTimer);
    state.analyzeTimer = window.setTimeout(() => analyzeImage(), 300);
  }

  function buildIntensity(data, channel) {
    const total = data.length / 4;
    const out = new Uint8Array(total);
    for (let i = 0, p = 0; i < total; i += 1, p += 4) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      if (channel === "red") out[i] = r;
      else if (channel === "green") out[i] = g;
      else if (channel === "blue") out[i] = b;
      else out[i] = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    }
    return out;
  }

  function buildSignal(intensity, background, mode) {
    const out = new Uint8Array(intensity.length);
    for (let i = 0; i < intensity.length; i += 1) {
      const diff = intensity[i] - background[i];
      out[i] = mode === "fluorescence" ? Math.max(0, diff) : Math.abs(diff);
    }
    return out;
  }

  function boxBlur(src, width, height, radius) {
    if (radius <= 0) return src.slice();
    const total = width * height;
    const tmp = new Uint8Array(total);
    const dst = new Uint8Array(total);
    const diameter = radius * 2 + 1;

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1) {
        sum += src[row + clamp(x, 0, width - 1)];
      }
      for (let x = 0; x < width; x += 1) {
        tmp[row + x] = Math.round(sum / diameter);
        const removeX = clamp(x - radius, 0, width - 1);
        const addX = clamp(x + radius + 1, 0, width - 1);
        sum += src[row + addX] - src[row + removeX];
      }
    }

    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -radius; y <= radius; y += 1) {
        sum += tmp[clamp(y, 0, height - 1) * width + x];
      }
      for (let y = 0; y < height; y += 1) {
        dst[y * width + x] = Math.round(sum / diameter);
        const removeY = clamp(y - radius, 0, height - 1);
        const addY = clamp(y + radius + 1, 0, height - 1);
        sum += tmp[addY * width + x] - tmp[removeY * width + x];
      }
    }

    return dst;
  }

  function buildHistogram(signal, width, bounds) {
    const histogram = new Uint32Array(256);
    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      let index = y * width + bounds.x0;
      for (let x = bounds.x0; x < bounds.x1; x += 1, index += 1) {
        histogram[signal[index]] += 1;
      }
    }
    return histogram;
  }

  function autoThreshold(histogram, mode, sensitivity) {
    const otsu = otsuThreshold(histogram);
    const percentile = percentileThreshold(histogram, mode === "fluorescence" ? 0.965 : 0.91);
    const base = mode === "fluorescence" ? Math.max(otsu, percentile * 0.82) : Math.max(otsu, percentile);
    return clamp(Math.round(base / sensitivity), 1, 255);
  }

  function otsuThreshold(histogram) {
    let total = 0;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) {
      total += histogram[i];
      sum += i * histogram[i];
    }

    let sumBackground = 0;
    let weightBackground = 0;
    let bestVariance = -1;
    let threshold = 0;

    for (let i = 0; i < 256; i += 1) {
      weightBackground += histogram[i];
      if (weightBackground === 0) continue;
      const weightForeground = total - weightBackground;
      if (weightForeground === 0) break;

      sumBackground += i * histogram[i];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        threshold = i;
      }
    }

    return threshold;
  }

  function percentileThreshold(histogram, percentile) {
    let total = 0;
    for (let i = 0; i < 256; i += 1) total += histogram[i];
    const target = total * percentile;
    let seen = 0;
    for (let i = 0; i < 256; i += 1) {
      seen += histogram[i];
      if (seen >= target) return i;
    }
    return 255;
  }

  function findObjects(signal, width, height, bounds, threshold, settings) {
    const total = width * height;
    const mask = new Uint8Array(total);
    const visited = new Uint8Array(total);
    const queue = new Int32Array(bounds.width * bounds.height);
    const objects = [];
    const minDiameter = settings.minDiameter;
    const maxDiameter = settings.maxDiameter;

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      let index = y * width + bounds.x0;
      for (let x = bounds.x0; x < bounds.x1; x += 1, index += 1) {
        if (signal[index] >= threshold) mask[index] = 1;
      }
    }

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      for (let x = bounds.x0; x < bounds.x1; x += 1) {
        const start = y * width + x;
        if (!mask[start] || visited[start]) continue;

        let head = 0;
        let tail = 0;
        queue[tail] = start;
        tail += 1;
        visited[start] = 1;

        let area = 0;
        let sumX = 0;
        let sumY = 0;
        let sumSignal = 0;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let perimeter = 0;

        while (head < tail) {
          const index = queue[head];
          head += 1;
          const py = Math.floor(index / width);
          const px = index - py * width;

          area += 1;
          sumX += px;
          sumY += py;
          sumSignal += signal[index];
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;

          perimeter += edgeContribution(mask, width, bounds, px, py);

          for (let dy = -1; dy <= 1; dy += 1) {
            const ny = py + dy;
            if (ny < bounds.y0 || ny >= bounds.y1) continue;
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx === 0 && dy === 0) continue;
              const nx = px + dx;
              if (nx < bounds.x0 || nx >= bounds.x1) continue;
              const next = ny * width + nx;
              if (mask[next] && !visited[next]) {
                visited[next] = 1;
                queue[tail] = next;
                tail += 1;
              }
            }
          }
        }

        const equivalentDiameter = Math.sqrt((4 * area) / Math.PI);
        const circularity = perimeter > 0 ? clamp((4 * Math.PI * area) / (perimeter * perimeter), 0, 1) : 1;
        const accepted =
          equivalentDiameter >= minDiameter &&
          equivalentDiameter <= maxDiameter &&
          circularity >= settings.minCircularity;

        if (accepted) {
          objects.push({
            id: objects.length + 1,
            x: sumX / area,
            y: sumY / area,
            area,
            equivalentDiameter,
            circularity,
            meanSignal: sumSignal / area,
            minX,
            maxX,
            minY,
            maxY,
          });
        } else {
          for (let i = 0; i < tail; i += 1) {
            mask[queue[i]] = 0;
          }
        }
      }
    }

    return { mask, objects };
  }

  function edgeContribution(mask, width, bounds, x, y) {
    let edges = 0;
    const checks = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of checks) {
      if (nx < bounds.x0 || nx >= bounds.x1 || ny < bounds.y0 || ny >= bounds.y1) {
        edges += 1;
      } else if (!mask[ny * width + nx]) {
        edges += 1;
      }
    }
    return edges;
  }

  function getAnalysisBounds(width, height, margin) {
    const roi = normalizedRoi(state.roi) || { x: 0, y: 0, width, height };
    const x0 = clamp(Math.round(roi.x + margin), 0, width);
    const y0 = clamp(Math.round(roi.y + margin), 0, height);
    const x1 = clamp(Math.round(roi.x + roi.width - margin), 0, width);
    const y1 = clamp(Math.round(roi.y + roi.height - margin), 0, height);
    return {
      x0,
      y0,
      x1,
      y1,
      width: Math.max(0, x1 - x0),
      height: Math.max(0, y1 - y0),
    };
  }

  function detectCellMask(signal, width, height, bounds) {
    const histogram = buildHistogram(signal, width, bounds);
    const base = percentileThreshold(histogram, 0.72);
    const threshold = clamp(Math.round(base * 0.55), 3, 255);
    const mask = new Uint8Array(width * height);

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      let index = y * width + bounds.x0;
      for (let x = bounds.x0; x < bounds.x1; x += 1, index += 1) {
        if (signal[index] >= threshold) mask[index] = 1;
      }
    }

    const radius = clamp(Math.round(Math.min(bounds.width, bounds.height) / 110), 3, 18);
    let cleaned = closeMask(mask, width, height, bounds, radius);
    cleaned = fillHoles(cleaned, width, height, bounds);
    cleaned = openMask(cleaned, width, height, bounds, Math.max(2, Math.round(radius / 3)));
    cleaned = largestComponent(cleaned, width, height, bounds);

    const area = countMaskPixels(cleaned);
    const minArea = Math.max(400, bounds.width * bounds.height * 0.015);
    if (area >= minArea && isReliableCellMask(cleaned, width, height, bounds)) return cleaned;
    const objectFallback = state.roi ? cellMaskFromObjects(width, height, bounds) : null;
    if (objectFallback && isReliableCellMask(objectFallback, width, height, bounds)) {
      const fallbackArea = countMaskPixels(objectFallback);
      if (fallbackArea / Math.max(1, bounds.width * bounds.height) <= 0.38) return objectFallback;
    }
    return null;
  }

  function isReliableCellMask(mask, width, height, bounds) {
    if (!mask) return false;
    const stats = maskStats(mask, width, height, bounds);
    if (!stats.area) return false;
    const boundsArea = bounds.width * bounds.height;
    const areaFraction = stats.area / Math.max(1, boundsArea);
    if (areaFraction < 0.015 || areaFraction > 0.52) return false;

    const fillsNearlyWholeRoi = stats.width > bounds.width * 0.94 && stats.height > bounds.height * 0.94;
    if (fillsNearlyWholeRoi) return false;

    const touchCount =
      (stats.minX <= bounds.x0 + 2 ? 1 : 0) +
      (stats.maxX >= bounds.x1 - 3 ? 1 : 0) +
      (stats.minY <= bounds.y0 + 2 ? 1 : 0) +
      (stats.maxY >= bounds.y1 - 3 ? 1 : 0);
    if (touchCount >= 3) return false;

    const borderLength = Math.max(1, bounds.width * 2 + bounds.height * 2);
    if (stats.borderPixels / borderLength > 0.16) return false;
    return true;
  }

  function maskStats(mask, width, height, bounds) {
    let area = 0;
    let minX = bounds.x1;
    let maxX = bounds.x0;
    let minY = bounds.y1;
    let maxY = bounds.y0;
    let borderPixels = 0;

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      let index = y * width + bounds.x0;
      for (let x = bounds.x0; x < bounds.x1; x += 1, index += 1) {
        if (!mask[index]) continue;
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x === bounds.x0 || x === bounds.x1 - 1 || y === bounds.y0 || y === bounds.y1 - 1) {
          borderPixels += 1;
        }
      }
    }

    return {
      area,
      minX,
      maxX,
      minY,
      maxY,
      width: area ? maxX - minX + 1 : 0,
      height: area ? maxY - minY + 1 : 0,
      borderPixels,
    };
  }

  function openMask(mask, width, height, bounds, radius) {
    return dilateMask(erodeMask(mask, width, height, bounds, radius), width, height, bounds, radius);
  }

  function closeMask(mask, width, height, bounds, radius) {
    return erodeMask(dilateMask(mask, width, height, bounds, radius), width, height, bounds, radius);
  }

  function dilateMask(mask, width, height, bounds, radius) {
    const tmp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      const row = y * width;
      let sum = 0;
      let left = bounds.x0;
      let right = bounds.x0 - 1;
      for (let x = bounds.x0; x < bounds.x1; x += 1) {
        const wantRight = Math.min(bounds.x1 - 1, x + radius);
        while (right < wantRight) {
          right += 1;
          sum += mask[row + right];
        }
        const wantLeft = Math.max(bounds.x0, x - radius);
        while (left < wantLeft) {
          sum -= mask[row + left];
          left += 1;
        }
        tmp[row + x] = sum > 0 ? 1 : 0;
      }
    }

    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      let sum = 0;
      let top = bounds.y0;
      let bottom = bounds.y0 - 1;
      for (let y = bounds.y0; y < bounds.y1; y += 1) {
        const wantBottom = Math.min(bounds.y1 - 1, y + radius);
        while (bottom < wantBottom) {
          bottom += 1;
          sum += tmp[bottom * width + x];
        }
        const wantTop = Math.max(bounds.y0, y - radius);
        while (top < wantTop) {
          sum -= tmp[top * width + x];
          top += 1;
        }
        out[y * width + x] = sum > 0 ? 1 : 0;
      }
    }

    return out;
  }

  function erodeMask(mask, width, height, bounds, radius) {
    const tmp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      const row = y * width;
      let sum = 0;
      let left = bounds.x0;
      let right = bounds.x0 - 1;
      for (let x = bounds.x0; x < bounds.x1; x += 1) {
        const wantRight = Math.min(bounds.x1 - 1, x + radius);
        while (right < wantRight) {
          right += 1;
          sum += mask[row + right];
        }
        const wantLeft = Math.max(bounds.x0, x - radius);
        while (left < wantLeft) {
          sum -= mask[row + left];
          left += 1;
        }
        tmp[row + x] = sum === right - left + 1 ? 1 : 0;
      }
    }

    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      let sum = 0;
      let top = bounds.y0;
      let bottom = bounds.y0 - 1;
      for (let y = bounds.y0; y < bounds.y1; y += 1) {
        const wantBottom = Math.min(bounds.y1 - 1, y + radius);
        while (bottom < wantBottom) {
          bottom += 1;
          sum += tmp[bottom * width + x];
        }
        const wantTop = Math.max(bounds.y0, y - radius);
        while (top < wantTop) {
          sum -= tmp[top * width + x];
          top += 1;
        }
        out[y * width + x] = sum === bottom - top + 1 ? 1 : 0;
      }
    }

    return out;
  }

  function fillHoles(mask, width, height, bounds) {
    const background = new Uint8Array(mask.length);
    const queue = new Int32Array(bounds.width * bounds.height);
    let head = 0;
    let tail = 0;

    const enqueue = (x, y) => {
      if (x < bounds.x0 || x >= bounds.x1 || y < bounds.y0 || y >= bounds.y1) return;
      const index = y * width + x;
      if (mask[index] || background[index]) return;
      background[index] = 1;
      queue[tail] = index;
      tail += 1;
    };

    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      enqueue(x, bounds.y0);
      enqueue(x, bounds.y1 - 1);
    }
    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      enqueue(bounds.x0, y);
      enqueue(bounds.x1 - 1, y);
    }

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const y = Math.floor(index / width);
      const x = index - y * width;
      enqueue(x - 1, y);
      enqueue(x + 1, y);
      enqueue(x, y - 1);
      enqueue(x, y + 1);
    }

    const out = mask.slice();
    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      let index = y * width + bounds.x0;
      for (let x = bounds.x0; x < bounds.x1; x += 1, index += 1) {
        if (!out[index] && !background[index]) out[index] = 1;
      }
    }
    return out;
  }

  function largestComponent(mask, width, height, bounds) {
    const labels = new Int32Array(mask.length);
    const queue = new Int32Array(bounds.width * bounds.height);
    let label = 0;
    let bestLabel = 0;
    let bestArea = 0;

    for (let y = bounds.y0; y < bounds.y1; y += 1) {
      for (let x = bounds.x0; x < bounds.x1; x += 1) {
        const start = y * width + x;
        if (!mask[start] || labels[start]) continue;
        label += 1;
        let head = 0;
        let tail = 0;
        labels[start] = label;
        queue[tail] = start;
        tail += 1;

        while (head < tail) {
          const index = queue[head];
          head += 1;
          const py = Math.floor(index / width);
          const px = index - py * width;
          const neighbors = [
            [px - 1, py],
            [px + 1, py],
            [px, py - 1],
            [px, py + 1],
          ];
          for (const [nx, ny] of neighbors) {
            if (nx < bounds.x0 || nx >= bounds.x1 || ny < bounds.y0 || ny >= bounds.y1) continue;
            const next = ny * width + nx;
            if (mask[next] && !labels[next]) {
              labels[next] = label;
              queue[tail] = next;
              tail += 1;
            }
          }
        }

        if (tail > bestArea) {
          bestArea = tail;
          bestLabel = label;
        }
      }
    }

    if (!bestLabel) return null;
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i] === bestLabel) out[i] = 1;
    }
    return out;
  }

  function cellMaskFromObjects(width, height, bounds) {
    const candidates = state.objects
      .filter((object) => objectWithinBounds(object, bounds))
      .filter((object) => object.equivalentDiameter >= state.settings.minDiameter)
      .filter((object) => {
        const edgePad = Math.max(8, Math.min(bounds.width, bounds.height) * 0.018);
        return (
          object.x > bounds.x0 + edgePad &&
          object.x < bounds.x1 - edgePad &&
          object.y > bounds.y0 + edgePad &&
          object.y < bounds.y1 - edgePad
        );
      });
    if (candidates.length < 3) return null;

    const medianX = median(candidates.map((object) => object.x));
    const medianY = median(candidates.map((object) => object.y));
    const distances = candidates.map((object) => Math.hypot(object.x - medianX, object.y - medianY));
    const cutoff = percentileValue(distances, candidates.length > 12 ? 0.78 : 0.9);
    const cluster = candidates.filter((object, index) => distances[index] <= cutoff);
    const objects = cluster.length >= 3 ? cluster : candidates;
    const padding = Math.max(28, Math.min(width, height) * 0.055);
    const minX = Math.max(bounds.x0, Math.min(...objects.map((object) => object.minX)) - padding);
    const maxX = Math.min(bounds.x1 - 1, Math.max(...objects.map((object) => object.maxX)) + padding);
    const minY = Math.max(bounds.y0, Math.min(...objects.map((object) => object.minY)) - padding);
    const maxY = Math.min(bounds.y1 - 1, Math.max(...objects.map((object) => object.maxY)) + padding);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let rx = Math.max(12, (maxX - minX) / 2);
    let ry = Math.max(12, (maxY - minY) / 2);
    const maxArea = bounds.width * bounds.height * 0.58;
    const ellipseArea = Math.PI * rx * ry;
    if (ellipseArea > maxArea) {
      const scale = Math.sqrt(maxArea / ellipseArea);
      rx *= scale;
      ry *= scale;
    }
    const out = new Uint8Array(width * height);
    const y0 = Math.max(bounds.y0, Math.round(cy - ry));
    const y1 = Math.min(bounds.y1 - 1, Math.round(cy + ry));
    const x0 = Math.max(bounds.x0, Math.round(cx - rx));
    const x1 = Math.min(bounds.x1 - 1, Math.round(cx + rx));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) out[y * width + x] = 1;
      }
    }
    return out;
  }

  function median(values) {
    return percentileValue(values, 0.5);
  }

  function percentileValue(values, percentile) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = clamp(Math.round((sorted.length - 1) * percentile), 0, sorted.length - 1);
    return sorted[index];
  }

  function polygonToMask(points, width, height) {
    if (!points || points.length < 3) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    const data = ctx.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0, p = 3; i < mask.length; i += 1, p += 4) {
      if (data[p]) mask[i] = 1;
    }
    return mask;
  }

  function countMaskPixels(mask) {
    if (!mask) return 0;
    let count = 0;
    for (let i = 0; i < mask.length; i += 1) count += mask[i] ? 1 : 0;
    return count;
  }

  function countEffectiveCellPixels() {
    if (!state.cellMask) return 0;
    let count = 0;
    for (let i = 0; i < state.cellMask.length; i += 1) {
      if (state.cellMask[i] && !state.backgroundEraseMask?.[i]) count += 1;
    }
    return count;
  }

  function countErasedCellPixels() {
    if (!state.backgroundEraseMask) return 0;
    if (!state.cellMask) return countMaskPixels(state.backgroundEraseMask);
    let count = 0;
    for (let i = 0; i < state.backgroundEraseMask.length; i += 1) {
      if (state.backgroundEraseMask[i] && state.cellMask[i]) count += 1;
    }
    return count;
  }

  function isObjectCounted(object) {
    if (!state.source) return false;
    const x = clamp(Math.round(object.x), 0, state.source.width - 1);
    const y = clamp(Math.round(object.y), 0, state.source.height - 1);
    const index = y * state.source.width + x;
    if (state.backgroundEraseMask?.[index]) return false;
    if (state.cellMask) return Boolean(state.cellMask[index]);
    return true;
  }

  function countedObjects() {
    return state.objects.filter(isObjectCounted);
  }

  function decodeMaskRle(start, runs, width, height) {
    const mask = new Uint8Array(width * height);
    let value = start ? 1 : 0;
    let cursor = 0;
    (runs || []).forEach((length) => {
      if (value) mask.fill(1, cursor, Math.min(mask.length, cursor + length));
      cursor += length;
      value = value ? 0 : 1;
    });
    return mask;
  }

  function sourceImageDataUrl() {
    const canvas = document.createElement("canvas");
    canvas.width = state.source.width;
    canvas.height = state.source.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(state.source.imageData, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function downsamplePoints(points, targetCount) {
    if (!points.length || points.length <= targetCount) return points.map((point) => ({ ...point }));
    const out = [];
    const step = points.length / targetCount;
    for (let i = 0; i < targetCount; i += 1) {
      out.push({ ...points[Math.floor(i * step)] });
    }
    return out;
  }

  function composeObjects() {
    if (!state.source) return [];
    const bounds = state.bounds || {
      x0: 0,
      y0: 0,
      x1: state.source.width,
      y1: state.source.height,
      width: state.source.width,
      height: state.source.height,
    };

    return [...state.autoObjects.filter((object) => !isSuppressed(object)), ...state.manualObjects]
      .filter((object) => objectWithinBounds(object, bounds))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((object, index) => ({ ...object, id: index + 1 }));
  }

  function isSuppressed(object) {
    return state.suppressedObjects.some((suppression) => {
      const distance = Math.hypot(object.x - suppression.x, object.y - suppression.y);
      return distance <= suppression.radius + object.equivalentDiameter / 2;
    });
  }

  function objectWithinBounds(object, bounds) {
    return object.x >= bounds.x0 && object.x < bounds.x1 && object.y >= bounds.y0 && object.y < bounds.y1;
  }

  function renderCanvas() {
    if (!state.source) return;
    const { width, height, imageData } = state.source;
    const ctx = els.imageCanvas.getContext("2d", { willReadFrequently: true });
    const output = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
    const opacity = state.settings.overlayOpacity;

    if (state.mask && opacity > 0) {
      const color = [0, 166, 166];
      for (let i = 0, p = 0; i < state.mask.length; i += 1, p += 4) {
        if (!state.mask[i]) continue;
        output.data[p] = Math.round(output.data[p] * (1 - opacity) + color[0] * opacity);
        output.data[p + 1] = Math.round(output.data[p + 1] * (1 - opacity) + color[1] * opacity);
        output.data[p + 2] = Math.round(output.data[p + 2] * (1 - opacity) + color[2] * opacity);
      }
    }

    if (state.cellMask) {
      const cellOpacity = Math.min(0.3, Math.max(0.12, opacity * 0.35));
      const color = [34, 197, 94];
      for (let i = 0, p = 0; i < state.cellMask.length; i += 1, p += 4) {
        if (!state.cellMask[i]) continue;
        output.data[p] = Math.round(output.data[p] * (1 - cellOpacity) + color[0] * cellOpacity);
        output.data[p + 1] = Math.round(output.data[p + 1] * (1 - cellOpacity) + color[1] * cellOpacity);
        output.data[p + 2] = Math.round(output.data[p + 2] * (1 - cellOpacity) + color[2] * cellOpacity);
      }
    }

    if (state.backgroundEraseMask) {
      const eraseOpacity = Math.min(0.48, Math.max(0.2, opacity * 0.5));
      const color = [214, 68, 68];
      for (let i = 0, p = 0; i < state.backgroundEraseMask.length; i += 1, p += 4) {
        if (!state.backgroundEraseMask[i]) continue;
        output.data[p] = Math.round(output.data[p] * (1 - eraseOpacity) + color[0] * eraseOpacity);
        output.data[p + 1] = Math.round(output.data[p + 1] * (1 - eraseOpacity) + color[1] * eraseOpacity);
        output.data[p + 2] = Math.round(output.data[p + 2] * (1 - eraseOpacity) + color[2] * eraseOpacity);
      }
    }

    ctx.putImageData(output, 0, 0);
    drawCellOverlay(ctx);
    drawObjectOverlay(ctx);
    drawSamBoxOverlay(ctx);
    drawRoiOverlay(ctx);
  }

  function drawCellOverlay(ctx) {
    if (!state.source) return;
    const { width, height } = state.source;
    const contour = state.cellContour || [];
    ctx.save();
    ctx.lineWidth = Math.max(2, Math.round(Math.min(width, height) / 650));
    ctx.strokeStyle = "#16a34a";
    ctx.fillStyle = "#16a34a";

    if (state.cellMask) {
      const step = Math.max(1, Math.round(Math.min(width, height) / 1200));
      ctx.globalAlpha = 0.9;
      for (let y = 1; y < height - 1; y += step) {
        for (let x = 1; x < width - 1; x += step) {
          const index = y * width + x;
          if (
            state.cellMask[index] &&
            (!state.cellMask[index - 1] ||
              !state.cellMask[index + 1] ||
              !state.cellMask[index - width] ||
              !state.cellMask[index + width])
          ) {
            ctx.fillRect(x, y, step, step);
          }
        }
      }
    }

    if (contour.length) {
      ctx.globalAlpha = 1;
      ctx.setLineDash(state.cellDrawMode || state.samPointMode ? [12, 8] : []);
      ctx.beginPath();
      contour.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      if (state.cellContourSource !== "manual-draft" && contour.length >= 3) ctx.closePath();
      ctx.stroke();

      const dotRadius = Math.max(3, Math.round(Math.min(width, height) / 400));
      contour.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    if (state.cellControlPoints.length) {
      ctx.globalAlpha = 1;
      const positivePoints = state.cellControlPoints.filter((point) => point.label !== 0);
      ctx.strokeStyle = "#16a34a";
      ctx.fillStyle = "#16a34a";
      ctx.setLineDash([8, 8]);
      if (positivePoints.length >= 2) {
        ctx.beginPath();
        positivePoints.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        if (positivePoints.length >= 3) ctx.closePath();
        ctx.stroke();
      }
      const radius = Math.max(4, Math.round(Math.min(width, height) / 360));
      state.cellControlPoints.forEach((point) => {
        ctx.beginPath();
        ctx.fillStyle = point.label === 0 ? "#ef4444" : "#16a34a";
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        if (point.label === 0) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(1, Math.round(radius / 3));
          ctx.beginPath();
          ctx.moveTo(point.x - radius * 0.75, point.y - radius * 0.75);
          ctx.lineTo(point.x + radius * 0.75, point.y + radius * 0.75);
          ctx.moveTo(point.x + radius * 0.75, point.y - radius * 0.75);
          ctx.lineTo(point.x - radius * 0.75, point.y + radius * 0.75);
          ctx.stroke();
        }
      });
    }

    ctx.restore();
  }

  function drawSamBoxOverlay(ctx) {
    const box = normalizedSamBox(state.tempSamBox || state.samBox);
    if (!box) return;
    ctx.save();
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = Math.max(2, Math.round(Math.min(state.source.width, state.source.height) / 720));
    ctx.setLineDash([12, 8]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.fillStyle = "rgba(22, 163, 74, 0.08)";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.restore();
  }

  function drawObjectOverlay(ctx) {
    if (!state.objects.length) return;
    ctx.save();
    ctx.lineWidth = Math.max(2, Math.round(Math.min(state.source.width, state.source.height) / 900));
    ctx.font = `${Math.max(11, Math.round(state.source.width / 180))}px ui-sans-serif, system-ui`;
    ctx.textBaseline = "middle";

    state.objects.forEach((object) => {
      const radius = object.equivalentDiameter / 2 + 2;
      const isManual = object.source === "manual";
      const counted = isObjectCounted(object);
      ctx.globalAlpha = counted ? 1 : 0.35;
      ctx.strokeStyle = counted ? (isManual ? "#22c55e" : "#ffb000") : "#64748b";
      ctx.fillStyle = counted ? (isManual ? "#22c55e" : "#ffb000") : "#64748b";
      ctx.beginPath();
      ctx.arc(object.x, object.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (isManual) {
        const tick = Math.max(4, radius * 0.42);
        ctx.beginPath();
        ctx.moveTo(object.x - tick, object.y);
        ctx.lineTo(object.x + tick, object.y);
        ctx.moveTo(object.x, object.y - tick);
        ctx.lineTo(object.x, object.y + tick);
        ctx.stroke();
      }
      if (state.settings.showLabels) {
        ctx.fillText(String(object.id), object.x + radius + 3, object.y);
      }
    });
    ctx.restore();
  }

  function drawRoiOverlay(ctx) {
    const roi = normalizedRoi(state.tempRoi || state.roi);
    if (!roi) return;
    const { width, height } = state.source;

    ctx.save();
    ctx.fillStyle = "rgba(23, 32, 31, 0.18)";
    ctx.fillRect(0, 0, width, roi.y);
    ctx.fillRect(0, roi.y + roi.height, width, height - (roi.y + roi.height));
    ctx.fillRect(0, roi.y, roi.x, roi.height);
    ctx.fillRect(roi.x + roi.width, roi.y, width - (roi.x + roi.width), roi.height);
    ctx.strokeStyle = "#f5b84b";
    ctx.lineWidth = Math.max(2, Math.round(Math.min(width, height) / 900));
    ctx.setLineDash([14, 10]);
    ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
    ctx.restore();
  }

  function scaleCanvas(options = {}) {
    if (!state.source) return;
    const stage = els.dropZone;
    const maxWidth = Math.max(280, stage.clientWidth - 48);
    const maxHeight = Math.max(280, stage.clientHeight - 48);
    state.fitScale = Math.min(maxWidth / state.source.width, maxHeight / state.source.height);
    const scale = state.fitScale * (state.settings.zoom / 100);
    const canvasWidth = Math.max(1, state.source.width * scale);
    const canvasHeight = Math.max(1, state.source.height * scale);
    els.imageCanvas.style.width = `${canvasWidth}px`;
    els.imageCanvas.style.height = `${canvasHeight}px`;

    if (options.center) {
      centerStageScroll();
      return;
    }

    if (Number.isFinite(options.anchorX) && Number.isFinite(options.anchorY)) {
      const offsetX = Number.isFinite(options.offsetX) ? options.offsetX : stage.clientWidth / 2;
      const offsetY = Number.isFinite(options.offsetY) ? options.offsetY : stage.clientHeight / 2;
      stage.scrollLeft = els.imageCanvas.offsetLeft + canvasWidth * options.anchorX - offsetX;
      stage.scrollTop = els.imageCanvas.offsetTop + canvasHeight * options.anchorY - offsetY;
    }
  }

  function viewportCenterAnchor() {
    if (!state.source || !els.imageCanvas.classList.contains("ready")) return {};
    const rect = els.imageCanvas.getBoundingClientRect();
    const stageRect = els.dropZone.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return {};
    const offsetX = els.dropZone.clientWidth / 2;
    const offsetY = els.dropZone.clientHeight / 2;
    return {
      anchorX: clamp((stageRect.left + offsetX - rect.left) / rect.width, 0, 1),
      anchorY: clamp((stageRect.top + offsetY - rect.top) / rect.height, 0, 1),
      offsetX,
      offsetY,
    };
  }

  function pointerAnchor(event) {
    const rect = els.imageCanvas.getBoundingClientRect();
    const stageRect = els.dropZone.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return viewportCenterAnchor();
    return {
      anchorX: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      anchorY: clamp((event.clientY - rect.top) / rect.height, 0, 1),
      offsetX: event.clientX - stageRect.left,
      offsetY: event.clientY - stageRect.top,
    };
  }

  function setZoom(zoom, anchor = {}) {
    state.settings.zoom = clamp(Math.round(zoom), 10, 800);
    els.zoomInput.value = String(state.settings.zoom);
    syncReadouts();
    scaleCanvas(anchor);
  }

  function fitCanvasToStage() {
    state.settings.zoom = 100;
    els.zoomInput.value = "100";
    syncReadouts();
    scaleCanvas({ center: true });
    setStatus("已适合窗口");
  }

  function centerStageScroll() {
    const stage = els.dropZone;
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
  }

  function togglePanel(side) {
    if (side === "left") state.leftPanelCollapsed = !state.leftPanelCollapsed;
    if (side === "right") state.rightPanelCollapsed = !state.rightPanelCollapsed;
    applyPanelLayout();
    window.setTimeout(() => {
      if (state.source) scaleCanvas(viewportCenterAnchor());
    }, 180);
  }

  function applyPanelLayout() {
    document.documentElement.style.setProperty("--left-width", `${state.leftPanelWidth}px`);
    document.documentElement.style.setProperty("--right-width", `${state.rightPanelWidth}px`);
    document.body.classList.toggle("left-collapsed", state.leftPanelCollapsed);
    document.body.classList.toggle("right-collapsed", state.rightPanelCollapsed);
    els.leftToggleButton.textContent = state.leftPanelCollapsed ? "›" : "‹";
    els.rightToggleButton.textContent = state.rightPanelCollapsed ? "‹" : "›";
    els.leftToggleButton.title = state.leftPanelCollapsed ? "展开左侧栏" : "折叠左侧栏";
    els.rightToggleButton.title = state.rightPanelCollapsed ? "展开右侧栏" : "折叠右侧栏";
  }

  function startPanelResize(side, event) {
    event.preventDefault();
    state.resizingPanel = side;
    document.body.classList.add("resizing-panels");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function resizePanel(event) {
    event.preventDefault();
    const layout = document.querySelector(".layout");
    const rect = layout.getBoundingClientRect();
    if (state.resizingPanel === "left") {
      const width = event.clientX - rect.left;
      if (width < 80) {
        state.leftPanelCollapsed = true;
      } else {
        state.leftPanelCollapsed = false;
        const maxWidth = Math.max(220, Math.min(520, rect.width - 520));
        state.leftPanelWidth = clamp(Math.round(width), 220, maxWidth);
      }
    } else if (state.resizingPanel === "right") {
      const width = rect.right - event.clientX;
      if (width < 80) {
        state.rightPanelCollapsed = true;
      } else {
        state.rightPanelCollapsed = false;
        const maxWidth = Math.max(240, Math.min(580, rect.width - 520));
        state.rightPanelWidth = clamp(Math.round(width), 240, maxWidth);
      }
    }
    applyPanelLayout();
    if (state.source) scaleCanvas(viewportCenterAnchor());
  }

  function finishPanelResize() {
    state.resizingPanel = null;
    document.body.classList.remove("resizing-panels");
    if (state.source) scaleCanvas(viewportCenterAnchor());
  }

  function setCorrectionMode(mode, updateStatus = true) {
    state.correctionMode = mode;
    document.querySelectorAll("[data-correction-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.correctionMode === mode);
    });
    els.imageCanvas.classList.toggle("correction-add", mode === "add");
    els.imageCanvas.classList.toggle("correction-remove", mode === "remove");
    if (mode !== "none") {
      state.cellDrawMode = false;
      state.samPointMode = false;
      state.samBoxMode = false;
      state.maskEditMode = false;
      els.imageCanvas.classList.remove("cell-draw-mode");
      els.imageCanvas.classList.remove("sam-point-mode", "sam-box-mode", "mask-edit-mode");
      els.drawCellButton?.classList.remove("active");
      els.samPointButton?.classList.remove("active");
      els.boxCellButton?.classList.remove("active");
      els.maskEditButton?.classList.remove("active");
      state.roiMode = false;
      els.roiButton?.classList.remove("active");
      els.imageCanvas.classList.remove("roi-mode");
    }
    if (updateStatus) {
      const message =
        mode === "add" ? "补点模式：点击漏识别脂滴中心" : mode === "remove" ? "删除模式：点击要移除的圈" : "手动修正关闭";
      setStatus(message);
    }
    updateButtonState();
  }

  function handleCanvasCorrection(event) {
    if (!state.source || state.busy || state.roiMode || state.correctionMode === "none" || state.drawingRoi) return;
    const point = canvasPoint(event);
    if (state.bounds && !objectWithinBounds(point, state.bounds)) {
      setStatus("点选位置在当前 ROI 外");
      return;
    }
    if (state.correctionMode === "add") {
      addManualObject(point);
    } else if (state.correctionMode === "remove") {
      removeNearestObject(point);
    }
  }

  function handleCanvasClick(event) {
    if (state.suppressCanvasClick) {
      state.suppressCanvasClick = false;
      return;
    }
    if (state.didPaintMask) {
      state.didPaintMask = false;
      return;
    }
    if (state.maskEditMode) return;
    if (state.samPointMode) {
      addSamPoint(event);
      return;
    }
    if (state.cellDrawMode) {
      addCellContourPoint(event);
      return;
    }
    handleCanvasCorrection(event);
  }

  function handleCanvasPointerDown(event) {
    if (startViewerPan(event)) return;
    if (state.maskEditMode) {
      if (event.shiftKey) {
        startMaskErase(event);
      } else {
        setStatus("手动蒙版：按住 Shift 在图像上涂抹背景区域");
      }
      return;
    }
    if (state.samBoxMode) {
      startSamBox(event);
      return;
    }
    startRoi(event);
  }

  function handleCanvasPointerMove(event) {
    if (state.resizingPanel) {
      resizePanel(event);
      return;
    }
    if (state.viewerPanning) {
      updateViewerPan(event);
      return;
    }
    if (state.isErasingMask) {
      paintEraseMask(event);
      return;
    }
    if (state.drawingSamBox) {
      updateSamBox(event);
      return;
    }
    if (state.samPointMode && !state.samBusy && !state.samUnavailable && state.cellControlPoints.length === 0) {
      scheduleSamHover(event);
      return;
    }
    updateRoi(event);
  }

  function handleCanvasPointerUp(event) {
    if (state.resizingPanel) {
      finishPanelResize();
      return;
    }
    if (state.viewerPanning) {
      finishViewerPan();
      return;
    }
    if (state.isErasingMask) {
      finishMaskErase();
      return;
    }
    if (state.drawingSamBox) {
      finishSamBox();
      return;
    }
    finishRoi();
  }

  function handleViewerWheel(event) {
    if (!state.source) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0014);
    const nextZoom = state.settings.zoom * factor;
    setZoom(nextZoom, pointerAnchor(event));
  }

  function startViewerPan(event) {
    if (!state.source || (event.button !== 1 && event.button !== 2)) return false;
    event.preventDefault();
    state.viewerPanning = true;
    state.suppressCanvasClick = false;
    state.panStartX = event.clientX;
    state.panStartY = event.clientY;
    state.panStartScrollLeft = els.dropZone.scrollLeft;
    state.panStartScrollTop = els.dropZone.scrollTop;
    els.dropZone.classList.add("panning");
    els.imageCanvas.setPointerCapture?.(event.pointerId);
    return true;
  }

  function updateViewerPan(event) {
    const dx = event.clientX - state.panStartX;
    const dy = event.clientY - state.panStartY;
    els.dropZone.scrollLeft = state.panStartScrollLeft - dx;
    els.dropZone.scrollTop = state.panStartScrollTop - dy;
    if (Math.hypot(dx, dy) > 3) state.suppressCanvasClick = true;
  }

  function finishViewerPan() {
    state.viewerPanning = false;
    els.dropZone.classList.remove("panning");
  }

  function setCellDrawMode(enabled, updateStatus = true) {
    state.cellDrawMode = Boolean(enabled && state.source);
    els.imageCanvas.classList.toggle("cell-draw-mode", state.cellDrawMode);
    els.drawCellButton.classList.toggle("active", state.cellDrawMode);
    if (state.cellDrawMode) {
      setSamPointMode(false, false);
      setSamBoxMode(false, false);
      setMaskEditMode(false, false);
      setCorrectionMode("none", false);
      state.roiMode = false;
      state.drawingRoi = false;
      state.tempRoi = null;
      els.roiButton?.classList.remove("active");
      els.imageCanvas.classList.remove("roi-mode");
    }
    if (updateStatus) {
      setStatus(state.cellDrawMode ? "沿细胞边缘依次点选，完成后点击闭合轮廓" : "细胞轮廓绘制关闭");
    }
    updateButtonState();
    if (state.source) renderCanvas();
  }

  function setSamPointMode(enabled, updateStatus = true) {
    state.samPointMode = Boolean(enabled && state.source);
    els.imageCanvas.classList.toggle("sam-point-mode", state.samPointMode);
    els.samPointButton.classList.toggle("active", state.samPointMode);
    if (state.samPointMode) {
      setCellDrawMode(false, false);
      setSamBoxMode(false, false);
      setMaskEditMode(false, false);
      setCorrectionMode("none", false);
      state.roiMode = false;
      state.drawingRoi = false;
      state.tempRoi = null;
      els.roiButton?.classList.remove("active");
      els.imageCanvas.classList.remove("roi-mode");
      if (!state.cellControlPoints.length && state.cellContour.length >= 3) {
        state.cellControlPoints = downsamplePoints(state.cellContour, 12);
      }
    }
    if (updateStatus) {
      const helper = hasSamBridge() ? "SAM 接口就绪" : "当前网页模式无 Python 桥接，将使用点选预览";
      setStatus(state.samPointMode ? `SAM 点选：点击添加绿色细胞点，按住 Alt/Option 点击添加红色背景点，${helper}` : "SAM 点选关闭");
    }
    updateButtonState();
    if (state.source) renderCanvas();
  }

  function setSamBoxMode(enabled, updateStatus = true) {
    state.samBoxMode = Boolean(enabled && state.source);
    els.imageCanvas.classList.toggle("sam-box-mode", state.samBoxMode);
    els.boxCellButton.classList.toggle("active", state.samBoxMode);
    if (state.samBoxMode) {
      setSamPointMode(false, false);
      setCellDrawMode(false, false);
      setMaskEditMode(false, false);
      setCorrectionMode("none", false);
      state.roiMode = false;
      state.drawingRoi = false;
      state.tempRoi = null;
      els.roiButton?.classList.remove("active");
      els.imageCanvas.classList.remove("roi-mode");
    }
    if (updateStatus) {
      setStatus(state.samBoxMode ? "SAM 框选：拖动鼠标粗略框住单个细胞" : "SAM 框选关闭");
    }
    updateButtonState();
    if (state.source) renderCanvas();
  }

  function setMaskEditMode(enabled, updateStatus = true) {
    state.maskEditMode = Boolean(enabled && state.source);
    els.imageCanvas.classList.toggle("mask-edit-mode", state.maskEditMode);
    els.maskEditButton.classList.toggle("active", state.maskEditMode);
    if (state.maskEditMode) {
      setSamPointMode(false, false);
      setSamBoxMode(false, false);
      setCellDrawMode(false, false);
      setCorrectionMode("none", false);
      state.roiMode = false;
      state.drawingRoi = false;
      state.tempRoi = null;
      els.roiButton?.classList.remove("active");
      els.imageCanvas.classList.remove("roi-mode");
    }
    if (updateStatus) {
      setStatus(state.maskEditMode ? "手动蒙版：按住 Shift 涂抹要排除的背景区域" : "手动蒙版编辑关闭");
    }
    updateButtonState();
    if (state.source) renderCanvas();
  }

  function addSamPoint(event) {
    if (!state.source || state.samBusy) return;
    const point = canvasPoint(event);
    point.label = event.altKey ? 0 : 1;
    state.cellControlPoints.push(point);
    state.samHoverPoint = null;
    state.samUnavailable = false;
    state.cellContourSource = "manual-draft";
    renderCanvas();
    updateButtonState();
    runSamPrediction("point");
  }

  function undoCellPoint() {
    if (!state.cellControlPoints.length || state.samBusy) return;
    state.cellControlPoints.pop();
    if (!state.cellControlPoints.length && state.cellContourSource === "manual-draft") {
      state.cellMask = null;
      state.cellContour = [];
    }
    renderCanvas();
    updateResults();
    updateButtonState();
    setStatus(`已撤销上一个点，剩余 ${state.cellControlPoints.length} 个`);
  }

  async function runSamPrediction(reason = "button", promptPoints = null) {
    const box = normalizedSamBox(state.samBox || state.tempSamBox);
    const points = promptPoints || state.cellControlPoints;
    const hasPositivePoint = points.some((point) => point.label !== 0);
    if (!state.source || state.samBusy) return;
    if ((!points.length || !hasPositivePoint) && !box) {
      if (reason === "button") setStatus("SAM 至少需要一个绿色点或一个框选区域");
      return;
    }

    state.samBusy = true;
    updateButtonState();
    setStatus("正在调用 SAM 模型分割细胞...");
    await nextFrame();

    try {
      if (hasSamBridge() && !state.samUnavailable) {
        const result = await window.lipidCellSegmentation.samPredict({
          imagePng: sourceImageDataUrl(),
          points: points.map((point) => ({ ...point, label: 1 })),
          box: box ? { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height } : null,
          modelType: "vit_b",
        });
        if (result?.ok) {
          applySamResult(result, reason === "hover" ? "sam-preview" : "sam");
          setStatus(`SAM 分割完成，置信度 ${formatNumber(result.score || 0)}`);
        } else {
          state.samUnavailable = true;
          const previewed = applyFallbackSamMask(box, points);
          setStatus(
            previewed
              ? `${result?.error || "SAM 不可用"}；已用绿色点生成临时多边形轮廓`
              : `${result?.error || "SAM 不可用"}；未生成粗略大圆，请安装 SAM 或至少添加 3 个绿色点`
          );
        }
      } else {
        const previewed = applyFallbackSamMask(box, points);
        setStatus(previewed ? "当前不是 Electron SAM 环境，已用绿色点生成临时多边形轮廓" : "当前不是 Electron SAM 环境：请安装并从软件版运行 SAM，或至少添加 3 个绿色点");
      }
    } catch (error) {
      console.error(error);
      const previewed = applyFallbackSamMask(box, points);
      setStatus(previewed ? "SAM 运行失败，已用绿色点生成临时多边形轮廓" : "SAM 运行失败，未生成粗略大圆");
    } finally {
      state.samBusy = false;
      renderCanvas();
      updateResults();
      updateButtonState();
      saveHistoryDebounced();
    }
  }

  function hasSamBridge() {
    return Boolean(window.lipidCellSegmentation?.samPredict);
  }

  function applySamResult(result, source) {
    state.cellMask = decodeMaskRle(result.maskStart, result.maskRle, result.width, result.height);
    state.cellContour = contourFromMaskBoundary(state.cellMask, result.width, result.height);
    state.cellContourSource = source;
  }

  function applyFallbackSamMask(box, points = state.cellControlPoints) {
    const positivePoints = points.filter((point) => point.label !== 0);
    if (positivePoints.length < 3) {
      state.cellMask = null;
      state.cellContour = [];
      state.cellContourSource = positivePoints.length ? "manual-draft" : "none";
      return false;
    }
    state.cellMask = polygonToMask(positivePoints, state.source.width, state.source.height);
    state.cellContour = contourFromMaskBoundary(state.cellMask, state.source.width, state.source.height);
    state.cellContourSource = "sam-preview";
    return true;
  }

  function startSamBox(event) {
    if (!state.source || !state.samBoxMode || state.samBusy) return;
    event.preventDefault();
    const point = canvasPoint(event);
    state.drawingSamBox = true;
    state.samBoxStart = point;
    state.tempSamBox = { x: point.x, y: point.y, width: 0, height: 0 };
    els.imageCanvas.setPointerCapture?.(event.pointerId);
  }

  function updateSamBox(event) {
    if (!state.drawingSamBox || !state.source) return;
    const point = canvasPoint(event);
    state.tempSamBox = {
      x: state.samBoxStart.x,
      y: state.samBoxStart.y,
      width: point.x - state.samBoxStart.x,
      height: point.y - state.samBoxStart.y,
    };
    renderCanvas();
  }

  function finishSamBox() {
    if (!state.drawingSamBox) return;
    state.drawingSamBox = false;
    const box = normalizedSamBox(state.tempSamBox);
    state.tempSamBox = null;
    if (box && box.width >= 8 && box.height >= 8) {
      state.samBox = box;
      state.samHoverPoint = null;
      runSamPrediction("box");
    } else {
      renderCanvas();
      setStatus("SAM 框选太小，请重新框选");
    }
  }

  function normalizedSamBox(box) {
    if (!box || !state.source) return null;
    const x = clamp(Math.min(box.x, box.x + box.width), 0, state.source.width);
    const y = clamp(Math.min(box.y, box.y + box.height), 0, state.source.height);
    const right = clamp(Math.max(box.x, box.x + box.width), 0, state.source.width);
    const bottom = clamp(Math.max(box.y, box.y + box.height), 0, state.source.height);
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  function scheduleSamHover(event) {
    if (!hasSamBridge() || state.samUnavailable) return;
    const point = canvasPoint(event);
    window.clearTimeout(state.samHoverTimer);
    state.samHoverTimer = window.setTimeout(() => {
      if (!state.samPointMode || state.cellControlPoints.length || state.samBusy) return;
      state.samHoverPoint = point;
      runSamPrediction("hover", [point]);
    }, 650);
  }

  function contourFromMaskBoundary(mask, width, height) {
    if (!mask) return [];
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    const boundary = [];
    const step = Math.max(1, Math.round(Math.min(width, height) / 900));
    for (let y = 1; y < height - 1; y += step) {
      for (let x = 1; x < width - 1; x += step) {
        const index = y * width + x;
        if (!mask[index]) continue;
        sumX += x;
        sumY += y;
        count += 1;
        if (!mask[index - 1] || !mask[index + 1] || !mask[index - width] || !mask[index + width]) {
          boundary.push({ x, y });
        }
      }
    }
    if (!boundary.length || !count) return [];
    const cx = sumX / count;
    const cy = sumY / count;
    boundary.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    return downsamplePoints(boundary, 240);
  }

  function startMaskErase(event) {
    if (!state.source) return;
    event.preventDefault();
    state.isErasingMask = true;
    state.didPaintMask = true;
    ensureEraseMask();
    els.imageCanvas.setPointerCapture?.(event.pointerId);
    paintEraseMask(event);
  }

  function paintEraseMask(event) {
    if (!state.source || !state.isErasingMask) return;
    const point = canvasPoint(event);
    const radius = Math.max(2, state.eraseBrushSize / 2);
    const radius2 = radius * radius;
    const { width, height } = state.source;
    const minX = Math.max(0, Math.floor(point.x - radius));
    const maxX = Math.min(width - 1, Math.ceil(point.x + radius));
    const minY = Math.max(0, Math.floor(point.y - radius));
    const maxY = Math.min(height - 1, Math.ceil(point.y + radius));
    ensureEraseMask();

    for (let y = minY; y <= maxY; y += 1) {
      const dy = y - point.y;
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - point.x;
        if (dx * dx + dy * dy <= radius2) {
          state.backgroundEraseMask[y * width + x] = 1;
        }
      }
    }

    renderCanvas();
  }

  function finishMaskErase() {
    state.isErasingMask = false;
    renderCanvas();
    updateResults();
    updateButtonState();
    saveHistoryDebounced();
    setStatus(`已擦除背景 ${formatArea(countMaskPixels(state.backgroundEraseMask))}`);
  }

  function ensureEraseMask() {
    if (!state.source) return;
    const total = state.source.width * state.source.height;
    if (!state.backgroundEraseMask || state.backgroundEraseMask.length !== total) {
      state.backgroundEraseMask = new Uint8Array(total);
    }
  }

  function clearBackgroundEraseMask() {
    state.backgroundEraseMask = null;
    renderCanvas();
    updateResults();
    updateButtonState();
    saveHistoryDebounced();
    setStatus("已清除手动擦除蒙版");
  }

  function addCellContourPoint(event) {
    if (!state.source || state.busy || state.drawingRoi) return;
    const point = canvasPoint(event);
    const first = state.cellContour[0];
    if (first && state.cellContour.length >= 3 && Math.hypot(point.x - first.x, point.y - first.y) <= 10) {
      finishCellContour();
      return;
    }
    state.cellContour.push(point);
    state.cellMask = null;
    state.cellContourSource = "manual-draft";
    renderCanvas();
    updateButtonState();
    setStatus(`已添加 ${state.cellContour.length} 个轮廓点`);
  }

  function finishCellContour() {
    if (!state.source) return;
    if (state.cellContour.length < 3) {
      setStatus("至少需要 3 个点才能闭合细胞轮廓");
      return;
    }
    state.cellMask = polygonToMask(state.cellContour, state.source.width, state.source.height);
    state.cellContourSource = "manual";
    state.cellControlPoints = [];
    setCellDrawMode(false, false);
    renderCanvas();
    updateResults();
    updateButtonState();
    saveHistoryDebounced();
    setStatus(`细胞轮廓已闭合，面积 ${formatArea(countMaskPixels(state.cellMask))}`);
  }

  function clearCellContour() {
    state.cellMask = null;
    state.cellContour = [];
    state.cellControlPoints = [];
    state.cellContourSource = "none";
    state.samBox = null;
    state.tempSamBox = null;
    state.samHoverPoint = null;
    setSamPointMode(false, false);
    setSamBoxMode(false, false);
    setCellDrawMode(false, false);
    renderCanvas();
    updateResults();
    updateButtonState();
    setStatus("已清除细胞轮廓");
  }

  async function autoDetectCell() {
    if (!state.source) return;
    if (!state.signal) {
      await analyzeImage();
      return;
    }
    const roiBox = normalizedRoi(state.roi);
    if (roiBox && hasSamBridge() && !state.samUnavailable) {
      state.samBox = roiBox;
      await runSamPrediction("box");
      return;
    }
    refreshCellMaskAfterAnalysis(true);
    renderCanvas();
    updateResults();
    updateButtonState();
    const area = countMaskPixels(state.cellMask);
    setStatus(
      area
        ? `已自动识别细胞轮廓，面积 ${formatArea(area)}`
        : "自动识别不够可靠：请先框选 ROI 后用 SAM，或改用手动绘制轮廓"
    );
  }

  function refreshCellMaskAfterAnalysis(forceAuto = false) {
    if (!state.source) return;
    const { width, height } = state.source;
    if (
      !forceAuto &&
      ["manual", "sam", "sam-preview"].includes(state.cellContourSource) &&
      state.cellContour.length >= 3
    ) {
      state.cellMask = polygonToMask(state.cellContour, width, height);
      return;
    }

    if (!state.signal || !state.bounds) {
      state.cellMask = null;
      state.cellContour = [];
      state.cellContourSource = "none";
      return;
    }

    const mask = detectCellMask(state.signal, width, height, state.bounds);
    state.cellMask = mask;
    state.cellContour = [];
    state.cellControlPoints = [];
    state.cellContourSource = mask ? "auto" : "none";
  }

  function addManualObject(point) {
    const object = createManualObject(point);
    state.manualObjects.push(object);
    state.correctionHistory.push({ type: "add", uid: object.uid });
    refreshManualCorrections(`已补点：${Math.round(point.x)}, ${Math.round(point.y)}`);
  }

  function removeNearestObject(point) {
    const nearest = findNearestObject(point);
    if (!nearest) {
      setStatus("附近没有可删除的对象");
      return;
    }

    if (nearest.object.source === "manual") {
      const index = state.manualObjects.findIndex((object) => object.uid === nearest.object.uid);
      if (index >= 0) {
        const [removed] = state.manualObjects.splice(index, 1);
        state.correctionHistory.push({ type: "remove-manual", object: removed, index });
      }
    } else {
      const suppression = {
        uid: `s${state.nextSuppressionUid}`,
        x: nearest.object.x,
        y: nearest.object.y,
        radius: Math.max(8, nearest.object.equivalentDiameter / 2 + 6),
      };
      state.nextSuppressionUid += 1;
      state.suppressedObjects.push(suppression);
      state.correctionHistory.push({ type: "suppress-auto", uid: suppression.uid });
    }

    refreshManualCorrections("已删除一个对象");
  }

  function undoCorrection() {
    const action = state.correctionHistory.pop();
    if (!action) return;

    if (action.type === "add") {
      state.manualObjects = state.manualObjects.filter((object) => object.uid !== action.uid);
    } else if (action.type === "remove-manual") {
      state.manualObjects.splice(action.index, 0, action.object);
    } else if (action.type === "suppress-auto") {
      state.suppressedObjects = state.suppressedObjects.filter((suppression) => suppression.uid !== action.uid);
    }

    refreshManualCorrections("已撤销上一步修正");
  }

  function clearCorrections(redraw = true) {
    state.manualObjects = [];
    state.suppressedObjects = [];
    state.correctionHistory = [];
    if (redraw) refreshManualCorrections("已清空手动修正");
  }

  function refreshManualCorrections(message) {
    state.objects = composeObjects();
    renderCanvas();
    updateResults();
    updateButtonState();
    saveHistoryDebounced();
    setStatus(message);
  }

  function createManualObject(point) {
    const diameter = state.settings.manualDiameter;
    const radius = diameter / 2;
    const x = clamp(point.x, 0, state.source.width - 1);
    const y = clamp(point.y, 0, state.source.height - 1);
    const signalIndex = Math.round(y) * state.source.width + Math.round(x);
    const meanSignal = state.signal ? state.signal[signalIndex] || 0 : 0;
    const object = {
      uid: `m${state.nextManualUid}`,
      source: "manual",
      x,
      y,
      area: Math.PI * radius * radius,
      equivalentDiameter: diameter,
      circularity: 1,
      meanSignal,
      minX: Math.max(0, Math.round(x - radius)),
      maxX: Math.min(state.source.width - 1, Math.round(x + radius)),
      minY: Math.max(0, Math.round(y - radius)),
      maxY: Math.min(state.source.height - 1, Math.round(y + radius)),
    };
    state.nextManualUid += 1;
    return object;
  }

  function findNearestObject(point) {
    let best = null;
    state.objects.forEach((object) => {
      const radius = Math.max(8, object.equivalentDiameter / 2 + 8);
      const distance = Math.hypot(object.x - point.x, object.y - point.y);
      if (distance <= radius && (!best || distance < best.distance)) {
        best = { object, distance };
      }
    });
    return best;
  }

  function startRoi(event) {
    if (!state.source || !state.roiMode) return;
    event.preventDefault();
    const point = canvasPoint(event);
    state.drawingRoi = true;
    state.roiStart = point;
    state.tempRoi = { x: point.x, y: point.y, width: 0, height: 0 };
    els.imageCanvas.setPointerCapture?.(event.pointerId);
  }

  function updateRoi(event) {
    if (!state.drawingRoi || !state.source) return;
    const point = canvasPoint(event);
    state.tempRoi = {
      x: state.roiStart.x,
      y: state.roiStart.y,
      width: point.x - state.roiStart.x,
      height: point.y - state.roiStart.y,
    };
    renderCanvas();
  }

  function finishRoi() {
    if (!state.drawingRoi) return;
    state.drawingRoi = false;
    const roi = normalizedRoi(state.tempRoi);
    state.tempRoi = null;
    if (roi && roi.width >= 8 && roi.height >= 8) {
      state.roi = roi;
      setStatus(`ROI：${Math.round(roi.width)}×${Math.round(roi.height)} px`);
      updateButtonState();
      scheduleAnalyze();
    } else {
      renderCanvas();
    }
  }

  function canvasPoint(event) {
    const rect = els.imageCanvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * state.source.width;
    const y = ((event.clientY - rect.top) / rect.height) * state.source.height;
    return {
      x: clamp(Math.round(x), 0, state.source.width - 1),
      y: clamp(Math.round(y), 0, state.source.height - 1),
    };
  }

  function normalizedRoi(roi) {
    if (!roi || !state.source) return null;
    const x = clamp(Math.min(roi.x, roi.x + roi.width), 0, state.source.width);
    const y = clamp(Math.min(roi.y, roi.y + roi.height), 0, state.source.height);
    const right = clamp(Math.max(roi.x, roi.x + roi.width), 0, state.source.width);
    const bottom = clamp(Math.max(roi.y, roi.y + roi.height), 0, state.source.height);
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  function drawHistogram(histogram, threshold) {
    const canvas = els.histogramCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    let max = 1;
    for (let i = 0; i < 256; i += 1) max = Math.max(max, histogram[i]);
    const logMax = Math.log1p(max);
    const barWidth = width / 256;

    ctx.fillStyle = "#9fb0ae";
    for (let i = 0; i < 256; i += 1) {
      const barHeight = (Math.log1p(histogram[i]) / logMax) * (height - 20);
      ctx.fillRect(i * barWidth, height - barHeight - 8, Math.max(1, barWidth), barHeight);
    }

    const x = (threshold / 255) * width;
    ctx.strokeStyle = "#d67b28";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, height - 8);
    ctx.stroke();

    els.thresholdBadge.textContent = `阈值 ${threshold}`;
  }

  function drawEmptyHistogram() {
    const empty = new Uint32Array(256);
    drawHistogram(empty, 0);
    els.thresholdBadge.textContent = "阈值 --";
  }

  function updateResults() {
    const objects = countedObjects();
    const settings = state.settings;
    const count = objects.length;
    const totalArea = objects.reduce((sum, object) => sum + object.area, 0);
    const meanDiameter = count ? objects.reduce((sum, object) => sum + object.equivalentDiameter, 0) / count : 0;
    const micron = settings.micronPerPixel;
    const boundsArea = state.bounds ? state.bounds.width * state.bounds.height : 0;
    const cellArea = countEffectiveCellPixels();
    const areaRatio = cellArea ? totalArea / cellArea : 0;

    els.countMetric.textContent = String(count);
    els.diameterMetric.textContent = count
      ? micron
        ? `${formatNumber(meanDiameter * micron)} µm`
        : `${formatNumber(meanDiameter)} px`
      : "--";
    els.areaMetric.textContent = count
      ? micron
        ? `${formatNumber(totalArea * micron * micron)} µm²`
        : `${formatNumber(totalArea)} px²`
      : "--";
    els.densityMetric.textContent =
      count && boundsArea
        ? micron
          ? `${formatNumber(count / ((boundsArea * micron * micron) / 1000))}/1000 µm²`
          : `${formatNumber(count / (boundsArea / 1_000_000))}/Mpx`
        : "--";
    els.cellAreaMetric.textContent = cellArea ? formatArea(cellArea) : "--";
    els.areaRatioMetric.textContent = cellArea ? `${formatNumber(areaRatio * 100)}%` : "--";

    els.objectBadge.textContent = `${count} 个`;
    els.manualBadge.textContent = `+${state.manualObjects.length} / -${state.suppressedObjects.length}`;
    els.maskBadge.textContent = `${formatNumber(countErasedCellPixels())} px`;
    els.cellBadge.textContent = cellArea
      ? cellSourceLabel()
      : "未识别";
    renderTable(objects, micron);
  }

  function cellSourceLabel() {
    if (state.cellContourSource === "manual") return "手动轮廓";
    if (state.cellContourSource === "sam") return "SAM";
    if (state.cellContourSource === "sam-preview") return "SAM 预览";
    return "自动轮廓";
  }

  function renderTable(objects, micron) {
    if (!objects.length) {
      els.objectTable.innerHTML = `<tr><td colspan="7" class="empty-cell">暂无结果</td></tr>`;
      return;
    }

    els.objectTable.innerHTML = objects
      .slice(0, 300)
      .map((object) => {
        const diameter = micron
          ? `${formatNumber(object.equivalentDiameter * micron)}`
          : `${formatNumber(object.equivalentDiameter)}`;
        return `
          <tr>
            <td>${object.id}</td>
            <td>${formatNumber(object.x)}</td>
            <td>${formatNumber(object.y)}</td>
            <td>${diameter}</td>
            <td>${object.circularity.toFixed(2)}</td>
            <td>${formatNumber(object.meanSignal)}</td>
            <td><span class="source-pill ${object.source === "manual" ? "manual" : ""}">${
              object.source === "manual" ? "手动" : "自动"
            }</span></td>
          </tr>
        `;
      })
      .join("");
  }

  function exportCsv() {
    if (!state.source) return;
    const micron = state.settings.micronPerPixel;
    const summary = buildSingleCellSummary();
    const summaryRows = [
      ["summary_key", "value", "unit"],
      ["image", state.source.name || "", ""],
      ["image_width", state.source.width, "px"],
      ["image_height", state.source.height, "px"],
      ["cell_contour_source", state.cellContourSource || "none", ""],
      ["raw_cell_area_px2", summary.rawCellAreaPx, "px2"],
      ["background_erased_area_px2", summary.erasedCellAreaPx, "px2"],
      ["cell_area_px2", summary.cellAreaPx, "px2"],
      ["droplet_count", summary.count, ""],
      ["droplet_total_area_px2", summary.totalAreaPx.toFixed(3), "px2"],
      ["droplet_mean_area_px2", summary.meanAreaPx.toFixed(3), "px2"],
      ["droplet_mean_diameter_px", summary.meanDiameterPx.toFixed(3), "px"],
      ["droplet_cell_area_ratio", summary.areaRatio.toFixed(6), ""],
      ["manual_added", state.manualObjects.length, ""],
      ["manual_removed", state.suppressedObjects.length, ""],
      ["threshold", state.threshold, ""],
      ["roi_x", state.bounds ? state.bounds.x0 : "", "px"],
      ["roi_y", state.bounds ? state.bounds.y0 : "", "px"],
      ["roi_width", state.bounds ? state.bounds.width : "", "px"],
      ["roi_height", state.bounds ? state.bounds.height : "", "px"],
      ["coordinate_origin", "top-left pixel of original image", ""],
      ["coordinate_scope", "auto detected and manual added droplets after current filters", ""],
    ];
    if (micron) {
      summaryRows.push(
        ["micron_per_pixel", micron, "um/px"],
        ["raw_cell_area_um2", (summary.rawCellAreaPx * micron * micron).toFixed(4), "um2"],
        ["background_erased_area_um2", (summary.erasedCellAreaPx * micron * micron).toFixed(4), "um2"],
        ["cell_area_um2", (summary.cellAreaPx * micron * micron).toFixed(4), "um2"],
        ["droplet_total_area_um2", (summary.totalAreaPx * micron * micron).toFixed(4), "um2"],
        ["droplet_mean_area_um2", (summary.meanAreaPx * micron * micron).toFixed(4), "um2"],
        ["droplet_mean_diameter_um", (summary.meanDiameterPx * micron).toFixed(4), "um"],
      );
    }

    const headers = [
      "image",
      "id",
      "object_uid",
      "source",
      "source_label",
      "center_x_px",
      "center_y_px",
      "area_px2",
      "diameter_px",
      "circularity",
      "mean_signal",
      "bbox_x",
      "bbox_y",
      "bbox_width",
      "bbox_height",
      "counted_in_cell",
    ];
    if (micron) headers.push("center_x_um", "center_y_um", "area_um2", "diameter_um");

    const rows = state.objects.map((object) => {
      const row = [
        state.source.name || "",
        object.id,
        object.uid || "",
        object.source === "manual" ? "manual" : "auto",
        object.source === "manual" ? "手动补点" : "自动识别",
        object.x.toFixed(2),
        object.y.toFixed(2),
        object.area.toFixed(3),
        object.equivalentDiameter.toFixed(3),
        object.circularity.toFixed(4),
        object.meanSignal.toFixed(3),
        object.minX,
        object.minY,
        object.maxX - object.minX + 1,
        object.maxY - object.minY + 1,
        isObjectCounted(object) ? 1 : 0,
      ];
      if (micron) {
        row.push(
          (object.x * micron).toFixed(4),
          (object.y * micron).toFixed(4),
          (object.area * micron * micron).toFixed(4),
          (object.equivalentDiameter * micron).toFixed(4),
        );
      }
      return row.map(csvCell).join(",");
    });

    const csv = [
      "single_cell_summary",
      ...summaryRows.map((row) => row.map(csvCell).join(",")),
      "",
      "droplet_coordinate_table",
      headers.map(csvCell).join(","),
      ...rows,
    ].join("\n");
    downloadBlob(`\ufeff${csv}`, filenameBase("lipid-droplets", "csv"), "text/csv;charset=utf-8");
    setStatus(`已导出 ${state.objects.length} 个脂滴坐标`);
  }

  function buildSingleCellSummary() {
    const objects = countedObjects();
    const count = objects.length;
    const totalAreaPx = objects.reduce((sum, object) => sum + object.area, 0);
    const meanAreaPx = count ? totalAreaPx / count : 0;
    const meanDiameterPx = count
      ? objects.reduce((sum, object) => sum + object.equivalentDiameter, 0) / count
      : 0;
    const rawCellAreaPx = countMaskPixels(state.cellMask);
    const erasedCellAreaPx = countErasedCellPixels();
    const cellAreaPx = countEffectiveCellPixels();
    const areaRatio = cellAreaPx ? totalAreaPx / cellAreaPx : 0;
    return { count, totalAreaPx, meanAreaPx, meanDiameterPx, rawCellAreaPx, erasedCellAreaPx, cellAreaPx, areaRatio };
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function exportMarkedPng() {
    if (!state.source) return;
    const canvas = document.createElement("canvas");
    canvas.width = state.source.width;
    canvas.height = state.source.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.putImageData(state.source.imageData, 0, 0);
    drawExportDropletMarkers(ctx);
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, filenameBase("lipid-droplets-marked", "png"), "image/png");
        setStatus(`已导出标记图，包含 ${state.objects.length} 个脂滴`);
      }
    });
  }

  function drawExportDropletMarkers(ctx) {
    if (!state.source) return;
    const { width, height } = state.source;
    const lineWidth = Math.max(2, Math.round(Math.min(width, height) / 720));
    const fontSize = Math.max(12, Math.round(width / 140));
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    state.objects.forEach((object) => {
      const radius = Math.max(4, object.equivalentDiameter / 2 + 2);
      const isManual = object.source === "manual";
      const color = isManual ? "#22c55e" : "#ffb000";
      ctx.globalAlpha = isObjectCounted(object) ? 1 : 0.45;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(object.x, object.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(object.x - Math.min(6, radius * 0.35), object.y);
      ctx.lineTo(object.x + Math.min(6, radius * 0.35), object.y);
      ctx.moveTo(object.x, object.y - Math.min(6, radius * 0.35));
      ctx.lineTo(object.x, object.y + Math.min(6, radius * 0.35));
      ctx.stroke();
      ctx.lineWidth = Math.max(3, lineWidth + 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(String(object.id), object.x + radius + 4, object.y);
      ctx.lineWidth = lineWidth;
      ctx.fillStyle = color;
      ctx.fillText(String(object.id), object.x + radius + 4, object.y);
    });

    const roi = normalizedRoi(state.roi);
    if (roi) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#f5b84b";
      ctx.setLineDash([14, 10]);
      ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
    }
    ctx.restore();
  }

  function downloadBlob(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function filenameBase(prefix, extension) {
    const stem = state.source?.name?.replace(/\.[^.]+$/, "") || prefix;
    return `${stem}-${prefix}.${extension}`;
  }

  function updateButtonState() {
    const hasImage = Boolean(state.source);
    const hasObjects = state.objects.length > 0;
    const hasCorrections = state.manualObjects.length > 0 || state.suppressedObjects.length > 0;
    const hasCell = Boolean(state.cellMask) || state.cellContour.length > 0;
    const hasEraseMask = Boolean(state.backgroundEraseMask && countMaskPixels(state.backgroundEraseMask));
    const hasHistory = state.historyRecords.length > 0;
    const hasSamPositivePoint = state.cellControlPoints.some((point) => point.label !== 0);
    els.analyzeButton.disabled = !hasImage || state.busy;
    els.autoButton.disabled = !hasImage || state.busy;
    els.roiButton.disabled = !hasImage;
    els.clearRoiButton.disabled = !hasImage || !state.roi;
    els.fitButton.disabled = !hasImage;
    els.resetButton.disabled = !hasImage;
    els.exportCsvButton.disabled = !hasImage;
    els.exportPngButton.disabled = !hasImage;
    els.manualDiameterInput.disabled = !hasImage;
    els.undoManualButton.disabled = !hasImage || state.correctionHistory.length === 0;
    els.clearManualButton.disabled = !hasImage || !hasCorrections;
    els.autoCellButton.disabled = !hasImage || state.busy;
    els.samPointButton.disabled = !hasImage || state.busy;
    els.boxCellButton.disabled = !hasImage || state.busy;
    els.refineCellButton.disabled = !hasImage || (!hasSamPositivePoint && !state.samBox) || state.samBusy;
    els.undoCellPointButton.disabled = !hasImage || !state.cellControlPoints.length || state.samBusy;
    els.drawCellButton.disabled = !hasImage || state.busy;
    els.finishCellButton.disabled = !hasImage || state.cellContour.length < 3;
    els.clearCellButton.disabled = !hasImage || !hasCell;
    els.maskEditButton.disabled = !hasImage;
    els.clearMaskButton.disabled = !hasImage || !hasEraseMask;
    els.eraseBrushInput.disabled = !hasImage;
    els.saveHistoryButton.disabled = !hasImage || !state.historyDb;
    els.clearHistoryButton.disabled = !hasHistory || !state.historyDb;
    els.manualBadge.textContent = `+${state.manualObjects.length} / -${state.suppressedObjects.length}`;
    els.maskBadge.textContent = `${formatNumber(countErasedCellPixels())} px`;
    els.historyBadge.textContent = `${state.historyRecords.length} / ${HISTORY_LIMIT}`;
    els.cellBadge.textContent = state.cellMask
      ? cellSourceLabel()
      : state.cellContour.length
        ? `${state.cellContour.length} 点`
        : "未识别";
    document.querySelectorAll("[data-correction-mode]").forEach((button) => {
      button.disabled = !hasImage && button.dataset.correctionMode !== "none";
    });
  }

  function syncControlsFromState(runReadout = true) {
    const settings = state.settings;
    document.querySelectorAll("[data-setting='mode']").forEach((button) => {
      button.classList.toggle("active", button.dataset.value === settings.mode);
    });
    els.channelSelect.value = settings.channel;
    els.autoThresholdInput.checked = settings.autoThreshold;
    els.thresholdInput.disabled = settings.autoThreshold;
    els.thresholdInput.value = String(settings.threshold);
    els.sensitivityInput.value = String(settings.sensitivity);
    els.backgroundInput.value = String(settings.backgroundRadius);
    els.minDiameterInput.value = String(settings.minDiameter);
    els.maxDiameterInput.value = String(settings.maxDiameter);
    els.circularityInput.value = String(settings.minCircularity);
    els.edgeInput.value = String(settings.edgeMargin);
    els.overlayInput.value = String(Math.round(settings.overlayOpacity * 100));
    els.zoomInput.value = String(settings.zoom);
    els.labelsInput.checked = settings.showLabels;
    els.manualDiameterInput.value = String(settings.manualDiameter);
    els.eraseBrushInput.value = String(state.eraseBrushSize);
    els.micronInput.value = settings.micronPerPixel ? String(settings.micronPerPixel) : "";
    if (runReadout) syncReadouts();
  }

  function syncReadouts() {
    els.thresholdValue.textContent = String(Math.round(state.settings.threshold));
    els.sensitivityValue.textContent = Number(state.settings.sensitivity).toFixed(2);
    els.backgroundValue.textContent = `${Math.round(state.settings.backgroundRadius)} px`;
    els.circularityValue.textContent = Number(state.settings.minCircularity).toFixed(2);
    els.edgeValue.textContent = `${Math.round(state.settings.edgeMargin)} px`;
    els.overlayValue.textContent = `${Math.round(state.settings.overlayOpacity * 100)}%`;
    els.zoomValue.textContent = `${Math.round(state.settings.zoom)}%`;
    els.manualDiameterValue.textContent = `${Math.round(state.settings.manualDiameter)} px`;
    els.eraseBrushValue.textContent = `${Math.round(state.eraseBrushSize)} px`;
  }

  function initHistory() {
    renderHistory();
    if (!("indexedDB" in window)) {
      setStatus("浏览器不支持本地历史记录");
      return;
    }

    const request = indexedDB.open(HISTORY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      state.historyDb = request.result;
      loadHistoryList();
    };
    request.onerror = () => {
      setStatus("历史记录初始化失败，仍可正常分析当前图像");
      renderHistory();
      updateButtonState();
    };
  }

  function historyStore(mode = "readonly") {
    if (!state.historyDb) return null;
    return state.historyDb.transaction(HISTORY_STORE, mode).objectStore(HISTORY_STORE);
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function loadHistoryList() {
    const store = historyStore();
    if (!store) {
      renderHistory();
      updateButtonState();
      return;
    }
    try {
      const records = await requestPromise(store.getAll());
      state.historyRecords = records
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, HISTORY_LIMIT)
        .map((record) => ({
          id: record.id,
          name: record.name,
          updatedAt: record.updatedAt,
          width: record.width,
          height: record.height,
          summary: record.summary || null,
        }));
      renderHistory();
      updateButtonState();
    } catch (error) {
      console.error(error);
      renderHistory();
      updateButtonState();
    }
  }

  function renderHistory() {
    if (!els.historyList) return;
    els.historyBadge.textContent = `${state.historyRecords.length} / ${HISTORY_LIMIT}`;
    if (!state.historyRecords.length) {
      els.historyList.innerHTML = `<div class="history-empty">暂无记录</div>`;
      return;
    }
    els.historyList.innerHTML = state.historyRecords
      .map((record) => {
        const summary = record.summary || {};
        const count = summary.count ?? 0;
        const ratio = summary.areaRatio ? `${formatNumber(summary.areaRatio * 100)}%` : "--";
        const date = new Date(record.updatedAt).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `
          <button class="history-item" type="button" data-history-id="${escapeHtml(record.id)}">
            <strong>${escapeHtml(record.name || "未命名图像")}</strong>
            <span>${date} · ${record.width}×${record.height} · ${count} 个 · ${ratio}</span>
          </button>
        `;
      })
      .join("");
    els.historyList.querySelectorAll("[data-history-id]").forEach((button) => {
      button.addEventListener("click", () => loadHistory(button.dataset.historyId));
    });
  }

  function saveHistoryDebounced() {
    if (state.suppressHistorySave || !state.source || !state.historyDb) return;
    window.clearTimeout(state.historySaveTimer);
    state.historySaveTimer = window.setTimeout(() => {
      saveHistoryNow();
    }, 900);
  }

  async function saveHistoryNow(message = "") {
    if (state.suppressHistorySave || !state.source || !state.historyDb) return;
    try {
      const record = await buildHistoryRecord();
      await requestPromise(historyStore("readwrite").put(record));
      state.currentHistoryId = record.id;
      await pruneHistory();
      await loadHistoryList();
      if (message) setStatus(message);
    } catch (error) {
      console.error(error);
      setStatus("历史记录保存失败，当前分析不受影响");
    }
  }

  async function buildHistoryRecord() {
    const summary = buildSingleCellSummary();
    return {
      id: state.currentHistoryId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: state.source.name || "未命名图像",
      updatedAt: Date.now(),
      width: state.source.width,
      height: state.source.height,
      imageBlob: await sourceImageBlob(),
      settings: { ...state.settings },
      roi: state.roi ? { ...state.roi } : null,
      cellContour: state.cellContour.map((point) => ({ ...point })),
      cellControlPoints: state.cellControlPoints.map((point) => ({ ...point })),
      cellContourSource: state.cellContourSource,
      samBox: state.samBox ? { ...state.samBox } : null,
      backgroundEraseMask: state.backgroundEraseMask ? state.backgroundEraseMask.slice() : null,
      eraseBrushSize: state.eraseBrushSize,
      manualObjects: state.manualObjects.map((object) => ({ ...object })),
      suppressedObjects: state.suppressedObjects.map((object) => ({ ...object })),
      correctionHistory: state.correctionHistory.map((item) => ({ ...item })),
      nextManualUid: state.nextManualUid,
      nextSuppressionUid: state.nextSuppressionUid,
      summary,
    };
  }

  async function pruneHistory() {
    const store = historyStore("readwrite");
    if (!store) return;
    const records = await requestPromise(store.getAll());
    const extras = records.sort((a, b) => b.updatedAt - a.updatedAt).slice(HISTORY_LIMIT);
    await Promise.all(extras.map((record) => requestPromise(historyStore("readwrite").delete(record.id))));
  }

  async function loadHistory(id) {
    const store = historyStore();
    if (!store) return;
    try {
      state.suppressHistorySave = true;
      setBusy(true, "正在打开历史记录...");
      const record = await requestPromise(store.get(id));
      if (!record) {
        setBusy(false, "未找到这条历史记录");
        return;
      }

      const decoded = await decodeBlobImage(record.imageBlob);
      state.source = {
        name: record.name || "历史记录",
        size: record.imageBlob?.size || 0,
        width: decoded.width,
        height: decoded.height,
        imageData: decoded.imageData,
      };
      state.settings = { ...defaults, ...(record.settings || {}) };
      state.roi = record.roi || null;
      state.tempRoi = null;
      state.signal = null;
      state.mask = null;
      state.histogram = null;
      state.autoObjects = [];
      state.manualObjects = (record.manualObjects || []).map((object) => ({ ...object }));
      state.suppressedObjects = (record.suppressedObjects || []).map((object) => ({ ...object }));
      state.objects = [];
      state.cellMask = null;
      state.cellContour = (record.cellContour || []).map((point) => ({ ...point }));
      state.cellControlPoints = (record.cellControlPoints || []).map((point) => ({ ...point }));
      state.cellContourSource = record.cellContourSource || "none";
      state.backgroundEraseMask = record.backgroundEraseMask ? new Uint8Array(record.backgroundEraseMask) : null;
      state.eraseBrushSize = record.eraseBrushSize || state.eraseBrushSize;
      state.cellDrawMode = false;
      state.samPointMode = false;
      state.samBoxMode = false;
      state.samBox = record.samBox || null;
      state.tempSamBox = null;
      state.samHoverPoint = null;
      state.maskEditMode = false;
      state.samBusy = false;
      state.roiMode = false;
      state.drawingRoi = false;
      state.correctionMode = "none";
      state.correctionHistory = (record.correctionHistory || []).map((item) => ({ ...item }));
      state.nextManualUid = record.nextManualUid || state.manualObjects.length + 1;
      state.nextSuppressionUid = record.nextSuppressionUid || state.suppressedObjects.length + 1;
      state.currentHistoryId = record.id;

      els.imageCanvas.width = decoded.width;
      els.imageCanvas.height = decoded.height;
      els.imageCanvas.classList.add("ready");
      els.imageCanvas.classList.remove("roi-mode", "cell-draw-mode", "sam-point-mode", "sam-box-mode", "mask-edit-mode", "correction-add", "correction-remove");
      els.emptyState.style.display = "none";
      els.fileMeta.textContent = `${state.source.name} · ${decoded.width}×${decoded.height}`;
      syncControlsFromState();
      scaleCanvas({ center: true });
      setCorrectionMode("none", false);
      setBusy(false, "历史记录已载入，正在复算...");
      await analyzeImage();
      setStatus("已打开历史记录");
    } catch (error) {
      console.error(error);
      setBusy(false, "历史记录打开失败");
    } finally {
      state.suppressHistorySave = false;
    }
  }

  async function clearHistory() {
    const store = historyStore("readwrite");
    if (!store) return;
    try {
      await requestPromise(store.clear());
      state.historyRecords = [];
      state.currentHistoryId = null;
      renderHistory();
      updateButtonState();
      setStatus("已清空历史记录");
    } catch (error) {
      console.error(error);
      setStatus("清空历史记录失败");
    }
  }

  function sourceImageBlob() {
    const canvas = document.createElement("canvas");
    canvas.width = state.source.width;
    canvas.height = state.source.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(state.source.imageData, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("无法保存图像快照"));
      }, "image/png");
    });
  }

  async function decodeBlobImage(blob) {
    const bitmap = await createBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      imageData: ctx.getImageData(0, 0, bitmap.width, bitmap.height),
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setBusy(isBusy, message = "") {
    state.busy = isBusy;
    if (message) setStatus(message);
    updateButtonState();
  }

  function setStatus(message) {
    els.statusLine.textContent = message;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "--";
    if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("zh-CN");
    if (Math.abs(value) >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function formatArea(pxArea) {
    const micron = state.settings.micronPerPixel;
    if (micron) return `${formatNumber(pxArea * micron * micron)} µm²`;
    return `${formatNumber(pxArea)} px²`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function decodeTiff(buffer) {
    const view = new DataView(buffer);
    const byteOrder = view.getUint16(0, false);
    const littleEndian = byteOrder === 0x4949;
    if (!littleEndian && byteOrder !== 0x4d4d) {
      throw new Error("不是有效的 TIFF 文件");
    }

    const read16 = (offset) => view.getUint16(offset, littleEndian);
    const read32 = (offset) => view.getUint32(offset, littleEndian);
    const magic = read16(2);
    if (magic !== 42) {
      throw new Error("暂不支持 BigTIFF");
    }

    const ifdOffset = read32(4);
    const tags = readIfd(view, ifdOffset, littleEndian);
    const width = scalar(tags[256]);
    const height = scalar(tags[257]);
    const compression = scalar(tags[259]) || 1;
    const photometric = scalar(tags[262]) ?? 1;
    const samplesPerPixel = scalar(tags[277]) || (Array.isArray(tags[258]) ? tags[258].length : 1);
    const planarConfiguration = scalar(tags[284]) || 1;
    const bits = arrayValue(tags[258] || [8]);
    const stripOffsets = arrayValue(tags[273]);
    const stripByteCounts = arrayValue(tags[279]);

    if (!width || !height || !stripOffsets.length) {
      throw new Error("TIFF 缺少必要的像素信息");
    }
    if (compression !== 1) {
      throw new Error(`这个 TIFF 使用了压缩格式（compression=${compression}），请导出 PNG 或未压缩 TIFF`);
    }
    if (planarConfiguration !== 1) {
      throw new Error("暂不支持分平面 TIFF");
    }

    const bitsPerSample = bits[0] || 8;
    if (!bits.every((item) => item === bitsPerSample) || ![8, 16].includes(bitsPerSample)) {
      throw new Error(`暂不支持 ${bits.join("/")}-bit TIFF`);
    }

    const bytesPerSample = bitsPerSample / 8;
    const bytesPerPixel = samplesPerPixel * bytesPerSample;
    const expectedBytes = width * height * bytesPerPixel;
    const raw = new Uint8Array(expectedBytes);
    let cursor = 0;

    stripOffsets.forEach((offset, index) => {
      const byteCount = stripByteCounts[index] || expectedBytes - cursor;
      const length = Math.min(byteCount, expectedBytes - cursor);
      raw.set(new Uint8Array(buffer, offset, length), cursor);
      cursor += length;
    });

    const rgba = new Uint8ClampedArray(width * height * 4);
    let source = 0;
    for (let pixel = 0, dest = 0; pixel < width * height; pixel += 1, dest += 4) {
      let r;
      let g;
      let b;
      if (photometric === 2 && samplesPerPixel >= 3) {
        r = readSample(raw, source, bitsPerSample, littleEndian);
        g = readSample(raw, source + bytesPerSample, bitsPerSample, littleEndian);
        b = readSample(raw, source + bytesPerSample * 2, bitsPerSample, littleEndian);
      } else {
        let value = readSample(raw, source, bitsPerSample, littleEndian);
        if (photometric === 0) value = 255 - value;
        r = value;
        g = value;
        b = value;
      }
      rgba[dest] = r;
      rgba[dest + 1] = g;
      rgba[dest + 2] = b;
      rgba[dest + 3] = 255;
      source += bytesPerPixel;
    }

    return {
      width,
      height,
      imageData: new ImageData(rgba, width, height),
    };
  }

  function readSample(raw, offset, bitsPerSample, littleEndian) {
    if (bitsPerSample === 8) return raw[offset];
    const value = littleEndian ? raw[offset] | (raw[offset + 1] << 8) : (raw[offset] << 8) | raw[offset + 1];
    return Math.round((value / 65535) * 255);
  }

  function readIfd(view, offset, littleEndian) {
    const typeSize = {
      1: 1,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      6: 1,
      7: 1,
      8: 2,
      9: 4,
      10: 8,
      11: 4,
      12: 8,
    };
    const read16 = (at) => view.getUint16(at, littleEndian);
    const read32 = (at) => view.getUint32(at, littleEndian);
    const count = read16(offset);
    const tags = {};

    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      const tag = read16(entry);
      const type = read16(entry + 2);
      const valueCount = read32(entry + 4);
      const bytes = (typeSize[type] || 1) * valueCount;
      const valueOffset = bytes <= 4 ? entry + 8 : read32(entry + 8);
      tags[tag] = readTagValues(view, valueOffset, type, valueCount, littleEndian);
    }

    return tags;
  }

  function readTagValues(view, offset, type, count, littleEndian) {
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const at = offset + tagTypeSize(type) * i;
      if (type === 1 || type === 7) values.push(view.getUint8(at));
      else if (type === 2) values.push(String.fromCharCode(view.getUint8(at)));
      else if (type === 3) values.push(view.getUint16(at, littleEndian));
      else if (type === 4) values.push(view.getUint32(at, littleEndian));
      else if (type === 5) values.push(view.getUint32(at, littleEndian) / view.getUint32(at + 4, littleEndian));
      else if (type === 6) values.push(view.getInt8(at));
      else if (type === 8) values.push(view.getInt16(at, littleEndian));
      else if (type === 9) values.push(view.getInt32(at, littleEndian));
      else if (type === 10) values.push(view.getInt32(at, littleEndian) / view.getInt32(at + 4, littleEndian));
      else if (type === 11) values.push(view.getFloat32(at, littleEndian));
      else if (type === 12) values.push(view.getFloat64(at, littleEndian));
    }

    if (type === 2) return values.join("").replace(/\0+$/, "");
    return count === 1 ? values[0] : values;
  }

  function tagTypeSize(type) {
    if ([1, 2, 6, 7].includes(type)) return 1;
    if ([3, 8].includes(type)) return 2;
    if ([4, 9, 11].includes(type)) return 4;
    if ([5, 10, 12].includes(type)) return 8;
    return 1;
  }

  function scalar(value) {
    return Array.isArray(value) ? value[0] : value;
  }

  function arrayValue(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  if (typeof window !== "undefined") {
    window.LipidDropletCounter = {
      decodeTiff,
      buildIntensity,
      boxBlur,
      buildSignal,
      autoThreshold,
      findObjects,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
