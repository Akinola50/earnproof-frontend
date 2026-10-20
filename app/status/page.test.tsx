/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StatusPage from "./page";

jest.mock("@/components/layout/public-shell", () => ({
  PublicShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/common/page-heading", () => ({
  PageHeading: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

jest.mock("@/components/common/production-ui", () => ({
  pageContainer: "page-container",
  MetricGrid: ({ items }: { items: { value: string; label: string }[] }) => (
    <section>
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.value}</span> – <span>{item.label}</span>
        </div>
      ))}
    </section>
  ),
  StatusBadge: ({
    children,
    tone,
  }: {
    children: React.ReactNode;
    tone?: string;
  }) => (
    <span data-tone={tone}>{children}</span>
  ),
  DataPanel: ({
    headers,
    rows,
    searchPlaceholder,
  }: {
    headers: string[];
    rows: {
      primary: string;
      secondary: string;
      tertiary: string;
      status: string;
    }[];
    searchPlaceholder: string;
  }) => (
    <section>
      <input placeholder={searchPlaceholder} />
      <div>
        {headers.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {rows.map((row) => (
        <article key={row.primary}>
          <span>{row.primary}</span>
          <span>{row.secondary}</span>
          <span>{row.tertiary}</span>
          <span>{row.status}</span>
        </article>
      ))}
    </section>
  ),
}));

const HEALTH_OK = {
  status: "ok",
  service: "earrproof-api",
  database: "ok",
  timestamp: new Date().toISOString(),
};

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = jest.fn().mockResolved({
    ok: true,
    json: async () => HEALTH_OK,
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

describe("StatusPage", () => {
  it("renders the page heading and initial loading state", () => {
    render(<StatusPage />);

    expect(
      screen.getByRole("heading", { name: "System status" }),
    ).toBeInDocument();
    expect(
      screen.getByText(/Live health for the EarnProof API/),
    ).toBeInTheDocument();
  });

  it("shows the loading skeleton before the first health check resolves", () => {
    render(<StatusPage />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Checking system status...")).toBeInTheDocument();
    expect(screen.queryByText("EarnProof API")).not.toBeInDocument();
  });

  it("renders live health data after fetch succeeds", async () => {
    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    });

    expect(screen.getByText("EarnProof API")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getAllByText("Global").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Just now").length).toBeGreaterThan(0);
    // The loading skeleton's busy status region is gone once data has
    // loaded (a separate, always-present status region now exists for the
    // support diagnostics export's screen-reader announcements).
    expect(screen.queryByText("Checking system status...")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument();
  });

  it("shows error banner when fetch fails", async () => {
    (global.fetch as jest.Mock).mockRejectedOnce(
      new TypeError("Failed to fetch"),
    );

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/Unable to reach/)).toBeInTheDocument();
    });
  });

  it("shows timeout error state", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );

    render(<StatusPage />);

    act(() => {
      jest.advanceTimesByTime(10_000);
    });

    await waitFor(() => {
      expect(screen.getByText(/Timed out/)).toBeInTheDocument();
    });
  });

  it("shows retry button and refetches on click", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    (global.fetch as jest.Mock).mockRejectedOnce(
      new TypeError("Failed to fetch"),
    );

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    (global.fetch as jest.Mock).mockResolvedOnce({
      ok: true,
      json: async () => HEALTH_OK,
    });

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    });
  });

  it("labels retained data as cached once a poll fails, then clears the label on recovery", async () => {
    (global.fetch as jest.Mock).mockResolvedOnce({
      ok: true,
      json: async () => HEALTH_OK,
    });

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByText(/Showing the last known status/),
    ).not.toBeInTheDocument();

    (global.fetch as jest.Mock).mockRejectedOnce(
      new TypeError("Failed to fetch"),
    );

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Showing the last known status/),
      ).toBeInTheDocument();
    });
    // The service rows are still showing the previously fetched data, not
    // wiped out by the failed poll.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);

    (global.fetch as jest.Mock).mockResolvedOnce({
      ok: true,
      json: async () => HEALTH_OK,
    });

    act(() => {
      jest.advanceTimesByTime(30_000);
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/Showing the last known status/),
      ).not.toBeInTheDocument();
    });
  });

  it("renders all expected service rows", async () => {
    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getByText("EarnProof API")).toBeInTheDocument();
    });

    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("Stellar indexer")).toBeInTheDocument();
    expect(screen.getByText("Smart contracts")).toBeInTheDocument();
    expect(screen.getByText("Webhook delivery")).toBeInTheDocument();
  });

  it("shows last checked timestamp", async () => {
    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/Last checked:/)).toBeInTheDocument();
    });
  });

  it("does not flip to degraded after a single failed probe (hysteresis)", async () => {
    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    });

    (global.fetch as jest.Mock).mockRejectedOnce(
      new TypeError("Failed to fetch"),
    );

    act(() => {
      jest.advanceTimesByTime(30_000);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Showing the last known status/),
      ).toBeInTheDocument();
    });

    // A single failed probe must not promote the dependency to a
    // degraded/outage status; the last known healthy status is retained.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Outage/)).not.toBeInTheDocument();
  });

  it("surfaces an outage timeline after sustained failures", async () => {
    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    });

    for (let i = 0; i < 3; i++) {
      (global.fetch as jest.Mock).mockRejectedOnce(
        new TypeError("Failed to fetch"),
      );
      act(() => {
        jest.advanceTimesByTime(30_000);
      });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });
    }

    await waitFor(() => {
      expect(screen.getByText(/Outage/)).toBeInTheDocument();
    });
  });
});
