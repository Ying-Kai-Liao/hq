# Where to scout skills (checked 2026-10-13)

Go through these in step 2 of SKILL.md ("Collect before building"). Taste and quality first, size last. Read
every SKILL.md and check its licence before copying; skills run code.

## Taste: visual previews, judged by eye
| Site | What it is | Use it for |
|---|---|---|
| skillry.dev | ~380 visual-production skills (web, slides, video, image), each with a preview; paid ($9.99/mo), ~34 free | Seeing what good looks like per format; free ones can be collected, paid ones only with the user's say-so |
| github.com/wheresryan22/anatomy-community | Figures made with Anatomy, rebuilt from source | Reference figures for the image agent's anatomy skill |
| open-design.ai/skills | 138 open-source design skills (slides, UI, brand, motion, review), MIT/Apache | Designer, branding, video skills |

## Official and scored
| Site | What it is | Use it for |
|---|---|---|
| github.com/anthropics/skills | Anthropic's own skills (docx, pdf, pptx, xlsx and more) | The format reference; document skills |
| tessl.io/registry | Registry that scores each skill on publish (quality, measured impact vs baseline, Snyk scan) | Picking between several skills for the same job |
| skills.sh | Vercel's directory; leaderboard by installs, official and security-audit sections; `npx skills add owner/repo` | What people actually use |
| github.com/netresearch/claude-code-marketplace | 39 hand-curated dev skills, MIT | Small, well-maintained examples |

## Big directories (search, then judge)
| Site | Size / ranking |
|---|---|
| claudemarketplaces.com | ~23,600 skills, 12,800 MCP servers; installs, stars, usage, spam filtered |
| agent-skills.cc | 63,000+ community skills, 12 categories, featured/hot lists |
| agensi.io | ~9,000 skills, 32 use cases, says it security-scans each |
| claudemarket.ai, mcpmarket.com/tools/skills, skillselion.com, agentskillsfinder.com | More aggregators; mostly the same sources |

## Curated lists on GitHub
ComposioHQ/awesome-claude-skills (≈77k★), travisvn/awesome-claude-skills (≈15k★).

## Already on this Mac (check first, no download)
- `~/.codex/skills/.system/` and `~/.codex/.tmp/plugins/plugins/`: OpenAI's Codex skills and curated plugins
  (imagegen Apache-2.0; build-web-data-visualization MIT; creative-production proprietary: ideas only).
- `~/.agents/skills/` (e.g. archify, MIT), `~/.claude/skills/`, `~/.hermes/hermes-agent/optional-skills/`.
- Other agents' `skills/` folders in hq: if one already owns it, call that agent instead of copying.
