# Bob Life · GCP 源码发布

完整解压后，在原来可以执行 `ssh gcp` 的 Windows 账户下双击 `Deploy-to-GCP.cmd`。也可执行 `.\scripts\deploy-gcp.ps1`，Linux 上用 `python3 scripts/deploy-gcp.py deploy`。需要 Python 3.9 或更高版本及 OpenSSH。首次连接请用已有可信主机记录。发布从当前解包目录读取代码，支持反复修改、重新执行。

## 修改入口

| 内容 | 包内源码 |
|---|---|
| 手机助理首页、交互与日历 | `gateway/life/web/home.html`、`life.js`、`calendar.mjs` |
| 顺路匹配、待办、推送、图片提取 | `gateway/life/` |
| 经典聊天界面及设置 | `gateway/public/index.html` |
| 网关与路由 | `gateway/main.go`、`features.go`、`life_host.go` |

这个包使用已验收的 Go 版经典界面，其中包含偏好设置；原 Node 原型的 `prototype/public/index.html` 和这份文件存在差异。在已含完整 Go 网关与 Life 模块的源码仓库运行同一发布器时，按节点台账和服务地图传入 `-SshAlias`、`-PublicOrigin`、`-GatewayPort`。

## 云端执行与验收

发布器经 SCP 上传源码，在现有 systemd 工作目录的独立目录中执行一次完整网关测试（含 Life 子包）和 `CGO_ENABLED=0 go build -p 1 -trimpath -ldflags="…" -o bobbot.candidate .`。本机无需 Go。通过后备份旧程序、原子切换、以免交互 sudo 重启现有服务。程序继续从原工作目录使用 `data/`。编译器版本会打印在终端。

保留原有服务 PIN。如果原服务没有配置 `BOBBOT_SECRET`，首次启动会在私有数据目录生成并保存会话签名密钥，先前登录的浏览器需用原 PIN 重新登录。已配置的显式签名密钥继续生效。发布包不包含线上配置及 API 密钥。

发布器检查服务本机与公网的 `/api/life/version` 均返回这次源码包对应的 SHA-256，还核对首页、日历资源和未登录访问限制。成功后输出 `Verified`，已验收源码可在服务工作目录的 `.life-sources/current` 查看。服务切换后验收失败会尝试恢复上一个二进制，并打印结果。若 SSH 在切换时中断，先查看公网版本和服务状态再决定是否重试。
