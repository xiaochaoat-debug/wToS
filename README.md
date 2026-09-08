# 数据搬运工 · 顽鹿(Onelap) → Strava

把顽鹿运动的骑行记录一键同步到 Strava 的**纯静态网页版**。

- 无需小程序审核、无需服务器、无需付费
- 账号密码与授权凭证只存在**你自己浏览器的 localStorage** 里，不会上传到任何服务器
- 授权一次长期有效，之后每次**点一下「开始同步」**就完事

在线地址：https://xiaochaoat-debug.github.io/wToS/

---

## 首次配置（只需做一次）

### 1. 顽鹿账号
在页面第 01 张卡片里填顽鹿的账号和密码，点「身份验证」。
密码只用于本地生成 MD5 摘要后调用顽鹿官方登录接口，登录成功后明文密码也只存在本机浏览器。

### 2. Strava 授权
> ⚠️ 需要先去 https://www.strava.com/settings/api 把自己 API 应用的
> **Authorization Callback Domain** 改成 `xiaochaoat-debug.github.io`（页面上有一键复制按钮）。
> 只改这一次，之后长期有效。

改完之后回到网页，点「连接 Strava」→ 在 Strava 页面点授权 → 会自动跳回本站并完成绑定。

**如果不想改 Strava 设置**：把回调模式切成「手动粘贴」，授权后浏览器会跳到打不开的
`localhost/?code=…`，把整条地址复制回网页的输入框即可（和原来小程序的操作一样）。

### 3. 同步
两边都连上后，点「开始同步」。默认同步最近 30 天、单次最多 10 条（防 Strava 限流）。
已经同步过的记录会记在本机，重复点不会重复上传。

---

## 实现说明

| 步骤 | 接口 |
| --- | --- |
| 顽鹿登录 | `POST https://www.onelap.cn/api/login`（密码 MD5） |
| 活动列表 | `POST https://u.onelap.cn/api/otm/ride_record/list`（Authorization + md5 签名） |
| 活动详情 | `GET https://u.onelap.cn/api/otm/ride_record/analysis/{id}` |
| 下载 FIT | `GET https://u.onelap.cn/api/otm/ride_record/analysis/fit_content/{base64(fitUrl)}` |
| Strava 换票 | `POST https://www.strava.com/oauth/token` |
| 查重 | `GET https://www.strava.com/api/v3/athlete/activities` |
| 上传 | `POST https://www.strava.com/api/v3/uploads`（multipart，data_type=fit） |

> 顽鹿旧的 `u.onelap.cn/analysis/list` 已经失效（返回 404），现在走新版 OTM 接口。
> 新版签名头 `nonce/timestamp/sign` 不在 CORS 白名单里，所以签名放在请求体里传；
> 页面会自动依次尝试「签名在 body → 签名在 query → 无签名 → 旧接口」，取第一个能拿到数据的。
> 设置里有「诊断顽鹿接口」按钮，会把每种方式的原始返回打出来，方便排查。

顽鹿和 Strava 的接口都返回 `Access-Control-Allow-Origin: *`，所以浏览器可以直连，不需要自建代理。
只有个别地区的顽鹿 FIT 下载 CDN 可能缺 CORS 头，此时会自动降级到公共代理；
你也可以在「同步设置」里填自己的代理前缀（例如 Cloudflare Worker）。

Strava 每次刷新 token 都会轮换 `refresh_token`，页面会自动回存新的，不会用几次就掉授权。

---

## 本地运行

直接双击 `index.html` 也能用，但 Strava 回调需要 http(s) 域名，建议起个本地服务：

```bash
python -m http.server 8080
# 打开 http://localhost:8080
```

## 文件

```
index.html   页面结构
style.css    样式
app.js       全部逻辑（登录 / 授权 / 同步）
md5.js       纯 JS MD5 实现
```

## 注意

- Strava API 的 `client_secret` 写在前端是为了免去服务器，仅适合自用。若担心，可自行改成走代理。
- 换浏览器 / 清缓存 = 凭证丢失，需要重新登录一次。
