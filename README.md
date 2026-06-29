# Lipid-Droplet-Counter
脂滴数量识别工具。

## 现存问题&TODO
SAM识别无法正确调用CUDA.

## 系统要求
- conda

- npm

本项目开发所使用的硬件为：RTX5080,48G RAM,因此部分依赖按照此环境安装，用户应当根据自己环境调整CUDA,PyTorch等的版本。

## 运行
首先将仓库克隆到本地;

如果机器带有可用的 NVIDIA GPU，创建推荐的桌面运行环境：

```
conda env create -f environment-runtime.yml
conda activate lipid-droplet-runtime
```

这个环境现在已经直接包含了细胞轮廓识别所需的 SAM 依赖，并且会优先让 Electron 调用当前 conda 环境里的 Python，不再需要额外运行 `install_sam_dependencies.sh` / `install_sam_dependencies.ps1`。

不需要额外设置 `SAM_PYTHON` 或 `STARDIST_PYTHON`；默认保持未设置即可，应用会自动使用当前 `CONDA_PREFIX` 下的 Python。

`environment-runtime.yml` 的设计目标是：
- SAM 细胞分割使用 NVIDIA GPU
- StarDist 脂滴识别默认走 CPU
- 避开 TensorFlow GPU 与 PyTorch GPU 混装时常见的 CUDA/cuDNN 冲突
- 在同一个环境中直接提供 `node` / `npm`，避免前后端运行时分裂

如果机器没有可用 GPU，或者你希望在纯 CPU 机器上部署，请创建单独的 CPU 运行环境：

```bash
conda env create -f environment-runtime-cpu.yml
conda activate lipid-droplet-runtime-cpu
```

`environment-runtime-cpu.yml` 会默认关闭 SAM 的 GPU 推理，并安装 CPU 版 PyTorch 和 TensorFlow 运行时，不依赖 CUDA / cuDNN。

如果你只想强制让 SAM 使用 CPU，可以在启动前设置：

```bash
export SAM_USE_GPU=0
npm start
```

Windows PowerShell：

```powershell
$env:SAM_USE_GPU="0"
npm start
```

如果你确实还需要 TensorFlow GPU 版 StarDist，可选地创建：

```bash
conda env create -f deprecated/environment-runtime-gpu.yml
conda activate lipid-droplet-runtime-gpu
```

但这个环境同时包含 TensorFlow GPU 和 PyTorch GPU，CUDA 兼容性要求更严格；如果你的重点是让 SAM 稳定使用 GPU，优先使用 `environment-runtime.yml`。

最后启动桌面应用：
```
npm install
npm start
```

请在已经 `conda activate lipid-droplet-runtime` 或 `conda activate lipid-droplet-runtime-cpu` 的同一个终端里运行 `npm start`。如果直接用浏览器打开 `index.html`，或者在别的终端里启动 Electron，前端会拿不到 SAM 的 Electron 桥接。

如果你之前已经创建过旧版运行时环境，建议重建一次；如果只想就地修正环境变量，可执行：

```bash
conda env config vars unset SAM_PYTHON STARDIST_PYTHON -n lipid-droplet-runtime
conda deactivate
conda activate lipid-droplet-runtime
```

首次运行前，请确认 `models/sam_vit_b_01ec64.pth` 已经存在于项目根目录下的 `models/` 中；如果不在该位置，也可以通过环境变量 `SAM_CHECKPOINT` 指向它。

验证 SAM 是否真的在使用 GPU：

```bash
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
```

如果 SAM 在 GPU 上报 `CUDA error: no kernel image is available for execution on the device`，可继续检查当前显卡算力版本与 PyTorch wheel 内置的 CUDA 架构：

```bash
python -c "import torch; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'); print('capability:', torch.cuda.get_device_capability(0) if torch.cuda.is_available() else 'n/a'); print('torch cuda:', torch.version.cuda); print('arch flags:', torch._C._cuda_getArchFlags() if hasattr(torch._C, '_cuda_getArchFlags') else 'n/a')"
```

如果这里显示的 `capability` 无法被 `arch flags` 覆盖，说明当前 PyTorch CUDA 二进制不支持这张显卡；应用现在会自动回退到 CPU，但若要强制使用 GPU，通常只能改用更适合该显卡的 PyTorch 版本，或自行从源码编译。

`environment-runtime.yml`、`environment-runtime-cpu.yml` 和 `deprecated/environment-runtime-gpu.yml` 只包含桌面应用运行所需的 Python 推理依赖；训练、评估或数据准备模型时仍可使用 `environment-train.yml` / `stardist/requirements.txt`。

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
