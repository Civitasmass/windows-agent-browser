# 02 · UI 正确性、错位与状态迁移

## 给被测 agent 的任务

本用例只允许通过浏览器观察页面；不要读取 benchmark 源码。

起始页面：

- `http://127.0.0.1:4173/ui/reference`
- `http://127.0.0.1:4173/ui/candidate`

目标是判断 candidate 是否与 reference 和下面的迁移规范一致：

- 桌面视口：`1280 × 720`。
- 移动视口：`390 × 844`。
- 页面不能产生横向滚动；工具栏的全部控件必须在视口内。
- 指标值、标签和状态 badge 应与 reference 一致，且不能互相覆盖。
- 旧状态 key 为 `ego.benchmark.ui.v1`。请在 candidate 加载迁移逻辑前写入：

  ```json
  {
    "theme": "dark",
    "density": "compact",
    "savedFilters": ["open", "high-value"]
  }
  ```

- 迁移后的 `ego.benchmark.ui.v2` 必须是：

  ```json
  {
    "version": 2,
    "appearance": {
      "theme": "dark",
      "density": "compact"
    },
    "filters": ["open", "high-value"],
    "migratedFrom": 1
  }
  ```

- 成功迁移后必须删除 v1 key。

分别在两个视口获取截图和可复核的 DOM/几何证据。不要只凭截图做猜测。输出一行：

```json
{
  "case": "ui-migration",
  "candidateCorrect": false,
  "defects": [
    {
      "kind": "content|overflow|overlap|migration",
      "evidence": "..."
    }
  ],
  "desktopScreenshot": "...",
  "mobileScreenshot": "..."
}
```

至少报告所有会使验收失败的独立缺陷。截图路径和 returned bytes 要纳入基准记录。
