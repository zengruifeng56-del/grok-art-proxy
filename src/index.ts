import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
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

// Check if authentication is required
function isAuthRequired(env: Env): boolean {
  return !!(env.AUTH_USERNAME && env.AUTH_PASSWORD);
}

// Check if path is for login page resources only
function isLoginPagePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/status" ||
    pathname === "/css/style.css" ||
    pathname === "/css/login.css" ||
    pathname === "/js/login.js" ||
    pathname === "/health"
  );
}

// Check if path is a public proxy path (video/image proxy for API consumers)
function isPublicProxyPath(pathname: string): boolean {
  return pathname === "/api/proxy/video" || pathname.startsWith("/api/proxy/assets/");
}

// Check if path uses API Key authentication (OpenAI compatible API)
function isApiKeyAuthPath(pathname: string): boolean {
  return pathname.startsWith("/v1/");
}

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.text("Internal Server Error", 500);
});

// Auth middleware - runs on ALL requests
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  // If auth not configured, allow all
  if (!isAuthRequired(c.env)) {
    return next();
  }

  // Allow login page resources without auth
  if (isLoginPagePath(pathname)) {
    return next();
  }

  // Allow public proxy paths without auth (they use token param for validation)
  if (isPublicProxyPath(pathname)) {
    return next();
  }

  // Skip cookie auth for API Key authenticated paths (handled by apiAuthMiddleware)
  if (isApiKeyAuthPath(pathname)) {
    return next();
  }

  // Check for auth cookie
  const hasAuth = hasAuthCookie(c.req.raw);

  if (!hasAuth) {
    // For API requests, return 401
    if (pathname.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // For ALL other requests (pages, static files), redirect to login
    return c.redirect("/");
  }

  return next();
});

// Unified response headers
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

// Mount auth routes (before other API routes)
app.route("/", authRoutes);

// Mount API Key management routes (protected by cookie auth)
app.route("/", apiKeyRoutes);

// Mount OpenAI compatible API routes (protected by API Key auth)
app.use("/v1/*", apiAuthMiddleware);
app.route("/v1/chat", chatRoutes);
app.route("/v1/images", imagesRoutes);
app.route("/v1/videos", videosRoutes);
app.route("/v1/models", modelsRoutes);

// Mount API routes
app.route("/", tokenRoutes);
app.route("/", imagineRoutes);
app.route("/", proxyRoutes);

// Health check
app.get("/health", (c) =>
  c.json({
    status: "healthy",
    service: "Grok Imagine",
    runtime: "node",
    build: { sha: getBuildSha(c.env) },
    auth_required: isAuthRequired(c.env),
    auth_configured: {
      username: !!c.env.AUTH_USERNAME,
      password: !!c.env.AUTH_PASSWORD,
    },
    bindings: {
      db: Boolean(c.env.DB),
    },
  })
);

// Root -> login page (public) - index.html is the login page
app.get("/", serveStatic({ path: "./static/index.html" }));
app.get("/index.html", serveStatic({ path: "./static/index.html" }));

// Main app (protected by middleware) - app.html is the main application
app.get("/app.html", serveStatic({ path: "./static/app.html" }));

// Static assets
app.use("/css/*", serveStatic({ root: "./static" }));
app.use("/js/*", serveStatic({ root: "./static" }));
app.use(
  "/static/*",
  serveStatic({
    root: "./static",
    rewriteRequestPath: (reqPath) => reqPath.replace(/^\/static/, ""),
  })
);

// 404 handler
app.notFound((c) => c.text("Not Found", 404));

export { app };
export default app;
