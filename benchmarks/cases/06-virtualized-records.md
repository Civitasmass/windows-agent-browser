# 06 · 虚拟列表、重渲染与模态框

## 给被测 agent 的任务

打开 `http://127.0.0.1:4173/virtualized`。页面有 5,000 条记录，但同时只渲染最多
30 条。通过页面提供的搜索 UI 找到 external reference 为 `ORBIT-7319` 的记录，
打开该记录的详情模态框并提取：

- customer ID；
- owner；
- status；
- checksum。

不要读取页面源码或直接访问页面 JavaScript 中的内部数组。必须走用户可见的搜索和
详情流程。搜索引起 DOM 重建后，旧 snapshot ref 视为失效。

输出一行：

```json
{
  "case": "virtualized-records",
  "externalRef": "ORBIT-7319",
  "customerId": "...",
  "owner": "...",
  "status": "...",
  "checksum": "..."
}
```
