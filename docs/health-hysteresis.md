# Build Dependency Health Hysteresis and Outage Timeline

This document describes the health hysteresis model used by the build dependency status surface (`app/status`, `components/status`, `lib/health-check.ts`) and the outage timeline rendered from it. It covers the public contract, the deterministic transition rules, privacy redaction, and the test matrix that guarantees this behavior.

## Goals

- Prevent a single failed probe from flickering the public status.
- Surface sustained failures as a clear incident timeline with recovery checkpoints.
- Keep historical health strictly separate from current status.
- Keep private diagnostics redacted from all public output.
- Make failure, stale-state, replay, authorization, and exact-boundary behavior deterministic and documented.

## Terminology

| Term | Meaning |
| --- | --- |
| Probe | A single health check execution for a dependency, producing `ok | unhealthy | unknown` plus a timestamp. |
| Hysteresis window | The consecutive-probe count and time bounds that must be satisfied before a public transition is committed. |
| Confidence | A deterministic score derived from the probe history inside the window, expressed as a fraction from 0 to 1. |
| Current status | The committed, hysteresis-filtered health state shown to users. |
| Historical health | The append-only list of probe results and committed transitions. |
| Outage timeline | Ordered incident entries derived from committed transitions. |
| Recovery checkpoint | A committed transition from `unhealthy` back to `ok`. |
| Dependency impact | The derived set of dependents affected by a committed unhealthy state. |

## Public contract

All public read paths return the same shape. The contract is versioned; any additive change must bump `schemaVersion` and keep older consumers reading the previous fields unchanged.

```ts
export type HealthStatus = "ok" | "unhealthy" | "unknown";

export type TransitionKind = "degrade" | "recovery";

export interface HealthProbeResult {
  readonly dependencyId: string;
  readonly status: HealthStatus;
  readonly observedAt: string; // ISO 8601, UTC
}

export interface HysteresisWindow {
  readonly minConsecutiveProbes: number;
  readonly minDurationMs: number;
  readonly maxStaleMs: number;
}

export interface HealthTransition {
  readonly id: string;
  readonly dependencyId: string;
  readonly from: HealthStatus;
  readonly to: HealthStatus;
  readonly kind: TransitionKind;
  readonly committedAt: string;
  readonly confidence: number; // 0..1
  readonly window: HysteresisWindow;
  readonly impactedDependencies: readonly string[];
}

export interface HealthSnapshot {
  readonly schemaVersion: 1;
  readonly dependencyId: string;
  readonly currentStatus: HealthStatus;
  readonly currentConfidence: number;
  readonly window: HysteresisWindow;
  readonly historicalTransitions: readonly HealthTransition[];
  readonly lastProbeAt: string | null;
  readonly stale: boolean;
  readonly outageTimeline: readonly OutageEntry[];
}

export interface OutageEntry {
  readonly transitionId: string;
  readonly dependencyId: string;
  readonly openedAt: string;
  readonly recoveredAt: string | null;
  readonly durationMs: number | null;
  readonly impactedDependencies: readonly string[];
  readonly recoveryCheckpointId: string | null;
}
```

Notes on the contract:

- `currentStatus` is the only field that represents the live status. Historical data is never merged into it.
- `historicalTransitions` is append-only and ordered by `committedAt` ascending. Ties are broken by `transitionId` ascending so replay is deterministic.
- `outageTimeline` is derived from committed transitions and is not stored independently.
- No field in this contract may contain raw probe payloads, error messages, stack traces, or any private diagnostic data.

## Hysteresis window

Default window (configurable per dependency, but validated against the bounds below):

| Field | Default | Min | Max |
| --- | --- | --- | --- |
| `minConsecutiveProbes` | 3 | 1 | 20 |
| `minDurationMs` | 60000 | 0 | 86400000 |
| `maxStaleMs` | 180000 | 1000 | 3600000 |

A transition is committed only when both `minConsecutiveProbes` and `minDurationMs` are satisfied by the candidate probe sequence. This is the core hysteresis guarantee: a single failed probe cannot flip the public status.

### Deterministic transition rules
Given a current committed status `C` and an ordered list of probe results `P = p1, p2, ...`, the following rules apply:

1. **Degradation candidate.** When `C = ok`, a degradation is committed when the trailing consecutive probes are all `unhealthy`, their count is at least `minConsecutiveProbes`, and the elapsed time between the first and last probe in that sequence is at least `minDurationMs`.
2. **Recovery candidate.** When `C = unhealthy`, a recovery is committed when the trailing consecutive probes are all `ok` and satisfy the same count and duration bounds.
3. **Unknown candidate.** A `unknown` probe neither advances nor resets a candidate sequence by itself; it interrupts consecutiveness. The candidate sequence is reset to empty and the current status is unchanged.
4. **No op otherwise.** Probes that do not satisfy a candidate rule leave the committed status unchanged.

Exact-boundary behavior is inclusive: a sequence of exactly `minConsecutiveProbes` probes spanning exactly `minDurationMs` commits the transition. One fewer probe or one millisecond shorter does not.

## Confidence

Confidence is a deterministic function of the candidate sequence and the window:

```
countFactor    = min(1, consecutiveCount / minConsecutiveProbes)
durationFactor = min(1, sequenceDurationMs / minDurationMs) // 1 when minDurationMs == 0
confidence     = round(100 * countFactor * durationFactor) / 100
```

