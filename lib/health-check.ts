"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appConfig } from "@/config/app";

export type HealthResponse = {
  status: string;
  service: string;
  database: string;
  timestamp: string;
};

export type HealthState = "healthy" | "degraded" | "down";

export type HealthTransition = {
  // Monotonic sequence number for deterministic ordering of transitions.
  seq: number;
  // "healthy" | "degraded" | "down" — the confirmed health state.
  state: HealthState;
  // Confidence in [0, 1] that the confirmed state reflects reality.
  confidence: number;
  // Number of consecutive probes that agreed with this state.
  consecutive: number;
  // When the transition was recorded (ISO string).
  at: string;
  // Human-readable reason for the transition (redacted of private data).
  reason: string;
};

// Versioned public snapshot shape used by the status surface. Historical
// health is kept strictly separate from the current committed status.
export type DependencyHealthSnapshot = {
  dependencyId: string;
  dependencyName: string;
  currentStatus: HealthState;
  confidence: number;
  hysteresisWindowMs: number;
  impact: "none" | "degraded" | "down";
  lastProbedAt: string | null;
  lastTransitionAt: string | null;
  isStale: boolean;
  transitions: HealthTransitionRecord[];
  // Private diagnostics are never rendered publicly; the panel only shows a
  // redacted placeholder when this field is present.
  privateDiagnostics?: string;
};

export type HealthTransitionRecord = {
  id: string;
  dependencyId: string;
  dependencyName: string;
  fromStatus: HealthState;
  toStatus: HealthState;
  occurredAt: string;
  confidence: number;
  hysteresisWindowMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  impact: "none" | "degraded" | "down";
  isRecoveryCheckpoint: boolean;
  summary: string;
};

type HealthCheckState = {
  data: HealthResponse | null;
  loading: boolean;
  error: string | null;
  lastChecked: Date | null;
  lastUpdated: Date | null;
  // Confirmed health state after hysteresis is applied. This is separate
  // from the raw `error`/`data` of the most recent probe: a single failed
  // probe does not flip `healthState` until the hysteresis window is met.
  healthState: HealthState;
  // Confidence in [0, 1] for `healthState`.
  confidence: number;
  // Number of consecutive probes agreeing with `healthState`.
  consecutive: number;
  // Bounded, ordered timeline of confirmed transitions (oldest first).
  transitions: HealthTransition[];
  // When the current outage began, if `healthState` is not "healthy".
  outageStartedAt: string | null;
  // Recovery checkpoints: timestamps of probes that confirmed recovery.
  recoveryCheckpoints: string[];
  // False whenever `data` was carried over from a previous successful
  // check rather than confirmed by the most recent one (the most recent
  // check errored, e.g. offline or a timeout). The status page uses this
  // to label what it's showing as "last known" rather than presenting
  // stale service state as a live result. This is never true while
  // `data` is null.
  isDataLive: boolean;
};

const TIMEOUT_MS = 10_000;
const STALE_MS = 60_000;

// Hysteresis: number of consecutive probes required before a state change
// is confirmed. A single failed probe never changes the confirmed state.
export const HYSTERESIS_WINDOW = 3;
// Maximum number of transitions retained in the timeline.
export const MAX_TRANSITIONS = 50;
// Maximum number of recovery checkpoints retained.
export const MAX_RECOVERY_CHECKPOINTS = 20;

function clampConfidence(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function computeConfidence(consecutive: number): number {
  // Confidence ramps from 0 to 1 across the hysteresis window and stays
  // at 1 once the window is satisfied.
  return clampConfidence(consecutive / HYSTERESIS_WINDOW);
}

function probeState(error: string | null): HealthState {
  if (error === null) return "healthy";
  if (error.startsWith("Database:") || error.startsWith("Status:")) {
    return "degraded";
  }
  return "down";
}

function isMalformed(body: unknown): body is HealthResponse {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.status !== "string" ||
    typeof obj.service !== "string" ||
    typeof obj.database !== "string" ||
    typeof obj.timestamp !== "string"
  );
}

function isStale(timestamp: string): boolean {
  try {
    const parsed = Date.parse(timestamp);
    return !Number.isNaN(parsed) && Date.now() - parsed > STALE_MS;
  } catch {
    return true;
  }
}

