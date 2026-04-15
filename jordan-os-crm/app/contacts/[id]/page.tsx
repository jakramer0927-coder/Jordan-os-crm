"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();
import VoiceDraftPanel from "./VoiceDraftPanel";

type TouchIntent =
  | "check_in"
  | "referral_ask"
  | "review_ask"
  | "deal_followup"
  | "collaboration"
  | "event_invite"
  | "other";

type Contact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  client_type: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  user_id?: string;
  buyer_budget_min: number | null;
  buyer_budget_max: number | null;
  buyer_target_areas: string | null;
  notes: string | null;
  ai_context: string | null;
  ai_context_updated_at: string | null;
  birthday: string | null;
  close_anniversary: string | null;
  move_in_date: string | null;
};

type DealStage = "lead" | "showing" | "offer_in" | "under_contract" | "closed_won" | "closed_lost";

const DEAL_STAGES: { value: DealStage; label: string }[] = [
  { value: "lead",           label: "Lead" },
  { value: "showing",        label: "Showing" },
  { value: "offer_in",       label: "Offer In" },
  { value: "under_contract", label: "Under Contract" },
  { value: "closed_won",     label: "Closed ✓" },
  { value: "closed_lost",    label: "Closed ✗" },
];

function stageColor(s: string): React.CSSProperties {
  if (s === "closed_won")     return { background: "rgba(11,107,42,.1)",   color: "#0b6b2a",           borderColor: "rgba(11,107,42,.25)" };
  if (s === "closed_lost")    return { background: "rgba(0,0,0,.05)",       color: "rgba(18,18,18,.4)", borderColor: "transparent" };
  if (s === "under_contract") return { background: "rgba(11,60,140,.08)",   color: "#1a3f8a",           borderColor: "rgba(11,60,140,.2)" };
  if (s === "offer_in")       return { background: "rgba(120,60,0,.08)",    color: "rgba(120,60,0,.9)", borderColor: "rgba(120,60,0,.2)" };
  return {};
}

type Deal = {
  id: string;
  address: string;
  role: string;
  status: string;
  price: number | null;
  close_date: string | null;
  notes: string | null;
  created_at: string;
  referral_source_contact_id: string | null;
  referral_source_name?: string | null;
};

type Touch = {
  id: string;
  contact_id: string;
  channel: "email" | "text" | "call" | "in_person" | "social_dm" | "other";
  direction: "outbound" | "inbound";
  occurred_at: string;
  intent: TouchIntent | null;
  summary: string | null;
  source: string | null;
  source_link: string | null;
};

function prettyCategory(c: string) {
  const s = (c || "").trim();
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function fmtDT(v: string) {
  try {
    return new Date(v).toLocaleString();
  } catch {
    return v;
  }
}

function dirPill(direction: Touch["direction"]) {
  const label = direction === "outbound" ? "Outbound" : "Inbound";
  const color = direction === "outbound" ? "#0b6b2a" : "#1a4fa0";
  return (
    <span style={{ color, fontWeight: 700 }}>{label}</span>
  );
}

function channelLabel(c: Touch["channel"]) {
  switch (c) {
    case "in_person":
      return "In person";
    case "social_dm":
      return "Social DM";
    default:
      return c;
  }
}

function TextThreadUploadPanel({ contactId }: { contactId: string }) {
  const [uid, setUid] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      if (!user) {
        window.location.href = "/login";
        return;
      }
      setUid(user.id);
    });
  }, []);

  async function upload() {
    setErr(null);
    setMsg(null);

    if (!uid) return setErr("Not signed in.");
    if (!raw.trim() || raw.trim().length < 20) return setErr("Paste a longer text thread.");
    setBusy(true);

    try {
      const res = await fetch("/api/text/imessage/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid,
          contact_id: contactId,
          title: title.trim() || null,
          raw_text: raw,
        }),
      });

      const j = await res.json();

      if (!res.ok) {
        setErr(j?.error || "Import failed");
      } else {
        setMsg(`Imported ✅ Messages inserted: ${j.inserted_messages ?? "?"}`);
        setTitle("");
        setRaw("");
      }
    } catch (e: any) {
      setErr(e?.message || "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section" style={{ marginTop: 18 }}>
      <div className="sectionTitleRow">
        <div className="sectionTitle">Upload text thread</div>
        <div className="sectionSub">
          Paste iMessage thread text → attach to this contact → improves Jordan Voice + keeps history.
        </div>
      </div>

      {(err || msg) ? (
        <div className={`alert ${err ? "alertError" : "alertOk"}`}>{err || msg}</div>
      ) : null}

      <div className="card cardPad stack">
        <div className="rowResponsiveBetween">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='Optional title (e.g., "Feb 2026 — renovation planning")'
            style={{ flex: 1, minWidth: 240 }}
          />
          <button className="btn btnPrimary btnFullMobile" onClick={upload} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>

        <textarea
          className="textarea"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={`Paste an iMessage thread here.\n\nExample:\nJordan: Hey — quick check-in...\nAli: Yeah, Bosch has a good one...`}
          style={{ minHeight: 220 }}
        />

        <div className="muted small">
          Tip: iPhone → Messages → open thread → select text → copy → paste here. Even if parsing isn’t perfect, the raw
          thread is saved.
        </div>
      </div>
    </div>
  );
}

type TouchFilter = "all" | "outbound" | "inbound";

