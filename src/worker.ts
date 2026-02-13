import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { apiAuthMiddleware } from "./middleware/api-auth";
import { authRoutes, hasAuthCookie } from "./routes/auth";
import { apiKeyRoutes } from "./routes/api-keys";
import { imagineRoutes } from "./routes/imagine";
import { proxyRoutes } from "./routes/proxy";
import { tokenRoutes } from "./routes/tokens";
import { chatRoutes } from "./routes/v1/chat";
import { imagesRoutes } from "./routes/v1/images";
import { modelsRoutes } from "./routes/v1/models";
import { videosRoutes } from "./routes/v1/videos";

const app = new Hono<{ Bindings: Env }>();

function getBuildSha(env: Env): string {
  const v = String(env.BUILD_SHA ?? "").trim();
  return v || "dev";
}

function isAuthRequired(env: Env): boolean {
  return !!(env.AUTH_USERNAME && env.AUTH_PASSWORD);
}

function isPublicAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith("/css/") ||
    pathname.startsWith("/js/") ||
    pathname.startsWith("/static/") ||
    pathname === "/favicon.ico"
  );
}

function isLoginPagePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/status" ||
    pathname === "/health"
  );
}

function isPublicProxyPath(pathname: string): boolean {
  return pathname === "/api/proxy/video" || pathname.startsWith("/api/proxy/assets/");
}

function isApiKeyAuthPath(pathname: string): boolean {
  return pathname.startsWith("/v1/");
}

function withPath(raw: Request, path: string): Request {
  const url = new URL(raw.url);
  url.pathname = path;
  return new Request(url.toString(), raw);
}

function serveAsset(c: Context<{ Bindings: Env }>, path?: string) {
  if (!c.env.ASSETS) {
    return c.text("ASSETS binding is missing", 500);
  }
  const req = path ? withPath(c.req.raw, path) : c.req.raw;
  return c.env.ASSETS.fetch(req);
}

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.text("Internal Server Error", 500);
});

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  if (!isAuthRequired(c.env)) {
    return next();
  }

  if (isLoginPagePath(pathname) || isPublicAssetPath(pathname) || isPublicProxyPath(pathname)) {
    return next();
  }

  if (isApiKeyAuthPath(pathname)) {
    return next();
  }

  const hasAuth = hasAuthCookie(c.req.raw);
  if (!hasAuth) {
    if (pathname.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.redirect("/");
  }

  return next();
});

app.use("*", async (c, next) => {
  await next();
  const pathname = new URL(c.req.url).pathname.toLowerCase();
  c.header("x-grok-imagine-build", getBuildSha(c.env));

  if (pathname.endsWith(".html") || pathname.endsWith(".js") || pathname.endsWith(".css")) {
    c.header("cache-control", "no-store, no-cache, must-revalidate");
    c.header("pragma", "no-cache");
    c.header("expires", "0");
  }
});

app.route("/", authRoutes);
app.route("/", apiKeyRoutes);

app.use("/v1/*", apiAuthMiddleware);
app.route("/v1/chat", chatRoutes);
app.route("/v1/images", imagesRoutes);
app.route("/v1/videos", videosRoutes);
app.route("/v1/models", modelsRoutes);

app.route("/", tokenRoutes);
app.route("/", imagineRoutes);
app.route("/", proxyRoutes);

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    service: "Grok Imagine",
    runtime: "cloudflare-worker",
    build: { sha: getBuildSha(c.env) },
    auth_required: isAuthRequired(c.env),
    auth_configured: {
      username: !!c.env.AUTH_USERNAME,
      password: !!c.env.AUTH_PASSWORD,
    },
    bindings: {
      db: Boolean(c.env.DB),
      assets: Boolean(c.env.ASSETS),
    },
  })
);

app.get("/", (c) => serveAsset(c, "/index.html"));
app.get("/index.html", (c) => serveAsset(c, "/index.html"));
app.get("/app.html", (c) => serveAsset(c, "/app.html"));

// Fallback static assets (css/js/static files)
app.get("*", (c) => serveAsset(c));

export default app;
