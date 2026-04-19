"use client";

import { useEffect, useState, useCallback } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

// ── Types ─────────────────────────────────────────────────────────────────────

type OppType = "buyer" | "seller" | "investor";
type BuyerStage = "initial_meeting" | "actively_searching" | "offer" | "under_contract" | "closed";
type SellerStage = "initial_meeting" | "signed_agreement" | "listing_prepped" | "on_market" | "in_contract" | "sold";
type PipelineStatus = "active" | "past_client" | "lost";

type ContactInfo = { id: string; display_name: string; category: string; tier: string | null; phone: string | null; email: string | null };

type Deal = {
  id: string;
  contact_id: string;
  opp_type: OppType;
  buyer_stage: BuyerStage | null;
  seller_stage: SellerStage | null;
  pipeline_status: PipelineStatus;
  // Legacy
  address: string | null;
  role: string;
  status: string;
  price: number | null;
  close_date: string | null;
  notes: string | null;
  created_at: string;
  // Buyer
  budget_min: number | null;
  budget_max: number | null;
  target_areas: string | null;
  pre_approval_amount: number | null;
  pre_approval_lender: string | null;
  motivation: string | null;
  timeline_notes: string | null;
  // Seller
  list_price: number | null;
  estimated_value: number | null;
  market_notes: string | null;
  cma_link: string | null;
  target_list_date: string | null;
  // Financial
  commission_pct: number | null;
  referral_fee_pct: number | null;
  // Relations
  contacts: ContactInfo | null;
  referral_source: { id: string; display_name: string } | null;
  referral_fee_contact: { id: string; display_name: string } | null;
  co_agent: { id: string; display_name: string } | null;
};

type Offer = {
  id: string;
  property_address: string;
  offer_price: number | null;
  asking_price: number | null;
  terms_notes: string | null;
  competing_offers_count: number | null;
  seller_agent_name: string | null;
  outcome: string;
  accepted_price: number | null;
  cma_link: string | null;
  occurred_at: string;
  seller_agent_contact: { id: string; display_name: string } | null;
};

type PrepItem = {
  id: string;
  item_name: string;
  vendor_name: string | null;
  cost: number | null;
  status: string;
  notes: string | null;
  vendor_contact: { id: string; display_name: string } | null;
};

type OppContact = {
  id: string;
  role: string;
  contact: ContactInfo | null;
};

type DealActivity = { id: string; note: string; activity_type: string; occurred_at: string };

// ── Stage configs ─────────────────────────────────────────────────────────────

const BUYER_STAGES: { value: BuyerStage; label: string; color: string; bg: string }[] = [
  { value: "initial_meeting",    label: "Initial Meeting",   color: "rgba(18,18,18,.55)", bg: "rgba(0,0,0,.03)" },
  { value: "actively_searching", label: "Actively Searching",color: "#1a3f8a",            bg: "rgba(11,60,140,.06)" },
  { value: "offer",              label: "Offer",             color: "rgba(120,60,0,.9)",  bg: "rgba(120,60,0,.06)" },
  { value: "under_contract",     label: "Under Contract",    color: "#5b21b6",            bg: "rgba(91,33,182,.06)" },
  { value: "closed",             label: "Closed",            color: "#0b6b2a",            bg: "rgba(11,107,42,.06)" },
];

const SELLER_STAGES: { value: SellerStage; label: string; color: string; bg: string }[] = [
  { value: "initial_meeting",  label: "Initial Meeting",  color: "rgba(18,18,18,.55)", bg: "rgba(0,0,0,.03)" },
  { value: "signed_agreement", label: "Signed Agreement", color: "#1a3f8a",            bg: "rgba(11,60,140,.06)" },
  { value: "listing_prepped",  label: "Listing Prepped",  color: "#0369a1",            bg: "rgba(3,105,161,.06)" },
  { value: "on_market",        label: "On Market",        color: "rgba(120,60,0,.9)",  bg: "rgba(120,60,0,.06)" },
  { value: "in_contract",      label: "In Contract",      color: "#5b21b6",            bg: "rgba(91,33,182,.06)" },
  { value: "sold",             label: "Sold",             color: "#0b6b2a",            bg: "rgba(11,107,42,.06)" },
];

const OFFER_OUTCOMES = ["pending", "accepted", "countered", "rejected", "withdrawn"] as const;
const PREP_STATUSES = ["planned", "in_progress", "completed"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

function calcNetGci(deal: Deal): number | null {
  const base = deal.price ?? deal.list_price ?? deal.estimated_value ?? deal.budget_max;
  if (!base || !deal.commission_pct) return null;
  const gross = base * (deal.commission_pct / 100);
  const refFee = deal.referral_fee_pct ? gross * (deal.referral_fee_pct / 100) : 0;
  return gross - refFee;
}

function estGci(deal: Deal): number | null {
  if (deal.buyer_stage === "closed" || deal.seller_stage === "sold") return calcNetGci(deal);
  const base = deal.opp_type === "seller"
    ? (deal.list_price ?? deal.estimated_value)
    : deal.budget_max;
  if (!base || !deal.commission_pct) return null;
  const gross = base * (deal.commission_pct / 100);
  const refFee = deal.referral_fee_pct ? gross * (deal.referral_fee_pct / 100) : 0;
  return gross - refFee;
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function daysLabel(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "1d";
  return `${n}d`;
}

function outcomeColor(o: string): string {
  if (o === "accepted") return "#0b6b2a";
  if (o === "rejected") return "#8a0000";
  if (o === "countered") return "rgba(120,60,0,.9)";
  if (o === "withdrawn") return "rgba(18,18,18,.4)";
  return "#1a3f8a";
}

function prepStatusColor(s: string): string {
  if (s === "completed") return "#0b6b2a";
  if (s === "in_progress") return "#1a3f8a";
  return "rgba(18,18,18,.4)";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StageChip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700, color, background: bg, border: `1px solid ${color}33` }}>
      {label}
    </span>
  );
}

