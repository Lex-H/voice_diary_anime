# Git hooks

本目錄含 **pre-push**：避免 `AGENTS.md`、`PROJECT_GUIDE.md` 被推到遠端。

在專案根目錄執行一次（僅本機 `.git/config`，不會進遠端）：

```bash
git config core.hooksPath .githooks
```

Windows 上請用 **Git Bash** 執行上述指令，以確保 `pre-push` 可執行。

驗證：嘗試 `git push` 一個仍含上述檔案的提交時，應被拒絕。