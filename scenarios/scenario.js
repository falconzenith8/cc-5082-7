import { normalizeCatalog } from "../src/catalog.js";

/**
 * Demo scenario built around an explicit rotation boundary:
 *
 *   v1 (published 11-10)  effectiveFrom 2026-11-12T00:00+08:00 (UTC 11-11 16:00)
 *     round sprint  : 11-12 00:00 .. 11-13 00:00 local (+08:00)
 *     round climber : 11-13 00:00 .. 11-14 00:00 local
 *     (there is a deliberate hole: 11-14 00:00 .. 11-15 00:00 — see gap test)
 *
 *   v2 (published 11-12 12:00 local, effectiveFrom 11-13 00:00 local)
 *     identical schedule, but scoring/ability/map restrictions change.
 *
 * Matches created before 11-13 00:00 local use v1 forever; matches created at or
 * after that boundary use v2. Their scores and restrictions differ accordingly.
 */
export const catalog = normalizeCatalog({
  schemaVersion: 1,
  maps: {
    "neon-docks": { contentId: "neon-docks", name: "Neon Docks", revision: 3, tags: ["urban", "sprint"] },
    "highland-pass": {
      contentId: "highland-pass",
      name: "Highland Pass",
      revision: 2,
      tags: ["outdoor", "climber"],
    },
    "frost-cavern": {
      contentId: "frost-cavern",
      name: "Frost Cavern",
      revision: 1,
      tags: ["outdoor", "climber", "winter"],
    },
  },
  abilities: {
    blink: { contentId: "blink", name: "Blink", revision: 2, tags: ["mobility"] },
    shield: { contentId: "shield", name: "Shield Projector", revision: 1, tags: ["defense"] },
    drone: { contentId: "drone", name: "Recon Drone", revision: 2, tags: ["utility"] },
  },
}).catalog;

export const basePackage = {
  id: "season-26-autumn",
  timeZone: "Asia/Shanghai",
  catalog,
  defaults: { mapPoolId: "ranked" },
  mapPool: {
    ranked: { maps: ["neon-docks", "highland-pass", "frost-cavern"], defaultMap: "neon-docks" },
    sprint: { maps: ["neon-docks", "highland-pass"], defaultMap: "neon-docks" },
    climber: { maps: ["highland-pass", "frost-cavern"], defaultMap: "highland-pass" },
  },
  scoring: {
    base: 10,
    perMapBonus: { "frost-cavern": 2 },
    categories: ["sprint"],
  },
  abilities: { defaultAllowed: true, allow: [], deny: [] },
  composition: { precedence: "newest", combine: "exclusive", allowTies: false, priority: [], exclusions: [] },
  schedule: {
    rounds: [
      {
        id: "sprint",
        name: "Sprint Weekend",
        startsAt: "2026-11-12T00:00:00",
        endsAt: "2026-11-13T00:00:00",
        mapPoolId: "sprint",
        winnerCondition: "score",
        effects: [{ kind: "scoring", multiplier: 1.5, label: "sprint-bonus" }],
        requiresAbilities: ["blink"],
      },
      {
        id: "climber",
        name: "Climber Series",
        startsAt: "2026-11-13T00:00:00",
        endsAt: "2026-11-14T00:00:00",
        mapPoolId: "climber",
        winnerCondition: "score",
        effects: [
          { kind: "scoring", multiplier: 0.5, label: "climb-handicap" },
          { kind: "ability", allow: [], deny: ["blink"], label: "no-blink" },
        ],
      },
    ],
  },
};

/** v1: original scoring and open ability set. */
export const v1 = {
  ...basePackage,
  publishedAt: "2026-11-10T00:00:00Z",
  effectiveFrom: "2026-11-12T00:00:00",
  displayName: "Autumn Season — baseline",
  notes: "v1 baseline: 10/base, 1.5x sprint, 0.5x climber",
  options: { basePoints: 10, sprintMultiplier: 1.5, climberMultiplier: 0.5 },
};
/**
 * v2: describes the same season with a new display name, but only the scoring
 * multiplier and the ability restriction actually changed. The display name is
 * deliberately a decoy: it says nothing about what changed.
 */
