const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    title: "Lipid Droplet Counter",
    backgroundColor: "#eef1f3",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.loadFile(path.join(__dirname, "index.html"));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("cell-sam-segment", async (_event, payload) => runSamSegment(payload));
ipcMain.handle("droplet-stardist-segment", async (_event, payload) => runDropletSegment(payload));

function appResourceRoot() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function bundledPythonExecutable(baseName) {
  const extension = process.platform === "win32" ? ".exe" : "";
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "python", baseName, `${baseName}${extension}`)]
    : [
        path.join(__dirname, "python", baseName, `${baseName}${extension}`),
        path.join(__dirname, "runtime", "windows", "python", baseName, `${baseName}${extension}`),
      ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function pythonProcessEnv() {
  return {
    ...process.env,
    LDC_RESOURCE_ROOT: appResourceRoot(),
  };
}

function buildPythonInvocations(baseName, envVarName) {
  const envPython = process.env[envVarName];
  if (envPython) {
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, `${baseName}.py`)
      : path.join(__dirname, `${baseName}.py`);
    return [{ command: envPython, args: envPython === "py" ? ["-3", scriptPath] : [scriptPath] }];
  }

  const bundledExecutable = bundledPythonExecutable(baseName);
  if (bundledExecutable) {
    return [{ command: bundledExecutable, args: [] }];
  }

  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, `${baseName}.py`)
    : path.join(__dirname, `${baseName}.py`);
  const commands = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

  return commands.map((command) => ({
    command,
    args: command === "py" ? ["-3", scriptPath] : [scriptPath],
  }));
}

function runDropletSegment(payload) {
  const invocations = buildPythonInvocations("droplet_segmenter", "STARDIST_PYTHON");
  return tryPython(invocations, payload, 180000);
}

function runSamSegment(payload) {
  const invocations = buildPythonInvocations("cell_segmenter", "SAM_PYTHON");
  return tryPython(invocations, payload);
}

// async function tryPython(candidates, scriptPath, payload) {
//   let lastError = "未找到 Python";
//   for (const command of candidates) {
//     try {
//       const args = command === "py" ? ["-3", scriptPath] : [scriptPath];
//       return await runPythonProcess(command, args, payload);
//     } catch (error) {
//       lastError = error.message || String(error);
//     }
//   }
//   return { ok: false, error: lastError };
// }

// function runPythonProcess(command, args, payload, timeoutMs = 20000) {
//   return new Promise((resolve) => {
//     const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
//     const timer = setTimeout(() => {
//       child.kill();
//       resolve({ ok: false, error: "Python 分割运行超时" });
//     }, timeoutMs);
//     let stdout = "";
//     let stderr = "";
//     let stdinError = "";
//     let settled = false;
//     const finish = (result) => {
//       if (settled) return;
//       settled = true;
//       clearTimeout(timer);
//       resolve(result);
//     };
//     const timer = setTimeout(() => {
//       child.kill();
//       finish({ ok: false, error: "SAM 分割运行超时" });
//     }, 20000);

//     child.stdout.on("data", (chunk) => {
//       stdout += chunk.toString();
//     });
//     child.stderr.on("data", (chunk) => {
//       stderr += chunk.toString();
//     });
//     child.stdin.on("error", (error) => {
//       stdinError = error.code === "EPIPE" ? "Python 进程提前退出，图像数据未能写入" : error.message;
//     });
//     child.on("error", (error) => {
//       finish({ ok: false, error: error.message });
//     });
//     child.on("close", (code) => {
//       if (code !== 0) {
//         finish({ ok: false, error: stderr.trim() || stdinError || `Python 退出码 ${code}` });
//         return;
//       }
//       try {
//         finish(JSON.parse(stdout));
//       } catch (error) {
//         finish({ ok: false, error: stdinError || "无法解析 SAM 输出" });
//       }
//     });

//     try {
//       child.stdin.end(JSON.stringify(payload));
//     } catch (error) {
//       stdinError = error.code === "EPIPE" ? "Python 进程提前退出，图像数据未能写入" : error.message;
//     }
//   });
// }
async function tryPython(invocations, payload, timeoutMs = 20000) {
  let lastError = "未找到 Python";
  for (const { command, args } of invocations) {
    try {
      return await runPythonProcess(command, args, payload, timeoutMs);
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  return { ok: false, error: lastError };
}

function pythonLogPath() {
  return path.join(app.getPath("userData"), "python-bridge.log");
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const { imagePng, ...rest } = payload;
  const summary = { ...rest };
  if (typeof imagePng === "string") {
    summary.imagePngBytes = imagePng.length;
  }
  return summary;
}

function writePythonBridgeLog(entry) {
  const logPath = pythonLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ time: new Date().toISOString(), ...entry }, null, 2)}\n`,
      "utf8"
    );
  } catch (_error) {
    // Swallow log write failures so they don't hide the original problem.
  }
  return logPath;
}

function parsePythonJson(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    throw new Error("empty stdout");
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!(line.startsWith("{") || line.startsWith("["))) continue;
      try {
        return JSON.parse(line);
      } catch (_lineError) {
        // Keep scanning upward for a clean JSON line.
      }
    }
  }

  throw new Error("invalid json");
}

function runPythonProcess(command, args, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: appResourceRoot(),
      env: pythonProcessEnv(),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "Python 分割运行超时" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.on("error", (error) => {
      stdinError = error.code === "EPIPE"
        ? "Python 进程提前退出，图像数据未能写入"
        : error.message;
    });

    child.on("error", (error) => {
      const logPath = writePythonBridgeLog({
        kind: "spawn-error",
        command,
        args,
        error: error.message,
        payload: summarizePayload(payload),
      });
      finish({ ok: false, error: `${error.message}（日志：${logPath}）` });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const logPath = writePythonBridgeLog({
          kind: "non-zero-exit",
          command,
          args,
          code,
          stdout,
          stderr,
          stdinError,
          payload: summarizePayload(payload),
        });
        finish({
          ok: false,
          error: `${stderr.trim() || stdinError || `Python 退出码 ${code}`}（日志：${logPath}）`,
        });
        return;
      }

      try {
        finish(parsePythonJson(stdout));
      } catch (error) {
        const logPath = writePythonBridgeLog({
          kind: "json-parse-failed",
          command,
          args,
          code,
          stdout,
          stderr,
          stdinError,
          parseError: error.message,
          payload: summarizePayload(payload),
        });
        finish({
          ok: false,
          error: `${stdinError || "无法解析 Python 输出"}（日志：${logPath}）`,
        });
      }
    });

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (error) {
      stdinError = error.code === "EPIPE"
        ? "Python 进程提前退出，图像数据未能写入"
        : error.message;
    }
  });
}
