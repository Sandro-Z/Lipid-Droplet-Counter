const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lipidCellSegmentation", {
  samPredict(payload) {
    return ipcRenderer.invoke("cell-sam-segment", payload);
  },
});
