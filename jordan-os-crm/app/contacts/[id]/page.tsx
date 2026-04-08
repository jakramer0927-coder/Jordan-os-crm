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
  ai_context: string | null;
  ai_context_updated_at: string | null;
};

type Deal = {
  id: string;
  address: string;
  role: string;
  status: string;
  price: number | null;
  close_date: string | null;
  notes: string | null;
  created_at: string;
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
  return direction === "outbound" ? "Outbound" : "Inbound";
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
  const [dealStatus, setDealStatus] = useState("active");
  const [dealPrice, setDealPrice] = useState("");
  const [dealCloseDate, setDealCloseDate] = useState("");
  const [dealNotes, setDealNotes] = useState("");
  const [dealBusy, setDealBusy] = useState(false);
  const [dealErr, setDealErr] = useState<string | null>(null);

  // merge
  const [mergeQ, setMergeQ] = useState("");
  const [mergeResults, setMergeResults] = useState<{ id: string; display_name: string; category: string }[]>([]);
  const [mergeTarget, setMergeTarget] = useState<{ id: string; display_name: string } | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);

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
      .select("id, display_name, category, tier, client_type, email, phone, created_at, user_id, buyer_budget_min, buyer_budget_max, buyer_target_areas, ai_context, ai_context_updated_at")
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
    setBuyerBudgetMin(c.buyer_budget_min != null ? String(c.buyer_budget_min) : "");
    setBuyerBudgetMax(c.buyer_budget_max != null ? String(c.buyer_budget_max) : "");
    setBuyerAreas(c.buyer_target_areas || "");
    setAiContext(c.ai_context ?? null);
    setAiContextUpdatedAt(c.ai_context_updated_at ?? null);

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
    const dealsRes = await fetch(`/api/contacts/deals?contact_id=${id}&uid=${myUid}`);
    if (dealsRes.ok) {
      const dj = await dealsRes.json().catch(() => ({}));
      setDeals(dj.deals ?? []);
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
      })
      .eq("id", contact.id);

    setSavingContact(false);

    if (error) {
      setError(`Update contact error: ${error.message}`);
      return;
    }

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
    setDealStatus("active");
    setDealPrice("");
    setDealCloseDate("");
    setDealNotes("");
    setDealErr(null);
    setDealFormOpen(true);
  }

  function openEditDeal(d: Deal) {
    setEditingDeal(d);
    setDealAddress(d.address);
    setDealRole(d.role);
    setDealStatus(d.status);
    setDealPrice(d.price != null ? String(d.price) : "");
    setDealCloseDate(d.close_date ?? "");
    setDealNotes(d.notes ?? "");
    setDealErr(null);
    setDealFormOpen(true);
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

  async function searchMergeTargets(q: string) {
    setMergeQ(q);
    if (q.trim().length < 2) { setMergeResults([]); return; }
    const { data } = await supabase
      .from("contacts")
      .select("id, display_name, category")
      .neq("archived", true)
      .neq("id", contact?.id ?? "")
      .ilike("display_name", `%${q.trim()}%`)
      .limit(8);
    setMergeResults((data ?? []) as { id: string; display_name: string; category: string }[]);
  }

  async function doMerge() {
    if (!mergeTarget || !contact) return;
    setMergeBusy(true);
    setMergeMsg(null);
    const res = await fetch("/api/contacts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: contact.id, target_id: mergeTarget.id }),
    });
    const j = await res.json();
    setMergeBusy(false);
    if (!res.ok) { setMergeMsg(`Error: ${j?.error || "Merge failed"}`); return; }
    setMergeMsg(`Done — ${j.touchesMoved} touches moved to "${j.targetName}". This contact has been archived.`);
    setMergeConfirm(false);
    setMergeTarget(null);
    setMergeResults([]);
    setMergeQ("");
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

  return (
    <div className="stack">
      {/* Header */}
      <div className="card cardPad">
        <div className="rowResponsiveBetween">
          <div style={{ minWidth: 0 }}>
            <div className="rowResponsive" style={{ alignItems: "baseline" }}>
              <h1 className="h1" style={{ margin: 0 }}>
                {contact.display_name}
              </h1>
              <span className="subtle">
                {prettyCategory(contact.category)}
                {contact.tier ? ` • Tier ${contact.tier}` : ""}
                {contact.client_type ? ` • ${contact.client_type}` : ""}
              </span>
            </div>

            <div className="subtle" style={{ marginTop: 8, fontSize: 13 }}>
              Last outbound: <strong>{lastOutbound ? lastOutbound.toLocaleString() : "—"}</strong>
            </div>
          </div>

          <div className="rowResponsive" style={{ justifyContent: "flex-end" }}>
            <a className="btn btnFullMobile" href="/contacts" style={{ textDecoration: "none" }}>
              Contacts
            </a>
            <button className="btn btnFullMobile" onClick={() => setEditing((v) => !v)}>
              {editing ? "Close edit" : "Edit"}
            </button>
            <button className="btn btnPrimary btnFullMobile" onClick={openLog}>
              Log touch
            </button>
          </div>
        </div>

        {error ? <div className="alert alertError" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>

      {/* Edit (clean, with danger zone) */}
      {editing && (
        <div className="card cardPad stack">
          <div className="rowResponsiveBetween">
            <div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Edit contact</div>
              <div className="subtle" style={{ marginTop: 4 }}>Keep it tight. No busy work.</div>
            </div>
            <button className="btn btnFullMobile" onClick={() => setEditing(false)}>
              Close
            </button>
          </div>

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
            <input
              className="input"
              value={clientType}
              onChange={(e) => setClientType(e.target.value)}
              placeholder="buyer / seller / past_client / lead / landlord / tenant / sphere ..."
            />
          </div>

          <div className="rowResponsive">
            <button className="btn btnPrimary btnFullMobile" onClick={saveContact} disabled={savingContact}>
              {savingContact ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="hr" />

          {/* Merge duplicate */}
          <div className="stack">
            <div style={{ fontWeight: 900 }}>Merge duplicate</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              All touches from <strong>{contact?.display_name}</strong> will move to the contact you pick, then this one gets archived.
            </div>

            {mergeMsg ? (
              <div className="alert alertOk" style={{ fontSize: 13 }}>{mergeMsg}</div>
            ) : mergeConfirm && mergeTarget ? (
              <div className="stack" style={{ gap: 8 }}>
                <div style={{ fontSize: 13 }}>
                  Merge <strong>{contact?.display_name}</strong> → <strong>{mergeTarget.display_name}</strong>?
                  All touches will be combined and this contact archived.
                </div>
                <div className="row">
                  <button className="btn btnPrimary" onClick={doMerge} disabled={mergeBusy}>
                    {mergeBusy ? "Merging…" : "Confirm merge"}
                  </button>
                  <button className="btn" onClick={() => { setMergeConfirm(false); setMergeTarget(null); }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <input
                  className="input"
                  value={mergeQ}
                  onChange={(e) => searchMergeTargets(e.target.value)}
                  placeholder="Search for the contact to merge into…"
                />
                {mergeResults.length > 0 && (
                  <div className="card" style={{ padding: "4px 0" }}>
                    {mergeResults.map((r) => (
                      <button
                        key={r.id}
                        className="btnGhost"
                        style={{ width: "100%", textAlign: "left", padding: "9px 14px", fontSize: 13, display: "block", borderRadius: 0 }}
                        onClick={() => { setMergeTarget(r); setMergeConfirm(true); setMergeResults([]); }}
                      >
                        <strong>{r.display_name}</strong>
                        <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>{r.category}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="hr" />

          <div className="stack">
            <div style={{ fontWeight: 900 }}>Danger zone</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              Deletes touches + imported texts attached to this contact.
            </div>
            <button className="btn btnFullMobile" onClick={deleteContact} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete contact"}
            </button>
          </div>
        </div>
      )}

      {/* Household / linked contacts */}
      <div className="card cardPad stack">
        <div className="rowBetween" style={{ alignItems: "center" }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>Household / linked contacts</div>
          <button className="btn" style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => { setLinkOpen((v) => !v); setLinkQ(""); setLinkResults([]); setLinkMsg(null); }}>
            {linkOpen ? "Cancel" : linkedContacts.length > 0 ? "Add another" : "Link contact"}
          </button>
        </div>

        {linkedContacts.length === 0 && !linkOpen && (
          <div className="subtle" style={{ fontSize: 13 }}>No linked contacts yet. Use this to connect joint contacts (e.g. Mike & Brooke McMahan).</div>
        )}

        {linkedContacts.map((lc) => (
          <div key={lc.link_id} className="rowBetween" style={{ alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
            <div>
              <a href={`/contacts/${lc.contact.id}`} style={{ fontWeight: 700 }}>{lc.contact.display_name}</a>
              <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>{lc.contact.category}{lc.contact.tier ? ` • ${lc.contact.tier}` : ""}</span>
              {lc.household_name && <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>({lc.household_name})</span>}
            </div>
            <button className="btn" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => removeLink(lc.link_id)} disabled={linkBusy}>Unlink</button>
          </div>
        ))}

        {linkOpen && (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className="field">
              <div className="label">Search contacts to link</div>
              <input
                className="input"
                value={linkQ}
                onChange={(e) => { setLinkQ(e.target.value); searchLinkContacts(e.target.value); }}
                placeholder="Type a name…"
              />
            </div>
            {linkResults.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                {linkResults.map((r) => (
                  <div key={r.id} className="rowBetween" style={{ alignItems: "center" }}>
                    <span>{r.display_name} <span className="subtle">• {r.category}{r.tier ? ` • ${r.tier}` : ""}</span></span>
                    <button className="btn btnPrimary" style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => addLink(r.id)} disabled={linkBusy}>Link</button>
                  </div>
                ))}
              </div>
            )}
            <div className="field">
              <div className="label">Household name (optional)</div>
              <input className="input" value={linkHouseholdName} onChange={(e) => setLinkHouseholdName(e.target.value)} placeholder="e.g. McMahan Household" />
            </div>
          </div>
        )}

        {linkMsg && <div className="subtle" style={{ fontSize: 13, color: linkMsg.startsWith("Error") ? "#8a0000" : "#0b6b2a" }}>{linkMsg}</div>}

        {linkedContacts.length > 0 && (
          <div className="stack" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Distribute & archive</div>
            <div className="subtle" style={{ fontSize: 12 }}>Copy all touches from this joint contact to each linked contact, then archive this one.</div>
            {distributeMsg ? (
              <div className="subtle" style={{ fontSize: 13, color: "#0b6b2a" }}>{distributeMsg}</div>
            ) : distributeConfirm ? (
              <div className="row">
                <span className="subtle" style={{ fontSize: 13 }}>Are you sure? This archives this contact.</span>
                <button className="btn btnPrimary" style={{ fontSize: 12 }} onClick={distributeToLinked} disabled={distributing}>{distributing ? "Working…" : "Confirm"}</button>
                <button className="btn" style={{ fontSize: 12 }} onClick={() => setDistributeConfirm(false)}>Cancel</button>
              </div>
            ) : (
              <button className="btn" style={{ fontSize: 12, alignSelf: "flex-start" }} onClick={() => setDistributeConfirm(true)}>Distribute & archive</button>
            )}
          </div>
        )}
      </div>

      {/* Properties / Deals */}
      <div className="card cardPad stack">
        <div className="rowBetween" style={{ alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>Properties & deals</div>
            <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>Transactions tied to this contact</div>
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
              <div className="field" style={{ minWidth: 130 }}>
                <div className="label">Status</div>
                <select className="select" value={dealStatus} onChange={e => setDealStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="pending">Pending</option>
                  <option value="closed">Closed</option>
                  <option value="cancelled">Cancelled</option>
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
              <div className="label">Notes (optional)</div>
              <textarea className="textarea" value={dealNotes} onChange={e => setDealNotes(e.target.value)} placeholder="Any notes about this transaction…" style={{ minHeight: 70 }} />
            </div>
            <div className="row">
              <button className="btn btnPrimary" onClick={saveDeal} disabled={dealBusy}>{dealBusy ? "Saving…" : "Save"}</button>
              <button className="btn" onClick={() => setDealFormOpen(false)} disabled={dealBusy}>Cancel</button>
            </div>
          </div>
        )}

        {/* Deal list */}
        {deals.length > 0 ? (
          <div className="stack" style={{ gap: 0 }}>
            {deals.map((d, i) => (
              <div key={d.id} style={{ padding: "10px 0", borderBottom: i < deals.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined }}>
                <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, wordBreak: "break-word" }}>{d.address}</div>
                    <div className="row" style={{ marginTop: 5, flexWrap: "wrap", gap: 4 }}>
                      <span className="badge" style={{ textTransform: "capitalize" }}>{d.role}</span>
                      <span className="badge" style={{ textTransform: "capitalize", ...(d.status === "closed" ? { background: "rgba(11,107,42,.1)", color: "#0b6b2a", borderColor: "rgba(11,107,42,.25)" } : d.status === "cancelled" ? { color: "rgba(18,18,18,.4)" } : {}) }}>{d.status}</span>
                      {d.price != null && <span className="badge">${Number(d.price).toLocaleString()}</span>}
                      {d.close_date && <span className="badge">Close {new Date(d.close_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>}
                    </div>
                    {d.notes && <div className="subtle" style={{ fontSize: 12, marginTop: 6 }}>{d.notes}</div>}
                  </div>
                  <div className="row" style={{ flexShrink: 0, gap: 6 }}>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openEditDeal(d)} disabled={dealBusy}>Edit</button>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => deleteDeal(d.id)} disabled={dealBusy}>Remove</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          !dealFormOpen && <div className="subtle" style={{ fontSize: 13 }}>No deals yet — add one above.</div>
        )}
      </div>

      {/* Buyer profile — active buyers only */}
      {(contact.category || "").toLowerCase() === "client" && (() => {
        const ct = (contact.client_type || "").toLowerCase();
        const isPastOrSeller = ct.includes("past") || ct.includes("seller") || ct.includes("landlord");
        if (isPastOrSeller) return (
          <div className="card cardPad" style={{ borderColor: "var(--line2)" }}>
            <div style={{ fontWeight: 900, fontSize: 15 }}>Buyer profile</div>
            <div className="subtle" style={{ fontSize: 13, marginTop: 6 }}>
              Not applicable — use <strong>Properties &amp; deals</strong> above to record the property this contact bought or sold.
            </div>
          </div>
        );
        return (
        <div className="card cardPad stack">
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>Buyer profile</div>
            <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>Budget and target areas for active buyers</div>
          </div>
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
          <div className="row" style={{ alignItems: "center", gap: 12 }}>
            <button className="btn btnPrimary" style={{ fontSize: 12 }} onClick={saveBuyerProfile} disabled={savingBuyer}>
              {savingBuyer ? "Saving…" : "Save buyer profile"}
            </button>
            {buyerMsg && <span style={{ fontSize: 12, color: buyerMsg.startsWith("Error") ? "#8a0000" : "#0b6b2a", fontWeight: 700 }}>{buyerMsg}</span>}
          </div>
        </div>
        );
      })()}

      {/* AI Insights */}
      <div className="card cardPad stack">
        <div className="rowBetween" style={{ alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>AI insights</div>
            {aiContextUpdatedAt && (
              <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
                Last extracted {new Date(aiContextUpdatedAt).toLocaleDateString()}
              </div>
            )}
          </div>
          <button
            className="btn"
            style={{ fontSize: 12, padding: "2px 10px" }}
            onClick={extractContext}
            disabled={extractingContext}
          >
            {extractingContext ? "Extracting…" : aiContext ? "Re-extract" : "Extract"}
          </button>
        </div>

        {extractContextMsg && (
          <div className={`alert ${extractContextMsg.startsWith("Error") ? "alertError" : "alertOk"}`} style={{ fontSize: 13 }}>
            {extractContextMsg}
          </div>
        )}

        {aiContext ? (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6 }}>{aiContext}</div>
        ) : (
          <div className="subtle" style={{ fontSize: 13 }}>
            No AI context yet. Import text threads or add touch summaries, then click Extract to generate relationship intelligence.
          </div>
        )}
      </div>

      {/* Jordan Voice FIRST */}
      <VoiceDraftPanel contactId={contact.id} contactEmail={contact.email} />

      {/* Text upload NEXT */}
      <TextThreadUploadPanel contactId={contact.id} />

      {/* Touch history: collapsed + calm */}
      <details className="card cardPad" open={false}>
        <summary style={{ cursor: "pointer", fontWeight: 900, listStyle: "none" as any }}>
          Touch history <span className="subtle">({touches.length})</span>
        </summary>

        <div className="stack" style={{ marginTop: 12 }}>
          {touches.length === 0 ? (
            <div className="subtle">No touches yet.</div>
          ) : (
            touches.map((t) => (
              <div key={t.id} className="card cardPad">
                <div className="rowResponsiveBetween">
                  <div style={{ fontWeight: 900 }}>
                    {dirPill(t.direction)} • {channelLabel(t.channel)}
                    {t.intent ? <span className="subtle"> • {t.intent}</span> : null}
                  </div>
                  <div className="subtle">{fmtDT(t.occurred_at)}</div>
                </div>

                {t.summary ? (
                  <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{t.summary}</div>
                ) : null}

                {(t.source || t.source_link) ? (
                  <div className="subtle" style={{ marginTop: 10, fontSize: 12 }}>
                    {t.source ? `source: ${t.source}` : ""}
                    {t.source_link ? (
                      <>
                        {" "}
                        •{" "}
                        <a href={t.source_link} target="_blank" rel="noreferrer">
                          open link
                        </a>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </details>

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