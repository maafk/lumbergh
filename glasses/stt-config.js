// Copied verbatim from ~/.config/blurt/config.toml. WhisperLive applies these at
// decode time, which is why this vocabulary is worth carrying rather than
// post-correcting: the words are recognised, not repaired.
export const STT = {
  // The STT target itself is backend config now (settings["glasses"]["stt"]);
  // the page only needs the same-origin path it proxies through.
  path: "/api/glasses/stt",
  model: "deepdml/faster-whisper-large-v3-turbo-ct2",
  language: "en",
  useVad: true,
  initialPrompt:
    "Technical dictation about software development. I use Claude and Claude Code daily, and deploy to cloud hosts behind Cloudflare. Other terms: GitHub, GitLab, kubectl, Kubernetes, Docker, Postgres, JSON, YAML, TOML, npm, PyPI, Python, TypeScript, Sherpa, FleetView, Obsidian, Jira, Grafana, Sentry, Tailscale, CapRover, systemd, Wayland, Hyprland, Omarchy, tmux, uv, gcloud, llmbox, blurt.",
  hotwords:
    "Claude,Claude Code,gcloud,kubectl,GitHub,GitLab,JSON,YAML,TOML,npm,PyPI,Postgres,Sherpa,FleetView,Obsidian,CapRover,Tailscale,Hyprland,Omarchy,llmbox,blurt",
};
