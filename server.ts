import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { 
  Account, 
  AccountCreate, 
  AccountUpdate, 
  ClaudeRequest
} from "./types.ts";
import * as db from "./db.ts";
import * as auth from "./auth.ts";
import { convertClaudeToAmazonQRequest } from "./converter.ts";
import { sendChatRequest } from "./amazon_q.ts";
import { ClaudeStreamHandler } from "./stream_handler.ts";

const app = new Hono();

app.use("*", cors());

// --- Configuration ---
const ALLOWED_API_KEYS = (Deno.env.get("OPENAI_KEYS") || "")
  .split(",")
  .map(k => k.trim())
  .filter(k => k);

const MAX_ERROR_COUNT = parseInt(Deno.env.get("MAX_ERROR_COUNT") || "100");
const CONSOLE_ENABLED = (Deno.env.get("ENABLE_CONSOLE") || "true").toLowerCase() !== "false";

// --- Helpers ---

async function refreshAccessTokenInDb(accountId: string): Promise<Account> {
  const acc = await db.getAccount(accountId);
  if (!acc) throw new Error("Account not found");

  if (!acc.clientId || !acc.clientSecret || !acc.refreshToken) {
    throw new Error("Account missing credentials for refresh");
  }

  try {
    const data = await auth.refreshToken(acc.clientId, acc.clientSecret, acc.refreshToken);
    const newAccess = data.accessToken;
    const newRefresh = data.refreshToken || acc.refreshToken;
    
    await db.updateAccountTokens(accountId, newAccess, newRefresh, "success");
    
    const updated = await db.getAccount(accountId);
    return updated!;
  } catch (e: any) {
    await db.updateAccountRefreshStatus(accountId, "failed");
    throw e;
  }
}

async function resolveAccountForKey(bearerKey?: string): Promise<Account> {
  if (ALLOWED_API_KEYS.length > 0) {
    if (!bearerKey || !ALLOWED_API_KEYS.includes(bearerKey)) {
      throw new Error("Invalid or missing API key"); // 401
    }
  }

  const candidates = await db.listAccounts(true);
  if (candidates.length === 0) {
    throw new Error("No enabled account available"); // 401
  }
  
  // Random choice
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function extractBearer(authHeader?: string): string | undefined {
  if (!authHeader) return undefined;
  if (authHeader.startsWith("Bearer ")) return authHeader.substring(7).trim();
  return authHeader.trim();
}

// --- Background Tasks ---

async function refreshStaleTokens() {
  try {
    const accounts = await db.listAccounts(true);
    const now = Date.now() / 1000;
    
    for (const acc of accounts) {
      let shouldRefresh = false;
      if (!acc.last_refresh_time || acc.last_refresh_status === "never") {
        shouldRefresh = true;
      } else {
        try {
          const lastTime = new Date(acc.last_refresh_time).getTime() / 1000;
          if (now - lastTime > 1500) { // 25 mins
            shouldRefresh = true;
          }
        } catch {
          shouldRefresh = true;
        }
      }

      if (shouldRefresh) {
        try {
          await refreshAccessTokenInDb(acc.id);
          console.log(`Refreshed token for ${acc.id}`);
        } catch (e) {
          console.error(`Failed to refresh ${acc.id}:`, e);
        }
      }
    }
  } catch (e) {
    console.error("Error in refreshStaleTokens:", e);
  }
}

// Deno Cron (works in Deploy)
Deno.cron("Refresh Tokens", "*/5 * * * *", refreshStaleTokens);

// --- Routes ---

app.get("/healthz", (c) => c.json({ status: "ok" }));

// Frontend
app.get("/", serveStatic({ path: "./frontend/index.html" }));

// Account Management
if (CONSOLE_ENABLED) {
  app.get("/v2/accounts", async (c) => {
    const accounts = await db.listAccounts();
    return c.json(accounts);
  });

  app.post("/v2/accounts", async (c) => {
    const body = await c.req.json<AccountCreate>();
    const acc = await db.createAccount(body);
    return c.json(acc);
  });

  app.get("/v2/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const acc = await db.getAccount(id);
    if (!acc) return c.json({ error: "Not found" }, 404);
    return c.json(acc);
  });

  app.delete("/v2/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await db.deleteAccount(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: id });
  });

  app.patch("/v2/accounts/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<AccountUpdate>();
    const updated = await db.updateAccount(id, body);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  });

  app.post("/v2/accounts/:id/refresh", async (c) => {
    const id = c.req.param("id");
    try {
      const acc = await refreshAccessTokenInDb(id);
      return c.json(acc);
    } catch (e: any) {
      return c.json({ error: e.message }, 502);
    }
  });
}

// Device Auth Flow
const AUTH_SESSIONS = new Map<string, any>();

