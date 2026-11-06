import { useEffect, useRef, useState } from "react";

/**
 * Click-to-start live fMP4 preview. Avoids auto-starting an ffmpeg encode for
 * every channel card (which left the native play control stuck / unusable).
 */
export function LivePromoPreview(props: { src: string; channelLabel: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    return () => {
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

  async function startPreview() {
    setError("");
    setStarting(true);
    setActive(true);

    // Wait until React mounts <video src=…> before calling play().
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
      v.load();
      await v.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  function stopPreview() {
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        // ignore
      }
    }

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
        src={props.src}
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
