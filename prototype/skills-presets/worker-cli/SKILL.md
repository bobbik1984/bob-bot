---
name: worker-cli
description: 将重型编程、深度研究、复杂多文件改造或长链路分析委派给本机已登录订阅的 Codex CLI (`codex exec`) 或 Antigravity CLI (`agy -p`)。当常规单步脚本不够用、需要重型自主代理协作时使用。
---

# Worker CLI — 本机重型执行主力委派规范

当前节点（VPS3）已内置并登录以下重型代理 CLI（使用其各自独立订阅，无需额外填 API Key；你自身由 `dsh` 驱动，负责总控调度与日常响应）：

## 1. 可用主力工具
- **Codex CLI (`codex`)**：适合复杂代码编写、脚本调试、数据清洗工程、批量文件处理。
  - 非交互调用示例：
    ```bash
    codex exec "在当前目录读取 uploads/report.xlsx，按部门汇总季度营收并生成美化后的 outputs/summary.xlsx 和 outputs/summary.html"
    ```
- **Antigravity CLI (`agy`)**：适合深度研究、架构分析、复杂报告撰写与长链路推理。
  - 非交互调用示例：
    ```bash
    agy -p --mode auto "分析 uploads/contract.pdf 中的关键风险条款并输出结构化摘要到 outputs/risk_summary.md"
    ```

## 2. 委派原则与边界
1. **轻量任务直接自己做**：常规问答、简单的 PDF/Excel/Word/PPT 提取与生成，直接用 `python3`（参考 `office-docs` 技能）秒级完成，不必启动重型子 CLI。
2. **重型任务委派给主力 CLI**：遇到复杂多步骤报表工程、需要反复调试脚本或深度综合研究时，优先在工作区内调用 `codex exec` 或 `agy -p`。
3. **产物落盘**：要求子 CLI 将最终产出文件写入工作区 `outputs/`，完成后向用户提供站内预览/下载链接（`/api/workspace/file?path=outputs/<文件名>`）。
4. **超时与安全**：子 CLI 仅在工作区目录运行，禁止访问敏感凭证目录。
