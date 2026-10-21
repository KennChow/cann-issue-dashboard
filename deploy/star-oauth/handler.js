// GitCode OAuth 换取令牌的最小后端，供 public/star.html 一键 Star 页面使用。
// client_secret 只保存在部署平台的环境变量中，不会出现在静态页面里。
//
// 环境变量：
//   GITCODE_CLIENT_ID      OAuth 应用 Client ID
//   GITCODE_CLIENT_SECRET  OAuth 应用 Client Secret
//   REDIRECT_URI           https://kennchow.github.io/cann-issue-dashboard/star.html
//
// 实测：GitCode /oauth/token 必须携带 client_secret，否则返回 "client_secret不能为空"。

const TOKEN_URL = "https://gitcode.com/oauth/token";

export async function handle(request, env) {
  // 仅记录排障所需信息，不记录 code / token / secret。
  console.log(
    JSON.stringify({
      event: "request",
      method: request.method,
      origin: request.headers.get("Origin"),
      ua: (request.headers.get("User-Agent") || "").slice(0, 120),
      country: request.headers.get("x-vercel-ip-country"),
    }),
  );
  const allowedOrigin = new URL(env.REDIRECT_URI).origin;
  const cors = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, { error_message: "method not allowed" });
  if (request.headers.get("Origin") !== allowedOrigin) return reply(403, { error_message: "forbidden origin" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return reply(400, { error_message: "invalid json" });
  }
  const code = typeof payload.code === "string" ? payload.code : "";
  if (!code || code.length > 512) return reply(400, { error_message: "invalid code" });
  if (payload.redirect_uri !== env.REDIRECT_URI) return reply(400, { error_message: "invalid redirect_uri" });

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.GITCODE_CLIENT_ID,
    client_secret: env.GITCODE_CLIENT_SECRET,
    redirect_uri: env.REDIRECT_URI,
  });
  const upstream = await fetch(`${TOKEN_URL}?${params}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const data = await upstream.json().catch(() => ({}));
  console.log(JSON.stringify({ event: "token_exchange", status: upstream.status, ok: Boolean(data.access_token), error: data.error_message }));
  if (!upstream.ok || !data.access_token) {
    // GitCode 失败响应格式：{"error_code":400,"error_code_name":"BAD_REQUEST","error_message":"授权码错误"}
    return reply(502, {
      error_message: data.error_message || `GitCode 返回 HTTP ${upstream.status}`,
    });
  }
  // 只把 access_token 回给浏览器，不下发 refresh_token。
  return reply(200, { access_token: data.access_token });
}
