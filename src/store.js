import { assemblePackage, normalizePackage, diffInputs } from "./normalize.js";
import { validateSnapshot } from "./validate.js";
import { fingerprint, canonicalJson, deepFreeze, shortDigest } from "./fingerprint.js";
import { parseWhen, formatLocal } from "./time.js";
import { PackageError, packageDigestMatches } from "./package.js";

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.details = details;
  }
}

/**
 * In-memory rule package store. Packages are immutable once published.
 * Publication is guarded by optimistic concurrency (expectCurrentDigest), strict
 * version increments, content-dedup, content-anchored identity, and a scan that
 * every already-started match stays bound to its original package.
 */
export class RulePackageStore {
  #entries = [];
  #baseline = null;

  constructor({ catalog = null, catalogDigest = null } = {}) {
    if (catalog) {
      this.#baseline = { catalog, catalogDigest: catalogDigest ?? fingerprint(catalog) };
    }
  }

  list() {
    return this.#entries.map((entry) => ({
      version: entry.version,
      digest: entry.digest,
      packageId: entry.pkg.id,
      displayName: entry.displayName,
      summary: entry.summary,
      effectiveFrom: entry.effectiveFrom,
      publishedAt: entry.pkg.publishedAt,
      timeZone: entry.pkg.timeZone,
    }));
  }

  listEntries() {
    return [...this.#entries];
  }

  /** All published versions already in force at the instant, newest first. */
  availableAt(instant) {
    return [...this.#entries]
      .filter(
        (entry) =>
          Date.parse(entry.effectiveFrom) <= instant && Date.parse(entry.pkg.publishedAt) <= instant,
      )
      .sort((a, b) => b.version - a.version);
  }

  has(version) {
    return this.#entries.some((entry) => entry.version === version);
  }

  head() {
    return this.#entries.length ? this.#entries[this.#entries.length - 1] : null;
  }

  versions() {
    return this.#entries.map((entry) => entry.version);
  }

  get(version) {
    return this.#entries.find((entry) => entry.version === version) ?? null;
  }

  getByDigest(digest) {
    return this.#entries.find((entry) => entry.digest === digest) ?? null;
  }

  currentCatalog() {
    const head = this.head();
    if (head) return { catalog: head.catalog, catalogDigest: head.catalogDigest };
    if (this.#baseline) return { catalog: this.#baseline.catalog, catalogDigest: this.#baseline.catalogDigest };
    return null;
  }

  /**
   * Publish a candidate. Returns { status: "published", entry } or
   * { status: "refused", ... } with diagnostics. `opts.now` is required so the
   * store never reads the wall clock and is fully controllable in tests.
   */
  publish(rawPackage, opts = {}) {
    const {
      now,
      expectCurrentDigest = undefined,
      catalog: catalogOverride = undefined,
      catalogDigest: catalogDigestOverride = undefined,
      allowTimestampChange = false,
      label = "publish",
    } = opts;

    if (!now) {
      return this.#refuse("PUBLISH_CLOCK_REQUIRED", "publish requires an explicit now", { label });
    }
    const head = this.head();
    const baseline = catalogOverride
      ? { catalog: catalogOverride, catalogDigest: catalogDigestOverride ?? fingerprint(catalogOverride) }
      : this.currentCatalog();
    if (!baseline) {
      return this.#refuse("CONTENT_CATALOG_REQUIRED", "no content catalog available for validation", { label });
    }

    if (head && expectCurrentDigest !== undefined && expectCurrentDigest !== head.digest) {
      return this.#refuse("VERSION_CONFLICT", "current package changed since the caller last read it", {
        expected: expectCurrentDigest,
        current: head.digest,
        currentVersion: head.version,
      });
    }

    const assembled = assemblePackage(rawPackage, {
      catalog: baseline.catalog,
      catalogDigest: baseline.catalogDigest,
      label,
    });
    if (assembled.status === "refused") {
      return { status: "refused", stage: "assemble", ...assembled };
    }

    const nextVersion = head ? head.version + 1 : 1;
    const pkg = assembled.package;

    if (pkg.publishedAt === null || parseWhen(pkg.publishedAt).status !== "ok") {
      return this.#refuse("PUBLISHED_AT_REQUIRED", "package publishedAt must resolve to an instant", { label });
    }
    const publishedInstant = parseWhen(pkg.publishedAt).instant;

    const duplicate = this.#entries.find((entry) => entry.digest === pkg.identity.digest);
    if (duplicate) {
      return {
        status: "duplicate",
        reason: "identical-package",
        version: duplicate.version,
        digest: duplicate.digest,
        entry: duplicate,
        diagnostics: assembled,
      };
    }

    if (head) {
      const headPublished = parseWhen(head.pkg.publishedAt).instant;
      if (publishedInstant < headPublished) {
        return this.#refuse("PUBLISH_STALE", "new package publishedAt predates current version", {
          currentVersion: head.version,
          currentPublishedAt: head.pkg.publishedAt,
          candidatePublishedAt: pkg.publishedAt,
        });
      }
      if (publishedInstant === headPublished && !allowTimestampChange) {
        return this.#refuse("PUBLISH_SAME_PUBLISHED_AT", "publishedAt must advance between versions", {
          currentVersion: head.version,
          publishedAt: pkg.publishedAt,
          currentDigest: head.digest,
          candidateDigest: pkg.identity.digest,
        });
      }
    }

    // Snapshot validation: everything that exists when the candidate lands must
    // keep its original package. This is the invariant that protects the
    // conditions of matches already under way.
    const validation = validateSnapshot({
      store: this,
      now,
      candidate: {
        core: assembled.core ?? pkg,
        version: nextVersion,
        effectiveFrom: publishedInstant,
        digest: pkg.identity.digest,
      },
      catalog: baseline.catalog,
      catalogDigest: baseline.catalogDigest,
    });
    if (!validation.ok) {
      return {
        status: "refused",
        stage: "snapshot",
        id: pkg.id,
        errors: validation.errors,
        warnings: [...assembled.warnings, ...validation.warnings],
        reasonCodes: validation.reasonCodes,
        digest: pkg.identity.digest,
      };
    }
    const effectiveFromResolved = parseWhen(rawPackage.effectiveFrom ?? pkg.publishedAt, pkg.timeZone);
    if (effectiveFromResolved.status !== "ok") {
      return this.#refuse("EFFECTIVE_BOUNDARY", "effectiveFrom is not resolvable", {
        status: effectiveFromResolved.status,
      });
    }
    if (effectiveFromResolved.instant < publishedInstant) {
      return this.#refuse("EFFECTIVE_BEFORE_PUBLICATION", "effectiveFrom cannot precede publication", {
        effectiveFrom: new Date(effectiveFromResolved.instant).toISOString(),
        publishedAt: pkg.publishedAt,
      });
    }

    const summary = buildSummary({
      pkg,
      catalog: baseline.catalog,
      catalogDigest: baseline.catalogDigest,
      summaryInputs: assembled.summaryInputs,
      displayName: rawPackage.displayName,
      notes: rawPackage.notes ?? null,
    });

    const entry = {
      version: nextVersion,
      digest: pkg.identity.digest,
      displayName: summary.displayName,
      summary,
      effectiveFrom: new Date(effectiveFromResolved.instant).toISOString(),
      effectiveFromLocal: formatLocal(effectiveFromResolved.instant, pkg.timeZone),
      pkg: deepFreeze(pkg),
      catalog: deepFreeze(baseline.catalog),
      catalogDigest: baseline.catalogDigest,
      materializedInputs: deepFreeze({
        id: rawPackage.id,
        publishedAt: pkg.publishedAt,
        timeZone: pkg.timeZone,
        schedule: rawPackage.schedule,
        defaults: rawPackage.defaults ?? null,
        mapPool: rawPackage.mapPool,
        scoring: rawPackage.scoring,
        abilities: rawPackage.abilities,
        composition: rawPackage.composition ?? null,
        displayName: rawPackage.displayName ?? null,
        notes: rawPackage.notes ?? null,
        options: rawPackage.options ?? {},
      }),
      diagnostics: { warnings: assembled.warnings, summaryInputs: assembled.summaryInputs },
      options: deepFreeze(rawPackage.options ?? {}),
    };
    this.#entries.push(entry);

    return {
      status: "published",
      entry,
      version: nextVersion,
      digest: entry.digest,
      warnings: assembled.warnings,
      summary,
    };
  }

  #refuse(code, message, details) {
    return {
      status: "refused",
      stage: "publish",
      errors: [{ severity: "error", code, message, details }],
      warnings: [],
      reasonCodes: [code],
    };
  }
}

