# Appendix: ACMI skill triage (2026-10-19)

Generated from `~/.hermes/skills`, which includes the ACMI skill pack through the `acmi` symlink to `~/clawd/skills/acmi` (repo madezmedia/acmi-multi-agent-coordination-protocol). Counts are raw-Redis and `acmi_*` tool mentions per SKILL.md.

All 169 files: Hermes 94, ACMI pack 75. By group: archived 19, deep 30, junk 8, light 38, recovery variant 52, track variant 22.

New LogMem skills that result: 16 from the ACMI skills (5 product: core, read-path recovery, track and outage, self-host, SDK primitives; 11 fleet). Two more product skills are new, from the fleet docs: logmem-decisions and logmem-onboard-agent. The rest are left, retired, deleted or edited in place.

| Source | Skill | Group | Action | LogMem skill | raw Redis | acmi tools |
|---|---|---|---|---|---|---|
| hermes | `.archive/acmi-agent-onboarding` | archived | leave |  | 27 | 9 |
| hermes | `.archive/acmi-console` | archived | leave |  | 20 | 0 |
| hermes | `.archive/acmi-data-pipeline` | archived | leave |  | 30 | 0 |
| hermes | `.archive/acmi-orchestrator-correction-inference` | archived | leave |  | 0 | 2 |
| hermes | `.archive/agent-report-validation` | archived | leave |  | 0 | 2 |
| hermes | `.archive/android-mobile-agent` | archived | leave |  | 1 | 2 |
| hermes | `.archive/client-proposal-pipeline` | archived | leave |  | 3 | 0 |
| hermes | `.archive/commerce-platform-expansion` | archived | leave |  | 0 | 3 |
| hermes | `.archive/community-engagement-acquisition` | archived | leave |  | 0 | 0 |
| hermes | `.archive/community-engagement` | archived | leave |  | 0 | 0 |
| hermes | `.archive/community-outreach` | archived | leave |  | 0 | 0 |
| hermes | `.archive/firecrawl-fleet-scraper` | archived | leave |  | 0 | 0 |
| hermes | `.archive/nextjs-fullstack` | archived | leave |  | 12 | 0 |
| hermes | `.archive/property-showcase-pattern` | archived | leave |  | 0 | 0 |
| hermes | `.archive/repo-deployment-audit` | archived | leave |  | 0 | 0 |
| hermes | `.archive/research-to-deliverable-packaging` | archived | leave |  | 3 | 0 |
| hermes | `.archive/serpbear-seo-integration` | archived | leave |  | 0 | 0 |
| hermes | `.archive/super-bus` | archived | leave |  | 7 | 1 |
| hermes | `.archive/vapi-voice-agent-prompting` | archived | leave |  | 0 | 0 |
| hermes | `acmi-coherence-lock-track-v2` | track variant | merge | `logmem-track-outage` | 9 | 0 |
| hermes | `acmi-cron-track` | track variant | merge | `logmem-track-outage` | 1 | 0 |
| hermes | `acmi-read-path-discipline` | deep | rewrite (product) | `logmem-read-path-recovery` | 22 | 6 |
| hermes | `acmi-read-path-outage-write-failure` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| hermes | `acmi-read-path-outage` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| hermes | `acmi-redis-read-resilience-test` | deep | rewrite (product) | `logmem-read-path-recovery` | 0 | 0 |
| hermes | `acmi-redis-shape-notes` | deep | rewrite (product) | `logmem-read-path-recovery` | 2 | 0 |
| hermes | `acmi-self-hosted-redis` | deep | rewrite (product) | `logmem-self-host` | 105 | 18 |
| hermes | `acmi-test-probe-write` | junk | list for deletion |  | 0 | 0 |
| hermes | `acmi-total-outage-write-failure` | recovery variant | merge | `logmem-read-path-recovery` | 3 | 0 |
| hermes | `acmi-track-bridge-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 12 | 0 |
| hermes | `acmi-track-only-cron-complete` | track variant | merge | `logmem-track-outage` | 12 | 0 |
| hermes | `acmi-track-only-cron-test` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| hermes | `acmi-track-only-silent` | track variant | merge | `logmem-track-outage` | 2 | 0 |
| hermes | `acmi-track-outage-emit` | recovery variant | merge | `logmem-read-path-recovery` | 7 | 0 |
| hermes | `acmi-track-outage-silent-exit` | recovery variant | merge | `logmem-read-path-recovery` | 9 | 0 |
| hermes | `acmi-track-total-outage-silent-exit` | recovery variant | merge | `logmem-read-path-recovery` | 8 | 0 |
| hermes | `acmi-typescript-primitives` | deep | rewrite (product) | `logmem-sdk-primitives` | 27 | 1 |
| pack | `acmi` | deep | rewrite (product) | `logmem (core skill)` | 6 | 5 |
| pack | `acmi/acmi-bridge-fallback-local` | recovery variant | merge | `logmem-read-path-recovery` | 10 | 0 |
| pack | `acmi/acmi-bridge-fallback-observations` | recovery variant | merge | `logmem-read-path-recovery` | 2 | 0 |
| pack | `acmi/acmi-bridge-flatlist` | recovery variant | merge | `logmem-read-path-recovery` | 1 | 0 |
| pack | `acmi/acmi-bridge-local-redis-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 15 | 0 |
| pack | `acmi/acmi-bridge-local-relay-pitfall` | recovery variant | merge | `logmem-read-path-recovery` | 4 | 0 |
| pack | `acmi/acmi-bridge-outage-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 2 | 0 |
| pack | `acmi/acmi-bridge-outage-recovery` | recovery variant | merge | `logmem-read-path-recovery` | 6 | 0 |
| pack | `acmi/acmi-bridge-persistent-outage` | recovery variant | merge | `logmem-read-path-recovery` | 8 | 0 |
| pack | `acmi/acmi-bridge-read-pattern` | recovery variant | merge | `logmem-read-path-recovery` | 1 | 0 |
| pack | `acmi/acmi-bridge-upstash-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 16 | 0 |
| pack | `acmi/acmi-coherence-lock-track` | track variant | merge | `logmem-track-outage` | 6 | 0 |
| pack | `acmi/acmi-console` | deep | retire | replaced by logmem.si/app | 17 | 0 |
| pack | `acmi/acmi-cron-learnings` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-cron-track` | track variant | merge | `logmem-track-outage` | 1 | 0 |
| pack | `acmi/acmi-degraded-mcp-signals` | recovery variant | merge | `logmem-read-path-recovery` | 0 | 2 |
| pack | `acmi/acmi-l1-cron-track-pattern` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-l1-cron-track` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-local-keyspace-diagnosis` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| pack | `acmi/acmi-local-redis-fallback-sequence` | recovery variant | merge | `logmem-read-path-recovery` | 4 | 0 |
| pack | `acmi/acmi-local-redis-no-auth` | recovery variant | merge | `logmem-read-path-recovery` | 15 | 0 |
| pack | `acmi/acmi-local-redis-sparse-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 4 | 0 |
| pack | `acmi/acmi-localhost-last-resort` | deep | merge | `logmem-read-path-recovery` | 7 | 0 |
| pack | `acmi/acmi-ops-heartbeat` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| pack | `acmi/acmi-ops-quiet-channel` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| pack | `acmi/acmi-ops-track-fallback-note` | recovery variant | merge | `logmem-read-path-recovery` | 3 | 0 |
| pack | `acmi/acmi-ops-track-local` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-ops-track` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-probe-test` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| pack | `acmi/acmi-read-failure-patterns` | deep | merge | `logmem-read-path-recovery` | 6 | 0 |
| pack | `acmi/acmi-read-path-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 1 | 0 |
| pack | `acmi/acmi-read-path-outage-local` | recovery variant | merge | `logmem-read-path-recovery` | 7 | 0 |
| pack | `acmi/acmi-read-path-outage-patch-check` | recovery variant | merge | `logmem-read-path-recovery` | 0 | 0 |
| pack | `acmi/acmi-read-path-outage-signatures` | recovery variant | merge | `logmem-read-path-recovery` | 6 | 0 |
| pack | `acmi/acmi-read-path-outage` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| pack | `acmi/acmi-read-path-verification` | recovery variant | merge | `logmem-read-path-recovery` | 6 | 0 |
| pack | `acmi/acmi-redis-cli-fallback-correction` | recovery variant | merge | `logmem-read-path-recovery` | 16 | 0 |
| pack | `acmi/acmi-redis-cli-fallback-pattern` | recovery variant | merge | `logmem-read-path-recovery` | 17 | 0 |
| pack | `acmi/acmi-redis-cli-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 17 | 0 |
| pack | `acmi/acmi-redis-read-resilience` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| pack | `acmi/acmi-sparse-keyspace-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 4 | 0 |
| pack | `acmi/acmi-sparse-keyspace` | recovery variant | merge | `logmem-read-path-recovery` | 3 | 0 |
| pack | `acmi/acmi-test-create-2` | junk | list for deletion |  | 0 | 0 |
| pack | `acmi/acmi-test-create` | junk | list for deletion |  | 0 | 0 |
| pack | `acmi/acmi-test-probe-write` | junk | list for deletion |  | 0 | 0 |
| pack | `acmi/acmi-thread-signals-read` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-timeline-read` | light | swap logging calls | (same skill, edited) | 1 | 0 |
| pack | `acmi/acmi-total-outage-recovery` | recovery variant | merge | `logmem-read-path-recovery` | 11 | 0 |
| pack | `acmi/acmi-track-bridge-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 9 | 0 |
| pack | `acmi/acmi-track-bridge-local-thread-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| pack | `acmi/acmi-track-bridge-outage-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 5 | 0 |
| pack | `acmi/acmi-track-cron-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 4 | 0 |
| pack | `acmi/acmi-track-cron-sparse-update` | recovery variant | merge | `logmem-read-path-recovery` | 0 | 0 |
| pack | `acmi/acmi-track-degraded-read-notes` | recovery variant | merge | `logmem-read-path-recovery` | 1 | 5 |
| pack | `acmi/acmi-track-degraded-read` | recovery variant | merge | `logmem-read-path-recovery` | 0 | 4 |
| pack | `acmi/acmi-track-local-divergence` | track variant | merge | `logmem-track-outage` | 4 | 0 |
| pack | `acmi/acmi-track-local-redis-probe` | recovery variant | merge | `logmem-read-path-recovery` | 6 | 0 |
| pack | `acmi/acmi-track-only-cron` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-track-only-silent` | track variant | merge | `logmem-track-outage` | 1 | 0 |
| pack | `acmi/acmi-track-outage-lessons` | recovery variant | merge | `logmem-read-path-recovery` | 2 | 0 |
| pack | `acmi/acmi-track-outage-reporting` | recovery variant | merge | `logmem-read-path-recovery` | 2 | 0 |
| pack | `acmi/acmi-track-outage-thread-composition` | recovery variant | merge | `logmem-read-path-recovery` | 8 | 0 |
| pack | `acmi/acmi-track-read-resilience` | track variant | merge | `logmem-track-outage` | 6 | 0 |
| pack | `acmi/acmi-track-silent-cron-lessons` | track variant | merge | `logmem-track-outage` | 3 | 0 |
| pack | `acmi/acmi-track-silent-exit` | track variant | merge | `logmem-track-outage` | 5 | 0 |
| pack | `acmi/acmi-track-silent-on-sparse` | recovery variant | merge | `logmem-read-path-recovery` | 8 | 0 |
| pack | `acmi/acmi-track-silent-test` | track variant | merge | `logmem-track-outage` | 0 | 0 |
| pack | `acmi/acmi-track-terminal-timeout-pitfall` | track variant | merge | `logmem-track-outage` | 10 | 0 |
| pack | `acmi/acmi-track-total-outage-emit` | recovery variant | merge | `logmem-read-path-recovery` | 1 | 0 |
| pack | `acmi/acmi-track-total-outage-silent-exit` | recovery variant | merge | `logmem-read-path-recovery` | 8 | 0 |
| pack | `acmi/acmi-write-path-fallback` | recovery variant | merge | `logmem-read-path-recovery` | 17 | 0 |
| pack | `acmi/ops-control-rules` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| pack | `acmi/ops-fleet-acmi` | light | swap logging calls | (same skill, edited) | 0 | 1 |
| pack | `acmi/test-acmi-skill-edit` | junk | list for deletion |  | 0 | 0 |
| pack | `acmi/test-write-probe-acmi` | junk | list for deletion |  | 0 | 0 |
| hermes | `agent-connectivity-troubleshooting` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `autonomous-ai-agents/aba-bcba-expert-agent` | light | swap logging calls | (same skill, edited) | 2 | 0 |
| hermes | `autonomous-ai-agents/hermes-agent` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `creative/fleet-media-pipeline` | light | swap logging calls | (same skill, edited) | 1 | 3 |
| hermes | `creative/song-to-video-pipeline` | light | swap logging calls | (same skill, edited) | 0 | 3 |
| hermes | `dental-practice-scraper` | deep | rewrite logging in place | (same skill, edited) | 0 | 8 |
| hermes | `design/multiscene-storyboard` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `devops/acmi-fleet-sync-dump` | deep | rewrite (fleet) | `logmem-fleet-sync` | 23 | 36 |
| hermes | `devops/acmi-project-stats-sync` | deep | rewrite (fleet) | `logmem-fleet-sync` | 2 | 0 |
| hermes | `devops/acmi-read-path-and-recovery` | deep | rewrite (product) | `logmem-read-path-recovery` | 2 | 7 |
| hermes | `devops/acmi-self-hosting` | deep | rewrite (product) | `logmem-self-host` | 91 | 17 |
| hermes | `devops/acmi-wrongtype-handling` | deep | rewrite (product) | `logmem-read-path-recovery` | 1 | 8 |
| hermes | `devops/cron-health-maintenance` | track variant | merge | `logmem-track-outage` | 3 | 0 |
| hermes | `devops/design-ops-center` | deep | rewrite (fleet) | `logmem-fleet-ops-center` | 10 | 1 |
| hermes | `devops/fleet-audit` | deep | rewrite (fleet) | `logmem-fleet-audit` | 16 | 24 |
| hermes | `devops/fleet-comms-roundtable-protocols` | deep | rewrite (fleet) | `logmem-fleet-roundtable` | 56 | 44 |
| hermes | `devops/fleet-expansion-deploy` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `devops/fleet-monitoring` | deep | rewrite (fleet) | `logmem-fleet-monitoring` | 0 | 0 |
| hermes | `devops/fleet-orchestration` | deep | rewrite (fleet) | `logmem-fleet-orchestration` | 26 | 17 |
| hermes | `devops/fleet-org-design` | deep | rewrite (fleet) | `logmem-fleet-orchestration` | 0 | 8 |
| hermes | `devops/hermes-cloud-deployment` | deep | rewrite (fleet) | `logmem-fleet-hermes-deploy` | 5 | 10 |
| hermes | `devops/kanban-orchestrator` | deep | rewrite (fleet) | `logmem-fleet-kanban` | 0 | 5 |
| hermes | `devops/macos-system-maintenance` | light | swap logging calls | (same skill, edited) | 0 | 1 |
| hermes | `devops/mattermost-bot-permissions` | light | swap logging calls | (same skill, edited) | 0 | 2 |
| hermes | `devops/open-design-local-export` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `devops/openclaw-gateway-ops` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `devops/vapi-voice-agent-management` | deep | rewrite (fleet) | `logmem-fleet-voice-agents` | 17 | 2 |
| hermes | `domain/folana-generative-media` | light | swap logging calls | (same skill, edited) | 0 | 2 |
| hermes | `domain/folana-stop-slop` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `domain/sonic-branding-agent` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `duane-daily-queue` | deep | rewrite (fleet) | `logmem-fleet-duane-queue` | 0 | 14 |
| hermes | `elestio-multiservice-vm` | light | swap logging calls | (same skill, edited) | 3 | 0 |
| hermes | `fleet/fleet-alignment-session` | deep | rewrite (fleet) | `logmem-fleet-sync` | 4 | 29 |
| hermes | `fleet/fleet-rollup` | deep | rewrite (fleet) | `logmem-fleet-rollup` | 11 | 12 |
| hermes | `fleet/fleet-sync` | light | swap logging calls | (same skill, edited) | 2 | 0 |
| hermes | `fleet/ops-center-fleet-read` | deep | rewrite (fleet) | `logmem-fleet-ops-center` | 10 | 16 |
| hermes | `mad-ez-build` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `mlops/xai-lite-plan` | light | swap logging calls | (same skill, edited) | 2 | 1 |
| hermes | `openclaw-imports/agentmail` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `openclaw-imports/antigravity` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `openclaw-imports/graphic-designer` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `openclaw-imports/openclaw` | light | swap logging calls | (same skill, edited) | 2 | 0 |
| hermes | `openclaw-imports/reddit` | light | swap logging calls | (same skill, edited) | 1 | 0 |
| hermes | `openclaw-imports/social-manager` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `openclaw-imports/vapi-conference-agent` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `openclaw-imports/vapi` | deep | rewrite logging in place | (same skill, edited) | 6 | 1 |
| hermes | `openclaw-imports/video-specialist` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `ops/ops-center-acmi-read-path` | deep | rewrite (product) | `logmem-read-path-recovery` | 9 | 0 |
| hermes | `serpbear-elestio-full-setup` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `software-development/subagent-driven-development` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `stop-slop` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `test-write-acmi` | junk | list for deletion |  | 0 | 0 |
| hermes | `test-write-probe-acmi2` | junk | list for deletion |  | 0 | 0 |
| hermes | `vm-mac-reverse-tunnel-bridge` | recovery variant | merge | `logmem-read-path-recovery` | 2 | 0 |
| hermes | `whop-manager` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `wordpress-detector` | light | swap logging calls | (same skill, edited) | 0 | 0 |
| hermes | `workflow/quiet-channel-protocol` | light | swap logging calls | (same skill, edited) | 1 | 0 |
