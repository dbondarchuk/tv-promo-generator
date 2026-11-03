import { AppSettings, HardwareAcceleration } from "@promo/shared";

export interface EncoderPlan {
  videoEncoder: string;
  inputArgs: string[];
  outputVideoArgs: string[];
  filterSuffix: string[];
}

export function buildEncoderPlan(settings: AppSettings): EncoderPlan {
  const isHevc = settings.videoCodec === "Hevc";
  const bitrate = `${settings.videoBitrate}k`;
  const accel = settings.hardwareAcceleration;

  switch (accel as HardwareAcceleration) {
    case "Nvenc":
      return {
        videoEncoder: isHevc ? "hevc_nvenc" : "h264_nvenc",
        // Complex filtergraphs need system-memory frames; decode in software.
        inputArgs: [],
        outputVideoArgs: [
          "-c:v",
          isHevc ? "hevc_nvenc" : "h264_nvenc",
          "-preset",
          settings.videoPreset || "p4",
          "-b:v",
          bitrate,
          "-profile:v",
          settings.videoProfile || "high",
        ],
        filterSuffix: [],
      };
    case "Qsv":
      return {
        videoEncoder: isHevc ? "hevc_qsv" : "h264_qsv",
        // Do not use -hwaccel qsv here: decode+filters need system frames.
        inputArgs: [],
        outputVideoArgs: [
          "-c:v",
          isHevc ? "hevc_qsv" : "h264_qsv",
          "-b:v",
          bitrate,
        ],
        filterSuffix: [],
      };
    case "Vaapi":
      return {
        videoEncoder: isHevc ? "hevc_vaapi" : "h264_vaapi",
        inputArgs: [],
        outputVideoArgs: [
          "-c:v",
          isHevc ? "hevc_vaapi" : "h264_vaapi",
          "-b:v",
          bitrate,
        ],
        filterSuffix: ["format=nv12", "hwupload"],
      };
    case "Amf":
      return {
        videoEncoder: isHevc ? "hevc_amf" : "h264_amf",
        inputArgs: [],
        outputVideoArgs: [
          "-c:v",
          isHevc ? "hevc_amf" : "h264_amf",
          "-b:v",
          bitrate,
        ],
        filterSuffix: [],
      };
    case "VideoToolbox":
      return {
        videoEncoder: isHevc ? "hevc_videotoolbox" : "h264_videotoolbox",
        inputArgs: [],
        outputVideoArgs: [
          "-c:v",
          isHevc ? "hevc_videotoolbox" : "h264_videotoolbox",
          "-b:v",
          bitrate,
        ],
        filterSuffix: [],
      };
    case "None":
    default:
      return {
        videoEncoder: isHevc ? "libx265" : "libx264",
        inputArgs: [],
        outputVideoArgs: [
          "-c:v",
          isHevc ? "libx265" : "libx264",
          "-preset",
          settings.videoPreset || "medium",
          "-profile:v",
          settings.videoProfile || "high",
          "-b:v",
          bitrate,
        ],
        filterSuffix: [],
      };
  }
}

export function globalHwArgs(settings: AppSettings): string[] {
  if (settings.hardwareAcceleration === "Vaapi") {
    const args = [
      "-vaapi_device",
      settings.vaapiDevice || "/dev/dri/renderD128",
    ];

    if (settings.vaapiDriver && settings.vaapiDriver !== "Default") {
      // LIBVA_DRIVER_NAME is env, not an ffmpeg arg; document via docker.
    }

    return args;
  }

  if (settings.hardwareAcceleration === "Qsv") {
    const device = settings.vaapiDevice || "/dev/dri/renderD128";
    return [
      "-init_hw_device",
      `qsv=hw,child_device=${device}`,
      "-filter_hw_device",
      "hw",
    ];
  }

  return [];
}

/** True when stderr looks like a missing/broken GPU encode path (safe to soft-fallback). */
export function isHardwareEncodeFailure(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("error initializing an mfx session") ||
    text.includes("device creation failed") ||
    text.includes("device setup failed") ||
    text.includes("no device available for decoder") ||
    text.includes("cannot load libcuda") ||
    text.includes("no nvenc capable devices") ||
    text.includes("failed to create a cuda context") ||
    (text.includes("vaapi") && text.includes("failed")) ||
    (text.includes("qsv") &&
      (text.includes("failed") || text.includes("error"))) ||
    (text.includes("nvenc") &&
      (text.includes("failed") || text.includes("error"))) ||
    (text.includes("impossible to open") && text.includes("/dev/dri"))
  );
}

/**
 * Escape for drawtext when embedded in -filter_complex.
 * ASCII apostrophe breaks ffmpeg's quoted option parser no matter how many
 * backslashes we add — replace with U+2019 (looks the same on screen).
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

export function escapeFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:");
}
