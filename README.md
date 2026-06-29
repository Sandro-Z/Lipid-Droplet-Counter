# Lipid-Droplet-Counter
脂滴数量识别工具。

## 系统要求
- conda

- npm

## 运行
首先将仓库克隆到本地;

然后选择一个 Python 运行环境：

CPU 运行环境：
```
conda env create -f environment-runtime.yml
conda activate lipid-droplet-runtime
```

GPU 运行环境：
```
conda env create -f environment-runtime-gpu.yml
conda activate lipid-droplet-runtime-gpu
```

GPU 运行环境需要 NVIDIA GPU 和可用的 NVIDIA 驱动。该环境会设置 `STARDIST_USE_GPU=1`，允许 StarDist 脂滴识别使用 TensorFlow GPU；SAM 会在 PyTorch 检测到 CUDA 时自动使用 GPU。

最后启动桌面应用：
```
npm install
npm start
```

`environment-runtime.yml` 和 `environment-runtime-gpu.yml` 只包含桌面应用运行所需的 Python 推理依赖；训练、评估或数据准备模型时仍可使用 `environment.yml` / `stardist/requirements.txt`。

## Windows 打包

项目现在支持把 Electron 前端和两个 Python 推理模块一起打成 Windows 可执行程序。

### 前置要求

- Windows 10/11 x64
- Node.js 与 `npm`
- Python 3.x，并且 `py -3` 可用

### 一键构建

在项目根目录执行：

```powershell
npm run build:win
```

这个命令会依次完成：

- 创建 `.venv-win-build`
- 安装 PyInstaller 和 Python 推理依赖
- 生成 `cell_segmenter.exe` 与 `droplet_segmenter.exe`
- 如缺失则下载 `models/sam_vit_b_01ec64.pth`
- 调用 `electron-builder` 产出 Windows 便携版程序

最终产物默认输出到 `release/` 目录。

### 分步构建

如果你想先只构建 Python 运行时：

```powershell
npm run build:python:win
```

如果 Python 运行时已经生成完成，只重新打 Electron 外壳：

```powershell
npm run build:electron:win
```
