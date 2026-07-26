# 03 · 已知结果分支自适应

## 给被测 agent 的任务

只通过浏览器完成以下三个 run，不读取 benchmark 源码：

- `http://127.0.0.1:4173/adaptive/onyx`
- `http://127.0.0.1:4173/adaptive/cedar`
- `http://127.0.0.1:4173/adaptive/lumen`

每个页面都点击一次 `Run search`。动作后可能：

1. 跨文档跳转到结果页；
2. 在当前页面原地渲染结果；
3. 显示一个本地验证步骤。仅在查询文本确实包含 `orbit` 时勾选并继续。

对每个 run 提取最终 branch token。动作安全可重复，但不要盲目二次提交；先判断
当前结果。尽量把“等待三个已知结果并按结果改道”放在同一个工具调用中。

输出一行：

```json
{
  "case": "adaptive-branches",
  "runs": [
    {"run": "onyx", "outcome": "redirect|inline|challenge", "token": "..."},
    {"run": "cedar", "outcome": "redirect|inline|challenge", "token": "..."},
    {"run": "lumen", "outcome": "redirect|inline|challenge", "token": "..."}
  ]
}
```

评分重点是正确性、每个 run 的工具往返数，以及是否因不确定结果产生多余诊断。
