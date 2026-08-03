/**
 * Compile-time drift gate between `src/openapi.yaml` and the hand-written
 * `./api.ts`.
 *
 * There are three descriptions of the same admin-API responses: the backend
 * code, `src/openapi.yaml` (the published API docs), and `./api.ts` (what the
 * SPA compiles against). The existing route-parity gate proves every route
 * EXISTS in the spec; nothing proved the shapes agreed. They did not — the
 * audit that added this file found `ClientSummary.kind` returned by the backend,
 * consumed by the UI, and absent from the spec entirely.
 *
 * This file contains no runtime code. It fails `vue-tsc` when a mirrored type
 * gains, loses, renames, or retypes a property on one side only. The error
 * names the offending property, because each check resolves to that property's
 * literal name instead of a bare `true`/`false`.
 *
 * ── Where the generated side comes from ──────────────────────────────────────
 * `bun run typecheck` regenerates `./openapi.generated.ts` from the spec before
 * running vue-tsc, so that (and CI's `check`, which calls it) is what actually
 * enforces the gate. `bun run build` deliberately does NOT regenerate and
 * consumes the committed file instead: the Dockerfile's admin-ui stage copies
 * only `admin-ui/`, so `../src/openapi.yaml` does not exist there and adding it
 * would couple that stage to a backend path. Same class of trap as the missing
 * `nodejs` the Dockerfile comment above that stage already records — it worked
 * on every developer machine and on the runner, and only the image build failed.
 *
 * ── Three things are compared ────────────────────────────────────────────────
 * The property SET, each shared property's VALUE type, and — since the spec
 * gained `required` markers — its OPTIONALITY. That last one is the sharpest of
 * the three: a field the UI treats as guaranteed while the backend may omit it
 * is a runtime `undefined` the type system would otherwise never mention.
 *
 * It could not exist before the markers did. Without `required`,
 * openapi-typescript makes every generated property optional, so the comparison
 * would have failed on all 35 types for a reason that says nothing about drift.
 * A handful of schemas still carry no `required` on purpose (a PATCH body, an
 * open-ended export document); those are simply compared on the other two axes.
 */
import type { components } from "./openapi.generated";
import type * as Ui from "./api";

type Schemas = components["schemas"];

/**
 * Properties that exist on the UI types by design and must never appear in the
 * spec: the demo build's i18n side-channel. `./api.ts` declares
 * `descriptionKey` / `labelKey` / `nameKey` on ~10 types so `demo/resolve.ts`'s
 * walker can swap localized text into the real field per active locale. They
 * are fixture plumbing for the public GitHub Pages demo and are never returned
 * by the backend, so listing them here is the correct answer rather than
 * documenting them into the published API.
 */
type DemoOnlyKeys = "descriptionKey" | "labelKey" | "nameKey";

/** Property names of `T`, with optionality stripped so `?` never hides a key. */
type Keys<T> = Exclude<keyof Required<T>, DemoOnlyKeys>;

/**
 * Resolves to `never` when both sides have exactly the same properties, and
 * otherwise to the names that are missing from one of them — which is what the
 * compiler prints, so the failure reads as `Type '"kind"' is not assignable to
 * type 'never'` rather than as an anonymous boolean mismatch.
 */
type KeyDrift<Spec, UiType> = Exclude<Keys<Spec>, Keys<UiType>> | Exclude<Keys<UiType>, Keys<Spec>>;

/** The properties of `T` that are genuinely optional, ignoring the demo-only side-channel. */
type OptionalKeys<T> = Exclude<
  { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? K : never }[keyof T],
  DemoOnlyKeys | undefined
>;

/**
 * Resolves to the names whose OPTIONALITY differs between the two sides —
 * required in the spec but `?` in the UI type, or the reverse.
 *
 * This check could not exist until the spec declared `required`: without it
 * openapi-typescript makes every generated property optional, so the comparison
 * would have failed on all 35 types for a reason that says nothing about drift.
 * With the markers in place it is the sharpest half of the gate, because
 * optionality is exactly what a consumer relies on — a field the UI treats as
 * guaranteed while the backend may omit it is a runtime `undefined`, and the
 * type system would have said nothing.
 */
type OptionalityDrift<Spec, UiType> =
  | Exclude<OptionalKeys<Spec> & Keys<UiType>, OptionalKeys<UiType>>
  | Exclude<OptionalKeys<UiType> & Keys<Spec>, OptionalKeys<Spec>>;

/**
 * Makes every property optional at every depth. Needed because the spec's
 * missing `required` markers reach NESTED types too: a property typed
 * `ApprovalDecision[]` is `{ id?: number }[]` on the generated side and
 * `{ id: number }[]` on the hand-written one, which are not mutually assignable
 * for a reason that has nothing to do with drift. Normalizing both sides first
 * leaves the comparison sensitive to what actually matters — a property that
 * exists on one side only, or whose type genuinely changed.
 */
type DeepOptional<T> = T extends (infer U)[]
  ? DeepOptional<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepOptional<T[K]> }
    : T;

/**
 * Resolves to the names of shared properties whose value types are not mutually
 * assignable once optionality is normalized away. Mutual assignability rather
 * than strict identity: it catches a changed enum, a `string` that became
 * `number`, a nullable that stopped being nullable, while tolerating the
 * harmless representational differences a code generator introduces.
 */
