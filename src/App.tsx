import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { app, on, fetchExternal, type AppContext } from "./manufact-sdk";
import { WORLD_LAND_PATH } from "./worldLand";
import "./styles.css";

const ENDPOINT = "https://api.wheretheiss.at/v1/satellites/25544";

type Position = {
  latitude: number;
  longitude: number;
  /** Unix seconds, exactly as reported by the API. */
  timestamp: number;
  /** When this app received the response (ms). */
  receivedAt: number;
};

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
  const requestId = useRef(0);
  const started = useRef(false);

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

      setPosition({ latitude, longitude, timestamp, receivedAt: Date.now() });
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
      </main>

      <footer className="foot">
        <span className="foot-endpoint">{ENDPOINT}</span>
        <span className="foot-note">No API key · no location access · no stored data</span>
      </footer>
    </div>
  );
}
