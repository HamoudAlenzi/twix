// ============================================================
// Warzone Services — Discord Bot Mini-Service
// Entry point. Runs the bot + an HTTP API on port 3001.
// The Next.js website talks to this service via:
//   /api/...?XTransformPort=3001
// ============================================================

import { WarzoneBot } from "./bot.js";

const PORT = 3001;
const bot = new WarzoneBot();

const token = process.env.DISCORD_BOT_TOKEN || null;
console.log("[bot] Starting Warzone Services bot...");
console.log("[bot] Token:", token ? "present (will attempt Discord login)" : "absent (DEMO mode)");
await bot.start(token);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ---- Health ----
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "warzone-discord-bot", port: PORT, time: new Date().toISOString() }, { headers: cors });
    }

    // ---- Bot state ----
    if (url.pathname === "/api/bot/state") {
      return Response.json(bot.getState(), { headers: cors });
    }

    // ---- Trigger setup ----
    if (url.pathname === "/api/bot/setup" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const guildId = body.guildId;
      if (!guildId) {
        return Response.json({ ok: false, error: "guildId required" }, { status: 400, headers: cors });
      }
      const result = await bot.setupGuild(guildId);
      return Response.json({ ok: result.ok, ...result }, { headers: cors });
    }

    // ---- Slash command registration (manual trigger) ----
    if (url.pathname === "/api/bot/register" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const guildId = body.guildId;
      if (!guildId || !bot.client) {
        return Response.json({ ok: false, error: "guildId required and bot must be connected" }, { status: 400, headers: cors });
      }
      try {
        const cmds = bot.getSlashCommands();
        await bot.client.rest.put(`/applications/${bot.client.user.id}/guilds/${guildId}/commands`, { body: cmds });
        return Response.json({ ok: true, registered: cmds.length }, { headers: cors });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message }, { status: 500, headers: cors });
      }
    }

    // ---- Send a message to a channel ----
    if (url.pathname === "/api/bot/message" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { guildId, channelName, content, embed } = body;
      if (!guildId || !channelName || !content) {
        return Response.json({ ok: false, error: "guildId, channelName, content required" }, { status: 400, headers: cors });
      }
      if (!bot.client) {
        return Response.json({ ok: false, error: "Bot not connected (demo mode)" }, { status: 400, headers: cors });
      }
      try {
        const guild = bot.client.guilds.cache.get(guildId);
        if (!guild) return Response.json({ ok: false, error: "Guild not found" }, { status: 404, headers: cors });
        const channel = guild.channels.cache.find((c) => c.name === channelName && c.type === 0);
        if (!channel || !channel.isTextBased?.()) return Response.json({ ok: false, error: "Channel not found" }, { status: 404, headers: cors });
        await (channel as any).send({ content, embeds: embed ? [embed] : undefined });
        return Response.json({ ok: true }, { headers: cors });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message }, { status: 500, headers: cors });
      }
    }

    // ---- Sync products to a Discord channel (post product embeds) ----
    if (url.pathname === "/api/bot/sync-products" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { guildId, channelName = "rank-boosting", products = [] } = body;
      if (!bot.client) {
        return Response.json({ ok: false, error: "Bot not connected (demo mode)" }, { status: 400, headers: cors });
      }
      try {
        const guild = bot.client.guilds.cache.get(guildId);
        if (!guild) return Response.json({ ok: false, error: "Guild not found" }, { status: 404, headers: cors });
        const channel = guild.channels.cache.find((c) => c.name === channelName && c.type === 0) as any;
        if (!channel) return Response.json({ ok: false, error: `Channel '${channelName}' not found` }, { status: 404, headers: cors });
        let posted = 0;
        for (const p of products) {
          const embed = {
            title: `${p.category === "RANK" ? "🏆" : p.category === "CAMO" ? "🎯" : p.category === "UNLOCK" ? "🔓" : p.category === "ACCOUNT" ? "📦" : p.category === "COACHING" ? "🎓" : "⚡"} ${p.name}`,
            description: p.description,
            color: 0x30b0c0,
            fields: [
              { name: "💰 Price", value: `$${p.basePrice}`, inline: true },
              { name: "🎮 Platform", value: p.platform, inline: true },
            ],
            footer: { text: `ID: ${p.id} • Use /order to purchase` },
          };
          await channel.send({ embeds: [embed] });
          posted++;
        }
        return Response.json({ ok: true, posted }, { headers: cors });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message }, { status: 500, headers: cors });
      }
    }

    return Response.json({ error: "Not found", path: url.pathname }, { status: 404, headers: cors });
  },
});

console.log(`[bot] HTTP API listening on http://localhost:${PORT}`);
export { server };
