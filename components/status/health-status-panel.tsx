import React from "react";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export type HealthTransitionKind = "failure" | "recovery" | "stale" | "replay";

export interface HealthTransition {
  id: string;
  timestamp: string;
  from: HealthStatus;
  to: HealthStatus;
  kind: HealthTransitionKind;
  confidence: number;
  dependencyId?: string;
  dependencyLabel?: string;
  impact?: string;
  recoveryCheckpoint?: boolean;
}

export interface HealthDependency {
  id: string;
  label: string;
  status: HealthStatus;
  confidence: number;
  impact?: string;
}

export interface HealthStatusPanelProps {
  currentStatus: HealthStatus;
  currentConfidence: number;
  hysteresisWindowSeconds: number;
  historicalTransitions: HealthTransition[];
  dependencies?: HealthDependency[];
  lastProbedAt?: string;
  className?: string;
}

const STATUS_LABELS: Record<HealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};

const TRANSITION_LABELS: Record<HealthTransitionKind, string> = {
  failure: "Failure",
  recovery: "Recovery",
  stale: "Stale state",
  replay: "Replay",
};

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function formatConfidence(value: number): string {
  return `${Math.round(clampConfidence(value))}%`;
}

function formatWindow(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }
  return new Date(parsed).toISOString();
}

export function HealthStatusPanel({
  currentStatus,
  currentConfidence,
  hysteresisWindowSeconds,
  historicalTransitions,
  dependencies = [],
  lastProbedAt,
  className,
}: HealthStatusPanelProps) {
  const sortedTransitions = React.useMemo(
    () =>
      [...historicalTransitions].sort((a, b) => {
        const at = Date.parse(a.timestamp);
        const bt = Date.parse(b.timestamp);
        if (Number.isNaN(at) || Number.isNaN(bt)) {
          return 0;
        }
        return bt - at;
      }),
    [historicalTransitions],
  );

  const recoveryCheckpoints = React.useMemo(
    () => sortedTransitions.filter((t) => t.recoveryCheckpoint === true),
    [sortedTransitions],
  );

  return (
    <section
      className={["flex flex-col gap-6 rounded-lg border border-slate-200 bg-white p-6", className]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby="health-status-panel-title"
      data-testid="health-status-panel"
    >
      <header className="flex flex-col gap-1">
        <h2
          id="health-status-panel-title"
          className="text-lg font-semibold text-slate-900"
        >
          Dependency health
        </h2>
        <p className="text-sm text-slate-600">
          Current status is separate from the historical timeline below.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Current status
          </p>
          <p
            className="mt-1 text-2xl font-semibold text-slate-900"
            data-testid="health-current-status"
          >
            {STATUS_LABELS[currentStatus]}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-slate-500">Confidence</dt>
              <dd
                className="font-medium text-slate-900"
                data-testid="health-current-confidence"
              >
                {formatConfidence(currentConfidence)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Hysteresis window</dt>
              <dd
                className="font-medium text-slate-900"
                data-testid="health-hysteresis-window"
              >
                {formatWindow(hysteresisWindowSeconds)}
              </dd>
            </div>
          </dl>
          {lastProbedAt ? (
            <p className="mt-3 text-xs text-slate-500">
              Last probed: <span className="font-medium">{formatTimestamp(lastProbedAt)}</span>
            </p>
          ) : null}
        </div>

        <div className="rounded-md border border-slate-200 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Dependency impact
          </p>
          {dependencies.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No dependencies reported.</p>
          ) : (
            <ul className="mt-2 space-y-2" data-testid="health-dependencies">
              {dependencies.map((dep) => (
                <li key={dep.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-slate-900">{dep.label}</span>
                  <span className="text-slate-600">
                    {STATUS_LABELS[dep.status]} · {formatConfidence(dep.confidence)}
                    {dep.impact ? ` · ${dep.impact}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Historical timeline</h3>
        {sortedTransitions.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="health-timeline-empty">
            No health transitions recorded.
          </p>
        ) : (
          <ol
            className="flex flex-col gap-3 border-l-2 border-slate-200 pl-4"
            data-testid="health-timeline"
          >
            {sortedTransitions.map((transition) => (
              <li key={transition.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">
                    {TRANSITION_LABELS[transition.kind]}: {STATUS_LABELS[transition.from]} → {STATUS_LABELS[transition.to]}
                  </span>
                  {transition.recoveryCheckpoint ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                      Recovery checkpoint
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                  <span>{formatTimestamp(transition.timestamp)}</span>
                  <span>Confidence {formatConfidence(transition.confidence)}</span>
                  {transition.dependencyLabel ? (
                    <span>{transition.dependencyLabel}</span>
                  ) : null}
                  {transition.impact ? <span>{transition.impact}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Recovery checkpoints</h3>
        {recoveryCheckpoints.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="health-recovery-empty">
            No recovery checkpoints recorded.
          </p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="health-recovery-checkpoints">
            {recoveryCheckpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="text-slate-700">
                {formatTimestamp(checkpoint.timestamp)} · {STATUS_LABELS[checkpoint.to]}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default HealthStatusPanel;
