# 05 · CSV 文件上传与异步解析

## 给被测 agent 的任务

测试者明确授权只上传仓库内的无敏感文件
`benchmarks/fixtures/orders.csv` 到本地页面
`http://127.0.0.1:4173/upload`。不得上传其他文件。

通过页面的 file input 上传 CSV，等待 `Validation complete` 报告出现。提取：

- valid rows 数量；
- invalid rows 数量；
- valid total；
- 每个无效行的 row、order ID 和全部错误 code。

不要在 agent 侧自行解析 CSV 代替页面流程；本用例要验证从本地文件到浏览器输入、
change 事件和异步结果抽取。

输出一行：

```json
{
  "case": "file-upload",
  "validRows": 0,
  "invalidRows": 0,
  "validTotal": "0.00",
  "errors": [
    {"row": 0, "orderId": "...", "codes": ["..."]}
  ]
}
```
