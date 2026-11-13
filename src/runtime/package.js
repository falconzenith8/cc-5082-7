import { fingerprint } from "../fingerprint.js";

/**
 * Rule packages are deterministic compositions of input content. Their identity
 * digest is computed from every field except the identity itself, so a package
 * whose content changed at all is a different package — even if its display
 * name was left untouched.
 */
const PACKAGE_FORMAT = "season-rule-package";
const PACKAGE_SCHEMA = 2;

export function packagePayloadCore(core) {
  return {
    format: PACKAGE_FORMAT,
    schemaVersion: PACKAGE_SCHEMA,
    id: core.id,
    publishedAt: core.publishedAt,
    timeZone: core.timeZone,
    schedule: core.schedule,
    defaults: core.defaults ?? null,
    mapPool: core.mapPool,
    scoring: core.scoring,
    abilities: core.abilities,
    composition: core.composition,
    catalogDigest: core.catalogDigest,
  };
}

export function sealPackage(core) {
  const payload = packagePayloadCore(core);
  const digest = fingerprint(payload);
  return {
    ...payload,
    identity: { digest, algorithm: "sha256", scope: "package-core" },
  };
}

export function packageDigestMatches(pkg) {
  const { identity: _identity, ...core } = pkg;
  return fingerprint(core) === pkg.identity.digest;
}

export class PackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PackageError";
    this.code = code;
    this.details = details;
  }
}