export function useHealthCheck(pollIntervalMs = 30_000) {
  const [state, setState] = useState<HealthCheckState>({
    data: null,
    loading: true,
    error: null,
    lastChecked: null,
    lastUpdated: null,
    isDataLive: false,
    healthState: "healthy",
    confidence: 0,
    consecutive: 0,
    transitions: [],
    outageStartedAt: null,
    recoveryCheckpoints: [],
  });

  const controllerRef = useRef<AbortController | null>(null);
  // Hysteresis bookkeeping kept in refs so concurrent probes cannot race
  // the confirmed state; only the current probe may commit a transition.
  const confirmedStateRef = useRef<HealthState>("healthy");
  const consecutiveRef = useRef(0);
  const seqRef = useRef(0);
  const outageStartedAtRef = useRef<string | null>(null);

  const commitProbe = useCallback((error: string | null) => {
    const observed = probeState(error);
    const confirmed = confirmedStateRef.current;

    if (observed === confirmed) {
      consecutiveRef.current += 1;
    } else {
      consecutiveRef.current = 1;
    }

    const confidence = computeConfidence(consecutiveRef.current);
    const shouldTransition =
      observed !== confirmed && consecutiveRef.current >= HYSTERESIS_WINDOW;
    const nowIso = new Date().toISOString();

    setState((prev) => {
      let healthState = prev.healthState;
      let transitions = prev.transitions;
      let outageStartedAt = prev.outageStartedAt;
      let recoveryCheckpoints = prev.recoveryCheckpoints;

      if (shouldTransition) {
        healthState = observed;
        confirmedStateRef.current = observed;
        seqRef.current += 1;
        const transition: HealthTransition = {
          seq: seqRef.current,
          state: observed,
          confidence,
          consecutive: consecutiveRef.current,
          at: nowIso,
          reason: error === null ? "recovered" : error,
        };
        transitions = [...prev.transitions, transition].slice(-MAX_TRANSITIONS);

        if (observed === "healthy") {
          outageStartedAt = null;
          outageStartedAtRef.current = null;
          recoveryCheckpoints = [...prev.recoveryCheckpoints, nowIso].slice(
            -MAX_RECOVERY_CHECKPOINTS,
          );
        } else if (outageStartedAt === null) {
          outageStartedAt = nowIso;
          outageStartedAtRef.current = nowIso;
        }
      }

      return {
        ...prev,
        healthState,
        confidence,
        consecutive: consecutiveRef.current,
        transitions,
        outageStartedAt,
        recoveryCheckpoints,
      };
    });
  }, []);

  const fetchHealth = useCallback(async () => {
    if (controllerRef.current) {
      controllerRef.current.abort();
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    // A stale request's own completion (success or failure) must never be
    // allowed to overwrite state a newer request already set. Every branch
    // below checks this before calling setState, rather than relying on
    // AbortController alone — abort() only guarantees the fetch signal
    // fires; it does not guarantee every environment rejects the fetch
    // promise before a competing response resolves.
    const isCurrent = () => controllerRef.current === controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearTimeoutIfActive = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("Request timed out"));
      }, TIMEOUT_MS);
    });

    try {
      const res = await Promise.race([
        fetch(`${appConfig.apiUrl}/health`, {
          signal: controller.signal,
          cache: "no-store",
          headers: { "Cache-Control": "no-store" },
        }),
        timeout,
      ]);

      clearTimeoutIfActive();

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body: unknown = await res.json();

      if (isMalformed(body)) {
        throw new Error("Malformed response");
      }

      if (!isCurrent()) {
        return;
      }

      const data = body as HealthResponse;
      const now = new Date();

      let error: string | null = null;
      if (data.status !== "ok") {
        error = `Status: ${data.status}`;
      } else if (data.database !== "ok") {
        error = `Database: ${data.database}`;
      } else if (isStale(data.timestamp)) {
        error = "Stale timestamp";
      }

      setState((prev) => ({
        ...prev,
        data,
        loading: false,
        error,
        lastChecked: now,
        lastUpdated: now,
        isDataLive: true,
      }));
      commitProbe(error);
    } catch (err: unknown) {
      clearTimeoutIfActive();

      if (!isCurrent()) {
        return;
      }

      if (controller.signal.aborted) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: "Request timed out",
          lastChecked: new Date(),
          isDataLive: false,
        }));
        commitProbe("Request timed out");
        return;
      }

      const message = err instanceof Error ? err.message : "Network error";

      setState((prev) => ({
        ...prev,
        loading: false,
        error: message,
        lastChecked: new Date(),
        isDataLive: false,
      }));
      commitProbe(message);
    }
  }, [commitProbe]);

  useEffect(() => {
    const timer = setTimeout(fetchHealth, 0);

    const interval = setInterval(fetchHealth, pollIntervalMs);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      controllerRef.current?.abort();
    };
  }, [fetchHealth, pollIntervalMs]);

  return { ...state, refetch: fetchHealth };
}