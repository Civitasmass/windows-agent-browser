# 08 · Windows 最小化窗口恢复

## 测试驱动准备

1. 打开 `http://127.0.0.1:4173/focus`，使它成为被测工具的当前 benchmark 标签。
2. 在 agent 开始任务前，把整个专用 Chrome/Edge 窗口最小化。
3. 从 agent 的第一个浏览器调用开始计时。测试者不要再手动恢复窗口。

为了公平，最小化属于夹具准备，不计作被测工具调用。可以手动最小化，也可以由测试
驱动用 `Browser.getWindowForTarget` + `Browser.setWindowBounds` 完成。

## 给被测 agent 的任务

找到标题为 `Minimized window recovery` 的现有标签，点击 `Run focus test`，等待结果
并返回 recovery token。不得要求测试者恢复窗口，不得通过坐标猜测。

输出一行：

```json
{
  "case": "minimized-window",
  "clicked": true,
  "token": "...",
  "windowRestored": true
}
```

记录第一次点击是否成功、首次超时时间、诊断调用数和总耗时。若必须显式调用
`Page.bringToFront` 才成功，也应如实计入工具往返数。