if (CONSOLE_ENABLED) {
  app.post("/v2/auth/start", async (c) => {
    const body = await c.req.json<{label?: string, enabled?: boolean}>();
    try {
        const [cid, csec] = await auth.registerClientMin();
        const dev = await auth.deviceAuthorize(cid, csec);
        
        const authId = crypto.randomUUID();
        const sess = {
            clientId: cid,
            clientSecret: csec,
            deviceCode: dev.deviceCode,
            interval: dev.interval || 1,
            expiresIn: dev.expiresIn || 600,
            verificationUriComplete: dev.verificationUriComplete,
            userCode: dev.userCode,
            startTime: Math.floor(Date.now() / 1000),
            label: body.label,
            enabled: body.enabled !== false,
            status: "pending",
            error: null,
            accountId: null
        };
        AUTH_SESSIONS.set(authId, sess);
        
        return c.json({
            authId,
            verificationUriComplete: sess.verificationUriComplete,
            userCode: sess.userCode,
            expiresIn: sess.expiresIn,
            interval: sess.interval
        });
    } catch (e: any) {
        return c.json({ error: e.message }, 502);
    }
  });

  app.get("/v2/auth/status/:authId", (c) => {
      const authId = c.req.param("authId");
      const sess = AUTH_SESSIONS.get(authId);
      if (!sess) return c.json({ error: "Not found" }, 404);
      
      const now = Math.floor(Date.now() / 1000);
      const deadline = sess.startTime + Math.min(sess.expiresIn, 300); // 5 min cap
      const remaining = Math.max(0, deadline - now);
      
      return c.json({
          status: sess.status,
          remaining,
          error: sess.error,
          accountId: sess.accountId
      });
  });

  app.post("/v2/auth/claim/:authId", async (c) => {
      const authId = c.req.param("authId");
      const sess = AUTH_SESSIONS.get(authId);
      if (!sess) return c.json({ error: "Not found" }, 404);
      
      if (["completed", "timeout", "error"].includes(sess.status)) {
          return c.json({
              status: sess.status,
              accountId: sess.accountId,
              error: sess.error
          });
      }
      
      try {
          const toks = await auth.pollTokenDeviceCode(
              sess.clientId,
              sess.clientSecret,
              sess.deviceCode,
              sess.interval,
              sess.expiresIn,
              300
          );
          
          const acc = await db.createAccount({
              clientId: sess.clientId,
              clientSecret: sess.clientSecret,
              accessToken: toks.accessToken,
              refreshToken: toks.refreshToken,
              label: sess.label,
              enabled: sess.enabled
          });
          
          sess.status = "completed";
          sess.accountId = acc.id;
          
          return c.json({
              status: "completed",
              account: acc
          });
      } catch (e: any) {
          if (e.message.includes("timeout")) {
              sess.status = "timeout";
              return c.json({ error: "Timeout" }, 408);
          } else {
              sess.status = "error";
              sess.error = e.message;
              return c.json({ error: e.message }, 502);
          }
      }
  });
}

// Chat API

app.post("/v1/messages", async (c) => {
    const req = await c.req.json<ClaudeRequest>();
    const authHeader = c.req.header("Authorization");
    const bearer = extractBearer(authHeader);
    
    let account: Account;
    try {
        account = await resolveAccountForKey(bearer);
    } catch (e: any) {
        return c.json({ error: e.message }, 401);
    }

    // Convert request
    const aqRequest = convertClaudeToAmazonQRequest(req);

    // Send upstream
    async function getStream(acc: Account) {
        let access = acc.accessToken;
        if (!access) {
            const refreshed = await refreshAccessTokenInDb(acc.id);
            access = refreshed.accessToken;
        }
        if (!access) throw new Error("Access token missing");
        
        return await sendChatRequest(access, aqRequest);
    }

    try {
        let result = await getStream(account);
        
        const stream = new ReadableStream({
            async start(controller) {
                const handler = new ClaudeStreamHandler(req.model, 0);
                const encoder = new TextEncoder();
                
                try {
                    for await (const [eventType, payload] of result.eventStream) {
                        for await (const sse of handler.handleEvent(eventType, payload)) {
                            controller.enqueue(encoder.encode(sse));
                        }
                    }
                    for await (const sse of handler.finish()) {
                        controller.enqueue(encoder.encode(sse));
                    }
                    await db.updateAccountStats(account.id, true, MAX_ERROR_COUNT);
                } catch (e) {
                    await db.updateAccountStats(account.id, false, MAX_ERROR_COUNT);
                    console.error("Stream error:", e);
                    controller.error(e);
                } finally {
                    controller.close();
                }
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            }
        });

    } catch (e: any) {
        await db.updateAccountStats(account.id, false, MAX_ERROR_COUNT);
        return c.json({ error: e.message }, 502);
    }
});

app.post("/v1/chat/completions", (c) => {
   return c.json({ error: "Not implemented in this Deno port yet. Use /v1/messages." }, 501);
});

Deno.serve(app.fetch);
