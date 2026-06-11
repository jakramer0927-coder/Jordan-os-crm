import { NextResponse } from "next/server";
import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

function cadenceDays(category: string, tier: string | null): number {
  const cat = (category || "").toLowerCase();
  const t = (tier || "").toUpperCase();
  if (cat === "client") return t === "A" ? 30 : t === "B" ? 60 : 90;
  if (cat === "sphere") return t === "A" ? 60 : t === "B" ? 90 : 120;
  if (cat === "agent") return t === "A" ? 30 : 60;
  if (cat === "developer" || cat === "vendor") return 60;
  return 60;
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function localDateStr(date: Date, tz = "America/Los_Angeles"): string {
  return date.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

function buildEmail(data: {
  streak: number;
  yesterdayCount: number;
  dailyTarget: number;
  overdueAClients: { name: string; days: number }[];
  overdueAgents: { name: string; days: number }[];
  topToday: { name: string; category: string; tier: string | null; days: number | null }[];
  missedDays: number;
  ceoReview?: string | null;
}): string {
  const { streak, yesterdayCount, dailyTarget, overdueAClients, overdueAgents, topToday, missedDays, ceoReview } = data;
  const catchUp = Math.max(0, dailyTarget - yesterdayCount);
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });

  const streakLine = streak >= 3
    ? `🔥 ${streak}-day streak — keep it going.`
    : streak === 0
      ? `⚠️ No active streak — let's get one started.`
      : `✅ ${streak}-day streak building.`;

  const yesterdayLine = yesterdayCount >= dailyTarget
    ? `Yesterday: ${yesterdayCount} touches — target hit ✓`
    : `Yesterday: ${yesterdayCount}/${dailyTarget} touches.${catchUp > 0 ? ` Add ${catchUp} extra today to catch up.` : ""}`;

  const aClientLines = overdueAClients.length > 0
    ? `\nOVERDUE A-CLIENTS (never miss):\n${overdueAClients.map((c) => `  • ${c.name} — ${c.days} days`).join("\n")}`
    : "";

  const agentLines = overdueAgents.length > 0
    ? `\nOVERDUE KEY AGENTS:\n${overdueAgents.slice(0, 4).map((c) => `  • ${c.name} — ${c.days} days`).join("\n")}`
    : "";

  const priorityLines = topToday.length > 0
    ? `\nTODAY'S TOP ${topToday.length}:\n${topToday.map((c, i) =>
        `  ${i + 1}. ${c.name}  [${c.category}${c.tier ? ` · ${c.tier}` : ""}]  ${c.days == null ? "never contacted" : `${c.days}d ago`}`
      ).join("\n")}`
    : "";

  const missedLine = missedDays > 0
    ? `\n⚠️  ${missedDays} weekday${missedDays !== 1 ? "s" : ""} missed in the last 2 weeks. Consistent daily outreach is the #1 driver of pipeline.`
    : "";

  return [
    `Jordan OS — Daily accountability`,
    `${today}`,
    ``,
    streakLine,
    yesterdayLine,
    missedLine,
    aClientLines,
    agentLines,
    priorityLines,
    ceoReview ? `\n${ceoReview}` : "",
    ``,
    `---`,
    `Open morning page: ${process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL}/morning`,
  ].filter((l) => l !== undefined).join("\n");
}

function makeRawEmail(to: string, from: string, subject: string, body: string): string {
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");
  return Buffer.from(msg).toString("base64url");
}

