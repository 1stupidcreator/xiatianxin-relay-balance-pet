# 账号余额桌宠

把账号余额和今日已用放在桌面上，顺便看看最近用了多少、缓存命中了多少。Windows 小工具，支持 Sub2API 兼容站点和 DeepSeek。

![桌宠外观](docs/pet-preview.png)

图里的金额是演示数据。

## 下载和设置

到 [Releases](https://github.com/1stupidcreator/xiatianxin-relay-balance-pet/releases/latest) 下载 `Relay-Balance-Pet-*-portable.exe`，双击运行，不用安装 Node.js。

右键托盘图标打开设置，选择站点类型，填写自己的 API Key。Sub2API 还需要填写站点根地址；想看账号级的今日已用和历史统计，再填面板登录账号、密码。设置会自动保存，第一次运行的账号信息都是空的。

Sub2API 不同部署的接口可能有差异，需要兼容 `/v1/usage`、面板登录和小时用量接口。

## 平时怎么用

- 鼠标移上去变亮，移开后变淡；单击桌宠刷新余额，双击打开数据统计。
- 右键人物隐藏 10 秒，挡住桌面时可以临时让开。手动隐身在设置里，也可以按 `Ctrl+Shift+H` 切换。
- 设置、统计和退出都在托盘菜单里，桌宠本体不占任务栏。
- 消费提醒默认每 10 个账号货币单位跳动、发声，间隔可以改；普通扣费不会逐笔响。
- 贴边、位置锁定、开机自启和外观也在设置里。

## 用量和缓存

**账号统计**看最近 24、72、144 小时，数据来自面板登录后的小时用量，包含消费、请求和 Token。登录有效时，今日已用优先使用账号实际扣费；更新失败时保留旧金额并显示“今日待同步”。没配置登录时，只能按本机余额变化估算，充值、退款会影响结果。余额曲线保留最近 145 小时，超过一小时的采样按分钟归档。

**本机统计**读取 CC Switch 的 Codex 代理日志，显示最近 1 分钟和 1 小时。数据库只读，不改 CC Switch 的配置。请求结束、日志写入后才会计入，所以这里和账号统计的范围不一样。

缓存率按 Token 总量计算，不是把每条请求的百分比取平均。CC Switch 输入总量已经包含缓存 Token，因此用缓存读取 Token 除以总输入 Token；输出 Token 不参与。只统计成功且能确认 Token 口径的 Codex 代理请求。

缓存告警每分钟读取一次新数据：最近 1 分钟低于 80% 时发 Windows 通知，可带声音。没有有效输入、数据不完整或读取失败时不告警。通知和声音会受 Windows 免打扰、通知权限及音量影响。

不想读取 CC Switch 时，可以在设置里暂停 1–168 小时，随时点“立即恢复”。暂停期间不读取数据库、不发缓存告警，账号统计仍可使用。

## 本地数据

配置和运行记录放在 `%APPDATA%\relay-balance-pet\`。API Key、面板账号密码保存在本机 `config.json`，目前未加密；JWT 只放在进程内存里。分享文件时别把这个目录一起发出去。

CC Switch 数据库默认从 `%USERPROFILE%\.cc-switch\cc-switch.db` 读取。账号请求发往你配置的站点，DeepSeek 模式使用其余额 API；Webhook 默认关闭，开启后会向你填写的地址发送事件。

## 从源码运行

需要 Windows、Node.js 22.13 或更新版本（包含 `node:sqlite`）。

```powershell
npm ci
npm start
```

安装依赖后，也可以双击 `start-pet.vbs`，启动时不显示终端。

打包便携 EXE：

```powershell
npm run dist:win
```

产物在 `dist/`。离线自检用 `npm run smoke`；发布文件的校验值在 `SHA256SUMS.txt`。

## 来源

桌宠基础代码来自 [qijiamin0822/deepseek-whale-pet](https://github.com/qijiamin0822/deepseek-whale-pet)，Sub2API 适配参考 [yigehaozi/relay-status-monitor](https://github.com/yigehaozi/relay-status-monitor)。代码采用 [MIT License](LICENSE)，保留上游版权声明。
