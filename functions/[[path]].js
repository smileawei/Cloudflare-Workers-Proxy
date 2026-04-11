// Cloudflare Pages Functions 版本：catch-all 路由
// 所有请求都会先进入这里，未命中 ROUTES 的才会回落到 public/ 下的静态文件
//
// 注：核心逻辑与根目录的 worker.js 保持一致，只是入口从 addEventListener('fetch')
// 改成了 Pages Functions 的 onRequest 导出形式。

// 路由映射：请求路径前缀 -> 目标站点
const ROUTES = {
  '/iptv/iptv-all.m3u':
    'https://raw.githubusercontent.com/smileawei/ChinaTelecom-GuangdongIPTV-RTP-List/master/iptv-all.m3u',
  '/iptv/epg.xml':
    'https://raw.githubusercontent.com/smileawei/ChinaTelecom-GuangdongIPTV-RTP-List/refs/heads/master/epg.xml',
};

export async function onRequest(context) {
  return handleRequest(context.request);
}

async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    // 根路径返回可用路由列表
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getRootHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 匹配路由前缀
    const match = matchRoute(url.pathname);
    if (!match) {
      return jsonResponse({ error: 'Route not found' }, 404);
    }

    const { prefix, target } = match;

    // 剥掉前缀后拼接到目标站点
    // 精确匹配（pathname === prefix）时 remaining 为 ''，保留 target 原样，
    // 这样像 /iptv/gd-all.m3u 这种指向具体文件的路由不会被追加多余的 '/'
    const remaining = url.pathname.slice(prefix.length);
    const actualUrlStr = target + remaining + url.search;

    // 创建新 Headers 对象，排除以 'cf-' 开头的请求头
    const newHeaders = filterHeaders(request.headers, name => !name.startsWith('cf-'));

    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.body,
      redirect: 'manual',
    });

    const response = await fetch(modifiedRequest);
    let body = response.body;

    // 处理重定向：把 Location 改写回代理前缀下
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return handleRedirect(response, prefix, target);
    } else if (response.headers.get('Content-Type')?.includes('text/html')) {
      body = await handleHtmlContent(response, prefix);
    }

    const modifiedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    setNoCacheHeaders(modifiedResponse.headers);
    setCorsHeaders(modifiedResponse.headers);

    return modifiedResponse;
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// 按最长前缀匹配路由
function matchRoute(pathname) {
  let best = null;
  for (const prefix of Object.keys(ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, target: ROUTES[prefix] };
      }
    }
  }
  return best;
}

// 处理重定向，把 Location 头改写到代理前缀下
function handleRedirect(response, prefix, target) {
  const location = response.headers.get('location');
  if (!location) return response;

  let modifiedLocation = location;
  try {
    const locUrl = new URL(location, target);
    // 如果跳转仍然落在目标站点上，改写为代理前缀路径
    if (locUrl.origin === new URL(target).origin) {
      modifiedLocation = prefix + locUrl.pathname + locUrl.search + locUrl.hash;
    }
  } catch (_) {
    // location 解析失败则保持原样
  }

  const headers = new Headers(response.headers);
  headers.set('Location', modifiedLocation);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// 改写 HTML 中的站内绝对路径为代理前缀路径
async function handleHtmlContent(response, prefix) {
  const originalText = await response.text();
  const regex = /((?:href|src|action)=["'])\/(?!\/)/g;
  return originalText.replace(regex, `$1${prefix}/`);
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

function setNoCacheHeaders(headers) {
  headers.set('Cache-Control', 'no-store');
}

function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
}

// 返回根目录的 HTML：只展示可用路径，不展示背后的原始地址
function getRootHtml() {
  const items = Object.keys(ROUTES)
    .map(prefix => `<li><a href="${prefix}"><code>${prefix}</code></a></li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Warp</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
      body, html {
          height: 100%;
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #ffffff;
          color: #2c3e50;
      }
      .wrap {
          min-height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
      }
      .card {
          width: 100%;
          max-width: 420px;
          padding: 32px 36px;
          border-radius: 12px;
          background: #f7f7f8;
          box-shadow: 0 4px 20px rgba(0,0,0,0.06);
      }
      h1 {
          margin: 0 0 20px;
          font-weight: 300;
          letter-spacing: 0.15em;
          text-align: center;
      }
      ul { list-style: none; padding: 0; margin: 0; }
      li {
          padding: 10px 0;
          border-bottom: 1px solid rgba(0,0,0,0.08);
      }
      li:last-child { border-bottom: none; }
      a { color: inherit; text-decoration: none; }
      a:hover code { background: rgba(0,0,0,0.1); }
      code {
          background: rgba(0,0,0,0.05);
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 0.95em;
      }
      @media (prefers-color-scheme: dark) {
          body, html { background: #121212; color: #e0e0e0; }
          .card { background: #1e1e1e; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          li { border-bottom-color: rgba(255,255,255,0.1); }
          code { background: rgba(255,255,255,0.08); }
          a:hover code { background: rgba(255,255,255,0.15); }
      }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Warp</h1>
      <ul>${items}</ul>
    </div>
  </div>
</body>
</html>`;
}
