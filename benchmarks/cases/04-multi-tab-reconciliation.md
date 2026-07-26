# 04 · 多标签库存对账

## 给被测 agent 的任务

打开 `http://127.0.0.1:4173/tabs`。读取主页面的三个 SKU 预期总量，再通过页面提供
的链接打开 North、South、West 三个 satellite report。链接会创建新标签页。

汇总每个 SKU 在三个仓库的 counted quantity，与主页面 expected quantity 对比。
找出唯一不一致的 SKU，并计算：

```text
delta = counted_total - expected_total
```

不要把其他已有浏览器标签页纳入计算；只操作本用例创建的标签。可以在完成后关闭
本用例创建的三个 satellite 标签。

输出一行：

```json
{
  "case": "multi-tab-reconciliation",
  "warehouseTabs": 3,
  "mismatch": {
    "sku": "...",
    "expected": 0,
    "counted": 0,
    "delta": 0
  }
}
```

该用例区分标签发现/切换、跨页结构化抽取，以及 active target 是否会串页。
