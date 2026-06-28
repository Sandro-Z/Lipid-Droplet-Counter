// const { contextBridge, ipcRenderer } = require("electron");

// contextBridge.exposeInMainWorld("lipidCellSegmentation", {
//   samPredict(payload) {
//     return ipcRenderer.invoke("cell-sam-segment", payload);
//   },
// });
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lipidCellSegmentation", {
  samPredict(payload) {
    return ipcRenderer.invoke("cell-sam-segment", payload);
  },
});

contextBridge.exposeInMainWorld("lipidDropletSegmentation", {
  stardistPredict(payload) {
    return ipcRenderer.invoke("droplet-stardist-segment", payload);
  },
});