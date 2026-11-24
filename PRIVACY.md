# Privacy Policy / 隐私政策

Last updated: 2026-11-24

## 中文说明

**sshpad** 是一款纯本地运行的 Chrome 扩展，不收集、不上传、不共享任何用户数据。

### 1. 数据收集与网络传输
- 本扩展**不收集任何个人身份信息、浏览历史、终端内容或使用统计**。
- 本扩展**不发起任何外部网络请求**，不包含第三方统计、广告、遥测脚本，也不加载任何远程代码。

### 2. 本地数据存储
- 您添加的授权站点地址、命令库、分组配置、排序与编辑记录均仅保存在浏览器本地的 `chrome.storage.local` 中。
- 扩展将 `chrome.storage.local` 的访问级别设置为 `TRUSTED_CONTEXTS`，网页端的内容脚本无法直接读取原始存储数据。
- 您可以随时在扩展设置页删除命令或站点，或卸载扩展以彻底清除所有本地数据。

### 3. 权限使用说明
- **`storage`**：在浏览器本地保存您的站点授权记录、命令库与自定义排序。
- **`scripting`**：仅在您显式授权的 JumpServer Luna 页面注入命令栏界面与终端会话状态探针，并在您点击快捷命令按钮时向当前确认的 SSH 会话提交命令。
- **`optional_host_permissions`（`https://*/*`、`http://*/*`）**：JumpServer 通常为私有化部署，域名和端口各不相同。扩展仅在您于设置页主动添加并通过 Chrome 原生弹窗确认授权后，才会在对应站点生效；未授权站点不会注入任何脚本。

### 4. 联系方式
如有隐私或安全相关问题，请通过开源仓库联系我们：
https://github.com/penn0312/sshpad

---

## English

**sshpad** is a strictly local Chrome extension. It does not collect, transmit, sell, or share any user data.

### 1. Data Collection & Network Activity
- sshpad **does not collect** any personally identifiable information, browsing history, terminal output, or analytics/telemetry data.
- sshpad makes **zero external network requests**, includes no third-party trackers or ads, and loads no remote code.

### 2. Local Storage
- Your authorized JumpServer site origins, command libraries, group selections, ordering, and local edits are stored exclusively on your device using `chrome.storage.local`.
- Storage access is restricted to `TRUSTED_CONTEXTS` so untrusted page scripts cannot read raw storage entries.
- You can delete any saved sites or commands in the extension's Options page at any time, or uninstall the extension to remove all local data.

### 3. Permissions
- **`storage`**: Persists your authorized sites, command libraries, and preferences locally in `chrome.storage.local`.
- **`scripting`**: Dynamically registers and injects the command bar UI and a MAIN-world session probe strictly on user-authorized JumpServer Luna pages, and submits commands to the verified active SSH session when you click a button.
- **`optional_host_permissions` (`https://*/*`, `http://*/*`)**: JumpServer instances are self-hosted on private domains and ports. Site access is requested per origin only when you explicitly add a site in the Options page and approve Chrome's permission prompt. No scripts run on unauthorized sites.

### 4. Contact
If you have questions about this privacy policy, please open an issue or security advisory at:
https://github.com/penn0312/sshpad