function buildSummary({ pkg, catalog, catalogDigest, summaryInputs, displayName, notes }) {
  const mapIds = [...new Set(Object.values(pkg.mapPool).flatMap((pool) => pool.maps))].sort();
  const abilityIds = [...new Set([...pkg.abilities.allow, ...pkg.abilities.deny])];
  const definedAbilityIds = Object.keys(catalog.abilities).sort();
  const tags = [...new Set([
    ...mapIds.flatMap((id) => catalog.maps[id]?.tags ?? []),
    ...definedAbilityIds.flatMap((id) => catalog.abilities[id]?.tags ?? []),
  ])].sort();
  const name =
    typeof displayName === "string" && displayName.trim()
      ? displayName.trim()
      : typeof pkg.notes === "string" && pkg.notes.trim()
        ? pkg.notes.trim()
        : `${pkg.id}@${pkg.publishedAt}`;
  return {
    displayName: name,
    notes: notes ?? null,
    digest: pkg.identity.digest,
    digestShort: shortDigest(pkg.identity.digest),
    catalogDigest,
    catalogDigestShort: shortDigest(catalogDigest),
    packageId: pkg.id,
    timeZone: pkg.timeZone,
    publishedAt: pkg.publishedAt,
    inputs: pkg.options,
    summaryInputs: summaryInputs ?? null,
    content: {
      maps: mapIds,
      abilities: definedAbilityIds,
      tags,
      mapPools: Object.keys(pkg.mapPool).sort(),
      rounds: pkg.schedule.rounds.map((round) => ({
        id: round.id,
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        startsAtInstant: round.startsAtInstant,
        endsAtInstant: round.endsAtInstant,
        mapPoolId: round.mapPoolId,
        winnerCondition: round.winnerCondition,
        effects: round.effects,
      })),
    },
  };
}

/** Explain a version selection, including whether anything other than the name changed. */
export function explainSelection(entryA, entryB) {
  if (!entryA || !entryB) return null;
  const inputsA = canonicalJson(entryA.diagnostics?.summaryInputs ?? {});
  const inputsB = canonicalJson(entryB.diagnostics?.summaryInputs ?? {});
  const changes = diffInputs(entryA.diagnostics?.summaryInputs ?? {}, entryB.diagnostics?.summaryInputs ?? {});
  return {
    sameInputs: inputsA === inputsB,
    displayNameChanged: entryA.displayName !== entryB.displayName,
    inputDiff: changes,
  };
}

export { normalizePackage, packageDigestMatches, PackageError };
