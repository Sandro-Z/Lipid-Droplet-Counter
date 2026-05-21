const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
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

function runSamSegment(payload) {
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, "cell_segmenter.py")
    : path.join(__dirname, "cell_segmenter.py");
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

  return tryPython(candidates, scriptPath, payload);
}

async function tryPython(candidates, scriptPath, payload) {
  let lastError = "未找到 Python";
  for (const command of candidates) {
    try {
      const args = command === "py" ? ["-3", scriptPath] : [scriptPath];
      return await runPythonProcess(command, args, payload);
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  return { ok: false, error: lastError };
}

function runPythonProcess(command, args, payload) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "SAM 分割运行超时" });
    }, 20000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", (error) => {
      stdinError = error.code === "EPIPE" ? "Python 进程提前退出，图像数据未能写入" : error.message;
    });
    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim() || stdinError || `Python 退出码 ${code}` });
        return;
      }
      try {
        finish(JSON.parse(stdout));
      } catch (error) {
        finish({ ok: false, error: stdinError || "无法解析 SAM 输出" });
      }
    });

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (error) {
      stdinError = error.code === "EPIPE" ? "Python 进程提前退出，图像数据未能写入" : error.message;
    }
  });
}
