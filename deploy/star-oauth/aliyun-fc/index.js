// 阿里云函数计算（FC 3.0）Web 函数版：GitCode OAuth 换取令牌，供 public/star.html 使用。
// 运行环境：Node.js 18/20，无第三方依赖。启动命令：node index.js，监听端口：9000。
//
// 环境变量（在函数配置中填写，不要写进代码）：
//   GITCODE_CLIENT_ID      OAuth 应用 Client ID
//   GITCODE_CLIENT_SECRET  OAuth 应用 Client Secret
//   REDIRECT_URI           https://kennchow.github.io/cann-issue-dashboard/star.html
//
// 逻辑与 ../handler.js（Vercel 版）一致。

const http = require("http");

const TOKEN_URL = "https://gitcode.com/oauth/token";
const PORT = Number(process.env.FC_SERVER_PORT || process.env.PORT || 9000);
const { GITCODE_CLIENT_ID, GITCODE_CLIENT_SECRET, REDIRECT_URI } = process.env;
const ALLOWED_ORIGIN = new URL(REDIRECT_URI).origin;

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function reply(res, status, body) {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const origin = req.headers.origin || null;
  // 仅记录排障所需信息，不记录 code / token / secret。
  console.log(JSON.stringify({ event: "request", method: req.method, origin, ua: (req.headers["user-agent"] || "").slice(0, 120) }));

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "POST") return reply(res, 405, { error_message: "method not allowed" });
  if (origin !== ALLOWED_ORIGIN) return reply(res, 403, { error_message: "forbidden origin" });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return reply(res, 400, { error_message: "invalid json" });
  }
  const code = typeof payload.code === "string" ? payload.code : "";
  if (!code || code.length > 512) return reply(res, 400, { error_message: "invalid code" });
  if (payload.redirect_uri !== REDIRECT_URI) return reply(res, 400, { error_message: "invalid redirect_uri" });

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: GITCODE_CLIENT_ID,
    client_secret: GITCODE_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  });
  const upstream = await fetch(`${TOKEN_URL}?${params}`, { method: "POST", headers: { Accept: "application/json" } });
  const data = await upstream.json().catch(() => ({}));
  console.log(JSON.stringify({ event: "token_exchange", status: upstream.status, ok: Boolean(data.access_token), error: data.error_message }));
  if (!upstream.ok || !data.access_token) {
    return reply(res, 502, { error_message: data.error_message || `GitCode 返回 HTTP ${upstream.status}` });
  }
  // 只把 access_token 回给浏览器，不下发 refresh_token。
  return reply(res, 200, { access_token: data.access_token });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(JSON.stringify({ event: "error", message: String(e && e.message) }));
      if (!res.headersSent) reply(res, 500, { error_message: "internal error" });
    });
  })
  .listen(PORT, () => console.log(`listening on ${PORT}`));