export async function GET(req: Request) {
  // Verify cron secret to prevent unauthorized triggers
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get all users with Google tokens (single-tenant for now)
    const { data: tokens } = await supabaseAdmin
      .from("google_tokens")
      .select("user_id, access_token, refresh_token, expiry_date, email");

    if (!tokens || tokens.length === 0) {
      return NextResponse.json({ ok: true, note: "No users with Google connected" });
    }

    const results = [];

    for (const tok of tokens as any[]) {
      const uid = tok.user_id as string;
      const userEmail = (tok.email || "") as string;
      if (!userEmail) { results.push({ uid, skipped: "no email" }); continue; }
      if (!tok.refresh_token) { results.push({ uid, skipped: "no refresh token" }); continue; }

      // --- Compute stats ---
      const now = new Date();
      const laToday = localDateStr(now);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const laYesterday = localDateStr(yesterday);

      // This user's contacts — fetched up front so every touch query below can
      // be scoped to them (touches has no user_id column of its own)
      const { data: contacts } = await supabaseAdmin
        .from("contacts")
        .select("id, display_name, category, tier")
        .eq("user_id", uid)
        .eq("archived", false)
        .limit(20000);

      const ownIds = new Set(((contacts ?? []) as any[]).map((c) => c.id));

      // Yesterday's outbound touches
      const yStart = new Date(`${laYesterday}T00:00:00-07:00`).toISOString();
      const yEnd   = new Date(`${laToday}T00:00:00-07:00`).toISOString();

      const { data: yTouches } = await supabaseAdmin
        .from("touches")
        .select("contact_id, occurred_at")
        .eq("direction", "outbound")
        .gte("occurred_at", yStart)
        .lt("occurred_at", yEnd)
        .limit(200);

      const yesterdayCount = new Set(
        (yTouches ?? []).filter((t: any) => ownIds.has(t.contact_id)).map((t: any) => t.contact_id)
      ).size;

      // Streak — count weekdays in last 30 days where distinct contacts touched >= 3
      const thirtyAgo = new Date(now);
      thirtyAgo.setDate(thirtyAgo.getDate() - 30);

      const { data: recentTouches } = await supabaseAdmin
        .from("touches")
        .select("contact_id, occurred_at")
        .eq("direction", "outbound")
        .gte("occurred_at", thirtyAgo.toISOString())
        .limit(2000);

      // Group by local date (own contacts only)
      const byDay = new Map<string, Set<string>>();
      for (const t of (recentTouches ?? []) as any[]) {
        if (!ownIds.has(t.contact_id)) continue;
        const d = localDateStr(new Date(t.occurred_at));
        if (!byDay.has(d)) byDay.set(d, new Set());
        byDay.get(d)!.add(t.contact_id);
      }

      // Walk backwards from yesterday to find streak
      const DAILY_TARGET = 3;
      let streak = 0;
      const check = new Date(yesterday);
      for (let i = 0; i < 30; i++) {
        const dow = check.getDay();
        const dStr = localDateStr(check);
        if (dow === 0 || dow === 6) { check.setDate(check.getDate() - 1); continue; } // skip weekends
        const count = byDay.get(dStr)?.size ?? 0;
        if (count >= DAILY_TARGET) streak++;
        else break;
        check.setDate(check.getDate() - 1);
      }

      // Missed weekdays in last 14 days
      let missedDays = 0;
      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      const walkDay = new Date(twoWeeksAgo);
      while (walkDay < yesterday) {
        const dow = walkDay.getDay();
        if (dow !== 0 && dow !== 6) {
          const dStr = localDateStr(walkDay);
          if ((byDay.get(dStr)?.size ?? 0) < DAILY_TARGET) missedDays++;
        }
        walkDay.setDate(walkDay.getDate() + 1);
      }

      // Overdue contacts — most recent outbound touch per contact. Without the
      // descending sort the map kept whichever row happened to arrive first,
      // which made overdue calculations use stale touch dates.
      const { data: lastTouches } = await supabaseAdmin
        .from("touches")
        .select("contact_id, occurred_at")
        .eq("direction", "outbound")
        .gte("occurred_at", new Date(Date.now() - 180 * 86400000).toISOString())
        .order("occurred_at", { ascending: false })
        .limit(3000);

      const lastTouchMap = new Map<string, string>();
      for (const t of (lastTouches ?? []) as any[]) {
        if (!ownIds.has(t.contact_id)) continue;
        if (!lastTouchMap.has(t.contact_id)) lastTouchMap.set(t.contact_id, t.occurred_at);
      }

      const overdueAClients: { name: string; days: number }[] = [];
      const overdueAgents: { name: string; days: number }[] = [];
      const scoredAll: { name: string; category: string; tier: string | null; days: number | null; score: number }[] = [];

      for (const c of (contacts ?? []) as any[]) {
        const lastIso = lastTouchMap.get(c.id) ?? null;
        const days = lastIso ? daysSince(lastIso) : null;
        const cadence = cadenceDays(c.category, c.tier);
        const overdue = days == null || days >= cadence;

        const cat = (c.category || "").toLowerCase();
        const tier = (c.tier || "").toUpperCase();

        if (overdue && cat === "client" && tier === "A") overdueAClients.push({ name: c.display_name, days: days ?? 999 });
        if (overdue && cat === "agent" && tier === "A") overdueAgents.push({ name: c.display_name, days: days ?? 999 });

        let score = 0;
        if (cat === "client" && tier === "A") score += 1000;
        if (overdue) score += 300;
        if (cat === "client") score += 80;
        if (cat === "sphere") score += 50;
        if (cat === "agent") score += 60;
        score += (days ?? cadence) * 2;

        scoredAll.push({ name: c.display_name, category: c.category, tier: c.tier, days, score });
      }

      scoredAll.sort((a, b) => b.score - a.score);
      const topToday = scoredAll.slice(0, 5);

      // ── Nightly rollup: upsert yesterday's daily_stats row ─────────────────
      // Classify each of yesterday's touched contacts by warmth using the full
      // 180-day touch history already fetched above.
      const touchesByContact = new Map<string, string[]>();
      for (const t of (lastTouches ?? []) as any[]) {
        if (!ownIds.has(t.contact_id)) continue;
        if (!touchesByContact.has(t.contact_id)) touchesByContact.set(t.contact_id, []);
        touchesByContact.get(t.contact_id)!.push(t.occurred_at); // already desc
      }

      const catById = new Map<string, string>();
      for (const c of (contacts ?? []) as any[]) catById.set(c.id, (c.category || "").toLowerCase());

      const yOwn = ((yTouches ?? []) as any[]).filter((t) => ownIds.has(t.contact_id));
      const yByContact = new Map<string, string>(); // contact -> earliest touch yesterday
      for (const t of yOwn) {
        const cur = yByContact.get(t.contact_id);
        if (!cur || t.occurred_at < cur) yByContact.set(t.contact_id, t.occurred_at);
      }

      let dormantTouches = 0;
      let newContactTouches = 0;
      for (const [cid, firstYesterday] of yByContact) {
        const prior = (touchesByContact.get(cid) ?? []).find((iso) => iso < firstYesterday);
        if (!prior) newContactTouches++;
        else if (new Date(firstYesterday).getTime() - new Date(prior).getTime() > 60 * 86400000) dormantTouches++;
      }

      const { count: notesYesterday } = await supabaseAdmin
        .from("interaction_notes")
        .select("id", { count: "exact", head: true })
        .gte("created_at", yStart)
        .lt("created_at", yEnd);

      await supabaseAdmin.from("daily_stats").upsert({
        user_id: uid,
        day: laYesterday,
        touches_outbound: yOwn.length,
        touches_outbound_agents: yOwn.filter((t) => catById.get(t.contact_id) === "agent").length,
        distinct_contacts: yByContact.size,
        referral_asks: 0, // intent not fetched in yTouches; recomputed below for CEO review
        dormant_touches: dormantTouches,
        new_contact_touches: newContactTouches,
        notes_logged: notesYesterday ?? 0,
      }, { onConflict: "user_id,day" });

      // ── Friday CEO review: score the week against the KPI model ────────────
      // Targets: 15 touches (10 warm / 3 dormant / 2 new), 5 referral asks,
      // 5 listing probes (proxy: selling-intent conversations), 1 upstream touch.
      let ceoReview: string | null = null;
      const laDow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).getDay();
      if (laDow === 5) {
        // Monday of the current LA week
        const monday = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
        const weekStartIso = new Date(`${localDateStr(monday)}T00:00:00-07:00`).toISOString();

        const [weekTouchesRes, weekNotesRes] = await Promise.all([
          supabaseAdmin
            .from("touches")
            .select("contact_id, occurred_at, intent")
            .eq("user_id", uid)
            .eq("direction", "outbound")
            .gte("occurred_at", weekStartIso)
            .limit(1000),
          supabaseAdmin
            .from("interaction_notes")
            .select("contact_id, transaction_intent")
            .gte("created_at", weekStartIso)
            .limit(500),
        ]);

        const wTouches = ((weekTouchesRes.data ?? []) as any[]).filter((t) => ownIds.has(t.contact_id));
        const wByContact = new Map<string, string>();
        for (const t of wTouches) {
          const cur = wByContact.get(t.contact_id);
          if (!cur || t.occurred_at < cur) wByContact.set(t.contact_id, t.occurred_at);
        }

        let wDormant = 0, wNew = 0;
        for (const [cid, first] of wByContact) {
          const prior = (touchesByContact.get(cid) ?? []).find((iso) => iso < first);
          if (!prior) wNew++;
          else if (new Date(first).getTime() - new Date(prior).getTime() > 60 * 86400000) wDormant++;
        }
        const wWarm = wByContact.size - wDormant - wNew;
        const wAsks = new Set(wTouches.filter((t) => t.intent === "referral_ask").map((t) => t.contact_id)).size;

        // Upstream: A-tier agents and developers (wealth managers aren't categorized yet)
        const upstreamIds = new Set(
          ((contacts ?? []) as any[])
            .filter((c) => {
              const cat = (c.category || "").toLowerCase();
              const tier = (c.tier || "").toUpperCase();
              return cat === "developer" || (cat === "agent" && tier === "A");
            })
            .map((c) => c.id)
        );
        const wUpstream = [...wByContact.keys()].filter((id) => upstreamIds.has(id)).length;

        const wProbes = new Set(
          ((weekNotesRes.data ?? []) as any[])
            .filter((n) => n.transaction_intent === "selling" && ownIds.has(n.contact_id))
            .map((n) => n.contact_id)
        ).size;

        const mark = (got: number, target: number) => `${got}/${target}${got >= target ? " ✓" : ""}`;
        ceoReview = [
          `══ FRIDAY CEO REVIEW (week so far) ══`,
          `Touches: ${mark(wByContact.size, 15)} distinct contacts`,
          `  warm ${mark(wWarm, 10)} · dormant>60d ${mark(wDormant, 3)} · new ${mark(wNew, 2)}`,
          `Referral asks: ${mark(wAsks, 5)}`,
          `Listing probes (selling-intent convos): ${mark(wProbes, 5)}`,
          `Upstream touches (A-agents/developers): ${mark(wUpstream, 1)}`,
        ].join("\n");
      }

      // Build and send email
      const body = buildEmail({
        streak,
        yesterdayCount,
        dailyTarget: DAILY_TARGET,
        overdueAClients: overdueAClients.sort((a, b) => b.days - a.days).slice(0, 5),
        overdueAgents: overdueAgents.sort((a, b) => b.days - a.days),
        topToday,
        missedDays,
        ceoReview,
      });

      const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
      const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()];
      const subject = isWeekday
        ? `${yesterdayCount >= DAILY_TARGET ? "✅" : "⚠️"} ${dow} check-in — ${streak > 0 ? `🔥 ${streak}d streak` : "streak at 0"} · ${overdueAClients.length} A-client${overdueAClients.length !== 1 ? "s" : ""} overdue`
        : `Weekend — ${overdueAClients.length} A-client${overdueAClients.length !== 1 ? "s" : ""} overdue`;

      // Send via Gmail API
      try {
        const oauth2 = getGoogleOAuthClient();
        oauth2.setCredentials({
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expiry_date: tok.expiry_date,
        });
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const raw = makeRawEmail(userEmail, userEmail, subject, body);
        await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
        results.push({ uid, sent: true, to: userEmail, streak, yesterdayCount, missedDays });
      } catch (sendErr: any) {
        results.push({ uid, sent: false, error: sendErr?.message, note: "Reconnect Google with gmail.send scope" });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    console.error("CRON_ACCOUNTABILITY_CRASH", e);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