function GciChip({ value }: { value: number | null }) {
  if (!value) return null;
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700, color: "#0b6b2a", background: "rgba(11,107,42,.07)", border: "1px solid rgba(11,107,42,.2)" }}>
      ~{fmt(value)} GCI
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Main tabs
  type MainTab = "buyers" | "sellers" | "investors" | "past_clients";
  const [mainTab, setMainTab] = useState<MainTab>("buyers");

  // ── Deal modal ──
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  type ModalTab = "details" | "offers" | "prep" | "activity" | "contacts";
  const [modalTab, setModalTab] = useState<ModalTab>("details");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Detail edit state
  const [editBuyerStage, setEditBuyerStage] = useState<BuyerStage>("initial_meeting");
  const [editSellerStage, setEditSellerStage] = useState<SellerStage>("initial_meeting");
  const [editPipelineStatus, setEditPipelineStatus] = useState<PipelineStatus>("active");
  const [editAddress, setEditAddress] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editMotivation, setEditMotivation] = useState("");
  const [editTimelineNotes, setEditTimelineNotes] = useState("");
  const [editBudgetMin, setEditBudgetMin] = useState("");
  const [editBudgetMax, setEditBudgetMax] = useState("");
  const [editTargetAreas, setEditTargetAreas] = useState("");
  const [editPreApproval, setEditPreApproval] = useState("");
  const [editPreApprovalLender, setEditPreApprovalLender] = useState("");
  const [editListPrice, setEditListPrice] = useState("");
  const [editEstValue, setEditEstValue] = useState("");
  const [editTargetListDate, setEditTargetListDate] = useState("");
  const [editMarketNotes, setEditMarketNotes] = useState("");
  const [editCmaLink, setEditCmaLink] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editCloseDate, setEditCloseDate] = useState("");
  const [editCommissionPct, setEditCommissionPct] = useState("");
  const [editRefFeePct, setEditRefFeePct] = useState("");
  const [editRefFeeQuery, setEditRefFeeQuery] = useState("");
  const [editRefFeeResults, setEditRefFeeResults] = useState<ContactInfo[]>([]);
  const [editRefFeeId, setEditRefFeeId] = useState("");
  const [editRefFeeName, setEditRefFeeName] = useState("");
  const [editCoAgentQuery, setEditCoAgentQuery] = useState("");
  const [editCoAgentResults, setEditCoAgentResults] = useState<ContactInfo[]>([]);
  const [editCoAgentId, setEditCoAgentId] = useState("");
  const [editCoAgentName, setEditCoAgentName] = useState("");

  // Offers state
  const [offers, setOffers] = useState<Offer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offerFormOpen, setOfferFormOpen] = useState(false);
  const [offerAddress, setOfferAddress] = useState("");
  const [offerPrice, setOfferPrice] = useState("");
  const [offerAskingPrice, setOfferAskingPrice] = useState("");
  const [offerTerms, setOfferTerms] = useState("");
  const [offerCompeting, setOfferCompeting] = useState("");
  const [offerAgentName, setOfferAgentName] = useState("");
  const [offerAgentQuery, setOfferAgentQuery] = useState("");
  const [offerAgentResults, setOfferAgentResults] = useState<ContactInfo[]>([]);
  const [offerAgentId, setOfferAgentId] = useState("");
  const [offerOutcome, setOfferOutcome] = useState<string>("pending");
  const [offerAcceptedPrice, setOfferAcceptedPrice] = useState("");
  const [offerCmaLink, setOfferCmaLink] = useState("");
  const [offerSaving, setOfferSaving] = useState(false);

  // Listing prep state
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [prepLoading, setPrepLoading] = useState(false);
  const [prepFormOpen, setPrepFormOpen] = useState(false);
  const [prepItem, setPrepItem] = useState("");
  const [prepVendorName, setPrepVendorName] = useState("");
  const [prepVendorQuery, setPrepVendorQuery] = useState("");
  const [prepVendorResults, setPrepVendorResults] = useState<ContactInfo[]>([]);
  const [prepVendorId, setPrepVendorId] = useState("");
  const [prepCost, setPrepCost] = useState("");
  const [prepStatus, setPrepStatus] = useState<string>("planned");
  const [prepNotes, setPrepNotes] = useState("");
  const [prepSaving, setPrepSaving] = useState(false);

  // Activity state
  const [activities, setActivities] = useState<DealActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityNote, setActivityNote] = useState("");
  const [activityType, setActivityType] = useState("note");
  const [activitySaving, setActivitySaving] = useState(false);

  // Opp contacts state
  const [oppContacts, setOppContacts] = useState<OppContact[]>([]);
  const [oppContactsLoading, setOppContactsLoading] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState("");
  const [contactSearchResults, setContactSearchResults] = useState<ContactInfo[]>([]);
  const [contactRole, setContactRole] = useState("co-buyer");
  const [contactAdding, setContactAdding] = useState(false);

  // New deal modal
  const [newOpen, setNewOpen] = useState(false);
  const [newType, setNewType] = useState<OppType>("buyer");
  const [newContactQuery, setNewContactQuery] = useState("");
  const [newContactResults, setNewContactResults] = useState<ContactInfo[]>([]);
  const [newContactId, setNewContactId] = useState("");
  const [newContactName, setNewContactName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newBudgetMin, setNewBudgetMin] = useState("");
  const [newBudgetMax, setNewBudgetMax] = useState("");
  const [newTargetAreas, setNewTargetAreas] = useState("");
  const [newEstValue, setNewEstValue] = useState("");
  const [newMotivation, setNewMotivation] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [newSaving, setNewSaving] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  // Additional contacts on new deal
  const [newCoContacts, setNewCoContacts] = useState<{ id: string; name: string; role: string }[]>([]);
  const [newCoQuery, setNewCoQuery] = useState("");
  const [newCoResults, setNewCoResults] = useState<ContactInfo[]>([]);
  const [newCoRole, setNewCoRole] = useState("co-buyer");

  // ── Load ──────────────────────────────────────────────────────────────────

  async function loadDeals() {
    setLoading(true);
    setError(null);
    try {
      const [activeRes, pastRes] = await Promise.all([
        fetch("/api/pipeline?pipeline_status=active"),
        fetch("/api/pipeline?pipeline_status=past_client"),
      ]);
      const activeJ = await activeRes.json();
      const pastJ = await pastRes.json();
      const all = [...(activeJ.deals ?? []), ...(pastJ.deals ?? [])];
      setDeals(all as Deal[]);
    } catch (e: any) {
      setError(e?.message || "Failed to load pipeline");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadDeals(); }, []);

  // ── Open deal modal ───────────────────────────────────────────────────────

  function openDeal(deal: Deal) {
    setSelectedDeal(deal);
    setModalTab("details");
    setSaveError(null);
    // Pre-fill edit state
    setEditBuyerStage(deal.buyer_stage ?? "initial_meeting");
    setEditSellerStage(deal.seller_stage ?? "initial_meeting");
    setEditPipelineStatus(deal.pipeline_status);
    setEditAddress(deal.address ?? "");
    setEditNotes(deal.notes ?? "");
    setEditMotivation(deal.motivation ?? "");
    setEditTimelineNotes(deal.timeline_notes ?? "");
    setEditBudgetMin(deal.budget_min != null ? String(deal.budget_min) : "");
    setEditBudgetMax(deal.budget_max != null ? String(deal.budget_max) : "");
    setEditTargetAreas(deal.target_areas ?? "");
    setEditPreApproval(deal.pre_approval_amount != null ? String(deal.pre_approval_amount) : "");
    setEditPreApprovalLender(deal.pre_approval_lender ?? "");
    setEditListPrice(deal.list_price != null ? String(deal.list_price) : "");
    setEditEstValue(deal.estimated_value != null ? String(deal.estimated_value) : "");
    setEditTargetListDate(deal.target_list_date ?? "");
    setEditMarketNotes(deal.market_notes ?? "");
    setEditCmaLink(deal.cma_link ?? "");
    setEditPrice(deal.price != null ? String(deal.price) : "");
    setEditCloseDate(deal.close_date ?? "");
    setEditCommissionPct(deal.commission_pct != null ? String(deal.commission_pct) : "");
    setEditRefFeePct(deal.referral_fee_pct != null ? String(deal.referral_fee_pct) : "");
    setEditRefFeeId(deal.referral_fee_contact?.id ?? "");
    setEditRefFeeName(deal.referral_fee_contact?.display_name ?? "");
    setEditRefFeeQuery(deal.referral_fee_contact?.display_name ?? "");
    setEditCoAgentId(deal.co_agent?.id ?? "");
    setEditCoAgentName(deal.co_agent?.display_name ?? "");
    setEditCoAgentQuery(deal.co_agent?.display_name ?? "");
  }

  // ── Modal tab switch + lazy load ──────────────────────────────────────────

  function switchModalTab(tab: ModalTab) {
    setModalTab(tab);
    if (!selectedDeal) return;
    if (tab === "offers" && offers.length === 0 && !offersLoading) loadOffers(selectedDeal.id);
    if (tab === "prep" && prepItems.length === 0 && !prepLoading) loadPrepItems(selectedDeal.id);
    if (tab === "activity" && activities.length === 0 && !activityLoading) loadActivities(selectedDeal.id);
    if (tab === "contacts" && oppContacts.length === 0 && !oppContactsLoading) loadOppContacts(selectedDeal.id);
  }

  async function loadOffers(dealId: string) {
    setOffersLoading(true);
    const res = await fetch(`/api/offers?deal_id=${dealId}`);
    if (res.ok) { const j = await res.json(); setOffers(j.offers ?? []); }
    setOffersLoading(false);
  }

  async function loadPrepItems(dealId: string) {
    setPrepLoading(true);
    const res = await fetch(`/api/listing-prep?deal_id=${dealId}`);
    if (res.ok) { const j = await res.json(); setPrepItems(j.items ?? []); }
    setPrepLoading(false);
  }

  async function loadActivities(dealId: string) {
    setActivityLoading(true);
    const res = await fetch(`/api/deals/activity?deal_id=${dealId}`);
    if (res.ok) { const j = await res.json(); setActivities(j.activities ?? []); }
    setActivityLoading(false);
  }

  async function loadOppContacts(dealId: string) {
    setOppContactsLoading(true);
    const res = await fetch(`/api/opportunity-contacts?deal_id=${dealId}`);
    if (res.ok) { const j = await res.json(); setOppContacts(j.contacts ?? []); }
    setOppContactsLoading(false);
  }

  // ── Save deal details ──────────────────────────────────────────────────────

  async function saveDeal() {
    if (!selectedDeal) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        id: selectedDeal.id,
        address: editAddress || null,
        notes: editNotes || null,
        motivation: editMotivation || null,
        timeline_notes: editTimelineNotes || null,
        budget_min: editBudgetMin ? Number(editBudgetMin) : null,
        budget_max: editBudgetMax ? Number(editBudgetMax) : null,
        target_areas: editTargetAreas || null,
        pre_approval_amount: editPreApproval ? Number(editPreApproval) : null,
        pre_approval_lender: editPreApprovalLender || null,
        list_price: editListPrice ? Number(editListPrice) : null,
        estimated_value: editEstValue ? Number(editEstValue) : null,
        target_list_date: editTargetListDate || null,
        market_notes: editMarketNotes || null,
        cma_link: editCmaLink || null,
        price: editPrice ? Number(editPrice) : null,
        close_date: editCloseDate || null,
        commission_pct: editCommissionPct ? Number(editCommissionPct) : null,
        referral_fee_pct: editRefFeePct ? Number(editRefFeePct) : null,
        referral_fee_contact_id: editRefFeeId || null,
        co_agent_contact_id: editCoAgentId || null,
        pipeline_status: editPipelineStatus,
      };
      if (selectedDeal.opp_type !== "seller") body.buyer_stage = editBuyerStage;
      if (selectedDeal.opp_type === "seller") body.seller_stage = editSellerStage;

      const res = await fetch("/api/pipeline", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) { setSaveError(j?.error || "Save failed"); return; }

      // Update local state
      setDeals(prev => prev.map(d => d.id === selectedDeal.id ? {
        ...d,
        buyer_stage: selectedDeal.opp_type !== "seller" ? editBuyerStage : d.buyer_stage,
        seller_stage: selectedDeal.opp_type === "seller" ? editSellerStage : d.seller_stage,
        pipeline_status: editPipelineStatus,
        address: editAddress || null,
        notes: editNotes || null,
        motivation: editMotivation || null,
        timeline_notes: editTimelineNotes || null,
        budget_min: editBudgetMin ? Number(editBudgetMin) : null,
        budget_max: editBudgetMax ? Number(editBudgetMax) : null,
        target_areas: editTargetAreas || null,
        pre_approval_amount: editPreApproval ? Number(editPreApproval) : null,
        pre_approval_lender: editPreApprovalLender || null,
        list_price: editListPrice ? Number(editListPrice) : null,
        estimated_value: editEstValue ? Number(editEstValue) : null,
        target_list_date: editTargetListDate || null,
        market_notes: editMarketNotes || null,
        cma_link: editCmaLink || null,
        price: editPrice ? Number(editPrice) : null,
        close_date: editCloseDate || null,
        commission_pct: editCommissionPct ? Number(editCommissionPct) : null,
        referral_fee_pct: editRefFeePct ? Number(editRefFeePct) : null,
      } : d));
      setSelectedDeal(prev => prev ? { ...prev,
        buyer_stage: prev.opp_type !== "seller" ? editBuyerStage : prev.buyer_stage,
        seller_stage: prev.opp_type === "seller" ? editSellerStage : prev.seller_stage,
        pipeline_status: editPipelineStatus,
      } : null);
    } finally {
      setSaving(false);
    }
  }

  // ── Add offer ─────────────────────────────────────────────────────────────

  async function addOffer() {
    if (!selectedDeal || !offerAddress.trim()) return;
    setOfferSaving(true);
    const res = await fetch("/api/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deal_id: selectedDeal.id,
        property_address: offerAddress.trim(),
        offer_price: offerPrice ? Number(offerPrice) : null,
        asking_price: offerAskingPrice ? Number(offerAskingPrice) : null,
        terms_notes: offerTerms || null,
        competing_offers_count: offerCompeting ? Number(offerCompeting) : null,
        seller_agent_contact_id: offerAgentId || null,
        seller_agent_name: offerAgentName || null,
        outcome: offerOutcome,
        accepted_price: offerAcceptedPrice ? Number(offerAcceptedPrice) : null,
        cma_link: offerCmaLink || null,
      }),
    });
    if (res.ok) {
      setOfferFormOpen(false);
      setOfferAddress(""); setOfferPrice(""); setOfferAskingPrice("");
      setOfferTerms(""); setOfferCompeting(""); setOfferAgentName("");
      setOfferAgentId(""); setOfferAgentQuery(""); setOfferOutcome("pending");
      setOfferAcceptedPrice(""); setOfferCmaLink("");
      loadOffers(selectedDeal.id);
    }
    setOfferSaving(false);
  }

  async function updateOfferOutcome(offerId: string, outcome: string) {
    await fetch("/api/offers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: offerId, outcome }),
    });
    setOffers(prev => prev.map(o => o.id === offerId ? { ...o, outcome } : o));
  }

  async function deleteOffer(offerId: string) {
    await fetch("/api/offers", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: offerId }),
    });
    setOffers(prev => prev.filter(o => o.id !== offerId));
  }

  // ── Add prep item ─────────────────────────────────────────────────────────

  async function addPrepItem() {
    if (!selectedDeal || !prepItem.trim()) return;
    setPrepSaving(true);
    const res = await fetch("/api/listing-prep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deal_id: selectedDeal.id,
        item_name: prepItem.trim(),
        vendor_contact_id: prepVendorId || null,
        vendor_name: prepVendorName || null,
        cost: prepCost ? Number(prepCost) : null,
        status: prepStatus,
        notes: prepNotes || null,
      }),
    });
    if (res.ok) {
      setPrepFormOpen(false);
      setPrepItem(""); setPrepVendorName(""); setPrepVendorId("");
      setPrepVendorQuery(""); setPrepCost(""); setPrepStatus("planned"); setPrepNotes("");
      loadPrepItems(selectedDeal.id);
    }
    setPrepSaving(false);
  }

  async function updatePrepStatus(itemId: string, status: string) {
    await fetch("/api/listing-prep", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId, status }),
    });
    setPrepItems(prev => prev.map(p => p.id === itemId ? { ...p, status } : p));
  }

  async function deletePrepItem(itemId: string) {
    await fetch("/api/listing-prep", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId }),
    });
    setPrepItems(prev => prev.filter(p => p.id !== itemId));
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  async function addActivity() {
    if (!selectedDeal || !activityNote.trim()) return;
    setActivitySaving(true);
    const res = await fetch("/api/deals/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deal_id: selectedDeal.id, note: activityNote.trim(), activity_type: activityType }),
    });
    if (res.ok) {
      setActivityNote("");
      loadActivities(selectedDeal.id);
    }
    setActivitySaving(false);
  }

  async function deleteActivity(id: string) {
    await fetch("/api/deals/activity", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setActivities(prev => prev.filter(a => a.id !== id));
  }

  // ── Opp contacts ──────────────────────────────────────────────────────────

  async function searchContacts(q: string, setter: (r: ContactInfo[]) => void) {
    if (!q.trim()) { setter([]); return; }
    const { data } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, phone, email")
      .ilike("display_name", `%${q}%`)
      .limit(6);
    setter((data ?? []) as ContactInfo[]);
  }

  async function addOppContact(contactId: string, role: string) {
    if (!selectedDeal) return;
    setContactAdding(true);
    await fetch("/api/opportunity-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deal_id: selectedDeal.id, contact_id: contactId, role }),
    });
    setContactSearchQuery(""); setContactSearchResults([]);
    loadOppContacts(selectedDeal.id);
    setContactAdding(false);
  }

  async function removeOppContact(id: string) {
    await fetch("/api/opportunity-contacts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setOppContacts(prev => prev.filter(c => c.id !== id));
  }

  // ── Create new deal ───────────────────────────────────────────────────────

  async function createDeal() {
    if (!newContactId) { setNewError("Select a contact first"); return; }
    setNewSaving(true);
    setNewError(null);
    const body: Record<string, unknown> = {
      contact_id: newContactId,
      opp_type: newType,
      notes: newNotes || null,
      motivation: newMotivation || null,
    };
    if (newType === "seller") {
      body.address = newAddress || null;
      body.estimated_value = newEstValue ? Number(newEstValue) : null;
    } else {
      body.budget_min = newBudgetMin ? Number(newBudgetMin) : null;
      body.budget_max = newBudgetMax ? Number(newBudgetMax) : null;
      body.target_areas = newTargetAreas || null;
    }
    const res = await fetch("/api/pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) { setNewError(j?.error || "Create failed"); setNewSaving(false); return; }
    const dealId = j.deal.id;

    // Link any additional contacts
    await Promise.all(newCoContacts.map(co =>
      fetch("/api/opportunity-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: dealId, contact_id: co.id, role: co.role }),
      })
    ));

    setDeals(prev => [j.deal as Deal, ...prev]);
    setNewOpen(false);
    setNewContactId(""); setNewContactName(""); setNewContactQuery("");
    setNewAddress(""); setNewBudgetMin(""); setNewBudgetMax("");
    setNewTargetAreas(""); setNewEstValue(""); setNewMotivation(""); setNewNotes("");
    setNewCoContacts([]); setNewCoQuery(""); setNewCoResults([]); setNewCoRole("co-buyer");
    setNewSaving(false);
  }

  // ── Delete deal ───────────────────────────────────────────────────────────

  async function deleteDeal() {
    if (!selectedDeal) return;
    if (!confirm(`Delete this opportunity? This cannot be undone.`)) return;
    await fetch("/api/pipeline", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selectedDeal.id }),
    });
    setDeals(prev => prev.filter(d => d.id !== selectedDeal.id));
    setSelectedDeal(null);
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const buyers = deals.filter(d => d.opp_type === "buyer" && d.pipeline_status === "active");
  const sellers = deals.filter(d => d.opp_type === "seller" && d.pipeline_status === "active");
  const investors = deals.filter(d => d.opp_type === "investor" && d.pipeline_status === "active");
  const pastClients = deals.filter(d => d.pipeline_status === "past_client");

  // GCI metrics
  const activeGci = deals
    .filter(d => d.pipeline_status === "active" && (
      d.buyer_stage === "offer" || d.buyer_stage === "under_contract" ||
      d.seller_stage === "on_market" || d.seller_stage === "in_contract"
    ))
    .reduce((sum, d) => sum + (estGci(d) ?? 0), 0);

  const totalPipelineGci = deals
    .filter(d => d.pipeline_status === "active")
    .reduce((sum, d) => sum + (estGci(d) ?? 0), 0);

  const closedGciYtd = deals
    .filter(d => {
      if (d.pipeline_status !== "past_client") return false;
      const closeYear = d.close_date ? new Date(d.close_date).getFullYear() : new Date(d.created_at).getFullYear();
      return closeYear === new Date().getFullYear();
    })
    .reduce((sum, d) => sum + (calcNetGci(d) ?? 0), 0);

  // ── Render helpers ────────────────────────────────────────────────────────

  function buyerStageConfig(s: BuyerStage) {
    return BUYER_STAGES.find(x => x.value === s) ?? BUYER_STAGES[0];
  }
  function sellerStageConfig(s: SellerStage) {
    return SELLER_STAGES.find(x => x.value === s) ?? SELLER_STAGES[0];
  }

  function DealCard({ deal }: { deal: Deal }) {
    const isBuyer = deal.opp_type !== "seller";
    const stage = isBuyer
      ? buyerStageConfig(deal.buyer_stage ?? "initial_meeting")
      : sellerStageConfig(deal.seller_stage ?? "initial_meeting");
    const gci = estGci(deal);
    const days = daysSince(deal.created_at);
    const name = deal.contacts?.display_name ?? "Unknown";

    return (
      <div
        className="card cardPad"
        style={{ cursor: "pointer", marginBottom: 8 }}
        onClick={() => { openDeal(deal); setOffers([]); setPrepItems([]); setActivities([]); setOppContacts([]); }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>{name}</div>
          <StageChip label={stage.label} color={stage.color} bg={stage.bg} />
        </div>

        {isBuyer && (deal.budget_max || deal.target_areas) && (
          <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
            {deal.budget_max ? fmt(deal.budget_max) : ""}
            {deal.budget_max && deal.target_areas ? " · " : ""}
            {deal.target_areas ?? ""}
          </div>
        )}
        {!isBuyer && deal.address && (
          <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>{deal.address}</div>
        )}
        {!isBuyer && (deal.list_price || deal.estimated_value) && (
          <div className="subtle" style={{ fontSize: 12 }}>{fmt(deal.list_price ?? deal.estimated_value)}</div>
        )}

        <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
          {gci && <GciChip value={gci} />}
          <span className="subtle" style={{ fontSize: 11 }}>{daysLabel(days)} in pipeline</span>
        </div>
      </div>
    );
  }

  function BuyerKanban() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${BUYER_STAGES.length}, minmax(200px, 1fr))`, gap: 12, overflowX: "auto" }}>
        {BUYER_STAGES.map(stage => {
          const stageDeal = buyers.filter(d => d.buyer_stage === stage.value);
          const stageGci = stageDeal.reduce((s, d) => s + (estGci(d) ?? 0), 0);
          return (
            <div key={stage.value}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: stage.color }}>{stage.label}</div>
                <div className="subtle" style={{ fontSize: 11 }}>
                  {stageDeal.length} {stageDeal.length === 1 ? "buyer" : "buyers"}
                  {stageGci > 0 ? ` · ${fmt(stageGci)}` : ""}
                </div>
              </div>
              {stageDeal.map(d => <div key={d.id}>{DealCard({ deal: d })}</div>)}
              {stageDeal.length === 0 && <div className="subtle" style={{ fontSize: 12, padding: "8px 0" }}>—</div>}
            </div>
          );
        })}
      </div>
    );
  }

  function SellerKanban() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${SELLER_STAGES.length}, minmax(200px, 1fr))`, gap: 12, overflowX: "auto" }}>
        {SELLER_STAGES.map(stage => {
          const stageDeal = sellers.filter(d => d.seller_stage === stage.value);
          const stageGci = stageDeal.reduce((s, d) => s + (estGci(d) ?? 0), 0);
          return (
            <div key={stage.value}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: stage.color }}>{stage.label}</div>
                <div className="subtle" style={{ fontSize: 11 }}>
                  {stageDeal.length} {stageDeal.length === 1 ? "seller" : "sellers"}
                  {stageGci > 0 ? ` · ${fmt(stageGci)}` : ""}
                </div>
              </div>
              {stageDeal.map(d => <div key={d.id}>{DealCard({ deal: d })}</div>)}
              {stageDeal.length === 0 && <div className="subtle" style={{ fontSize: 12, padding: "8px 0" }}>—</div>}
            </div>
          );
        })}
      </div>
    );
  }

  function InvestorView() {
    if (investors.length === 0) return <div className="subtle">No active investors — add one with + New.</div>;
    return (
      <div className="stack">
        {investors.map(d => <div key={d.id}>{DealCard({ deal: d })}</div>)}
      </div>
    );
  }

  function PastClientView() {
    if (pastClients.length === 0) return <div className="subtle">No past clients yet.</div>;
    return (
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid rgba(0,0,0,.08)" }}>
              {["Name", "Type", "Property / Search", "Close date", "Net GCI", ""].map(h => (
                <th key={h} style={{ padding: "6px 12px", textAlign: "left", fontWeight: 700, color: "rgba(18,18,18,.5)", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pastClients.map(d => {
              const gci = calcNetGci(d);
              const closeDate = d.close_date
                ? new Date(d.close_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "—";
              return (
                <tr key={d.id} style={{ borderBottom: "1px solid rgba(0,0,0,.05)", cursor: "pointer" }}
                  onClick={() => { openDeal(d); setOffers([]); setPrepItems([]); setActivities([]); setOppContacts([]); }}>
                  <td style={{ padding: "10px 12px", fontWeight: 700 }}>{d.contacts?.display_name ?? "—"}</td>
                  <td style={{ padding: "10px 12px", textTransform: "capitalize" }}>{d.opp_type}</td>
                  <td style={{ padding: "10px 12px", color: "rgba(18,18,18,.65)" }}>
                    {d.address ?? (d.opp_type === "seller" ? "—" : (d.target_areas ?? (d.budget_max ? fmt(d.budget_max) : "—")))}
                  </td>
                  <td style={{ padding: "10px 12px" }}>{closeDate}</td>
                  <td style={{ padding: "10px 12px", fontWeight: gci ? 700 : 400, color: gci ? "#0b6b2a" : undefined }}>{gci ? fmt(gci) : "—"}</td>
                  <td style={{ padding: "10px 12px" }}><span style={{ fontSize: 12, color: "rgba(18,18,18,.4)" }}>Open →</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Deal modal ────────────────────────────────────────────────────────────

  function DealModal() {
    if (!selectedDeal) return null;
    const isBuyer = selectedDeal.opp_type !== "seller";
    const isSeller = selectedDeal.opp_type === "seller";
    const isInvestor = selectedDeal.opp_type === "investor";
    const stageConf = isBuyer
      ? buyerStageConfig(selectedDeal.buyer_stage ?? "initial_meeting")
      : sellerStageConfig(selectedDeal.seller_stage ?? "initial_meeting");

    const prepTotal = prepItems.reduce((s, p) => s + (p.cost ?? 0), 0);
    const prepDone = prepItems.filter(p => p.status === "completed").length;

    const tabList: { key: ModalTab; label: string }[] = [
      { key: "details", label: "Details" },
      { key: isSeller ? "prep" : "offers", label: isSeller ? "Listing Prep" : "Offers" },
      { key: "activity", label: "Activity" },
      { key: "contacts", label: "Contacts" },
    ];

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        onClick={() => setSelectedDeal(null)}>
        <div style={{ background: "var(--paper)", borderRadius: 12, width: "100%", maxWidth: 680, maxHeight: "90vh", overflow: "auto", display: "flex", flexDirection: "column" }}
          onClick={e => e.stopPropagation()}>

          {/* Header */}
          <div style={{ padding: "18px 20px 0", borderBottom: "1px solid rgba(0,0,0,.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>{selectedDeal.contacts?.display_name ?? "—"}</div>
                <div className="row" style={{ gap: 8, marginTop: 5, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, textTransform: "capitalize", color: "rgba(18,18,18,.5)" }}>{selectedDeal.opp_type}</span>
                  <StageChip label={stageConf.label} color={stageConf.color} bg={stageConf.bg} />
                  <GciChip value={estGci(selectedDeal)} />
                </div>
              </div>
              <button className="btn" style={{ fontSize: 12 }} onClick={() => setSelectedDeal(null)}>Close</button>
            </div>

            {/* Tab bar */}
            <div className="row" style={{ gap: 0 }}>
              {tabList.map(({ key, label }) => (
                <button key={key} onClick={() => switchModalTab(key)}
                  style={{ background: "none", border: "none", borderBottom: modalTab === key ? "2px solid var(--ink)" : "2px solid transparent",
                    marginBottom: -1, padding: "6px 14px 10px", fontWeight: modalTab === key ? 900 : 500,
                    fontSize: 13, cursor: "pointer", color: modalTab === key ? "var(--ink)" : "rgba(18,18,18,.45)" }}>
                  {label}
                  {key === "prep" && prepItems.length > 0 && ` (${prepDone}/${prepItems.length})`}
                  {key === "offers" && offers.length > 0 && ` (${offers.length})`}
                </button>
              ))}
            </div>
          </div>

          {/* Tab content */}
          <div style={{ padding: 20, flex: 1, overflow: "auto" }}>
            {saveError && <div className="alert alertError" style={{ marginBottom: 12 }}>{saveError}</div>}

            {/* ── Details tab ── */}
            {modalTab === "details" && (
              <div className="stack">
                {/* Stage */}
                <div>
                  <div className="label">Stage</div>
                  {isBuyer && (
                    <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {BUYER_STAGES.map(s => (
                        <button key={s.value} className="btn"
                          style={{ fontSize: 12, fontWeight: editBuyerStage === s.value ? 900 : 400,
                            background: editBuyerStage === s.value ? s.bg : undefined,
                            color: editBuyerStage === s.value ? s.color : undefined,
                            borderColor: editBuyerStage === s.value ? s.color + "55" : undefined }}
                          onClick={() => setEditBuyerStage(s.value)}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {isSeller && (
                    <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {SELLER_STAGES.map(s => (
                        <button key={s.value} className="btn"
                          style={{ fontSize: 12, fontWeight: editSellerStage === s.value ? 900 : 400,
                            background: editSellerStage === s.value ? s.bg : undefined,
                            color: editSellerStage === s.value ? s.color : undefined,
                            borderColor: editSellerStage === s.value ? s.color + "55" : undefined }}
                          onClick={() => setEditSellerStage(s.value)}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Pipeline status */}
                <div className="field">
                  <div className="label">Pipeline status</div>
                  <select className="select" value={editPipelineStatus} onChange={e => setEditPipelineStatus(e.target.value as PipelineStatus)} style={{ maxWidth: 200 }}>
                    <option value="active">Active</option>
                    <option value="past_client">Past client</option>
                    <option value="lost">Lost</option>
                  </select>
                </div>

                {/* Buyer-specific fields */}
                {(isBuyer || isInvestor) && (
                  <>
                    <div className="field">
                      <div className="label">Property address</div>
                      <input className="input" value={editAddress} onChange={e => setEditAddress(e.target.value)} placeholder="123 Main St, LA, CA 90001" />
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div className="field" style={{ minWidth: 140 }}>
                        <div className="label">Budget min</div>
                        <input className="input" value={editBudgetMin} onChange={e => setEditBudgetMin(e.target.value)} placeholder="800,000" />
                      </div>
                      <div className="field" style={{ minWidth: 140 }}>
                        <div className="label">Budget max</div>
                        <input className="input" value={editBudgetMax} onChange={e => setEditBudgetMax(e.target.value)} placeholder="1,500,000" />
                      </div>
                      <div className="field" style={{ flex: 1, minWidth: 200 }}>
                        <div className="label">Target areas</div>
                        <input className="input" value={editTargetAreas} onChange={e => setEditTargetAreas(e.target.value)} placeholder="Silver Lake, Los Feliz…" />
                      </div>
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div className="field" style={{ minWidth: 160 }}>
                        <div className="label">Pre-approval amount</div>
                        <input className="input" value={editPreApproval} onChange={e => setEditPreApproval(e.target.value)} placeholder="1,200,000" />
                      </div>
                      <div className="field" style={{ flex: 1, minWidth: 160 }}>
                        <div className="label">Lender</div>
                        <input className="input" value={editPreApprovalLender} onChange={e => setEditPreApprovalLender(e.target.value)} placeholder="Bank / broker name" />
                      </div>
                    </div>
                  </>
                )}

                {/* Seller-specific fields */}
                {isSeller && (
                  <>
                    <div className="field">
                      <div className="label">Property address</div>
                      <input className="input" value={editAddress} onChange={e => setEditAddress(e.target.value)} placeholder="123 Main St, LA, CA 90001" />
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div className="field" style={{ minWidth: 160 }}>
                        <div className="label">Estimated value</div>
                        <input className="input" value={editEstValue} onChange={e => setEditEstValue(e.target.value)} placeholder="2,000,000" />
                      </div>
                      <div className="field" style={{ minWidth: 160 }}>
                        <div className="label">List price</div>
                        <input className="input" value={editListPrice} onChange={e => setEditListPrice(e.target.value)} placeholder="1,949,000" />
                      </div>
                      <div className="field" style={{ minWidth: 140 }}>
                        <div className="label">Target list date</div>
                        <input className="input" type="date" value={editTargetListDate} onChange={e => setEditTargetListDate(e.target.value)} />
                      </div>
                    </div>
                    <div className="field">
                      <div className="label">Market notes / comps</div>
                      <textarea className="textarea" value={editMarketNotes} onChange={e => setEditMarketNotes(e.target.value)} placeholder="3 recent comps in $1.8–2.1M range…" style={{ minHeight: 60 }} />
                    </div>
                    <div className="field">
                      <div className="label">CMA link (Compass)</div>
                      <input className="input" value={editCmaLink} onChange={e => setEditCmaLink(e.target.value)} placeholder="https://…" />
                    </div>
                  </>
                )}

                {/* Shared */}
                <div className="field">
                  <div className="label">Motivation</div>
                  <input className="input" value={editMotivation} onChange={e => setEditMotivation(e.target.value)} placeholder="Relocation, upgrade, investment…" />
                </div>
                <div className="field">
                  <div className="label">Timeline notes</div>
                  <input className="input" value={editTimelineNotes} onChange={e => setEditTimelineNotes(e.target.value)} placeholder="Want to be in by summer…" />
                </div>

                {/* Financial */}
                <div style={{ fontWeight: 700, fontSize: 13, paddingTop: 4 }}>Financials</div>
                <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                  <div className="field" style={{ minWidth: 160 }}>
                    <div className="label">Sale / close price</div>
                    <input className="input" value={editPrice} onChange={e => setEditPrice(e.target.value)} placeholder="1,800,000" />
                  </div>
                  <div className="field" style={{ minWidth: 140 }}>
                    <div className="label">Close date</div>
                    <input className="input" type="date" value={editCloseDate} onChange={e => setEditCloseDate(e.target.value)} />
                  </div>
                  <div className="field" style={{ minWidth: 120 }}>
                    <div className="label">Commission %</div>
                    <input className="input" value={editCommissionPct} onChange={e => setEditCommissionPct(e.target.value)} placeholder="2.5" />
                  </div>
                  <div className="field" style={{ minWidth: 120 }}>
                    <div className="label">Referral fee %</div>
                    <input className="input" value={editRefFeePct} onChange={e => setEditRefFeePct(e.target.value)} placeholder="25" />
                  </div>
                </div>

                {/* Net GCI preview */}
                {editCommissionPct && (editPrice || editListPrice || editEstValue || editBudgetMax) && (() => {
                  const base = editPrice || editListPrice || editEstValue || editBudgetMax;
                  const gross = Number(base) * (Number(editCommissionPct) / 100);
                  const refFee = editRefFeePct ? gross * (Number(editRefFeePct) / 100) : 0;
                  const net = gross - refFee;
                  return (
                    <div style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(11,107,42,.06)", border: "1px solid rgba(11,107,42,.15)", fontSize: 13 }}>
                      <span className="subtle">Est. net GCI: </span>
                      <strong style={{ color: "#0b6b2a" }}>{fmt(net)}</strong>
                      {refFee > 0 && <span className="subtle"> (after {fmt(refFee)} referral fee)</span>}
                    </div>
                  );
                })()}

                {/* Referral fee contact */}
                <div className="field">
                  <div className="label">Referral fee — paying to</div>
                  <input className="input" value={editRefFeeQuery}
                    onChange={e => { setEditRefFeeQuery(e.target.value); searchContacts(e.target.value, setEditRefFeeResults); }}
                    placeholder="Search contacts…" />
                  {editRefFeeResults.length > 0 && (
                    <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                      {editRefFeeResults.map(c => (
                        <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13 }}
                          onClick={() => { setEditRefFeeId(c.id); setEditRefFeeName(c.display_name); setEditRefFeeQuery(c.display_name); setEditRefFeeResults([]); }}>
                          {c.display_name} <span className="subtle">{c.category}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {editRefFeeId && <div style={{ fontSize: 12, marginTop: 4, color: "rgba(18,18,18,.5)" }}>→ {editRefFeeName} <button style={{ marginLeft: 6, fontSize: 11, color: "#8a0000", background: "none", border: "none", cursor: "pointer" }} onClick={() => { setEditRefFeeId(""); setEditRefFeeName(""); setEditRefFeeQuery(""); }}>remove</button></div>}
                </div>

                {/* Co-agent */}
                <div className="field">
                  <div className="label">Co-agent (co-listing / referral)</div>
                  <input className="input" value={editCoAgentQuery}
                    onChange={e => { setEditCoAgentQuery(e.target.value); searchContacts(e.target.value, setEditCoAgentResults); }}
                    placeholder="Search contacts…" />
                  {editCoAgentResults.length > 0 && (
                    <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                      {editCoAgentResults.map(c => (
                        <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13 }}
                          onClick={() => { setEditCoAgentId(c.id); setEditCoAgentName(c.display_name); setEditCoAgentQuery(c.display_name); setEditCoAgentResults([]); }}>
                          {c.display_name} <span className="subtle">{c.category}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {editCoAgentId && <div style={{ fontSize: 12, marginTop: 4, color: "rgba(18,18,18,.5)" }}>→ {editCoAgentName} <button style={{ marginLeft: 6, fontSize: 11, color: "#8a0000", background: "none", border: "none", cursor: "pointer" }} onClick={() => { setEditCoAgentId(""); setEditCoAgentName(""); setEditCoAgentQuery(""); }}>remove</button></div>}
                </div>

                {/* Notes */}
                <div className="field">
                  <div className="label">Notes</div>
                  <textarea className="textarea" value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Any context…" style={{ minHeight: 70 }} />
                </div>

                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btnPrimary" onClick={saveDeal} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
                  <button className="btn" style={{ fontSize: 12, color: "#8a0000", borderColor: "rgba(200,0,0,.2)", marginLeft: "auto" }} onClick={deleteDeal}>Delete</button>
                </div>
              </div>
            )}

            {/* ── Offers tab (buyers + investors) ── */}
            {modalTab === "offers" && (
              <div className="stack">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>Offers made ({offers.length})</div>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setOfferFormOpen(v => !v)}>
                    {offerFormOpen ? "Cancel" : "+ Add offer"}
                  </button>
                </div>

                {offerFormOpen && (
                  <div className="card cardPad stack" style={{ background: "rgba(0,0,0,.02)" }}>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div className="field" style={{ flex: 1, minWidth: 200 }}>
                        <div className="label">Property address *</div>
                        <input className="input" value={offerAddress} onChange={e => setOfferAddress(e.target.value)} placeholder="123 Main St…" autoFocus />
                      </div>
                      <div className="field" style={{ minWidth: 140 }}>
                        <div className="label">Asking price</div>
                        <input className="input" value={offerAskingPrice} onChange={e => setOfferAskingPrice(e.target.value)} placeholder="1,500,000" />
                      </div>
                      <div className="field" style={{ minWidth: 140 }}>
                        <div className="label">Our offer</div>
                        <input className="input" value={offerPrice} onChange={e => setOfferPrice(e.target.value)} placeholder="1,450,000" />
                      </div>
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div className="field" style={{ minWidth: 120 }}>
                        <div className="label">Competing offers</div>
                        <input className="input" value={offerCompeting} onChange={e => setOfferCompeting(e.target.value)} placeholder="4" />
                      </div>
                      <div className="field" style={{ minWidth: 140 }}>
                        <div className="label">Outcome</div>
                        <select className="select" value={offerOutcome} onChange={e => setOfferOutcome(e.target.value)}>
                          {OFFER_OUTCOMES.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
                        </select>
                      </div>
                      {(offerOutcome === "accepted" || offerOutcome === "countered") && (
                        <div className="field" style={{ minWidth: 140 }}>
                          <div className="label">Accepted / counter price</div>
                          <input className="input" value={offerAcceptedPrice} onChange={e => setOfferAcceptedPrice(e.target.value)} placeholder="1,475,000" />
                        </div>
                      )}
                    </div>
                    <div className="field">
                      <div className="label">Seller's agent</div>
                      <input className="input" value={offerAgentQuery}
                        onChange={e => { setOfferAgentQuery(e.target.value); setOfferAgentName(e.target.value); searchContacts(e.target.value, setOfferAgentResults); }}
                        placeholder="Search contacts or type name…" />
                      {offerAgentResults.length > 0 && (
                        <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                          {offerAgentResults.map(c => (
                            <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13 }}
                              onClick={() => { setOfferAgentId(c.id); setOfferAgentName(c.display_name); setOfferAgentQuery(c.display_name); setOfferAgentResults([]); }}>
                              {c.display_name} <span className="subtle">{c.category}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="field">
                      <div className="label">Terms / contingencies</div>
                      <textarea className="textarea" value={offerTerms} onChange={e => setOfferTerms(e.target.value)} placeholder="21-day inspection, loan contingency, close 30 days…" style={{ minHeight: 60 }} />
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
                      <div className="field" style={{ flex: 1 }}>
                        <div className="label">CMA link</div>
                        <input className="input" value={offerCmaLink} onChange={e => setOfferCmaLink(e.target.value)} placeholder="https://…" />
                      </div>
                    </div>
                    <button className="btn btnPrimary" onClick={addOffer} disabled={offerSaving || !offerAddress.trim()}>
                      {offerSaving ? "Saving…" : "Save offer"}
                    </button>
                  </div>
                )}

                {offersLoading && <div className="subtle">Loading…</div>}
                {!offersLoading && offers.length === 0 && !offerFormOpen && (
                  <div className="subtle">No offers logged yet.</div>
                )}
                {offers.map(offer => (
                  <div key={offer.id} className="card cardPad">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>{offer.property_address}</div>
                      <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                        {OFFER_OUTCOMES.map(o => (
                          <button key={o} className="btn" style={{ fontSize: 11, padding: "2px 8px",
                            fontWeight: offer.outcome === o ? 900 : 400,
                            background: offer.outcome === o ? outcomeColor(o) : undefined,
                            color: offer.outcome === o ? "white" : undefined }}
                            onClick={() => updateOfferOutcome(offer.id, o)}>
                            {o}
                          </button>
                        ))}
                        <button className="btn" style={{ fontSize: 11, color: "#8a0000" }} onClick={() => deleteOffer(offer.id)}>✕</button>
                      </div>
                    </div>
                    <div className="row" style={{ marginTop: 6, gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                      {offer.asking_price && <span><span className="subtle">Ask:</span> {fmt(offer.asking_price)}</span>}
                      {offer.offer_price && <span><span className="subtle">Offer:</span> {fmt(offer.offer_price)}</span>}
                      {offer.accepted_price && <span><span className="subtle">Accepted:</span> {fmt(offer.accepted_price)}</span>}
                      {offer.competing_offers_count != null && <span className="subtle">{offer.competing_offers_count} competing</span>}
                    </div>
                    {(offer.seller_agent_contact?.display_name || offer.seller_agent_name) && (
                      <div style={{ fontSize: 12, marginTop: 4, color: "rgba(18,18,18,.55)" }}>
                        Seller's agent: {offer.seller_agent_contact?.display_name || offer.seller_agent_name}
                      </div>
                    )}
                    {offer.terms_notes && <div style={{ fontSize: 12, marginTop: 6, color: "rgba(18,18,18,.65)", whiteSpace: "pre-wrap" }}>{offer.terms_notes}</div>}
                    {offer.cma_link && <a href={offer.cma_link} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "rgba(18,18,18,.45)", display: "block", marginTop: 4 }}>CMA →</a>}
                  </div>
                ))}
              </div>
            )}

            {/* ── Listing Prep tab (sellers) ── */}
            {modalTab === "prep" && (
              <div className="stack">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>Listing prep</div>
                    {prepItems.length > 0 && (
                      <div className="subtle" style={{ fontSize: 12 }}>
                        {prepDone}/{prepItems.length} complete · Total cost: {fmt(prepTotal)}
                      </div>
                    )}
                  </div>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setPrepFormOpen(v => !v)}>
                    {prepFormOpen ? "Cancel" : "+ Add item"}
                  </button>
                </div>

                {prepFormOpen && (
                  <div className="card cardPad stack" style={{ background: "rgba(0,0,0,.02)" }}>
                    <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                      <div className="field" style={{ flex: 1, minWidth: 160 }}>
                        <div className="label">Item *</div>
                        <input className="input" value={prepItem} onChange={e => setPrepItem(e.target.value)} placeholder="Flooring, Painting, Landscaping…" autoFocus />
                      </div>
                      <div className="field" style={{ minWidth: 120 }}>
                        <div className="label">Cost</div>
                        <input className="input" value={prepCost} onChange={e => setPrepCost(e.target.value)} placeholder="8,400" />
                      </div>
                      <div className="field" style={{ minWidth: 130 }}>
                        <div className="label">Status</div>
                        <select className="select" value={prepStatus} onChange={e => setPrepStatus(e.target.value)}>
                          <option value="planned">Planned</option>
                          <option value="in_progress">In progress</option>
                          <option value="completed">Completed</option>
                        </select>
                      </div>
                    </div>
                    <div className="field">
                      <div className="label">Vendor (search contacts or type name)</div>
                      <input className="input" value={prepVendorQuery}
                        onChange={e => { setPrepVendorQuery(e.target.value); setPrepVendorName(e.target.value); searchContacts(e.target.value, setPrepVendorResults); }}
                        placeholder="Mike's Floors, Sarah's Staging Co…" />
                      {prepVendorResults.length > 0 && (
                        <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                          {prepVendorResults.map(c => (
                            <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13 }}
                              onClick={() => { setPrepVendorId(c.id); setPrepVendorName(c.display_name); setPrepVendorQuery(c.display_name); setPrepVendorResults([]); }}>
                              {c.display_name} <span className="subtle">{c.category}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="field">
                      <div className="label">Notes</div>
                      <textarea className="textarea" value={prepNotes} onChange={e => setPrepNotes(e.target.value)} placeholder="Any details…" style={{ minHeight: 50 }} />
                    </div>
                    <button className="btn btnPrimary" onClick={addPrepItem} disabled={prepSaving || !prepItem.trim()}>
                      {prepSaving ? "Saving…" : "Add item"}
                    </button>
                  </div>
                )}

                {prepLoading && <div className="subtle">Loading…</div>}
                {!prepLoading && prepItems.length === 0 && !prepFormOpen && (
                  <div className="subtle">No prep items yet.</div>
                )}
                {prepItems.map(item => (
                  <div key={item.id} className="card cardPad">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{item.item_name}</div>
                        {(item.vendor_contact?.display_name || item.vendor_name) && (
                          <div style={{ fontSize: 12, color: "rgba(18,18,18,.55)", marginTop: 2 }}>
                            {item.vendor_contact?.display_name || item.vendor_name}
                            {item.cost != null && ` · ${fmt(item.cost)}`}
                          </div>
                        )}
                        {!item.vendor_name && !item.vendor_contact && item.cost != null && (
                          <div style={{ fontSize: 12, color: "rgba(18,18,18,.55)", marginTop: 2 }}>{fmt(item.cost)}</div>
                        )}
                        {item.notes && <div style={{ fontSize: 12, marginTop: 4, color: "rgba(18,18,18,.6)" }}>{item.notes}</div>}
                      </div>
                      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                        {PREP_STATUSES.map(s => (
                          <button key={s} className="btn" style={{ fontSize: 11, padding: "2px 8px",
                            fontWeight: item.status === s ? 900 : 400,
                            background: item.status === s ? prepStatusColor(s) : undefined,
                            color: item.status === s ? "white" : undefined }}
                            onClick={() => updatePrepStatus(item.id, s)}>
                            {s === "in_progress" ? "In progress" : s.charAt(0).toUpperCase() + s.slice(1)}
                          </button>
                        ))}
                        <button className="btn" style={{ fontSize: 11, color: "#8a0000" }} onClick={() => deletePrepItem(item.id)}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Activity tab ── */}
            {modalTab === "activity" && (
              <div className="stack">
                <div style={{ fontWeight: 800, fontSize: 15 }}>Activity log</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <select className="select" value={activityType} onChange={e => setActivityType(e.target.value)} style={{ width: 160 }}>
                    <option value="note">Note</option>
                    <option value="showing_feedback">Showing feedback</option>
                    <option value="offer">Offer update</option>
                    <option value="price_change">Price change</option>
                    <option value="status_change">Status change</option>
                    <option value="other">Other</option>
                  </select>
                  <input className="input" style={{ flex: 1, minWidth: 200 }} value={activityNote}
                    onChange={e => setActivityNote(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && !activitySaving && addActivity()}
                    placeholder="Add a note…" />
                  <button className="btn btnPrimary" onClick={addActivity} disabled={activitySaving || !activityNote.trim()}>
                    {activitySaving ? "…" : "Add"}
                  </button>
                </div>
                {activityLoading && <div className="subtle">Loading…</div>}
                {!activityLoading && activities.length === 0 && <div className="subtle">No activity yet.</div>}
                <div className="stack" style={{ gap: 0 }}>
                  {activities.map((a, i) => (
                    <div key={a.id} style={{ padding: "10px 0", borderBottom: i < activities.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined, display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: "rgba(18,18,18,.4)", marginBottom: 3 }}>
                          {new Date(a.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · {a.activity_type}
                        </div>
                        <div style={{ fontSize: 13 }}>{a.note}</div>
                      </div>
                      <button style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(18,18,18,.3)", fontSize: 14, padding: "0 2px" }}
                        onClick={() => deleteActivity(a.id)}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Contacts tab ── */}
            {modalTab === "contacts" && (
              <div className="stack">
                <div style={{ fontWeight: 800, fontSize: 15 }}>People on this deal</div>

                {/* Primary contact */}
                <div className="card cardPad" style={{ background: "rgba(11,60,140,.04)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.45)", marginBottom: 4 }}>PRIMARY</div>
                  <a href={`/contacts/${selectedDeal.contact_id}`} style={{ fontWeight: 800, fontSize: 14 }}>
                    {selectedDeal.contacts?.display_name ?? "—"}
                  </a>
                  {selectedDeal.contacts?.phone && <div className="subtle" style={{ fontSize: 12 }}>{selectedDeal.contacts.phone}</div>}
                  {selectedDeal.contacts?.email && <div className="subtle" style={{ fontSize: 12 }}>{selectedDeal.contacts.email}</div>}
                </div>

                {/* Additional contacts */}
                {oppContactsLoading && <div className="subtle">Loading…</div>}
                {oppContacts.filter(c => c.contact?.id !== selectedDeal.contact_id).map(c => (
                  <div key={c.id} className="card cardPad">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.45)", textTransform: "uppercase", marginBottom: 3 }}>{c.role}</div>
                        <a href={`/contacts/${c.contact?.id}`} style={{ fontWeight: 700, fontSize: 14 }}>{c.contact?.display_name ?? "—"}</a>
                        {c.contact?.phone && <div className="subtle" style={{ fontSize: 12 }}>{c.contact.phone}</div>}
                      </div>
                      <button className="btn" style={{ fontSize: 12, color: "#8a0000" }} onClick={() => removeOppContact(c.id)}>Remove</button>
                    </div>
                  </div>
                ))}

                {/* Add contact */}
                <div className="field">
                  <div className="label">Add person to this deal</div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <input className="input" style={{ flex: 1, minWidth: 200 }} value={contactSearchQuery}
                      onChange={e => { setContactSearchQuery(e.target.value); searchContacts(e.target.value, setContactSearchResults); }}
                      placeholder="Search contacts…" />
                    <select className="select" value={contactRole} onChange={e => setContactRole(e.target.value)} style={{ width: 130 }}>
                      <option value="co-buyer">Co-buyer</option>
                      <option value="co-seller">Co-seller</option>
                      <option value="secondary">Secondary</option>
                    </select>
                  </div>
                  {contactSearchResults.length > 0 && (
                    <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                      {contactSearchResults.map(c => (
                        <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13 }}
                          onClick={() => addOppContact(c.id, contactRole)} disabled={contactAdding}>
                          {c.display_name} <span className="subtle">{c.category}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── New deal modal ────────────────────────────────────────────────────────

  function NewDealModal() {
    if (!newOpen) return null;
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        onClick={() => setNewOpen(false)}>
        <div style={{ background: "var(--paper)", borderRadius: 12, width: "100%", maxWidth: 520, padding: 24 }}
          onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 16 }}>New opportunity</div>

          {newError && <div className="alert alertError" style={{ marginBottom: 12 }}>{newError}</div>}

          <div className="stack">
            <div className="field">
              <div className="label">Type</div>
              <div className="row" style={{ gap: 8 }}>
                {(["buyer", "seller", "investor"] as OppType[]).map(t => (
                  <button key={t} className="btn"
                    style={{ fontWeight: newType === t ? 900 : 400, background: newType === t ? "var(--ink)" : undefined, color: newType === t ? "var(--paper)" : undefined, textTransform: "capitalize" }}
                    onClick={() => setNewType(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="label">Contact *</div>
              <input className="input" value={newContactQuery}
                onChange={e => { setNewContactQuery(e.target.value); searchContacts(e.target.value, setNewContactResults); }}
                placeholder="Search contacts…" />
              {newContactResults.length > 0 && (
                <div className="stack" style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                  {newContactResults.map(c => (
                    <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13 }}
                      onClick={() => { setNewContactId(c.id); setNewContactName(c.display_name); setNewContactQuery(c.display_name); setNewContactResults([]); }}>
                      {c.display_name} <span className="subtle">{c.category}</span>
                    </button>
                  ))}
                </div>
              )}
              {newContactId && <div style={{ fontSize: 12, color: "rgba(18,18,18,.5)", marginTop: 4 }}>Selected: <strong>{newContactName}</strong></div>}
            </div>

            {newType === "seller" ? (
              <>
                <div className="field">
                  <div className="label">Property address</div>
                  <input className="input" value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder="123 Main St, LA, CA 90001" />
                </div>
                <div className="field">
                  <div className="label">Estimated value</div>
                  <input className="input" value={newEstValue} onChange={e => setNewEstValue(e.target.value)} placeholder="2,000,000" />
                </div>
              </>
            ) : (
              <>
                <div className="row" style={{ gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <div className="label">Budget min</div>
                    <input className="input" value={newBudgetMin} onChange={e => setNewBudgetMin(e.target.value)} placeholder="800,000" />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <div className="label">Budget max</div>
                    <input className="input" value={newBudgetMax} onChange={e => setNewBudgetMax(e.target.value)} placeholder="1,500,000" />
                  </div>
                </div>
                <div className="field">
                  <div className="label">Target areas</div>
                  <input className="input" value={newTargetAreas} onChange={e => setNewTargetAreas(e.target.value)} placeholder="Silver Lake, Los Feliz…" />
                </div>
              </>
            )}

            <div className="field">
              <div className="label">Motivation (optional)</div>
              <input className="input" value={newMotivation} onChange={e => setNewMotivation(e.target.value)} placeholder="Relocation, upgrade, investment…" />
            </div>
            <div className="field">
              <div className="label">Notes (optional)</div>
              <textarea className="textarea" value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Any context…" style={{ minHeight: 60 }} />
            </div>

            {/* Additional contacts */}
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Additional contacts (co-buyer, spouse, partner…)</div>
              {newCoContacts.length > 0 && (
                <div className="stack" style={{ marginBottom: 8, gap: 4 }}>
                  {newCoContacts.map((co, i) => (
                    <div key={co.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span style={{ fontWeight: 700 }}>{co.name}</span>
                      <span className="badge" style={{ fontSize: 11 }}>{co.role}</span>
                      <button style={{ marginLeft: "auto", fontSize: 11, color: "#8a0000", background: "none", border: "none", cursor: "pointer" }}
                        onClick={() => setNewCoContacts(prev => prev.filter((_, j) => j !== i))}>remove</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
                  <input className="input" value={newCoQuery}
                    onChange={e => { setNewCoQuery(e.target.value); searchContacts(e.target.value, setNewCoResults); }}
                    placeholder="Search contacts…" />
                  {newCoResults.length > 0 && (
                    <div style={{ position: "absolute", zIndex: 10, left: 0, right: 0, background: "var(--paper)", border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                      {newCoResults.map(c => (
                        <button key={c.id} className="btn" style={{ borderRadius: 0, textAlign: "left", fontSize: 13, width: "100%" }}
                          onClick={() => {
                            if (!newCoContacts.find(x => x.id === c.id) && c.id !== newContactId) {
                              setNewCoContacts(prev => [...prev, { id: c.id, name: c.display_name, role: newCoRole }]);
                            }
                            setNewCoQuery(""); setNewCoResults([]);
                          }}>
                          {c.display_name} <span className="subtle">{c.category}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <select className="select" value={newCoRole} onChange={e => setNewCoRole(e.target.value)} style={{ minWidth: 120 }}>
                  <option value="co-buyer">Co-buyer</option>
                  <option value="co-seller">Co-seller</option>
                  <option value="spouse">Spouse</option>
                  <option value="partner">Partner</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              <button className="btn btnPrimary" onClick={createDeal} disabled={newSaving || !newContactId}>{newSaving ? "Creating…" : "Create"}</button>
              <button className="btn" onClick={() => setNewOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Page render ───────────────────────────────────────────────────────────

  if (loading) return <div className="card cardPad">Loading pipeline…</div>;
  if (error) return <div className="alert alertError">{error}</div>;

  const MAIN_TABS: { key: MainTab; label: string; count: number }[] = [
    { key: "buyers",      label: "Buyers",      count: buyers.length },
    { key: "sellers",     label: "Sellers",     count: sellers.length },
    { key: "investors",   label: "Investors",   count: investors.length },
    { key: "past_clients",label: "Past Clients",count: pastClients.length },
  ];

  return (
    <div className="stack">
      {/* ── Header ── */}
      <div className="card cardPad">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 className="h1" style={{ margin: 0 }}>Pipeline</h1>
            <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
              {buyers.length + sellers.length + investors.length} active · {pastClients.length} past clients
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btnPrimary" onClick={() => { setNewType(mainTab === "sellers" ? "seller" : mainTab === "investors" ? "investor" : "buyer"); setNewOpen(true); }}>
              + New
            </button>
          </div>
        </div>

        {/* GCI metrics */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 16 }}>
          <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(11,107,42,.06)", border: "1px solid rgba(11,107,42,.15)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(11,107,42,.7)", marginBottom: 3 }}>ACTIVE GCI</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#0b6b2a" }}>{fmt(activeGci)}</div>
            <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", marginTop: 2 }}>Offer / under contract stage</div>
          </div>
          <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(11,60,140,.05)", border: "1px solid rgba(11,60,140,.15)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(11,60,140,.7)", marginBottom: 3 }}>TOTAL PIPELINE</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#1a3f8a" }}>{fmt(totalPipelineGci)}</div>
            <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", marginTop: 2 }}>All active opportunities</div>
          </div>
          {closedGciYtd > 0 && (
            <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(0,0,0,.02)", border: "1px solid rgba(0,0,0,.08)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.5)", marginBottom: 3 }}>CLOSED YTD</div>
              <div style={{ fontSize: 20, fontWeight: 900 }}>{fmt(closedGciYtd)}</div>
              <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", marginTop: 2 }}>Net GCI this year</div>
            </div>
          )}
          <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(0,0,0,.02)", border: "1px solid rgba(0,0,0,.08)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.5)", marginBottom: 3 }}>OPPORTUNITY MIX</div>
            <div style={{ fontSize: 14, fontWeight: 900, marginTop: 2 }}>{buyers.length}B · {sellers.length}S · {investors.length}I</div>
            <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", marginTop: 2 }}>Buyers · Sellers · Investors</div>
          </div>
        </div>

        {/* Main tabs */}
        <div className="row" style={{ gap: 0, marginTop: 16, borderBottom: "2px solid rgba(0,0,0,.08)" }}>
          {MAIN_TABS.map(({ key, label, count }) => (
            <button key={key} onClick={() => setMainTab(key)}
              style={{ background: "none", border: "none", borderBottom: mainTab === key ? "2px solid var(--ink)" : "2px solid transparent",
                marginBottom: -2, padding: "6px 16px 10px", fontWeight: mainTab === key ? 900 : 500,
                fontSize: 14, cursor: "pointer", color: mainTab === key ? "var(--ink)" : "rgba(18,18,18,.45)" }}>
              {label} {count > 0 && <span style={{ fontSize: 12, opacity: 0.6 }}>({count})</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab content ── */}
      <div className="card cardPad">
        {mainTab === "buyers"      && BuyerKanban()}
        {mainTab === "sellers"     && SellerKanban()}
        {mainTab === "investors"   && InvestorView()}
        {mainTab === "past_clients" && PastClientView()}
      </div>

      {selectedDeal && DealModal()}
      {NewDealModal()}
    </div>
  );
}