type ValueDrift<Spec, UiType> = {
  [K in Extract<Keys<Spec>, Keys<UiType>>]: DeepOptional<Required<Spec>[K]> extends DeepOptional<Required<UiType>[K]>
    ? DeepOptional<Required<UiType>[K]> extends DeepOptional<Required<Spec>[K]>
      ? never
      : K
    : K;
}[Extract<Keys<Spec>, Keys<UiType>>];

/**
 * Everything that drifted for one mirrored type, tagged with the type's name —
 * so the compiler error reads `Type '"ClientSummary.kind"' is not assignable to
 * type 'never'` and points at both the type and the property.
 *
 * `[X] extends [never]` rather than `X extends never`: a naked type parameter
 * distributes over unions, which would make the check vacuously false whenever
 * more than one property drifted.
 */
type AnyDrift<SpecKey extends keyof Schemas, UiType> =
  | KeyDrift<Schemas[SpecKey], UiType>
  | ValueDrift<Schemas[SpecKey], UiType>
  | OptionalityDrift<Schemas[SpecKey], UiType>;

type Drift<Name extends string, SpecKey extends keyof Schemas, UiType> = [AnyDrift<SpecKey, UiType>] extends [never]
  ? never
  : `${Name}.${AnyDrift<SpecKey, UiType> & string}`;

/**
 * Every mirrored type, unioned. Collected into ONE alias, and asserted once
 * below, because a `T extends never` constraint on a generic alias is checked
 * against the alias's own unresolved parameters — the assertion has to sit
 * where every operand is already concrete.
 *
 * Adding a type to ./api.ts that also exists in the spec? Add its line here.
 */
type AllDrift =
  | Drift<"AdminUserSummary", "AdminUserSummary", Ui.AdminUserSummary>
  | Drift<"AlertRule", "AlertRule", Ui.AlertRule>
  | Drift<"ApprovalRecord", "ApprovalRecord", Ui.ApprovalRecord>
  | Drift<"AuditLogEntry", "AuditLogEntry", Ui.AuditLogEntry>
  | Drift<"BundleSummary", "BundleSummary", Ui.BundleSummary>
  | Drift<"BundleToolRef", "BundleToolRef", Ui.BundleToolRef>
  | Drift<"CanaryConfig", "CanaryConfig", Ui.CanaryConfig>
  | Drift<"ClientGuardConfig", "ClientGuardConfig", Ui.ClientGuardConfig>
  | Drift<"ClientSummary", "ClientSummary", Ui.ClientSummary>
  | Drift<"ClientDetail", "ClientDetail", Ui.ClientDetail>
  | Drift<"BundleDetail", "BundleDetail", Ui.BundleDetail>
  | Drift<"CompositeDetail", "CompositeDetail", Ui.CompositeDetail>
  | Drift<"CatalogEntry", "CatalogEntry", Ui.CatalogEntry>
  | Drift<"ApprovalDecision", "ApprovalDecision", Ui.ApprovalDecision>
  | Drift<"CompositeStep", "CompositeStep", Ui.CompositeStep>
  | Drift<"CompositeSummary", "CompositeSummary", Ui.CompositeSummary>
  | Drift<"ConfigDiffEntry", "ConfigDiffEntry", Ui.ConfigDiffEntry>
  | Drift<"Consumer", "Consumer", Ui.Consumer>
  | Drift<"EffectiveConfig", "EffectiveConfig", Ui.EffectiveConfig>
  | Drift<"GuardPolicy", "GuardPolicy", Ui.GuardPolicy>
  | Drift<"LbConfig", "LbConfig", Ui.LbConfig>
  | Drift<"McpKeyScopes", "McpKeyScopes", Ui.McpKeyScopes>
  | Drift<"Schedule", "Schedule", Ui.Schedule>
  | Drift<"StoredSpan", "StoredSpan", Ui.StoredSpan>
  | Drift<"Team", "Team", Ui.Team>
  | Drift<"ToolGuardConfig", "ToolGuardConfig", Ui.ToolGuardConfig>
  | Drift<"TopSessionRow", "TopSessionRow", Ui.TopSessionRow>
  | Drift<"TopToolRow", "TopToolRow", Ui.TopToolRow>
  | Drift<"TraceSummary", "TraceSummary", Ui.TraceSummary>
  | Drift<"TrafficRecord", "TrafficRecord", Ui.TrafficRecord>
  | Drift<"UpstreamAuthInfo", "UpstreamAuthInfo", Ui.UpstreamAuthInfo>
  | Drift<"UsageByKeyRow", "UsageByKeyRow", Ui.UsageByKeyRow>
  | Drift<"UsageSummary", "UsageSummary", Ui.UsageSummary>
  | Drift<"UsageTimeseries", "UsageTimeseries", Ui.UsageTimeseries>
  | Drift<"WsProxyTarget", "WsProxyTarget", Ui.WsProxyTarget>;

/** The gate. `AllDrift` must be `never`; anything else names what diverged. */
export type _NoDriftBetweenSpecAndUiTypes = NoDrift<AllDrift>;
type NoDrift<T extends never> = T;

// ── Union / enum aliases ─────────────────────────────────────────────────────
// Not object shapes, so the key/value machinery above does not apply: assert
// mutual assignability directly. A member added on one side only fails here —
// which is how a stale `UpstreamKind = "rest" | "mcp"` would be caught.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

export type _UpstreamKind = AssertTrue<SameUnion<Schemas["UpstreamKind"], Ui.UpstreamKind>>;