export const v2 = {
  ...basePackage,
  publishedAt: "2026-11-12T12:00:00",
  effectiveFrom: "2026-11-13T00:00:00",
  displayName: "Autumn Season — v2 (same name family)",
  notes: "v2 changed: climber 0.5x -> 0.8x, sprint 1.5x -> 1.75x, drone locked",
  options: { basePoints: 10, sprintMultiplier: 1.75, climberMultiplier: 0.8, droneLocked: true },
  scoring: { ...basePackage.scoring, base: 10 },
  abilities: { defaultAllowed: true, allow: [], deny: ["drone"] },
  schedule: {
    rounds: basePackage.schedule.rounds.map((round) =>
      round.id === "sprint"
        ? {
            ...round,
            effects: [{ kind: "scoring", multiplier: 1.75, label: "sprint-bonus-v2" }],
          }
        : {
            ...round,
            effects: [
              { kind: "scoring", multiplier: 0.8, label: "climb-handicap-v2" },
              { kind: "ability", allow: [], deny: ["blink"], label: "no-blink" },
            ],
          },
    ),
  },
};

/**
 * A deliberately broken candidate: references maps/abilities that do not exist
 * in the catalog, which must be refused rather than silently pruned.
 */
export const invalidResourcePackage = {
  ...basePackage,
  id: "season-26-winter",
  publishedAt: "2026-11-14T00:00:00",
  effectiveFrom: "2026-11-15T00:00:00",
  displayName: "Winter Season — broken refs",
  mapPool: {
    ...basePackage.mapPool,
    winter: { maps: ["glacier-rift", "neon-docks"], defaultMap: "glacier-rift" },
  },
  schedule: {
    rounds: [
      {
        id: "winter",
        startsAt: "2026-11-15T00:00:00",
        endsAt: "2026-11-16T00:00:00",
        mapPoolId: "winter",
        effects: [
          { kind: "scoring", multiplier: 2 },
          { kind: "ability", allow: ["grapple-hook"], deny: [] },
        ],
        requiresAbilities: ["orbit-scan"],
      },
    ],
  },
};

/** Overlapping activities that start at the same instant with no priority and no exclusion. */
export const unresolvedOverlapPackage = {
  ...basePackage,
  id: "season-26-overlap",
  publishedAt: "2026-11-10T00:00:00Z",
  effectiveFrom: "2026-11-12T00:00:00",
  displayName: "Overlap — unresolved",
  composition: { precedence: "newest", combine: "exclusive", allowTies: false, priority: [], exclusions: [] },
  schedule: {
    rounds: [
      {
        id: "sprint",
        name: "Sprint Weekend",
        startsAt: "2026-11-12T00:00:00",
        endsAt: "2026-11-13T00:00:00",
        mapPoolId: "sprint",
        effects: [{ kind: "scoring", multiplier: 1.5 }],
      },
      {
        id: "climber",
        name: "Climber Series",
        startsAt: "2026-11-12T00:00:00",
        endsAt: "2026-11-14T00:00:00",
        mapPoolId: "climber",
        effects: [{ kind: "scoring", multiplier: 0.5 }],
      },
    ],
  },
};

/** Same overlap, but with explicit priority declared so it can be assembled. */
export const resolvedOverlapPackage = {
  ...unresolvedOverlapPackage,
  id: "season-26-overlap-priority",
  publishedAt: "2026-11-10T00:00:01Z",
  displayName: "Overlap — priority declared",
  composition: {
    precedence: "declared",
    combine: "exclusive",
    allowTies: false,
    priority: ["sprint", "climber"],
    exclusions: [],
  },
};

/** Same tie, mutually excluded instead of priority-resolved. */
export const excludedOverlapPackage = {
  ...unresolvedOverlapPackage,
  id: "season-26-overlap-excluded",
  publishedAt: "2026-11-10T00:00:02Z",
  displayName: "Overlap — excluded",
  composition: {
    precedence: "newest",
    combine: "exclusive",
    allowTies: false,
    priority: [],
    exclusions: [{ a: "climber", b: "sprint" }],
  },
};

/** Two rounds with a real hole between them and no fallback pool. */
/** Two rounds with a real hole between them and no fallback pool. */
export const gapPackage = {
  ...basePackage,
  id: "season-26-gap",
  publishedAt: "2026-11-10T00:00:00Z",
  effectiveFrom: "2026-11-12T00:00:00",
  displayName: "Schedule with a gap",
  defaults: { mapPoolId: null },
  schedule: {
    rounds: [
      {
        id: "sprint",
        startsAt: "2026-11-12T00:00:00",
        endsAt: "2026-11-13T00:00:00",
        mapPoolId: "sprint",
        effects: [{ kind: "scoring", multiplier: 1.5 }],
      },
      {
        id: "climber",
        startsAt: "2026-11-15T00:00:00",
        endsAt: "2026-11-16T00:00:00",
        mapPoolId: "climber",
        effects: [{ kind: "scoring", multiplier: 0.5 }],
      },
    ],
  },
};

