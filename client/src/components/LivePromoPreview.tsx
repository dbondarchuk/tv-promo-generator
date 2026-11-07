import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

/**
 * Click-to-start live HLS preview (`promo.m3u8`; shares encode with ETV's `promo.ts`).
 * Avoids auto-starting an ffmpeg encode for every channel card.
 */
export function LivePromoPreview(props: { src: string; channelLabel: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    return () => {
      const hls = hlsRef.current;
      hlsRef.current = null;
      if (hls) {
        try {
          hls.destroy();
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
    const hls = hlsRef.current;
    hlsRef.current = null;
    if (hls) {
      try {
        hls.destroy();
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

    // Wait until React mounts <video> before attaching HLS.
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
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          liveDurationInfinity: true,
        });

        hlsRef.current = hls;
        hls.loadSource(props.src);
        hls.attachMedia(v);

        await new Promise<void>((resolve, reject) => {
          const onManifest = () => {
            hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
            hls.off(Hls.Events.ERROR, onFail);
            resolve();
          };

          const onFail = (
            _event: string,
            data: { fatal: boolean; type: string },
          ) => {
            if (!data.fatal) return;

            hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
            hls.off(Hls.Events.ERROR, onFail);
            reject(
              new Error(
                data.type === Hls.ErrorTypes.NETWORK_ERROR
                  ? "HLS network error"
                  : data.type === Hls.ErrorTypes.MEDIA_ERROR
                    ? "HLS media error"
                    : "HLS playback error",
              ),
            );
          };

          hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
          hls.on(Hls.Events.ERROR, onFail);
        });

        await v.play();
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = props.src;
        v.load();
        await v.play();
      } else {
        setError("HLS is not supported in this browser");
      }
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
