import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { app, cloud, on, fetchExternal, type AppContext } from "./manufact-sdk";
import { WORLD_LAND_PATH } from "./worldLand";
import "./styles.css";

const ENDPOINT = "https://api.wheretheiss.at/v1/satellites/25544";

type Position = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  velocity: number | null;
  /** Unix seconds, exactly as reported by the API. */
  timestamp: number;
  /** When this app received the response (ms). */
  receivedAt: number;
};

/** One row of the app's private iss_snapshots table. */
type Snapshot = {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number | null;
  velocity: number | null;
};

/** A row of the App Cloud iss_snapshots table (bigint may arrive as a string). */
type SnapshotRow = {
  snapshot_ts: number | string;
  latitude: number | string;
  longitude: number | string;
  altitude: number | string | null;
  velocity: number | string | null;
};

const SELECT_SNAPSHOTS =
  "SELECT snapshot_ts, latitude, longitude, altitude, velocity FROM iss_snapshots ORDER BY id DESC LIMIT 10";

const INSERT_SNAPSHOT =
  "INSERT INTO iss_snapshots (snapshot_ts, latitude, longitude, altitude, velocity) VALUES (?, ?, ?, ?, ?)";

/** Keep only the newest 500 rows of the current user's history. */
const PRUNE_SNAPSHOTS = `DELETE FROM iss_snapshots
  WHERE owner = app.user_id()
    AND id NOT IN (
      SELECT id FROM iss_snapshots
       WHERE owner = app.user_id()
       ORDER BY id DESC
       LIMIT 500
    )`;

function toSnapshot(row: SnapshotRow): Snapshot {
  const num = (v: number | string) => Number(v);
  const opt = (v: number | string | null) =>
    v === null || v === undefined ? null : Number(v);
  return {
    timestamp: num(row.snapshot_ts),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    altitude: opt(row.altitude),
    velocity: opt(row.velocity),
  };
}

