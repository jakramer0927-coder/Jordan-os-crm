// Shared UI primitives built on the design tokens in app/globals.css.
// Use these instead of hand-rolling inline styles so pages stay consistent.

import React from "react";

/** Shimmer placeholder shown while data loads. */
export function Skeleton({
  width,
  height,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ""}`}
      style={{ width: width ?? "100%", height: height ?? 12, ...style }}
      aria-hidden="true"
    />
  );
}

/** A card-shaped loading placeholder (title + a few lines). */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card cardPad" aria-busy="true" aria-label="Loading">
      <span className="skeleton skeletonTitle" aria-hidden="true" />
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className="skeleton skeletonText"
          style={{ width: `${90 - i * 12}%` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/** Stack of skeleton cards for list/feed loading. */
export function SkeletonList({ count = 4, lines = 3 }: { count?: number; lines?: number }) {
  return (
    <div className="stack" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}

/** Friendly empty state with optional call-to-action. */
export function EmptyState({
  icon = "—",
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="emptyState" role="status">
      <div className="emptyStateIcon">{icon}</div>
      <div className="emptyStateTitle">{title}</div>
      {body && <div className="emptyStateBody">{body}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/** Editorial metric card — big serif value over an uppercase label. */
export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "danger" | "ok" | "warn";
}) {
  const color =
    tone === "danger" ? "var(--red)" : tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--amber)" : "var(--ink)";
  return (
    <div className="statCard">
      <div className="statLabel">{label}</div>
      <div className="statValue" style={{ color }}>
        {value}
        {sub != null && <span className="statValueSub"> {sub}</span>}
      </div>
    </div>
  );
}

const CATEGORY_BADGE: Record<string, string> = {
  agent: "badgeAgent",
  client: "badgeClient",
  sphere: "badgeSphere",
  vendor: "badgeVendor",
  developer: "badgeDeveloper",
};

/** Category pill using the shared category color tokens. */
export function CategoryBadge({ category }: { category: string | null | undefined }) {
  const key = (category || "").toLowerCase();
  const cls = CATEGORY_BADGE[key];
  if (!key) return null;
  return <span className={`badge${cls ? ` ${cls}` : ""}`}>{key}</span>;
}
