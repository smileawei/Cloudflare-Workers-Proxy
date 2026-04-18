# Cloudflare Pages Proxy

一个基于 Cloudflare Pages Functions 的前缀路由反向代理。通过 Cloudflare KV 保存 `前缀 -> 目标地址` 映射，将访问 `https://your-site.example.com/<prefix>/...` 的请求转发到对应的上游站点，并提供一个简单的 `/admin` 管理后台来维护这些路由。

## 简介

基于 "路由前缀 -> 目标地址" 的映射工作。

例如：

- `/docs` -> `https://example.com/docs`
- `/blog` -> `https://blog.example.com`

当访问：

- `https://your-site.example.com/docs/getting-started`

会把请求转发到：

- `https://example.com/docs/getting-started`

项目主要能力：

- 基于最长前缀匹配进行路由转发
- 路由配置持久化到 Cloudflare KV
- 提供 `/admin` 管理页面增删改路由
- 处理上游重定向并改写同源跳转地址
- 对 HTML 响应中的部分相对路径进行重写
- 为响应补充 CORS 头和禁用缓存头

## 项目结构

- [functions/\[\[path\]\].js](functions/[[path]].js): Pages Functions catch-all 路由，包含代理逻辑、管理 API 和前端页面
- [public/](public): 静态资源目录，用于 Pages 部署时的静态内容占位

## 所需绑定

部署前请在 Cloudflare Pages 项目中配置以下绑定：

- `ROUTES_KV`
  KV Namespace 绑定，用于保存路由配置。代码会把所有路由作为 JSON 存在 `routes` 这个 key 下。
- `ADMIN_PASSWORD`
  管理后台密码（建议以 Secret 形式存放）。前端会通过 `X-Admin-Token` 请求头把它发送给 Pages Functions。

如果没有绑定 `ROUTES_KV`，读取路由时会回退为空对象，保存路由时会报错。
如果没有设置 `ADMIN_PASSWORD`，管理 API 的鉴权会始终失败。

## 部署方法

推荐直接使用 Cloudflare Dashboard 部署：

1. 在 Cloudflare Dashboard 创建一个 Pages 项目，连接本仓库。
2. 构建设置保持默认（无需构建命令；输出目录为 `public`）。
3. 在 Pages 项目的 Settings 中：
   - Functions → KV namespace bindings：添加绑定，变量名 `ROUTES_KV`，指向你创建的 KV namespace。
   - Environment variables：新增 `ADMIN_PASSWORD`（Production / Preview 都建议加）。
4. 重新部署使绑定生效。

## 使用方式

### 1. 管理路由

访问：

- `https://your-site.example.com/admin`

输入管理员密码后，可以在管理后台进行：

- 查看当前所有路由
- 新增路由
- 编辑已有路由的目标地址
- 删除路由

### 2. 访问代理路由

假设在后台配置：

- `prefix`: `/docs`
- `target`: `https://example.com/docs`

那么：

- `https://your-site.example.com/docs`
- `https://your-site.example.com/docs/getting-started?lang=zh`

会分别代理到：

- `https://example.com/docs`
- `https://example.com/docs/getting-started?lang=zh`

### 3. 查看路由首页

访问根路径：

- `https://your-site.example.com/`

会显示当前已配置路由的列表页。

## 管理 API

内置以下管理 API，路径前缀为 `/admin/api`。除 `OPTIONS` 预检外，都需要携带请求头：

```http
X-Admin-Token: <ADMIN_PASSWORD>
```

可用接口：

- `GET /admin/api/check`
  用于校验管理员口令是否正确
- `GET /admin/api/routes`
  获取当前全部路由
- `POST /admin/api/routes`
  新增或覆盖一条路由
- `DELETE /admin/api/routes`
  删除一条路由

`POST /admin/api/routes` 请求体示例：

```json
{
  "prefix": "/docs",
  "target": "https://example.com/docs"
}
```

`DELETE /admin/api/routes` 请求体示例：

```json
{
  "prefix": "/docs"
}
```

## 实现说明

当前版本的代理实现有一些明确边界：

- 只会匹配已配置的前缀，未命中时返回 `404`
- 路由匹配采用最长前缀优先
- HTML 内容改写只处理 `href`、`src`、`action` 中以 `/` 开头的相对路径
- 并不是所有网站都能被完整代理，复杂前端站点、脚本动态拼接资源、严格 CSP 或依赖特殊请求头的站点可能表现异常
- 会透传大部分请求头，但会过滤掉以 `cf-` 开头的头以及 `host`

## 注意事项

- 请合理限制谁能访问你的站点地址和 `/admin` 页面。
- `ADMIN_PASSWORD` 当前采用请求头明文比对，适合轻量自用，不适合作为高强度管理系统。
- 请勿将该服务用于未经授权的抓取、绕过限制或其他非法用途。
- 代理第三方网站时，请确认你拥有合法权限，并遵守目标站点的服务条款、版权和当地法律法规。

## 免责声明

- **责任限制**：作者不对脚本可能导致的任何安全问题、数据损失、服务中断、法律纠纷或其他损害负责。使用此脚本需自行承担风险。
- **不当使用**：使用者需了解，本脚本可能被用于非法活动或未经授权的访问。作者强烈反对和谴责任何不当使用脚本的行为，并鼓励合法合规的使用。
- **合法性**：请确保遵守所有适用的法律、法规和政策，包括但不限于互联网使用政策、隐私法规和知识产权法。确保您拥有对目标地址的合法权限。
- **自担风险**：使用此脚本需自行承担风险。作者和 Cloudflare 不对脚本的滥用、不当使用或导致的任何损害承担责任。

**此免责声明针对非中国大陆地区用户，如在中国大陆地区使用，需遵守相关地区法律法规，且由使用者自行承担相应风险与责任。**

## 资源

- [Cloudflare Pages 文档](https://developers.cloudflare.com/pages/)
- [Pages Functions 文档](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare KV 文档](https://developers.cloudflare.com/kv/)

[![Powered by DartNode](https://dartnode.com/branding/DN-Open-Source-sm.png)](https://dartnode.com "Powered by DartNode - Free VPS for Open Source")

## 许可证

本项目采用 MIT 许可证。详细信息请参阅 [LICENSE](LICENSE) 文件。