function formatRowTime(unixSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function formatAltitude(km: number | null): string {
  return km === null ? "—" : `${km.toFixed(1)} km`;
}

function formatVelocity(kmh: number | null, locale: string): string {
  if (kmh === null) return "—";
  return `${Math.round(kmh).toLocaleString(locale)} km/h`;
}

type Problem = {
  /** What failed, in the user's terms. */
  title: string;
  /** The exact message from the API or the bridge, verbatim. */
  detail: string;
};

function numberFrom(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function formatCoord(value: number, axis: "lat" | "lon"): string {
  const abs = Math.abs(value).toFixed(4);
  const suffix =
    axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${abs}° ${suffix}`;
}

function formatApiTime(unixSeconds: number, locale: string): string {
  const date = new Date(unixSeconds * 1000);
  const base = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
  const zone = new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return zone ? `${base} ${zone}` : base;
}

export function App() {
  const [ctx, setCtx] = useState<AppContext | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [accent, setAccent] = useState<string>("#3b82f6");
  const [position, setPosition] = useState<Position | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [storeProblem, setStoreProblem] = useState<string | null>(null);
  const requestId = useRef(0);
  const started = useRef(false);

  const describeStoreError = (error: unknown): string => {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    return code ? `${code}: ${message}` : message;
  };

  const loadSnapshots = useCallback(async () => {
    const result = await cloud.db.query(SELECT_SNAPSHOTS);
    setSnapshots(cloud.db.rows<SnapshotRow>(result).map(toSnapshot));
  }, []);

  useEffect(() => {
    void app.ready().then((c) => {
      setCtx(c);
      setTheme(c.theme);
      if (c.accent) setAccent(c.accent);
      void app.setTitle("Live ISS Tracker");
    });
    const offTheme = on("theme", (data) => {
      const t = (data as { theme?: "light" | "dark" }).theme;
      if (t) setTheme(t);
    });
    const offLang = on("lang", () => {
      // Re-render so the timestamp picks up the OS language.
      setCtx((current) => (current ? { ...current } : current));
    });
    return () => {
      offTheme();
      offLang();
    };
  }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setProblem(null);

    try {
      const res = await fetchExternal(ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (id !== requestId.current) return;

      if (res.status < 200 || res.status >= 300) {
        setProblem({
          title: `The station API answered with HTTP ${res.status}.`,
          detail: res.body?.slice(0, 400) || "(empty response body)",
        });
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        setProblem({
          title: "The station API returned a response that is not JSON.",
          detail: res.body?.slice(0, 400) || "(empty response body)",
        });
        return;
      }

      const latitude = numberFrom(body, "latitude");
      const longitude = numberFrom(body, "longitude");
      const timestamp = numberFrom(body, "timestamp");

      if (latitude === null || longitude === null || timestamp === null) {
        setProblem({
          title: "The station API response is missing position data.",
          detail: `latitude=${latitude ?? "missing"}, longitude=${longitude ?? "missing"}, timestamp=${timestamp ?? "missing"}`,
        });
        return;
      }

      const altitude = numberFrom(body, "altitude");
      const velocity = numberFrom(body, "velocity");

      setPosition({
        latitude,
        longitude,
        altitude,
        velocity,
        timestamp,
        receivedAt: Date.now(),
      });

      // Save this fix to App Cloud (insert + prune to the newest 500 in one
      // transaction), then show the ten most recent rows. A storage failure
      // never hides the live reading.
      if (!cloud.available()) {
        setStoreProblem(
          "App Cloud needs MoteOS bridge 1.8 — update the system to keep a shared history.",
        );
      } else {
        try {
          await cloud.db.batch([
            {
              sql: INSERT_SNAPSHOT,
              params: [timestamp, latitude, longitude, altitude, velocity],
            },
            { sql: PRUNE_SNAPSHOTS },
          ]);
          await loadSnapshots();
          setStoreProblem(null);
        } catch (error) {
          setStoreProblem(describeStoreError(error));
        }
      }
    } catch (error) {
      if (id !== requestId.current) return;
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown error");
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      setProblem({
        title: "Could not reach api.wheretheiss.at.",
        detail: code ? `${code}: ${message}` : message,
      });
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  // Ask for one live fix as soon as the app opens; Refresh always asks again.
  useEffect(() => {
    if (!ctx || started.current) return;
    started.current = true;
    void refresh();
  }, [ctx, refresh]);

  // Show the history saved by earlier sessions before (or without) a refresh.
  useEffect(() => {
    if (!ctx || !cloud.available()) return;
    let cancelled = false;
    void (async () => {
      try {
        await loadSnapshots();
        if (!cancelled) setStoreProblem(null);
      } catch (error) {
        if (!cancelled) setStoreProblem(describeStoreError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, loadSnapshots]);

  // First screen is on screen: let the host fade out its loading animation.
  useEffect(() => {
    if (ctx) void app.loaded();
  }, [ctx]);

  const locale = ctx?.lang || navigator.language || "en";

  return (
    <div className="app" data-theme={theme} style={{ "--accent": accent } as CSSProperties}>
      <header className="head">
        <div className="head-text">
          <p className="eyebrow">Orbital telemetry · Zarya 25544</p>
          <h1>Live ISS Tracker</h1>
          <p className="sub">
            Live position of the International Space Station, straight from
            api.wheretheiss.at.
          </p>
        </div>
        <button
          type="button"
          className="refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Refreshing…
            </>
          ) : (
            <>
              <span className="icon" aria-hidden="true">⟳</span>
              Refresh
            </>
          )}
        </button>
      </header>

      <main className="main">
        <section className="panel map-panel" aria-label="Position on the world map">
          <div className="map">
            <svg
              className="map-svg"
              viewBox="0 0 360 180"
              preserveAspectRatio="none"
              role="img"
              aria-label={
                position
                  ? `International Space Station at ${formatCoord(position.latitude, "lat")}, ${formatCoord(position.longitude, "lon")}`
                  : "World map, waiting for a position"
              }
            >
              <path className="land" d={WORLD_LAND_PATH} />
              <g className="graticule">
                {[30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((x) => (
                  <line key={`v${x}`} x1={x} y1={0} x2={x} y2={180} />
                ))}
                {[30, 60, 120, 150].map((y) => (
                  <line key={`h${y}`} x1={0} y1={y} x2={360} y2={y} />
                ))}
                <line className="equator" x1={0} y1={90} x2={360} y2={90} />
                <line className="meridian" x1={180} y1={0} x2={180} y2={180} />
              </g>

              {position && (
                <g
                  className="station"
                  transform={`translate(${position.longitude + 180} ${90 - position.latitude})`}
                >
                  <circle className="pulse" r="1.6" />
                  <circle className="dot" r="1.7" />
                  <text className="tag" y="-4.2" textAnchor="middle">
                    ISS
                  </text>
                </g>
              )}
            </svg>

            {!position && !problem && (
              <div className="map-empty">
                {loading ? "Contacting the station…" : "No fix yet"}
              </div>
            )}
            {!position && problem && (
              <div className="map-empty muted">Position unavailable</div>
            )}
          </div>
          <p className="map-caption">
            <span className="legend-dot" aria-hidden="true" />
            Live position · equirectangular grid, 30°
          </p>
        </section>

        <section className="panel readout" aria-live="polite" aria-busy={loading}>
          <div className="stat">
            <p className="stat-label">Latitude</p>
            <p className="stat-value">
              {position ? formatCoord(position.latitude, "lat") : "—"}
            </p>
            <p className="stat-raw">
              {position ? position.latitude.toFixed(4) : " "}
            </p>
          </div>

          <div className="stat">
            <p className="stat-label">Longitude</p>
            <p className="stat-value">
              {position ? formatCoord(position.longitude, "lon") : "—"}
            </p>
            <p className="stat-raw">
              {position ? position.longitude.toFixed(4) : " "}
            </p>
          </div>

          <div className="stat wide">
            <p className="stat-label">API timestamp</p>
            <p className="stat-value time">
              {position ? formatApiTime(position.timestamp, locale) : "—"}
            </p>
            <p className="stat-raw">
              {position ? `unix ${position.timestamp}` : " "}
            </p>
          </div>

          {loading && (
            <p className="status status-loading">
              <span className="spinner dark" aria-hidden="true" />
              Requesting a live fix from api.wheretheiss.at…
            </p>
          )}

          {problem && (
            <div className="status status-error" role="alert">
              <p className="status-title">{problem.title}</p>
              <pre className="status-detail">{problem.detail}</pre>
              <p className="status-hint">
                No cached or sample values are shown — the numbers above only
                ever come from a successful live response.
              </p>
            </div>
          )}

          {position && !problem && !loading && (
            <p className="status status-ok">
              Live fix received at {new Date(position.receivedAt).toLocaleTimeString(locale)}
            </p>
          )}
        </section>

        <section className="panel history" aria-label="Recent snapshots">
          <div className="history-head">
            <h2>Recent snapshots</h2>
            <span className="history-sub">
              Last 10 saved fixes · stored in this app's App Cloud
            </span>
          </div>

          {snapshots.length === 0 ? (
            <p className="history-empty">
              {!cloud.available()
                ? "App Cloud is unavailable on this MoteOS version — history cannot be shown."
                : "No snapshots yet — every successful refresh adds one."}
            </p>
          ) : (
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th scope="col">API time</th>
                    <th scope="col" className="num">Latitude</th>
                    <th scope="col" className="num">Longitude</th>
                    <th scope="col" className="num">Altitude</th>
                    <th scope="col" className="num">Velocity</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((snap, index) => (
                    <tr key={`${snap.timestamp}-${index}`}>
                      <td className="cell-time">
                        {formatRowTime(snap.timestamp, locale)}
                      </td>
                      <td className="num">{formatCoord(snap.latitude, "lat")}</td>
                      <td className="num">{formatCoord(snap.longitude, "lon")}</td>
                      <td className="num">{formatAltitude(snap.altitude)}</td>
                      <td className="num">{formatVelocity(snap.velocity, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {storeProblem && (
            <p className="history-error" role="status">
              History store error — {storeProblem}
            </p>
          )}
        </section>
      </main>

      <footer className="foot">
        <span className="foot-endpoint">{ENDPOINT}</span>
        <span className="foot-note">
          No API key · no location access · snapshot history in App Cloud
        </span>
      </footer>
    </div>
  );
}
