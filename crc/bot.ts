// ============================================================
// Warzone Services — Discord Bot
// Connects to Discord, auto-sets-up the server on /setup,
// mirrors tickets & orders to the website via the DB.
// ============================================================

import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  Events,
  type Guild,
  type TextChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  ROLE_BLUEPRINTS,
  CATEGORY_BLUEPRINTS,
  SERVER_NAME,
} from "./store-structure.js";

export interface BotState {
  ready: boolean;
  loggedIn: boolean;
  guilds: { id: string; name: string; memberCount: number }[];
  lastSetupAt: string | null;
  lastError: string | null;
  uptime: number;
}

export class WarzoneBot {
  client: Client | null = null;
  state: BotState = {
    ready: false,
    loggedIn: false,
    guilds: [],
    lastSetupAt: null,
    lastError: null,
    uptime: 0,
  };
  private startedAt = 0;
  private token: string | null = null;

  async start(token: string | null) {
    this.token = token;
    if (!token) {
      // Run in "demo" mode — no Discord connection, but HTTP API still works.
      console.log("[bot] No DISCORD_BOT_TOKEN set — running in DEMO mode.");
      this.state.ready = true;
      this.startedAt = Date.now();
      return;
    }
    try {
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      client.once(Events.ClientReady, (c) => {
        this.state.ready = true;
        this.state.loggedIn = true;
        this.startedAt = Date.now();
        console.log(`[bot] Logged in as ${c.user.tag}`);
        this.syncGuilds();
      });

      client.on(Events.GuildCreate, () => this.syncGuilds());
      client.on(Events.GuildDelete, () => this.syncGuilds());
      client.on(Events.InteractionCreate, (i) => this.handleInteraction(i));

      client.on(Events.GuildMemberAdd, async (member) => {
        const channel = member.guild.channels.cache.find(
          (c) => c.name === "general" && c.type === ChannelType.GuildText,
        ) as TextChannel | undefined;
        if (channel) {
          channel.send(
            `Welcome <@${member.id}> to **${SERVER_NAME}**! Head to <#create-ticket> to place an order.`,
          );
        }
        await member.roles.add(member.guild.roles.cache.find((r) => r.name === "Member") ?? []).catch(() => {});
      });

      await client.login(token);
      this.client = client;
    } catch (e: any) {
      console.error("[bot] Login failed:", e?.message);
      this.state.lastError = e?.message ?? "unknown error";
      // Fallback to demo mode so HTTP API keeps working.
      this.state.ready = true;
      this.startedAt = Date.now();
    }
  }

