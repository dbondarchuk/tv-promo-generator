import mpegts from "mpegts.js";
import { useEffect, useRef, useState } from "react";

/**
 * Click-to-start live MPEG-TS preview (`promo.ts` — same URL ETV uses).
 * Avoids auto-starting an ffmpeg encode for every channel card.
 */
export function LivePromoPreview(props: { src: string; channelLabel: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<mpegts.Player | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    return () => {
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          // ignore
        }
      }

      const v = videoRef.current;
      if (!v) return;

      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        // ignore
      }
    };
  }, []);

  function teardownPlayer() {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      try {
        player.pause();
        player.unload();
        player.detachMediaElement();
        player.destroy();
      } catch {
        // ignore
      }
    }

    const v = videoRef.current;
    if (!v) return;

    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {
      // ignore
    }
  }

  async function startPreview() {
    setError("");
    setStarting(true);
    setActive(true);

    // Wait until React mounts <video> before attaching the player.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const v = videoRef.current;
    if (!v) {
      setStarting(false);
      setError("Preview player missing");
      return;
    }

    try {
      if (!mpegts.isSupported()) {
        setError("MPEG-TS playback is not supported in this browser");
        return;
      }

      // Workers reject relative URLs — resolve against the page origin.
      const url = new URL(props.src, window.location.href).href;

      const player = mpegts.createPlayer(
        {
          type: "mse",
          isLive: true,
          url,
        },
        {
          enableWorker: true,
          enableStashBuffer: true,
          stashInitialSize: 384,
          liveBufferLatencyChasing: false,
        },
      );

      playerRef.current = player;
      player.attachMediaElement(v);

      player.on(mpegts.Events.ERROR, (_type, _detail, info) => {
        const msg =
          info && typeof info === "object" && "msg" in info
            ? String((info as { msg?: string }).msg)
            : "playback error";

        setError(
          `Live preview failed for ${props.channelLabel} (${msg}). Check server logs / upcoming media paths.`,
        );
      });

      player.load();
      await v.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      teardownPlayer();
    } finally {
      setStarting(false);
    }
  }

  function stopPreview() {
    teardownPlayer();
    setActive(false);
    setStarting(false);
    setError("");
  }

  if (!active) {
    return (
      <div className="live-preview idle">
        <button type="button" onClick={() => void startPreview()}>
          Preview live
        </button>
        <span className="muted">Starts a live encode for this channel</span>
      </div>
    );
  }

  return (
    <div className="live-preview active">
      <video
        ref={videoRef}
        controls
        playsInline
        muted
        autoPlay
        onError={() =>
          setError(
            `Live preview failed for ${props.channelLabel}. Check server logs / upcoming media paths.`,
          )
        }
      />
      <div className="row">
        <button type="button" onClick={stopPreview}>
          Stop preview
        </button>
        {starting && <span className="muted">Starting encode…</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
