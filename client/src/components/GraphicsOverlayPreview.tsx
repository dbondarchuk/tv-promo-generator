import type { GraphicsPhase } from "@promo/shared";
import { useState } from "react";

const PHASES: { value: GraphicsPhase; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "next", label: "Next" },
];

export function GraphicsOverlayPreview(props: {
  channelNumber: string;
  channelName: string;
  language: string;
  /** Prefer currently airing item; fall back to first upcoming. */
  mediaItemId?: number;
}) {
  const [phase, setPhase] = useState<GraphicsPhase>("now");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function clearPreview() {
    setPreviewUrl("");
    setError("");
  }

  function onPreview() {
    const params = new URLSearchParams({
      phase,
      channelNumber: props.channelNumber,
      channelName: props.channelName,
      language: props.language,
      t: String(Date.now()),
    });

    // Optional pin — otherwise the server resolves the current schedule item.
    if (props.mediaItemId) {
      params.set("mediaItemId", String(props.mediaItemId));
    }

    setLoading(true);
    setError("");
    setPreviewUrl(`/graphics/overlay.png?${params.toString()}`);
  }

  return (
    <div className="graphics-preview">
      <div className="row" style={{ alignItems: "flex-end", gap: 8 }}>
        <label style={{ flex: "0 0 auto", marginBottom: 0 }}>
          Overlay
          <select
            value={phase}
            onChange={(e) => {
              setPhase(e.target.value as GraphicsPhase);
              clearPreview();
            }}
          >
            {PHASES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={loading}
          title="Render overlay PNG for this channel (no auto-load)"
          onClick={onPreview}
        >
          Preview
        </button>
        {previewUrl && (
          <button
            type="button"
            className="secondary"
            onClick={clearPreview}
            title="Hide preview"
          >
            Clear
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Mid on ETV plays Now, then Next (separate banners with fade).
      </p>
      {error && <div className="error">{error}</div>}
      {previewUrl && (
        <img
          className="graphics-preview-img"
          src={previewUrl}
          alt={`${props.channelName} ${phase} overlay`}
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setError("Failed to render overlay.");
            setPreviewUrl("");
          }}
        />
      )}
      {loading && !error && <div className="muted">Rendering…</div>}
    </div>
  );
}