function TouchHistory({ touches }: { touches: Touch[] }) {
  const [filter, setFilter] = useState<TouchFilter>("all");

  const filtered = filter === "all" ? touches : touches.filter((t) => t.direction === filter);
  const outboundCount = touches.filter((t) => t.direction === "outbound").length;
  const inboundCount = touches.filter((t) => t.direction === "inbound").length;

  return (
    <div className="card cardPad" style={{ marginTop: 18 }}>
      <div className="rowResponsiveBetween" style={{ marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 15 }}>
            Touch history <span className="subtle" style={{ fontWeight: 400 }}>({touches.length})</span>
          </div>
          <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
            {outboundCount} outbound · {inboundCount} inbound
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {(["all", "outbound", "inbound"] as TouchFilter[]).map((f) => (
            <button
              key={f}
              className="btn"
              style={{
                fontSize: 12,
                padding: "2px 10px",
                fontWeight: filter === f ? 900 : 400,
                background: filter === f ? "var(--ink)" : undefined,
                color: filter === f ? "var(--paper)" : undefined,
              }}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="stack">
        {filtered.length === 0 ? (
          <div className="subtle">No touches{filter !== "all" ? ` (${filter})` : ""} yet.</div>
        ) : (
          filtered.map((t) => (
            <div key={t.id} className="card cardPad">
              <div className="rowResponsiveBetween">
                <div style={{ fontWeight: 700 }}>
                  {dirPill(t.direction)}
                  <span style={{ color: "var(--ink)", fontWeight: 400 }}> · {channelLabel(t.channel)}</span>
                  {t.intent ? <span className="subtle"> · {t.intent}</span> : null}
                  {t.source ? <span className="subtle"> · {t.source}</span> : null}
                </div>
                <div className="subtle" style={{ flexShrink: 0 }}>{fmtDT(t.occurred_at)}</div>
              </div>

              {t.summary ? (
                <div style={{ marginTop: 8, whiteSpace: "pre-wrap", fontSize: 14 }}>{t.summary}</div>
              ) : null}

              {t.source_link ? (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <a href={t.source_link} target="_blank" rel="noreferrer" className="subtle">
                    open in {t.source ?? "source"} →
                  </a>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function ContactDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || "";

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uid, setUid] = useState<string | null>(null);

  const [contact, setContact] = useState<Contact | null>(null);
  const [touches, setTouches] = useState<Touch[]>([]);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [clientType, setClientType] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [birthday, setBirthday] = useState("");
  const [closeAnniversary, setCloseAnniversary] = useState("");
  const [moveInDate, setMoveInDate] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logDirection, setLogDirection] = useState<Touch["direction"]>("outbound");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logOccurredAt, setLogOccurredAt] = useState<string>("");
  const [logSummary, setLogSummary] = useState("");
  const [logSource, setLogSource] = useState("manual");
  const [logLink, setLogLink] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

  const [deleting, setDeleting] = useState(false);

  // Follow-ups
  type FollowUpLocal = { id: string; due_date: string; note: string | null; };
  const [followUps, setFollowUps] = useState<FollowUpLocal[]>([]);
  const [fuFormOpen, setFuFormOpen] = useState(false);
  const [fuDate, setFuDate] = useState("");
  const [fuNote, setFuNote] = useState("");
  const [fuSaving, setFuSaving] = useState(false);

  // linked contacts (household)
  type LinkedContact = { link_id: string; household_name: string | null; contact: { id: string; display_name: string; category: string; tier: string | null } };
  const [linkedContacts, setLinkedContacts] = useState<LinkedContact[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkQ, setLinkQ] = useState("");
  const [linkResults, setLinkResults] = useState<{ id: string; display_name: string; category: string; tier: string | null }[]>([]);
  const [linkHouseholdName, setLinkHouseholdName] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [distributeConfirm, setDistributeConfirm] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [distributeMsg, setDistributeMsg] = useState<string | null>(null);

  // deals
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [dealAddress, setDealAddress] = useState("");
  const [dealRole, setDealRole] = useState("buyer");
  const [dealStatus, setDealStatus] = useState<DealStage>("showing");
  const [dealPrice, setDealPrice] = useState("");
  const [dealCloseDate, setDealCloseDate] = useState("");
  const [dealNotes, setDealNotes] = useState("");
  const [dealRefSourceId, setDealRefSourceId] = useState("");
  const [dealRefSourceName, setDealRefSourceName] = useState("");
  const [dealRefQuery, setDealRefQuery] = useState("");
  const [dealRefResults, setDealRefResults] = useState<{ id: string; display_name: string; category: string }[]>([]);
  const [dealBusy, setDealBusy] = useState(false);
  const [dealErr, setDealErr] = useState<string | null>(null);

  // AI insights
  const [aiContext, setAiContext] = useState<string | null>(null);
  const [aiContextUpdatedAt, setAiContextUpdatedAt] = useState<string | null>(null);
  const [extractingContext, setExtractingContext] = useState(false);
  const [extractContextMsg, setExtractContextMsg] = useState<string | null>(null);

  // buyer profile
  const [buyerBudgetMin, setBuyerBudgetMin] = useState("");
  const [buyerBudgetMax, setBuyerBudgetMax] = useState("");
  const [buyerAreas, setBuyerAreas] = useState("");
  const [savingBuyer, setSavingBuyer] = useState(false);
  const [buyerMsg, setBuyerMsg] = useState<string | null>(null);

  const lastOutbound = useMemo(() => {
    const t = touches.find((x) => x.direction === "outbound");
    return t ? new Date(t.occurred_at) : null;
  }, [touches]);

  // UI state
  const [activeTab, setActiveTab] = useState<"draft" | "history">("draft");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  async function requireSession() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      window.location.href = "/login";
      return null;
    }
    return data.session;
  }

  async function fetchAll() {
    setError(null);

    const sess = await requireSession();
    if (!sess) return;

    const myUid = sess.user.id;
    setUid(myUid);

    // Contact (scoped to user_id if your table has it)
    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, email, phone, notes, created_at, user_id, buyer_budget_min, buyer_budget_max, buyer_target_areas, ai_context, ai_context_updated_at, birthday, close_anniversary, move_in_date")
      .eq("id", id)
      .eq("user_id", myUid)
      .single();

    if (cErr) {
      setError(`Contact fetch error: ${cErr.message}`);
      setContact(null);
      setTouches([]);
      return;
    }

    const c = cData as Contact;
    setContact(c);

    setName(c.display_name || "");
    setCategory(c.category || "Client");
    setTier(((c.tier || "A").toUpperCase() as any) || "A");
    setClientType(c.client_type || "");
    setEmail(c.email || "");
    setPhone(c.phone || "");
    setNotes(c.notes || "");
    setBuyerBudgetMin(c.buyer_budget_min != null ? String(c.buyer_budget_min) : "");
    setBuyerBudgetMax(c.buyer_budget_max != null ? String(c.buyer_budget_max) : "");
    setBuyerAreas(c.buyer_target_areas || "");
    setAiContext(c.ai_context ?? null);
    setAiContextUpdatedAt(c.ai_context_updated_at ?? null);
    setBirthday(c.birthday ?? "");
    setCloseAnniversary(c.close_anniversary ?? "");
    setMoveInDate(c.move_in_date ?? "");

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, intent, summary, source, source_link")
      .eq("contact_id", id)
      .order("occurred_at", { ascending: false })
      .limit(200);

    if (tErr) {
      setError((prev) => prev ?? `Touches fetch error: ${tErr.message}`);
      setTouches([]);
      return;
    }

    setTouches((tData ?? []) as Touch[]);

    // Load linked contacts
    const linksRes = await fetch(`/api/contacts/links?contact_id=${id}`);
    if (linksRes.ok) {
      const lj = await linksRes.json().catch(() => ({}));
      setLinkedContacts(lj.links ?? []);
    }

    // Load deals
    const fuRes = await fetch(`/api/follow-ups?contact_id=${id}`);
    if (fuRes.ok) {
      const fj = await fuRes.json().catch(() => ({}));
      setFollowUps((fj.follow_ups ?? []) as FollowUpLocal[]);
    }

    const dealsRes = await fetch(`/api/contacts/deals?contact_id=${id}&uid=${myUid}`);
    if (dealsRes.ok) {
      const dj = await dealsRes.json().catch(() => ({}));
      const rawDeals = (dj.deals ?? []) as any[];
      setDeals(rawDeals.map((d: any) => ({
        ...d,
        referral_source_name: (d.referral_source as any)?.display_name ?? null,
      })));
    }
  }

  async function saveContact() {
    if (!contact) return;
    setSavingContact(true);
    setError(null);

    const { error } = await supabase
      .from("contacts")
      .update({
        display_name: name.trim(),
        category,
        tier,
        client_type: clientType.trim() ? clientType.trim() : null,
        email: email.trim() ? email.trim().toLowerCase() : null,
        phone: phone.trim() ? phone.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        birthday: birthday || null,
        close_anniversary: closeAnniversary || null,
        move_in_date: moveInDate || null,
      })
      .eq("id", contact.id);

    if (error) {
      setSavingContact(false);
      setError(`Update contact error: ${error.message}`);
      return;
    }

    // Keep contact_emails table in sync with the primary email
    const newEmail = email.trim().toLowerCase();
    if (newEmail) {
      // Upsert into contact_emails so Gmail sync can match this address
      await supabase
        .from("contact_emails")
        .upsert({ contact_id: contact.id, email: newEmail }, { onConflict: "contact_id,email" });
    }

    setSavingContact(false);
    setEditing(false);
    await fetchAll();
  }

  function openLog() {
    setLogOpen(true);
    setLogChannel("text");
    setLogDirection("outbound");
    setLogIntent("check_in");
    setLogSummary("");
    setLogSource("manual");
    setLogLink("");
    setLogOccurredAt(new Date().toISOString().slice(0, 16)); // yyyy-mm-ddThh:mm
  }

  async function saveTouch() {
    if (!contact) return;
    setSavingTouch(true);
    setError(null);

    const occurred_at = logOccurredAt ? new Date(logOccurredAt).toISOString() : new Date().toISOString();

    const { error } = await supabase.from("touches").insert({
      contact_id: contact.id,
      channel: logChannel,
      direction: logDirection,
      intent: logIntent,
      occurred_at,
      summary: logSummary.trim() ? logSummary.trim() : null,
      source: logSource.trim() ? logSource.trim() : null,
      source_link: logLink.trim() ? logLink.trim() : null,
    });

    setSavingTouch(false);

    if (error) {
      setError(`Insert touch error: ${error.message}`);
      return;
    }

    setLogOpen(false);
    await fetchAll();
  }

  async function searchLinkContacts(q: string) {
    if (!uid || q.trim().length < 2) { setLinkResults([]); return; }
    const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({}));
    setLinkResults((j.results || []).filter((r: any) => r.id !== id && !linkedContacts.some((l: LinkedContact) => l.contact.id === r.id)));
  }

  async function addLink(targetId: string) {
    if (!uid) return;
    setLinkBusy(true);
    setLinkMsg(null);
    const res = await fetch("/api/contacts/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, contact_id_a: id, contact_id_b: targetId, household_name: linkHouseholdName.trim() || null }),
    });
    const j = await res.json().catch(() => ({}));
    setLinkBusy(false);
    if (!res.ok) { setLinkMsg(`Error: ${j?.error || "Failed"}`); return; }
    setLinkOpen(false); setLinkQ(""); setLinkResults([]); setLinkHouseholdName(""); setLinkMsg(null);
    await fetchAll();
  }

  async function removeLink(linkId: string) {
    setLinkBusy(true);
    const res = await fetch("/api/contacts/links", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link_id: linkId }),
    });
    setLinkBusy(false);
    if (res.ok) await fetchAll();
  }

  async function distributeToLinked() {
    if (!uid) return;
    setDistributing(true);
    setDistributeMsg(null);
    const res = await fetch("/api/contacts/distribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, group_contact_id: id }),
    });
    const j = await res.json().catch(() => ({}));
    setDistributing(false);
    if (!res.ok) { setDistributeMsg(`Error: ${j?.error || "Failed"}`); setDistributeConfirm(false); return; }
    setDistributeMsg(`Done — ${j.touches_copied} touches copied to ${j.distributed_to.join(" & ")}. This contact has been archived.`);
    setDistributeConfirm(false);
    await fetchAll();
  }

  function openNewDeal() {
    setEditingDeal(null);
    setDealAddress("");
    setDealRole("buyer");
    setDealStatus("showing");
    setDealPrice("");
    setDealCloseDate("");
    setDealNotes("");
    setDealRefSourceId("");
    setDealRefSourceName("");
    setDealRefQuery("");
    setDealRefResults([]);
    setDealErr(null);
    setDealFormOpen(true);
  }

  function openEditDeal(d: Deal) {
    setEditingDeal(d);
    setDealAddress(d.address);
    setDealRole(d.role);
    setDealStatus(d.status as DealStage);
    setDealPrice(d.price != null ? String(d.price) : "");
    setDealCloseDate(d.close_date ?? "");
    setDealNotes(d.notes ?? "");
    setDealRefSourceId(d.referral_source_contact_id ?? "");
    setDealRefSourceName(d.referral_source_name ?? "");
    setDealRefQuery(d.referral_source_name ?? "");
    setDealRefResults([]);
    setDealErr(null);
    setDealFormOpen(true);
  }

  async function searchRefSource(q: string) {
    setDealRefQuery(q);
    setDealRefSourceId("");
    setDealRefSourceName("");
    if (!q.trim() || q.trim().length < 2) { setDealRefResults([]); return; }
    const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({}));
    setDealRefResults(res.ok ? (j.results ?? []) : []);
  }

  async function saveDeal() {
    if (!uid || !contact) return;
    if (!dealAddress.trim()) { setDealErr("Address is required."); return; }
    setDealBusy(true);
    setDealErr(null);
    const res = await fetch("/api/contacts/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid,
        contact_id: contact.id,
        id: editingDeal?.id,
        address: dealAddress,
        role: dealRole,
        status: dealStatus,
        price: dealPrice ? Number(dealPrice.replace(/[^0-9.]/g, "")) : null,
        close_date: dealCloseDate || null,
        notes: dealNotes,
        referral_source_contact_id: dealRefSourceId || null,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setDealBusy(false);
    if (!res.ok) { setDealErr(j?.error || "Save failed"); return; }
    setDealFormOpen(false);
    await fetchAll();
  }

  async function deleteDeal(dealId: string) {
    if (!uid) return;
    setDealBusy(true);
    await fetch("/api/contacts/deals", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, id: dealId }),
    });
    setDealBusy(false);
    await fetchAll();
  }

  async function saveFollowUp() {
    if (!fuDate || !contact) return;
    setFuSaving(true);
    await fetch("/api/follow-ups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contact.id, due_date: fuDate, note: fuNote.trim() || null }),
    });
    setFuSaving(false);
    setFuFormOpen(false);
    setFuDate("");
    setFuNote("");
    await fetchAll();
  }

  async function completeFollowUp(fuId: string) {
    await fetch("/api/follow-ups", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: fuId }),
    });
    setFollowUps((prev) => prev.filter((f) => f.id !== fuId));
  }

  async function deleteFollowUp(fuId: string) {
    await fetch("/api/follow-ups", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: fuId }),
    });
    setFollowUps((prev) => prev.filter((f) => f.id !== fuId));
  }

  async function saveBuyerProfile() {
    if (!contact || !uid) return;
    setSavingBuyer(true);
    setBuyerMsg(null);
    const { error } = await supabase.from("contacts").update({
      buyer_budget_min: buyerBudgetMin ? Number(buyerBudgetMin.replace(/[^0-9]/g, "")) : null,
      buyer_budget_max: buyerBudgetMax ? Number(buyerBudgetMax.replace(/[^0-9]/g, "")) : null,
      buyer_target_areas: buyerAreas.trim() || null,
    }).eq("id", contact.id);
    setSavingBuyer(false);
    if (error) { setBuyerMsg(`Error: ${error.message}`); return; }
    setBuyerMsg("Saved.");
    await fetchAll();
  }

  async function deleteContact() {
    if (!contact || !uid) return;

    const ok = window.confirm(`Delete contact "${contact.display_name}"?\n\nThis will delete touches + imported texts too.`);
    if (!ok) return;

    setDeleting(true);
    setError(null);

    try {
      const res = await fetch("/api/contacts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, contact_id: contact.id }),
      });

      const j = await res.json();
      if (!res.ok) {
        setError(j?.error || "Delete failed");
        setDeleting(false);
        return;
      }

      window.location.href = "/contacts";
    } catch (e: any) {
      setError(e?.message || "Delete failed");
      setDeleting(false);
    }
  }

  async function extractContext() {
    if (!contact) return;
    setExtractingContext(true);
    setExtractContextMsg(null);
    try {
      const res = await fetch("/api/contacts/extract_context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id }),
      });
      const j = await res.json();
      if (!res.ok) {
        setExtractContextMsg(`Error: ${j?.error || "Extraction failed"}`);
      } else {
        setAiContext(j.ai_context ?? null);
        setAiContextUpdatedAt(new Date().toISOString());
        setExtractContextMsg(null);
      }
    } catch (e: any) {
      setExtractContextMsg(`Error: ${e?.message || "Extraction failed"}`);
    } finally {
      setExtractingContext(false);
    }
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const myUid = data.session?.user.id ?? null;

      if (!alive) return;

      if (!myUid) {
        window.location.href = "/login";
        return;
      }

      setReady(true);
      await fetchAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const myUid = session?.user.id ?? null;
      if (!myUid) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!ready) return <div className="card cardPad">Loading…</div>;

  if (!contact) {
    return (
      <div className="stack">
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Contact not found</div>
          {error ? <div className="alert alertError" style={{ marginTop: 10 }}>{error}</div> : null}
          <div style={{ marginTop: 12 }}>
            <a href="/contacts" style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>
              ← Back to Contacts
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Relationship health helpers
  const daysSinceOutbound = lastOutbound
    ? Math.floor((Date.now() - lastOutbound.getTime()) / 86400000)
    : null;
  const healthColor = daysSinceOutbound === null
    ? "#8a0000"
    : daysSinceOutbound <= 7 ? "#0b6b2a"
    : daysSinceOutbound <= 21 ? "#92610a"
    : daysSinceOutbound <= 45 ? "#c25a00"
    : "#8a0000";
  const healthLabel = daysSinceOutbound === null
    ? "Never reached out"
    : daysSinceOutbound === 0 ? "Touched today"
    : daysSinceOutbound === 1 ? "1 day ago"
    : `${daysSinceOutbound} days ago`;

  const activeDeals = deals.filter((d) => d.status !== "closed_won" && d.status !== "closed_lost");
  const closedDeals = deals.filter((d) => d.status === "closed_won" || d.status === "closed_lost");
  const overdueFollowUps = followUps.filter((f) => f.due_date < new Date().toISOString().slice(0, 10));

  // Milestone check helper
  function getMilestones() {
    const today = new Date();
    const milestones: { label: string; date: string; daysAway: number }[] = [];
    const checkRecurring = (dateStr: string | null, label: string) => {
      if (!dateStr) return;
      const d = new Date(dateStr);
      const thisYear = new Date(today.getFullYear(), d.getMonth(), d.getDate());
      const next = thisYear >= today ? thisYear : new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
      const days = Math.ceil((next.getTime() - today.getTime()) / 86400000);
      if (days <= 30) milestones.push({ label, date: next.toLocaleDateString("en-US", { month: "short", day: "numeric" }), daysAway: days });
    };
    checkRecurring(contact.birthday, "Birthday");
    checkRecurring(contact.close_anniversary, "Close anniversary");
    if (contact.move_in_date) {
      const d = new Date(contact.move_in_date);
      const days = Math.ceil((d.getTime() - today.getTime()) / 86400000);
      if (days >= 0 && days <= 30) milestones.push({ label: "Move-in", date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), daysAway: days });
    }
    return milestones;
  }
  const milestones = getMilestones();

  return (
    <div className="stack">
      {error ? <div className="alert alertError">{error}</div> : null}

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div className="card cardPad">
        {/* Back + name row */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <a href="/contacts" className="subtle" style={{ fontSize: 12, textDecoration: "none", display: "block", marginBottom: 6 }}>← Contacts</a>
            <h1 className="h1" style={{ margin: 0, lineHeight: 1.1 }}>{contact.display_name}</h1>

            {/* Badges */}
            <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
              <span className="badge" style={{ fontWeight: 700 }}>{prettyCategory(contact.category)}</span>
              {contact.tier && <span className="badge" style={{ fontWeight: 700 }}>Tier {contact.tier}</span>}
              {contact.client_type && <span className="badge" style={{ textTransform: "capitalize" }}>{contact.client_type.replace(/_/g, " ")}</span>}
              {/* Relationship health */}
              <span className="badge" style={{ color: healthColor, borderColor: `${healthColor}44`, fontWeight: 700, fontSize: 12 }}>
                <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: healthColor, marginRight: 5, verticalAlign: "middle" }} />
                {healthLabel}
              </span>
            </div>

            {/* Contact info */}
            {(contact.email || contact.phone) && (
              <div className="subtle" style={{ marginTop: 8, fontSize: 13 }}>
                {contact.email && <a href={`mailto:${contact.email}`} style={{ color: "inherit" }}>{contact.email}</a>}
                {contact.email && contact.phone && <span> · </span>}
                {contact.phone && <a href={`tel:${contact.phone}`} style={{ color: "inherit" }}>{contact.phone}</a>}
              </div>
            )}
          </div>

          {/* Primary actions */}
          <div className="row" style={{ flexShrink: 0, gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <button
              className="btn btnPrimary"
              onClick={() => { setActiveTab("draft"); document.getElementById("contact-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            >
              Draft message
            </button>
            <button className="btn" onClick={openLog}>Log touch</button>
            <button className="btn" onClick={() => setAdvancedOpen((v) => !v)} style={{ fontSize: 12 }}>
              {advancedOpen ? "Close ▲" : "Edit ▾"}
            </button>
          </div>
        </div>

        {/* Milestone banners */}
        {milestones.length > 0 && (
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap", gap: 6 }}>
            {milestones.map((m) => (
              <span key={m.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: "rgba(146,97,10,.09)", border: "1px solid rgba(146,97,10,.22)", fontSize: 13, fontWeight: 700, color: "#92610a" }}>
                🎯 {m.label}: {m.date}{m.daysAway === 0 ? " — today!" : m.daysAway === 1 ? " — tomorrow" : ` — ${m.daysAway}d`}
              </span>
            ))}
          </div>
        )}

        {/* Snapshot strip */}
        <div className="row" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,.07)", flexWrap: "wrap", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1 }}>{touches.length}</div>
            <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>touches</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1, color: activeDeals.length > 0 ? "#1a3f8a" : undefined }}>{activeDeals.length}</div>
            <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>active deals</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1, color: overdueFollowUps.length > 0 ? "#8a0000" : undefined }}>{followUps.length}</div>
            <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>{overdueFollowUps.length > 0 ? `${overdueFollowUps.length} overdue` : "follow-ups"}</div>
          </div>
          {linkedContacts.length > 0 && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1 }}>{linkedContacts.length}</div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>linked</div>
            </div>
          )}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1 }}>
              {Math.floor((Date.now() - new Date(contact.created_at).getTime()) / (86400000 * 30))}mo
            </div>
            <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>in CRM</div>
          </div>
        </div>
      </div>

      {/* ── EDIT PANEL (collapsed by default) ─────────────────────────────── */}
      {advancedOpen && (
        <div className="card cardPad stack">
          <div style={{ fontWeight: 900, fontSize: 15 }}>Edit contact</div>

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 240 }}>
              <div className="label">Name</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field" style={{ width: 220, minWidth: 180 }}>
              <div className="label">Category</div>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option>Client</option>
                <option>Agent</option>
                <option>Developer</option>
                <option>Vendor</option>
                <option>Sphere</option>
                <option>Other</option>
              </select>
            </div>
            <div className="field" style={{ width: 140 }}>
              <div className="label">Tier</div>
              <select className="select" value={tier} onChange={(e) => setTier(e.target.value as any)}>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </div>
          </div>

          <div className="field">
            <div className="label">Client Type (optional)</div>
            <input className="input" value={clientType} onChange={(e) => setClientType(e.target.value)} placeholder="buyer / seller / past_client / lead / landlord / tenant / sphere ..." />
          </div>

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <div className="label">Email (optional)</div>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Phone (optional)</div>
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(310) 555-0100" />
            </div>
          </div>

          <div className="field">
            <div className="label">Notes</div>
            <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context for AI drafts, relationship notes, key details…" style={{ minHeight: 80 }} />
          </div>

          <div style={{ fontWeight: 700, fontSize: 13 }}>Milestones</div>
          <div className="fieldGridMobile">
            <div className="field">
              <div className="label">Birthday</div>
              <input className="input" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
            </div>
            <div className="field">
              <div className="label">Close anniversary</div>
              <input className="input" type="date" value={closeAnniversary} onChange={(e) => setCloseAnniversary(e.target.value)} />
            </div>
            <div className="field">
              <div className="label">Move-in date</div>
              <input className="input" type="date" value={moveInDate} onChange={(e) => setMoveInDate(e.target.value)} />
            </div>
          </div>

          <div>
            <button className="btn btnPrimary" onClick={saveContact} disabled={savingContact}>
              {savingContact ? "Saving…" : "Save changes"}
            </button>
          </div>

          <div className="hr" />

          {/* Household */}
          <div style={{ fontWeight: 700, fontSize: 13 }}>Household / linked contacts</div>
          {linkedContacts.map((lc) => (
            <div key={lc.link_id} className="rowBetween" style={{ alignItems: "center", padding: "4px 0" }}>
              <div>
                <a href={`/contacts/${lc.contact.id}`} style={{ fontWeight: 700 }}>{lc.contact.display_name}</a>
                <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>{lc.contact.category}{lc.contact.tier ? ` · ${lc.contact.tier}` : ""}</span>
                {lc.household_name && <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>({lc.household_name})</span>}
              </div>
              <button className="btn" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => removeLink(lc.link_id)} disabled={linkBusy}>Unlink</button>
            </div>
          ))}
          <button className="btn" style={{ fontSize: 12, alignSelf: "flex-start" }} onClick={() => { setLinkOpen((v) => !v); setLinkQ(""); setLinkResults([]); setLinkMsg(null); }}>
            {linkOpen ? "Cancel" : linkedContacts.length > 0 ? "+ Add another" : "+ Link contact"}
          </button>
          {linkOpen && (
            <div className="stack" style={{ marginTop: 4 }}>
              <input className="input" value={linkQ} onChange={(e) => { setLinkQ(e.target.value); searchLinkContacts(e.target.value); }} placeholder="Type a name…" />
              {linkResults.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  {linkResults.map((r) => (
                    <div key={r.id} className="rowBetween" style={{ alignItems: "center" }}>
                      <span style={{ fontSize: 13 }}>{r.display_name} <span className="subtle">· {r.category}</span></span>
                      <button className="btn btnPrimary" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => addLink(r.id)} disabled={linkBusy}>Link</button>
                    </div>
                  ))}
                </div>
              )}
              <input className="input" value={linkHouseholdName} onChange={(e) => setLinkHouseholdName(e.target.value)} placeholder="Household name (optional)" />
            </div>
          )}
          {linkMsg && <div className="subtle" style={{ fontSize: 12, color: linkMsg.startsWith("Error") ? "#8a0000" : "#0b6b2a" }}>{linkMsg}</div>}
          {linkedContacts.length > 0 && (
            <div style={{ paddingTop: 8, borderTop: "1px solid rgba(0,0,0,.07)" }}>
              <div className="subtle" style={{ fontSize: 12, marginBottom: 6 }}>Copy all touches to each linked contact, then archive this one.</div>
              {distributeMsg ? (
                <div className="subtle" style={{ fontSize: 12, color: "#0b6b2a" }}>{distributeMsg}</div>
              ) : distributeConfirm ? (
                <div className="row">
                  <span className="subtle" style={{ fontSize: 12 }}>This archives this contact.</span>
                  <button className="btn btnPrimary" style={{ fontSize: 12 }} onClick={distributeToLinked} disabled={distributing}>{distributing ? "Working…" : "Confirm"}</button>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setDistributeConfirm(false)}>Cancel</button>
                </div>
              ) : (
                <button className="btn" style={{ fontSize: 12 }} onClick={() => setDistributeConfirm(true)}>Distribute & archive</button>
              )}
            </div>
          )}

          <div className="hr" />

          {/* Buyer profile */}
          {(contact.category || "").toLowerCase() === "client" && (() => {
            const ct = (contact.client_type || "").toLowerCase();
            if (ct.includes("past") || ct.includes("seller") || ct.includes("landlord")) return null;
            return (
              <>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Buyer profile</div>
                <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                  <div className="field" style={{ minWidth: 150 }}>
                    <div className="label">Min budget</div>
                    <input className="input" value={buyerBudgetMin} onChange={e => setBuyerBudgetMin(e.target.value)} placeholder="800,000" />
                  </div>
                  <div className="field" style={{ minWidth: 150 }}>
                    <div className="label">Max budget</div>
                    <input className="input" value={buyerBudgetMax} onChange={e => setBuyerBudgetMax(e.target.value)} placeholder="1,500,000" />
                  </div>
                  <div className="field" style={{ flex: 1, minWidth: 220 }}>
                    <div className="label">Target areas</div>
                    <input className="input" value={buyerAreas} onChange={e => setBuyerAreas(e.target.value)} placeholder="Silver Lake, Los Feliz, Echo Park" />
                  </div>
                </div>
                <div className="row" style={{ alignItems: "center", gap: 10 }}>
                  <button className="btn" style={{ fontSize: 12 }} onClick={saveBuyerProfile} disabled={savingBuyer}>
                    {savingBuyer ? "Saving…" : "Save buyer profile"}
                  </button>
                  {buyerMsg && <span style={{ fontSize: 12, color: buyerMsg.startsWith("Error") ? "#8a0000" : "#0b6b2a", fontWeight: 700 }}>{buyerMsg}</span>}
                </div>
                <div className="hr" />
              </>
            );
          })()}

          {/* Text thread upload */}
          <div style={{ fontWeight: 700, fontSize: 13 }}>Upload text thread</div>
          <div className="subtle" style={{ fontSize: 12 }}>Paste iMessage thread → attach to this contact → improves AI drafts.</div>
          <TextThreadUploadPanel contactId={contact.id} />

          <div className="hr" />

          {/* Danger zone */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#8a0000", marginBottom: 6 }}>Danger zone</div>
            <button className="btn" style={{ fontSize: 12, color: "#8a0000", borderColor: "rgba(200,0,0,.25)" }} onClick={deleteContact} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete contact"}
            </button>
          </div>
        </div>
      )}

      {/* ── AI CONTEXT ─────────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div className="rowBetween" style={{ alignItems: "flex-start", marginBottom: aiContext || contact.notes ? 12 : 0 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>Relationship intelligence</div>
            {aiContextUpdatedAt && (
              <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
                Updated {new Date(aiContextUpdatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </div>
            )}
          </div>
          <button className="btn" style={{ fontSize: 12, padding: "2px 10px", flexShrink: 0 }} onClick={extractContext} disabled={extractingContext}>
            {extractingContext ? "Extracting…" : aiContext ? "Refresh" : "Extract"}
          </button>
        </div>
        {extractContextMsg && (
          <div className={`alert ${extractContextMsg.startsWith("Error") ? "alertError" : "alertOk"}`} style={{ fontSize: 13, marginBottom: 10 }}>
            {extractContextMsg}
          </div>
        )}
        {contact.notes && (
          <div style={{ fontSize: 13, color: "rgba(18,18,18,.6)", marginBottom: aiContext ? 12 : 0, paddingBottom: aiContext ? 12 : 0, borderBottom: aiContext ? "1px solid rgba(0,0,0,.07)" : undefined, whiteSpace: "pre-wrap" }}>
            {contact.notes}
          </div>
        )}
        {aiContext ? (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.65 }}>{aiContext}</div>
        ) : (
          <div className="subtle" style={{ fontSize: 13 }}>
            No AI context yet — import text threads or add touch summaries, then click Extract.
          </div>
        )}
      </div>

      {/* ── ACTIVE DEALS ───────────────────────────────────────────────────── */}
      <div className="card cardPad stack">
        <div className="rowBetween" style={{ alignItems: "center" }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>
            Deals
            {activeDeals.length > 0 && <span className="subtle" style={{ fontWeight: 400, fontSize: 13, marginLeft: 6 }}>{activeDeals.length} active</span>}
          </div>
          <button className="btn" style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => dealFormOpen ? setDealFormOpen(false) : openNewDeal()}>
            {dealFormOpen && !editingDeal ? "Cancel" : "+ Add deal"}
          </button>
        </div>

        {dealErr && <div className="alert alertError" style={{ fontSize: 13 }}>{dealErr}</div>}

        {/* Inline form */}
        {dealFormOpen && (
          <div className="stack" style={{ paddingTop: 12, borderTop: "1px solid rgba(0,0,0,.08)" }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>{editingDeal ? "Edit deal" : "New deal"}</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <div className="label">Address</div>
                <input className="input" value={dealAddress} onChange={e => setDealAddress(e.target.value)} placeholder="123 Main St, City, CA 90210" autoFocus />
              </div>
              <div className="field" style={{ minWidth: 130 }}>
                <div className="label">Role</div>
                <select className="select" value={dealRole} onChange={e => setDealRole(e.target.value)}>
                  <option value="buyer">Buyer</option>
                  <option value="seller">Seller</option>
                  <option value="landlord">Landlord</option>
                  <option value="tenant">Tenant</option>
                </select>
              </div>
              <div className="field" style={{ minWidth: 160 }}>
                <div className="label">Stage</div>
                <select className="select" value={dealStatus} onChange={e => setDealStatus(e.target.value as DealStage)}>
                  {DEAL_STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <div className="field" style={{ minWidth: 160 }}>
                <div className="label">Price (optional)</div>
                <input className="input" value={dealPrice} onChange={e => setDealPrice(e.target.value)} placeholder="1,250,000" />
              </div>
              <div className="field" style={{ minWidth: 160 }}>
                <div className="label">Close date (optional)</div>
                <input className="input" type="date" value={dealCloseDate} onChange={e => setDealCloseDate(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <div className="label">Referral source (optional)</div>
              <input
                className="input"
                value={dealRefQuery}
                onChange={e => searchRefSource(e.target.value)}
                placeholder="Search contacts…"
              />
              {dealRefResults.length > 0 && (
                <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                  {dealRefResults.slice(0, 5).map(c => (
                    <button
                      key={c.id}
                      className="btn"
                      style={{ borderRadius: 0, textAlign: "left", justifyContent: "flex-start", fontSize: 13 }}
                      onClick={() => { setDealRefSourceId(c.id); setDealRefSourceName(c.display_name); setDealRefQuery(c.display_name); setDealRefResults([]); }}
                    >
                      {c.display_name} <span style={{ color: "rgba(18,18,18,.4)", marginLeft: 6 }}>{c.category}</span>
                    </button>
                  ))}
                </div>
              )}
              {dealRefSourceId && (
                <div style={{ marginTop: 4, fontSize: 12, color: "rgba(18,18,18,.5)" }}>
                  Linked: <strong>{dealRefSourceName}</strong>
                  <button style={{ marginLeft: 8, fontSize: 11, color: "#8a0000", background: "none", border: "none", cursor: "pointer" }} onClick={() => { setDealRefSourceId(""); setDealRefSourceName(""); setDealRefQuery(""); }}>remove</button>
                </div>
              )}
            </div>
            <div className="field">
              <div className="label">Notes (optional)</div>
              <textarea className="textarea" value={dealNotes} onChange={e => setDealNotes(e.target.value)} placeholder="Any notes about this transaction…" style={{ minHeight: 70 }} />
            </div>
            <div className="row">
              <button className="btn btnPrimary" onClick={saveDeal} disabled={dealBusy}>{dealBusy ? "Saving…" : "Save"}</button>
              <button className="btn" onClick={() => setDealFormOpen(false)} disabled={dealBusy}>Cancel</button>
            </div>
          </div>
        )}

        {/* Deal form */}
        {dealFormOpen && (
          <div className="stack" style={{ paddingTop: 12, borderTop: "1px solid rgba(0,0,0,.08)" }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>{editingDeal ? "Edit deal" : "New deal"}</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <div className="label">Address</div>
                <input className="input" value={dealAddress} onChange={e => setDealAddress(e.target.value)} placeholder="123 Main St, City, CA 90210" autoFocus />
              </div>
              <div className="field" style={{ minWidth: 130 }}>
                <div className="label">Role</div>
                <select className="select" value={dealRole} onChange={e => setDealRole(e.target.value)}>
                  <option value="buyer">Buyer</option>
                  <option value="seller">Seller</option>
                  <option value="landlord">Landlord</option>
                  <option value="tenant">Tenant</option>
                </select>
              </div>
              <div className="field" style={{ minWidth: 160 }}>
                <div className="label">Stage</div>
                <select className="select" value={dealStatus} onChange={e => setDealStatus(e.target.value as DealStage)}>
                  {DEAL_STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <div className="field" style={{ minWidth: 160 }}>
                <div className="label">Price (optional)</div>
                <input className="input" value={dealPrice} onChange={e => setDealPrice(e.target.value)} placeholder="1,250,000" />
              </div>
              <div className="field" style={{ minWidth: 160 }}>
                <div className="label">Close date (optional)</div>
                <input className="input" type="date" value={dealCloseDate} onChange={e => setDealCloseDate(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <div className="label">Referral source (optional)</div>
              <input className="input" value={dealRefQuery} onChange={e => searchRefSource(e.target.value)} placeholder="Search contacts…" />
              {dealRefResults.length > 0 && (
                <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                  {dealRefResults.slice(0, 5).map(c => (
                    <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", justifyContent: "flex-start", fontSize: 13 }}
                      onClick={() => { setDealRefSourceId(c.id); setDealRefSourceName(c.display_name); setDealRefQuery(c.display_name); setDealRefResults([]); }}>
                      {c.display_name} <span style={{ color: "rgba(18,18,18,.4)", marginLeft: 6 }}>{c.category}</span>
                    </button>
                  ))}
                </div>
              )}
              {dealRefSourceId && (
                <div style={{ marginTop: 4, fontSize: 12, color: "rgba(18,18,18,.5)" }}>
                  Linked: <strong>{dealRefSourceName}</strong>
                  <button style={{ marginLeft: 8, fontSize: 11, color: "#8a0000", background: "none", border: "none", cursor: "pointer" }} onClick={() => { setDealRefSourceId(""); setDealRefSourceName(""); setDealRefQuery(""); }}>remove</button>
                </div>
              )}
            </div>
            <div className="field">
              <div className="label">Notes (optional)</div>
              <textarea className="textarea" value={dealNotes} onChange={e => setDealNotes(e.target.value)} placeholder="Any notes about this transaction…" style={{ minHeight: 70 }} />
            </div>
            <div className="row">
              <button className="btn btnPrimary" onClick={saveDeal} disabled={dealBusy}>{dealBusy ? "Saving…" : "Save"}</button>
              <button className="btn" onClick={() => setDealFormOpen(false)} disabled={dealBusy}>Cancel</button>
            </div>
          </div>
        )}

        {/* Active deals */}
        {activeDeals.length > 0 && (
          <div className="stack" style={{ gap: 0 }}>
            {activeDeals.map((d, i) => (
              <div key={d.id} style={{ padding: "10px 0", borderBottom: i < activeDeals.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined }}>
                <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, wordBreak: "break-word" }}>{d.address}</div>
                    <div className="row" style={{ marginTop: 5, flexWrap: "wrap", gap: 4 }}>
                      <span className="badge" style={{ textTransform: "capitalize" }}>{d.role}</span>
                      <span className="badge" style={{ textTransform: "capitalize", ...stageColor(d.status) }}>
                        {DEAL_STAGES.find(s => s.value === d.status)?.label ?? d.status}
                      </span>
                      {d.price != null && <span className="badge">${Number(d.price).toLocaleString()}</span>}
                      {d.close_date && <span className="badge">Close {new Date(d.close_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>}
                      {d.referral_source_name && <span className="badge">Ref: {d.referral_source_name}</span>}
                    </div>
                    {d.notes && <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>{d.notes}</div>}
                  </div>
                  <div className="row" style={{ flexShrink: 0, gap: 4 }}>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openEditDeal(d)} disabled={dealBusy}>Edit</button>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => deleteDeal(d.id)} disabled={dealBusy}>Remove</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Closed deals — collapsed */}
        {closedDeals.length > 0 && (
          <details style={{ marginTop: activeDeals.length > 0 ? 8 : 0 }}>
            <summary className="subtle" style={{ fontSize: 12, cursor: "pointer", userSelect: "none" }}>
              {closedDeals.length} closed deal{closedDeals.length !== 1 ? "s" : ""}
            </summary>
            <div className="stack" style={{ gap: 0, marginTop: 6 }}>
              {closedDeals.map((d, i) => (
                <div key={d.id} style={{ padding: "8px 0", borderBottom: i < closedDeals.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined }}>
                  <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, wordBreak: "break-word" }}>{d.address}</div>
                      <div className="row" style={{ marginTop: 4, flexWrap: "wrap", gap: 4 }}>
                        <span className="badge" style={{ textTransform: "capitalize" }}>{d.role}</span>
                        <span className="badge" style={{ textTransform: "capitalize", ...stageColor(d.status) }}>
                          {DEAL_STAGES.find(s => s.value === d.status)?.label ?? d.status}
                        </span>
                        {d.price != null && <span className="badge">${Number(d.price).toLocaleString()}</span>}
                        {d.close_date && <span className="badge">{new Date(d.close_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>}
                      </div>
                    </div>
                    <div className="row" style={{ flexShrink: 0, gap: 4 }}>
                      <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openEditDeal(d)} disabled={dealBusy}>Edit</button>
                      <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => deleteDeal(d.id)} disabled={dealBusy}>Remove</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        {deals.length === 0 && !dealFormOpen && (
          <div className="subtle" style={{ fontSize: 13 }}>No deals yet.</div>
        )}
      </div>

      {/* ── FOLLOW-UPS ─────────────────────────────────────────────────────── */}
      <div className="card cardPad stack">
        <div className="rowBetween" style={{ alignItems: "center" }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>
            Follow-ups
            {overdueFollowUps.length > 0 && (
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: "#8a0000", background: "rgba(200,0,0,.08)", border: "1px solid rgba(200,0,0,.2)", borderRadius: 4, padding: "1px 6px" }}>
                {overdueFollowUps.length} overdue
              </span>
            )}
          </div>
          <button className="btn" style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => setFuFormOpen((v) => !v)}>
            {fuFormOpen ? "Cancel" : "+ Add"}
          </button>
        </div>

        {fuFormOpen && (
          <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end", paddingTop: 10, borderTop: "1px solid rgba(0,0,0,.07)" }}>
            <div className="field">
              <div className="label">Follow up on</div>
              <input className="input" type="date" value={fuDate} onChange={(e) => setFuDate(e.target.value)} autoFocus />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <div className="label">Context (optional)</div>
              <input className="input" value={fuNote} onChange={(e) => setFuNote(e.target.value)} placeholder="e.g. Check if they decided on the listing" />
            </div>
            <button className="btn btnPrimary" onClick={saveFollowUp} disabled={fuSaving || !fuDate}>
              {fuSaving ? "Saving…" : "Save"}
            </button>
          </div>
        )}

        {followUps.length > 0 ? (
          <div className="stack" style={{ gap: 0 }}>
            {followUps.map((f, i) => {
              const today = new Date().toISOString().slice(0, 10);
              const overdue = f.due_date < today;
              return (
                <div key={f.id} style={{ padding: "9px 0", borderBottom: i < followUps.length - 1 ? "1px solid rgba(0,0,0,.05)" : undefined, display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: overdue ? "#8a0000" : undefined }}>
                      {overdue ? "Overdue · " : ""}{f.due_date}
                    </span>
                    {f.note && <span className="subtle" style={{ fontSize: 13, marginLeft: 8 }}>{f.note}</span>}
                  </div>
                  <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => completeFollowUp(f.id)}>Done ✓</button>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px", color: "rgba(18,18,18,.4)" }} onClick={() => deleteFollowUp(f.id)}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          !fuFormOpen && <div className="subtle" style={{ fontSize: 13 }}>No reminders set.</div>
        )}
      </div>

      {/* ── DRAFT + HISTORY TABS ───────────────────────────────────────────── */}
      <div className="card cardPad" id="contact-tabs">
        {/* Tab bar */}
        <div className="row" style={{ gap: 0, marginBottom: 16, borderBottom: "2px solid rgba(0,0,0,.08)" }}>
          {([["draft", "Draft message"], ["history", `History (${touches.length})`]] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === tab ? "2px solid var(--ink)" : "2px solid transparent",
                marginBottom: -2,
                padding: "6px 16px 10px",
                fontWeight: activeTab === tab ? 900 : 500,
                fontSize: 14,
                cursor: "pointer",
                color: activeTab === tab ? "var(--ink)" : "rgba(18,18,18,.45)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === "draft" && <VoiceDraftPanel contactId={contact.id} />}
        {activeTab === "history" && <TouchHistory touches={touches} />}
      </div>

      {/* Log touch modal (kept functional but less noisy text) */}
      {logOpen && (
        <div
          className="modalSheet"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
            zIndex: 999,
          }}
        >
          <div className="card cardPad modalSheetCard" style={{ width: "min(860px, 100%)" }}>
            <div className="rowResponsiveBetween">
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log touch</div>
                <div className="subtle" style={{ marginTop: 4 }}>{contact.display_name}</div>
              </div>
              <button className="btn btnFullMobile" onClick={() => setLogOpen(false)}>
                Close
              </button>
            </div>

            <div className="rowResponsive" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <div className="field" style={{ width: 160, minWidth: 160 }}>
                <div className="label">Direction</div>
                <select className="select" value={logDirection} onChange={(e) => setLogDirection(e.target.value as any)}>
                  <option value="outbound">outbound</option>
                  <option value="inbound">inbound</option>
                </select>
              </div>

              <div className="field" style={{ width: 160, minWidth: 160 }}>
                <div className="label">Channel</div>
                <select className="select" value={logChannel} onChange={(e) => setLogChannel(e.target.value as any)}>
                  <option value="email">email</option>
                  <option value="text">text</option>
                  <option value="call">call</option>
                  <option value="in_person">in_person</option>
                  <option value="social_dm">social_dm</option>
                  <option value="other">other</option>
                </select>
              </div>

              <div className="field" style={{ width: 220, minWidth: 220 }}>
                <div className="label">Intent</div>
                <select className="select" value={logIntent} onChange={(e) => setLogIntent(e.target.value as any)}>
                  <option value="check_in">check_in</option>
                  <option value="referral_ask">referral_ask</option>
                  <option value="review_ask">review_ask</option>
                  <option value="deal_followup">deal_followup</option>
                  <option value="collaboration">collaboration</option>
                  <option value="event_invite">event_invite</option>
                  <option value="other">other</option>
                </select>
              </div>

              <div className="field" style={{ width: 220, minWidth: 220 }}>
                <div className="label">Occurred at</div>
                <input
                  className="input"
                  type="datetime-local"
                  value={logOccurredAt}
                  onChange={(e) => setLogOccurredAt(e.target.value)}
                />
              </div>
            </div>

            <div className="rowResponsive" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <div className="label">Source</div>
                <input
                  className="input"
                  value={logSource}
                  onChange={(e) => setLogSource(e.target.value)}
                  placeholder="manual / gmail / sms"
                />
              </div>

              <div className="field" style={{ flex: 1, minWidth: 260 }}>
                <div className="label">Link (optional)</div>
                <input
                  className="input"
                  value={logLink}
                  onChange={(e) => setLogLink(e.target.value)}
                  placeholder="thread link / calendar link"
                />
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="label">Summary (optional)</div>
              <textarea
                className="textarea"
                value={logSummary}
                onChange={(e) => setLogSummary(e.target.value)}
                placeholder="Quick note about what happened"
              />
            </div>

            <div className="rowResponsive" style={{ marginTop: 12 }}>
              <button className="btn btnPrimary btnFullMobile" onClick={saveTouch} disabled={savingTouch}>
                {savingTouch ? "Saving…" : "Save touch"}
              </button>
              <button className="btn btnFullMobile" onClick={() => setLogOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}