  private syncGuilds() {
    if (!this.client) return;
    this.state.guilds = this.client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
    }));
  }

  // ---- Setup the entire server structure ----
  async setupGuild(guildId: string): Promise<{
    ok: boolean;
    created: { roles: number; categories: number; channels: number };
    errors: string[];
  }> {
    const errors: string[] = [];
    const created = { roles: 0, categories: 0, channels: 0 };

    if (!this.client) {
      return { ok: false, created, errors: ["Bot not connected (demo mode)"] };
    }
    const guild = this.client.guilds.cache.get(guildId) as Guild | undefined;
    if (!guild) {
      return { ok: false, created, errors: [`Guild ${guildId} not found`] };
    }

    // 1. Roles (bottom-up so positions are correct)
    for (const blueprint of [...ROLE_BLUEPRINTS].reverse()) {
      try {
        const existing = guild.roles.cache.find((r) => r.name === blueprint.name);
        if (!existing) {
          const perms = blueprint.permissions.reduce((acc, p) => {
            const flag = (PermissionFlagsBits as any)[p];
            return flag ? acc | flag : acc;
          }, 0n);
          await guild.roles.create({
            name: blueprint.name,
            color: blueprint.color as any,
            permissions: perms,
            mentionable: blueprint.mentionable,
            hoist: blueprint.hoist,
            reason: "Warzone Services auto-setup",
          });
          created.roles++;
        }
      } catch (e: any) {
        errors.push(`Role ${blueprint.name}: ${e?.message}`);
      }
    }

    // 2. Categories + channels
    for (let i = 0; i < CATEGORY_BLUEPRINTS.length; i++) {
      const catBp = CATEGORY_BLUEPRINTS[i];
      try {
        let category = guild.channels.cache.find(
          (c) => c.name === catBp.name && c.type === ChannelType.GuildCategory,
        );
        if (!category) {
          category = await guild.channels.create({
            name: catBp.name,
            type: ChannelType.GuildCategory,
            position: i,
            reason: "Warzone Services auto-setup",
          });
          created.categories++;
        }
        for (let j = 0; j < catBp.channels.length; j++) {
          const chBp = catBp.channels[j];
          const exists = guild.channels.cache.find(
            (c) =>
              c.name === chBp.name &&
              c.parentId === (category as any).id,
          );
          if (!exists) {
            const typeMap: Record<string, ChannelType> = {
              text: ChannelType.GuildText,
              voice: ChannelType.GuildVoice,
              announcement: ChannelType.GuildAnnouncement,
              rules: ChannelType.GuildText,
              stage: ChannelType.GuildStageVoice,
            };
            await guild.channels.create({
              name: chBp.name,
              type: typeMap[chBp.type] ?? ChannelType.GuildText,
              parent: (category as any).id,
              topic: chBp.topic,
              position: j,
              reason: "Warzone Services auto-setup",
            });
            created.channels++;
          }
        }
      } catch (e: any) {
        errors.push(`Category ${catBp.name}: ${e?.message}`);
      }
    }

    // 3. Post welcome embed to #general
    try {
      const general = guild.channels.cache.find(
        (c) => c.name === "general" && c.type === ChannelType.GuildText,
      ) as TextChannel | undefined;
      if (general) {
        const embed = new EmbedBuilder()
          .setTitle(`${SERVER_NAME} — Server Ready`)
          .setDescription(
            "The server has been fully configured by the Warzone Services bot.\n\n" +
              "**What was set up:**\n" +
              `• ${created.roles} roles\n` +
              `• ${created.categories} categories\n` +
              `• ${created.channels} channels\n\n` +
              "Use `/ticket` to open a support ticket, or `/products` to browse boosting services.",
          )
          .setColor(0x34c759)
          .setTimestamp();
        await general.send({ embeds: [embed] });
      }
    } catch (e: any) {
      errors.push(`Welcome message: ${e?.message}`);
    }

    this.state.lastSetupAt = new Date().toISOString();
    return { ok: errors.length === 0, created, errors };
  }

  // ---- Slash command interaction handler ----
  private async handleInteraction(interaction: any) {
    if (!interaction.isChatInputCommand?.()) return;
    const i = interaction as ChatInputCommandInteraction;
    try {
      switch (i.commandName) {
        case "setup":
          return await this.cmdSetup(i);
        case "products":
          return await this.cmdProducts(i);
        case "ticket":
          return await this.cmdTicket(i);
        case "order":
          return await this.cmdOrder(i);
        case "help":
          return await this.cmdHelp(i);
        case "boost-status":
          return await this.cmdBoostStatus(i);
      }
    } catch (e: any) {
      console.error("[bot] Interaction error:", e?.message);
      if (!i.replied) await i.reply({ content: `Error: ${e?.message}`, ephemeral: true }).catch(() => {});
    }
  }

  private async cmdSetup(i: ChatInputCommandInteraction) {
    await i.reply({ content: "⚙️ Setting up server structure... this may take a few seconds.", ephemeral: true });
    const result = await this.setupGuild(i.guildId!);
    await i.followUp({
      content: `✅ Setup complete.\nRoles: ${result.created.roles}\nCategories: ${result.created.categories}\nChannels: ${result.created.channels}${result.errors.length ? `\n⚠️ Errors: ${result.errors.length}` : ""}`,
      ephemeral: true,
    });
  }

  private async cmdProducts(i: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle("🛒 Warzone Services — Products")
      .setColor(0x30b0c0)
      .addFields(
        { name: "🏆 Rank Boosting", value: "Iron → Top 500. From $5.", inline: true },
        { name: "🎯 Camo Unlocks", value: "Gold, Platinum, Polyatomic, Orion. From $3.", inline: true },
        { name: "🔓 Account Unlocks", value: "Operators, weapons, attachments. From $10.", inline: true },
        { name: "⚡ Challenges", value: "Daily, weekly, seasonal. From $2.", inline: true },
        { name: "🎓 Coaching", value: "1-on-1 with pros. $25/hour.", inline: true },
        { name: "📦 Accounts", value: "Pre-built accounts. From $30.", inline: true },
      )
      .setFooter({ text: "Open a ticket with /ticket to order." });
    await i.reply({ embeds: [embed] });
  }

  private async cmdTicket(i: ChatInputCommandInteraction) {
    const subject = i.options.getString("subject") ?? "General support";
    const guild = i.guild;
    if (!guild) return;
    const category = guild.channels.cache.find(
      (c) => c.name === "Support" && c.type === ChannelType.GuildCategory,
    );
    const member = i.member;
    const channel = await guild.channels.create({
      name: `ticket-${i.user.username}`.toLowerCase().slice(0, 30),
      type: ChannelType.GuildText,
      parent: category?.id,
      topic: `Ticket for ${i.user.tag} — ${subject}`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: guild.roles.cache.find((r) => r.name === "🛠️ Admin")?.id ?? "", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: guild.roles.cache.find((r) => r.name === "🏆 Head Booster")?.id ?? "", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
    const embed = new EmbedBuilder()
      .setTitle("🎫 Ticket Opened")
      .setDescription(`Hello <@${i.user.id}>, a staff member will be with you shortly.\n\n**Subject:** ${subject}\n\nUse \`/close\` to close this ticket.`)
      .setColor(0xffcc00)
      .setTimestamp();
    await (channel as TextChannel).send({ content: `<@${i.user.id}>`, embeds: [embed] });
    await i.reply({ content: `✅ Ticket created: <#${channel.id}>`, ephemeral: true });
  }

  private async cmdOrder(i: ChatInputCommandInteraction) {
    const service = i.options.getString("service") ?? "rank-boosting";
    const details = i.options.getString("details") ?? "";
    const embed = new EmbedBuilder()
      .setTitle("📦 New Order Request")
      .setDescription(`<@${i.user.id}> wants to order **${service}**.`)
      .addFields({ name: "Details", value: details || "—", inline: false })
      .setColor(0x30b0c0)
      .setTimestamp();
    const ordersBoard = i.guild?.channels.cache.find(
      (c) => c.name === "orders-board" && c.type === ChannelType.GuildText,
    ) as TextChannel | undefined;
    if (ordersBoard) {
      await ordersBoard.send({ content: `<@&${i.guild?.roles.cache.find((r) => r.name === "🏆 Head Booster")?.id}>`, embeds: [embed] });
    }
    await i.reply({ content: "✅ Order request posted to staff. A booster will claim it shortly.", ephemeral: true });
  }

  private async cmdHelp(i: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle("🎯 Warzone Services — Help")
      .setDescription(
        "**Commands:**\n" +
          "`/setup` — Configure the server (admin only)\n" +
          "`/products` — List boosting services\n" +
          "`/ticket` — Open a support ticket\n" +
          "`/order` — Submit an order request\n" +
          "`/boost-status` — View current boost status\n" +
          "`/help` — Show this message",
      )
      .setColor(0x34c759);
    await i.reply({ embeds: [embed], ephemeral: true });
  }

  private async cmdBoostStatus(i: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle("🚀 Boost Status")
      .setDescription("No active boosts at the moment.\nUse `/order` to place one!")
      .setColor(0xff9500);
    await i.reply({ embeds: [embed] });
  }

  // ---- Slash command definitions (for registration) ----
  getSlashCommands() {
    return [
      new SlashCommandBuilder().setName("setup").setDescription("Set up the entire server structure (admin only).").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      new SlashCommandBuilder().setName("products").setDescription("List all boosting services."),
      new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Open a private support ticket.")
        .addStringOption((o) => o.setName("subject").setDescription("What do you need help with?").setRequired(false)),
      new SlashCommandBuilder()
        .setName("order")
        .setDescription("Submit an order request.")
        .addStringOption((o) =>
          o.setName("service").setDescription("Which service?").setRequired(true)
            .addChoices(
              { name: "Rank Boosting", value: "rank-boosting" },
              { name: "Camo Unlocks", value: "camo-unlocks" },
              { name: "Account Unlocks", value: "account-unlocks" },
              { name: "Challenge Completion", value: "challenges" },
              { name: "Coaching", value: "coaching" },
              { name: "Accounts Shop", value: "accounts" },
            ),
        )
        .addStringOption((o) => o.setName("details").setDescription("Extra details (current rank, target, etc.)").setRequired(false)),
      new SlashCommandBuilder().setName("boost-status").setDescription("View current boost status."),
      new SlashCommandBuilder().setName("help").setDescription("Show help and command list."),
    ].map((c) => c.toJSON());
  }

  getState(): BotState {
    return { ...this.state, uptime: Date.now() - this.startedAt };
  }
}
