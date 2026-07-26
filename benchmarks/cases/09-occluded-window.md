# 09 · Windows 正常窗口完整遮挡

## 测试驱动准备

1. 打开 `http://127.0.0.1:4173/occluded`，使它成为被测工具的当前 benchmark
   标签。
2. 确认专用 Chrome/Edge 窗口不是最小化状态。
3. 用另一个正常或 topmost 窗口完整覆盖浏览器。覆盖必须保持到首次点击成功或超时，
   测试者不得手动把浏览器抬到前台。
4. 从 agent 的第一个浏览器调用开始计时。

为了可重复地覆盖主屏幕，可以从仓库根目录在另一个 Windows PowerShell 进程运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\benchmarks\windows-occluder.ps1 -Seconds 60
```

测试窗口会在 60 秒后自动关闭，也可按 Escape 提前关闭。如果它在首次点击结束前
自动关闭，本轮无效，必须重跑。遮挡属于夹具准备，不计作被测工具调用。

## 给被测 agent 的任务

找到标题为 `Occluded window recovery` 的现有标签。在点击前读取
`document.visibilityState`，点击 `Run occlusion test`，等待结果并返回 recovery
token。不得要求测试者抬起浏览器，不得调用外部窗口管理 API，不得通过坐标猜测。

输出一行：

```json
{
  "case": "occluded-window",
  "clicked": true,
  "token": "...",
  "visibilityBeforeClick": "visible|hidden"
}
```

记录第一次点击是否成功、首次超时时间、诊断调用数和总耗时。这个用例与 Case 08
不同：浏览器始终不是最小化状态，测试的是 Windows native occlusion，而不是恢复
窗口状态。