Confidence is computed from the same inputs on every replay, so it is stable and comparable across snapshots. It is committed into the transition record at commit time and never recomputed retroactively.

## Stale state

A snapshot is marked `stale: true` when either:

- there is no probe result at all, or the most recent probe is older than `maxStaleMs`; or
- the most recent probe is older than `maxStaleMs` relative to the snapshot generation time.

Staleness does not automatically commit a transition. It is reported separately from `currentStatus` so consumers can distinguish "no data" from "healthy". The current status remains the last committed state until a hysteresis-satisfying sequence commits a change.

## Outage timeline

The timeline is derived from committed transitions:

- A `degrade` transition opens an outage entry with `openedAt = committedAt`.
- A `recovery` transition closes the open entry with `recoveredAt = committedAt` and `durationMs = recoveredAt - openedAt`. The recovery transition id is recorded as `recoveryCheckpointId`.
- An open entry has `recoveredAt = null`, `durationMs = null`, and `recoveryCheckpointId = null`.
- Entries are ordered by `openedAt` ascending, then by `transitionId`.
- `impactedDependencies` is copied from the opening transition and is immutable for the lifetime of the entry.

The timeline is purely derived; replaying the same transition log always produces the same timeline.

## Dependency impact

Each committed transition records the set of dependents impacted by the new status. Impact is derived from the dependency graph at commit time and is stored on the transition so historical replay does not drift when the graph changes.

- For a degradation, impacted dependencies are the transitive dependents that resolve through the degraded dependency.
- For a recovery, impacted dependencies are empty.

The set is deterministically sorted and deduplicated before being committed.

## Privacy and redaction

Public status responses must never include:

- Raw probe response bodies or headers.
- Error messages, stack traces, or internal hostnames.
- Authentication tokens, wallet material, private proof data, or production credentials.
- Per-probe identifiers that could be correlated with internal infrastructure.

The public snapshot contains only the fields defined in `HealthSnapshot`. Private diagnostics are available only through the authorized internal diagnostics endpoint, and are redacted before logging.

## Authorization

Reading the public status snapshot requires no authentication. Writing probe results and committing transitions requires the internal service credential.

- Unauthorized writes return 401 and do not mutate history.
- Authorized writes with an invalid payload return 400 and do not mutate history.
- Authorization is checked before validation so unauthorized callers cannot probe the validator.

## Replay and concurrency

- Transitions are append-only and idempotent by id: replaying a transition with an existing id is a no-op.
- Concurrent probe writes are serialized by `observedAt` then by a monotonic sequence number so the committed order is deterministic regardless of arrival order.
- Replaying the complete history from an empty state reproduces the same current status, confidence, and timeline.

## Validation

Probe writes are validated against the versioned schema before being accepted:

- `dependencyId` must be a non-empty string with a maximum length of 128 characters.
- `status` must be one of `ok`, `unhealthy`, `unknown`.
- `observedAt` must be a valid ISO 8601 timestamp and must not be in the future beyond a small clock-skew tolerance.
- Hysteresis window values must fall within the bounds defined above.

Invalid payloads are rejected with 400 and do not appear in history.

## Rendering

The status surface renders the following distinct sections:

1. **Current status** — the committed hysteresis-filtered state, confidence, and staleness indicator.
2. **Hysteresis window** — configured thresholds for the dependency.
3. **Historical health** — append-only transition list, visually separated from current status.
4. **Outage timeline** — open and closed outages with duration and recovery checkpoints.
5. **Dependency impact** — the affected dependents for each committed transition.

Historical health is rendered in a separate region with its own heading and is never used to derive the current status display. Private diagnostics are not rendered in this surface.

## Test matrix

The following cases are covered by the focused Jest / React Testing Library suite and Playwright suite:

| Category | Case |
| --- | --- |
| Positive | Sustained unhealthy probes commit a degradation and open an outage entry. |
| Positive | Sustained ok probes after a degradation commit a recovery and close the outage entry with a recovery checkpoint. |
| Negative | A single failed probe does not change the current status. |
| Negative | A `unknown` probe interrupts a candidate sequence and leaves the current status unchanged. |
| Authorization | Unauthorized probe writes return 401 and do not mutate history. |
| Authorization | Authorized writes with invalid payloads return 400 and do not mutate history. |
| Concurrency | Concurrent probe writes commit in a deterministic order and produce the same snapshot as serial writes. |
| Boundary | Exactly `minConsecutiveProbes` probes spanning exactly `minDurationMs` commit the transition. |
| Boundary | One fewer probe or one millisecond shorter does not commit the transition. |
| Boundary | A probe older than `maxStaleMs` marks the snapshot stale without committing a transition. |
| Regression | Replaying the full history reproduces the same current status, confidence, and timeline. |
| Regression | Public snapshots contain no private diagnostics and render historical health separately from current status. |

## Validation commands

Run before opening the pull request and include the exact commands and results summary in the PR description:

```bash
npx jest --runInBand --selectProjects=status
npx playwright test tests/status
npm run lint
npm test
npm run build
```

## Compatibility

- `schemaVersion` is currently `1`. Additive changes bump `schemaVersion` and keep older consumers reading the previous fields unchanged.ump the version and keep existing consumers reading the previous fields unchanged.
- Removing or renaming a field requires a major version bump and a documented migration path.
- Historical transitions are immutable; consumers must tolerate unknown additive fields on transition records.
