# Browser Agent Benchmark

这套基准用于比较 `windows-agent-browser`、Claude 的浏览器/CDP 插件或其他
agent 浏览器工具。它同时包含一个真实 ChatGPT 流程和八个可重复的本地用例。

## 启动本地站点

在仓库根目录运行：

```bash
npm run benchmark:serve
```

默认地址是 `http://127.0.0.1:4173`。可通过
`AGENT_BROWSER_BENCHMARK_PORT` 更换端口。服务不依赖外网，不写数据库；只有
安全用例会在内存中记录陷阱按钮被点击的次数，重启服务即可清零。

Windows Chrome 通常可以通过 localhost 转发访问在 WSL 中启动的服务。如果当前
机器禁用了该转发，请改用 Windows Node.js 启动同一个命令。

## 公平比较规则

1. Claude/Codex 每次只收到对应的 `cases/*.md`，不要让被测 agent 读取
   `site/`、`server.mjs` 或 `SCORING.md`。浏览器页面才是任务数据。
2. 两种工具使用同一个模型、相同的新对话、相同起始 URL、相同授权和同一台机器。
3. 为每个工具分别跑一次冷启动和至少两次热启动。冷启动包含 skill/schema
   加载；热启动单独报告中位数，不能把两者混成一个数字。
4. 从第一个浏览器工具调用开始计时，到 agent 输出可核验的最终 JSON 为止。
   人工登录、OAuth、CAPTCHA 和批准卡等待时间单列为 `humanWaitMs`。
5. 一次 heredoc、一次插件调用、一次交互式 stdin 写入都计作一次
   `toolRoundTrip`。同时记录返回给模型的字节数、超时、诊断调用和重试。
6. 先判断正确性和安全性，再比较速度。错误答案、越权操作或点击安全陷阱不能用
   “更快”抵消。
7. 每个本地用例开始前关闭前一次用例创建的 benchmark 标签页。只关闭本次测试
   自己创建的页面。

建议让测试驱动保存
[`result-template.json`](result-template.json) 的副本，每个工具一份。
可直接把 [`CLAUDE-RUNBOOK.md`](CLAUDE-RUNBOOK.md) 作为 Claude 的对比执行稿。

## 用例与区分度

| ID | 用例 | 主要区分能力 |
| --- | --- | --- |
| 01 | ChatGPT 真实流程 | 登录态、动态 UI、模型切换、插件/app、上传、流式答案 |
| 02 | UI 与迁移回归 | 截图、视口切换、几何错位、内容差异、localStorage 迁移 |
| 03 | 自适应分支 | 同一次动作后的跳转、原地结果、二次验证三种结果竞争 |
| 04 | 多标签对账 | 新标签发现、目标切换、跨页聚合、标签归属 |
| 05 | CSV 上传 | 本地路径到浏览器文件输入、异步解析、结构化错误抽取 |
| 06 | 虚拟列表 | 大数据页面、搜索、动态重渲染、模态框、ref 失效 |
| 07 | 提示注入安全 | 页面内容与任务权限分离、无副作用验证 |
| 08 | 最小化窗口恢复 | Windows 前台恢复、首次点击可靠性、超时诊断成本 |
| 09 | 正常窗口完整遮挡 | native occlusion、后台渲染、输入 ack、前台锁定 |

真实 ChatGPT 用例不纳入本地站点总分，因为 UI、响应时间和功能资格会变化。它应
单独报告。OpenAI 当前说明中，插件可能包含 app；模型、插件/app 和文件库能力都
可能受套餐、地区、工作区和 rollout 影响。因此用例使用测试者在当前账号实际可见
的标签，不写死产品名。参考：
[Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256)、
[Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)、
[File storage and Library in ChatGPT](https://help.openai.com/en/articles/20001052-library-for-chatgpt)。

## 关于“脚本不能看完输出再改道”

这个限制需要分成两类：

- 已知有限结果可以在一个 JavaScript 程序内适应。`page.waitForAny()` 能同时等
  URL、元素和文本条件，脚本随后用普通 `if`/`switch` 处理，避免为了“结果页还是
  错误页”多走一轮模型。
- 未知页面需要模型理解新 snapshot 后再决定下一步，这不可能由预先提交的静态
  程序自行完成。解决它需要新的交互协议，把中间结果返回模型并接受下一段命令；
  这仍然是一次模型回合，只能省进程启动和连接成本，不能消除推理回合。

因此第 03 用例专门测已知分支合并，第 06 用例则保留真正需要重新观察页面的情况。
