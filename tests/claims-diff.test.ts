/**
 * tests/claims-diff.test.ts
 * Tests the claims diffing algorithm for detecting added, updated, and unchanged factual claims,
 * including normalized value comparison across currency symbols, casing, and spacing.
 */

import { describe, it, expect } from "vitest";
import { diffClaims, normalizeClaimValue } from "../src/memory/claims.js";
import type { Claim } from "../src/pipeline/types.js";

describe("memory/claims diffClaims", () => {
  const oldClaims: Claim[] = [
    {
      entity: "HubSpot",
      attribute: "starter_price",
      value: "$15/month",
      sourceUrl: "https://hubspot.com/pricing",
      retrievedAt: "2026-11-01T00:00:00.000Z",
      volatility: "high",
    },
    {
      entity: "Postgres",
      attribute: "license",
      value: "PostgreSQL License",
      sourceUrl: "https://postgresql.org",
      retrievedAt: "2026-11-01T00:00:00.000Z",
      volatility: "low",
    },
  ];

  it("normalizes currency symbols, whitespace, and case in values", () => {
    expect(normalizeClaimValue("$15 / month")).toBe("15/month");
    expect(normalizeClaimValue("15 USD / month")).toBe("15/month");
    expect(normalizeClaimValue("  €20/month  ")).toBe("20/month");
    expect(normalizeClaimValue("PostgreSQL  License")).toBe("postgresql license");
  });

  it("treats cosmetically different currency formats as unchanged", () => {
    const newClaims: Claim[] = [
      {
        entity: "HubSpot",
        attribute: "starter_price",
        value: "15 USD / month", // Same price formatted differently
        sourceUrl: "https://hubspot.com/pricing",
        retrievedAt: "2026-11-14T00:00:00.000Z",
        volatility: "high",
      },
    ];

    const diff = diffClaims(oldClaims, newClaims);
    expect(diff.updated.length).toBe(0);
    expect(diff.unchanged.length).toBe(1);
  });

  it("identifies genuine price updates as updated claims", () => {
    const newClaims: Claim[] = [
      {
        entity: "HubSpot",
        attribute: "starter_price",
        value: "$20/month", // Genuine price increase
        sourceUrl: "https://hubspot.com/pricing-new",
        retrievedAt: "2026-11-14T00:00:00.000Z",
        volatility: "high",
      },
      {
        entity: "Postgres",
        attribute: "license",
        value: "PostgreSQL License", // Unchanged
        sourceUrl: "https://postgresql.org",
        retrievedAt: "2026-11-14T00:00:00.000Z",
        volatility: "low",
      },
    ];

    const diff = diffClaims(oldClaims, newClaims);

    expect(diff.updated.length).toBe(1);
    expect(diff.updated[0].old.value).toBe("$15/month");
    expect(diff.updated[0].current.value).toBe("$20/month");
    expect(diff.unchanged.length).toBe(1);
    expect(diff.added.length).toBe(0);
  });

  it("identifies new entities/attributes as added claims", () => {
    const newClaims: Claim[] = [
      {
        entity: "Pipedrive",
        attribute: "starter_price",
        value: "$14/month",
        sourceUrl: "https://pipedrive.com/pricing",
        retrievedAt: "2026-11-14T00:00:00.000Z",
        volatility: "high",
      },
    ];

    const diff = diffClaims(oldClaims, newClaims);

    expect(diff.added.length).toBe(1);
    expect(diff.added[0].entity).toBe("Pipedrive");
    expect(diff.updated.length).toBe(0);
  });
});
