// ============================================================
// Warzone Services — Discord Server Structure Blueprint
// This is the "ideal" server layout the bot will create.
// ============================================================

export interface ChannelBlueprint {
  name: string;
  type: "text" | "voice" | "announcement" | "rules" | "stage";
  topic?: string;
}

export interface CategoryBlueprint {
  name: string;
  channels: ChannelBlueprint[];
}

export interface RoleBlueprint {
  name: string;
  color: string;
  permissions: string[]; // Discord permission flags (readable names)
  mentionable: boolean;
  hoist: boolean;
}

// ---- Roles (created in this order, top = highest) ----
export const ROLE_BLUEPRINTS: RoleBlueprint[] = [
  {
    name: "🔥 Owner",
    color: "#FF3B30",
    permissions: ["Administrator"],
    mentionable: false,
    hoist: true,
  },
  {
    name: "🛡️ Head Admin",
    color: "#FF9500",
    permissions: ["Administrator"],
    mentionable: false,
    hoist: true,
  },
  {
    name: "🛠️ Admin",
    color: "#FFCC00",
    permissions: ["ManageChannels", "ManageRoles", "KickMembers", "BanMembers", "ManageMessages"],
    mentionable: false,
    hoist: true,
  },
  {
    name: "🏆 Head Booster",
    color: "#34C759",
    permissions: ["ManageChannels", "ManageMessages", "MentionEveryone"],
    mentionable: true,
    hoist: true,
  },
  {
    name: "⚔️ Booster",
    color: "#30B0C0",
    permissions: ["SendMessages", "ManageMessages", "EmbedLinks", "AttachFiles"],
    mentionable: true,
    hoist: true,
  },
  {
    name: "🎯 Trial Booster",
    color: "#5856D6",
    permissions: ["SendMessages", "EmbedLinks"],
    mentionable: true,
    hoist: true,
  },
  {
    name: "💎 VIP",
    color: "#AF52DE",
    permissions: ["SendMessages", "EmbedLinks", "AttachFiles", "UseExternalEmojis"],
    mentionable: true,
    hoist: true,
  },
  {
    name: "📦 Customer",
    color: "#64D2FF",
    permissions: ["SendMessages", "ReadMessageHistory", "EmbedLinks"],
    mentionable: true,
    hoist: false,
  },
  {
    name: "Member",
    color: "#99AAB5",
    permissions: ["SendMessages", "ReadMessageHistory"],
    mentionable: false,
    hoist: false,
  },
];

// ---- Categories + Channels (top to bottom) ----
export const CATEGORY_BLUEPRINTS: CategoryBlueprint[] = [
  {
    name: "📢 INFORMATION",
    channels: [
      { name: "rules", type: "rules", topic: "Server rules — read before doing anything." },
      { name: "announcements", type: "announcement", topic: "Official Warzone Services announcements." },
      { name: "server-info", type: "text", topic: "Server info, pricing & FAQ." },
      { name: "boost-status", type: "text", topic: "Live boost progress board." },
    ],
  },
  {
    name: "🛒 BOOSTING SERVICES",
    channels: [
      { name: "rank-boosting", type: "text", topic: "Rank up — Iron to Top 500." },
      { name: "camo-unlocks", type: "text", topic: "Unlock gold, platinum, polyatomic & Orion camos." },
      { name: "account-unlocks", type: "text", topic: "Unlock operators, weapons, attachments." },
      { name: "challenge-completion", type: "text", topic: "Daily, weekly & seasonal challenges." },
      { name: "coaching", type: "text", topic: "1-on-1 coaching with pros." },
      { name: "accounts-shop", type: "text", topic: "Pre-built accounts for sale." },
    ],
  },
  {
    name: "🎫 SUPPORT",
    channels: [
      { name: "create-ticket", type: "text", topic: "Click to open a private support ticket." },
      { name: "faq", type: "text", topic: "Frequently asked questions." },
      { name: "open-tickets", type: "text", topic: "List of currently open tickets." },
    ],
  },
  {
    name: "💬 COMMUNITY",
    channels: [
      { name: "general", type: "text", topic: "General chat — keep it civil." },
      { name: "off-topic", type: "text", topic: "Anything goes (within rules)." },
      { name: "clips-and-highlights", type: "text", topic: "Share your best Warzone clips." },
      { name: "looking-for-group", type: "text", topic: "Find squadmates." },
      { name: "general-vc", type: "voice" },
      { name: "lounge-vc", type: "voice" },
    ],
  },
  {
    name: "🚀 BOOSTING LOBBIES",
    channels: [
      { name: "lobby-1", type: "voice" },
      { name: "lobby-2", type: "voice" },
      { name: "lobby-3", type: "voice" },
      { name: "lobby-4", type: "voice" },
      { name: "private-boost-vc", type: "voice" },
    ],
  },
  {
    name: "📊 STAFF ZONE",
    channels: [
      { name: "staff-chat", type: "text", topic: "Staff-only chat." },
      { name: "orders-board", type: "text", topic: "Live orders feed." },
      { name: "boosters-availability", type: "text", topic: "Booster online/offline status." },
      { name: "staff-vc", type: "voice" },
    ],
  },
  {
    name: "🔐 LOGS",
    channels: [
      { name: "order-logs", type: "text", topic: "All order events (created, assigned, completed)." },
      { name: "ticket-logs", type: "text", topic: "All ticket events." },
      { name: "member-logs", type: "text", topic: "Member join/leave/ban." },
      { name: "message-logs", type: "text", topic: "Deleted / edited messages." },
    ],
  },
];

export const SERVER_NAME = "Warzone Services";
export const SERVER_ICON_EMOJI = "🎯";
