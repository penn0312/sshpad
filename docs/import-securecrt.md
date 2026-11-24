# 从 SecureCRT 迁移快捷命令

macOS 的脚本使用 Python 3.9+ 标准库。默认只读 `~/Library/Application Support/VanDyke/SecureCRT/Config/` 内的 `ButtonBarV5.ini` 和 `Commands/`。保存 SecureCRT 快捷命令后，在项目根目录执行。

```bash
python3 scripts/sync_securecrt.py --dry-run
python3 scripts/sync_securecrt.py --output "$HOME/Downloads/securecrt-commands.json"
```

在扩展设置里选择「下载」中的文件，检查预览并确认。后续更新重复执行相同命令。备用配置目录可在两条命令中加入 `--config-dir "$HOME/path/to/Config"`。同一配置路径会生成相同来源 ID。

脚本导入 `SEND` 记录并保留名称、分组和组内顺序。脚本移除一个末尾 CR、LF 或 CRLF。包含等待、内部换行、控制键、凭据占位符和未知转义的记录计入复核。分组内同名同内容只保留首条，同名异内容计入冲突。控制台只输出统计，JSON 文件以 `0600` 权限原子写入。

## 可选过滤

可以创建本地规则 JSON，以下示例会排除 `Demo navigation` 分组中仅发送 RFC 1918 IPv4 地址的按钮。

```json
{
  "excludePrivateIpGroups": ["Demo navigation"]
}
```

使用 `--rules path/to/rules.json` 指定规则。使用默认 SecureCRT 配置目录时，脚本也会读取项目内的 `.local/securecrt-rules.json`，显式传入 `--rules` 可以覆盖它。干净检出的项目默认无过滤规则。生成的命令库和本地规则可保存在已忽略的 `.local/`。
