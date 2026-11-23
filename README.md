# Bob-Bot

Bob-Bot 是可自行托管的个人助理。它能保存对话中的待办和随手记，按用户时区提醒，也能让用户接手正在操作的浏览器。

## 完整版

使用 Node.js 24.9 或以上版本，并安装 Chromium、Chrome 或 Edge。在 `prototype/` 安装锁定的依赖，设置自己的六位 PIN，再启动服务。

```sh
npm ci
node set-pin.mjs --stdin
node server.mjs
```

在本机打开 `http://127.0.0.1:8787`，登录后在设置中选择模型并填入自己的密钥。对话、用户配置、随手记和推送订阅保存在实例的私有数据目录。部署 Web Push 时设定 `BOB_PUSH_SUBJECT` 为运营者的联系邮箱（mailto URI）或 HTTPS 地址。[完整版使用说明](prototype/README.md)

## 轻量版

在 `gateway/` 设置环境变量 `BOBBOT_PIN`，然后运行 `go test ./...` 和 `go run .`。默认端口为 8080。随附的 systemd 示例使用专用用户 bobbot 和部署者提供的环境文件。[提醒与日历说明](gateway/life/README.md)

## iPhone 与微信

`shortcuts/Bob.cherri` 提供快捷指令源码。将模板中的示例域名替换为自己的 HTTPS 地址，编译并签名，将生成的文件放到完整版实例的 `data/Bob.shortcut`。用户即可在文员页添加这台实例的快捷指令。微信消息桥可按需安装。[微信桥说明](wechat/README.md)
