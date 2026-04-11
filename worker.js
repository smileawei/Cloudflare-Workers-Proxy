// 路由映射：请求路径前缀 -> 目标站点
// 访问 your-worker.com/gh/foo/bar 会被转发到 https://github.com/foo/bar
const ROUTES = {
  '/gh': 'https://github.com',
  '/api': 'https://api.openai.com',
  '/iptv/gd-all.m3u':
    'https://raw.githubusercontent.com/smileawei/ChinaTelecom-GuangdongIPTV-RTP-List/master/iptv-all.m3u',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

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

// 返回根目录的 HTML，列出所有可用路由
function getRootHtml() {
  const items = Object.entries(ROUTES)
    .map(
      ([prefix, target]) =>
        `<li><a href="${prefix}"><code>${prefix}</code></a> &rarr; <span>${target}</span></li>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Routes</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
      body, html { height: 100%; margin: 0; }
      .background {
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.9);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .route-list { list-style: none; padding: 0; }
      .route-list li {
          padding: 10px 0;
          border-bottom: 1px solid rgba(0,0,0,0.1);
      }
      .route-list li:last-child { border-bottom: none; }
      .route-list code {
          background: rgba(0,0,0,0.06);
          padding: 2px 8px;
          border-radius: 4px;
      }
      @media (prefers-color-scheme: dark) {
          body, html { background-color: #121212; color: #e0e0e0; }
          .card { background-color: rgba(33, 33, 33, 0.9); color: #ffffff; }
          .route-list li { border-bottom-color: rgba(255,255,255,0.1); }
          .route-list code { background: rgba(255,255,255,0.1); }
          .route-list a { color: #80cbc4; }
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Routes</span>
                          <ul class="route-list">${items}</ul>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
</body>
</html>`;
}
