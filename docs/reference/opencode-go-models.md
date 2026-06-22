# OpenCode Go — Model Catalogue

> **Last updated:** 2026-06-15  
> **Subscription:** $5 first month, then **$10/month** flat  
> **Usage caps:** $12/5hr | $30/week | $60/month  
> **API auth:** `https://opencode.ai/auth` → subscribe → copy key → `/connect`  
> **Config format:** `opencode-go/<model-id>` (e.g. `opencode-go/qwen3.6-plus`)  
> **Live model list:** `GET https://opencode.ai/zen/go/v1/models`

---

## Quick Vision Summary

| Has Vision? | Models |
|---|---|
| ✅ **text+image+video** | Qwen3.6 Plus, Qwen3.5 Plus, MiniMax M3, Kimi K2.7 Code, Kimi K2.6, Kimi K2.5, MiMo-V2.5 |
| ✅ **text+image+audio+video+pdf** | MiMo-V2-Omni |
| ✅ **text+image** | Qwen3.7 Plus |
| ❌ **text-only** | DeepSeek V4 Pro, DeepSeek V4 Flash, Qwen3.7 Max, GLM-5.1, GLM-5, MiniMax M2.7, MiniMax M2.5, MiMo-V2.5-Pro, MiMo-V2-Pro, Hy3 Preview |

---

## Full Model Table

### Vision-Capable Models ✅

| # | Model | ID | Params (tot/act) | Context | Vision | Audio | Input $/M tok | Output $/M tok | Cache Read $/M | API Format |
|---|-------|----|------------------|---------|--------|-------|--------------|---------------|---------------|------------|
| 1 | **Qwen3.6 Plus** | `qwen3.6-plus` | undisclosed (closed) | 1M | 🟢 image+video | ❌ | $0.50 (≤256K)<br>$2.00 (>256K) | $3.00 (≤256K)<br>$6.00 (>256K) | $0.05 / $0.20 | Anthropic Messages |
| 2 | **Qwen3.7 Plus** | `qwen3.7-plus` | undisclosed (closed) | 1M | 🟢 image | ❌ | $0.40 (≤256K)<br>$1.20 (>256K) | $1.60 (≤256K)<br>$4.80 (>256K) | $0.04 / $0.12 | Anthropic Messages |
| 3 | **Qwen3.5 Plus** | `qwen3.5-plus` | undisclosed (closed) | 1M | 🟢 image+video | ❌ | _not in docs_ | _not in docs_ | — | (_inferred_) Anthropic Messages |
| 4 | **MiniMax M3** | `minimax-m3` | ~428B / ~23B | 512K | 🟢 image+video | ❌ | $0.30 | $1.20 | $0.06 | Anthropic Messages |
| 5 | **Kimi K2.7 Code** | `kimi-k2.7-code` | 1T / 32B | 256K | 🟢 image+video | ❌ | $0.95 | $4.00 | $0.19 | OpenAI-compatible |
| 6 | **Kimi K2.6** | `kimi-k2.6` | 1T / 32B | 256K | 🟢 image+video | ❌ | $0.95 | $4.00 | $0.16 | OpenAI-compatible |
| 7 | **Kimi K2.5** | `kimi-k2.5` | 1T / 32B | 256K | 🟢 image+video | ❌ | _not in docs_ | _not in docs_ | — | (_inferred_) OpenAI-compatible |
| 8 | **MiMo-V2.5** | `mimo-v2.5` | 310B / 15B | 1M | 🟢 image+video | 🟢 audio | $0.14 | $0.28 | $0.0028 | OpenAI-compatible |
| 9 | **MiMo-V2-Omni** | `mimo-v2-omni` | ~310B / ~15B (est.) | 256K | 🟢 image+video+pdf | 🟢 audio | _not in docs_ | _not in docs_ | — | (_inferred_) OpenAI-compatible |

### Text-Only Models ❌

| # | Model | ID | Params (tot/act) | Context | Input $/M tok | Output $/M tok | Cache Read $/M | API Format |
|---|-------|----|------------------|---------|--------------|---------------|---------------|------------|
| 10 | **DeepSeek V4 Pro** | `deepseek-v4-pro` | 1.6T / 49B | 1M | $1.74 | $3.48 | $0.0145 | OpenAI-compatible |
| 11 | **DeepSeek V4 Flash** | `deepseek-v4-flash` | 284B / 13B | 1M | $0.14 | $0.28 | $0.0028 | OpenAI-compatible |
| 12 | **Qwen3.7 Max** | `qwen3.7-max` | undisclosed (closed) | 1M | $2.50 | $7.50 | $0.50 | Anthropic Messages |
| 13 | **GLM-5.1** | `glm-5.1` | ~744B / ~40B | 200K | $1.40 | $4.40 | $0.26 | OpenAI-compatible |
| 14 | **GLM-5** | `glm-5` | ~744B / ~40B | 200K | $1.00 | $3.20 | $0.20 | OpenAI-compatible |
| 15 | **MiniMax M2.7** | `minimax-m2.7` | ~230B / ~10B | 200K | $0.30 | $1.20 | $0.06 | Anthropic Messages |
| 16 | **MiniMax M2.5** | `minimax-m2.5` | ~230B / ~10B | 200K | $0.30 | $1.20 | $0.06 | Anthropic Messages |
| 17 | **MiMo-V2.5-Pro** | `mimo-v2.5-pro` | 1.02T / 42B | 1M | $1.74 | $3.48 | $0.0145 | OpenAI-compatible |
| 18 | **MiMo-V2-Pro** | `mimo-v2-pro` | ~1T / ~42B (est.) | 1M | _not in docs_ | _not in docs_ | — | (_inferred_) OpenAI-compatible |
| 19 | **Hy3 Preview** | `hy3-preview` | 295B / 21B | 256K | _not in docs_ | _not in docs_ | — | (_inferred_) OpenAI-compatible |

> **Note:** "_not in docs_" = model appears in the API (`GET /zen/go/v1/models`) but is not listed on the official [Go docs page](https://opencode.ai/docs/go/). Prices for these may change or be undocumented.

---

## Agent Assignment Reference

Current `opencode.json` subagent config (as of 2026-06-15):

| Agent | Model | Vision? |
|-------|-------|---------|
| `build` (primary) | `deepseek/deepseek-v4-pro` (OpenRouter) | ❌ |
| `explore` | `deepseek/deepseek-v4-pro` (OpenRouter) | ❌ |
| `general` | `deepseek/deepseek-v4-pro` (OpenRouter) | ❌ |
| `executor` | `deepseek/deepseek-v4-pro` (OpenRouter) | ❌ |
| **`reviewer`** | **`opencode-go/qwen3.6-plus`** | ✅ **image+video** |
| `worker` | `deepseek/deepseek-v4-flash` (OpenRouter) | ❌ |

> **Only the reviewer agent has vision.** If you need another agent to process images, change its model in `~/.config/opencode/opencode.json` to a vision-capable OpenCode Go model.

---

## Runtime Update Instructions

### For a new agent session to update this document:

```markdown
## Task: Update OpenCode Go Model Catalogue

1. Read this file: docs/ai/references/opencode-go-models.md
   — Understand the current state and table format.

2. Fetch the live model list from the API:
   curl https://opencode.ai/zen/go/v1/models
   — Compare the returned model IDs against the table.
   — Note any NEW models not in the table.
   — Note any REMOVED models that were previously listed.

3. For each NEW model, look up its specs:
   a. Search https://models.dev for: parameter count, context window, modality.
   b. Search https://openrouter.ai/models?q=<model-name> for cross-reference.
   c. Check https://opencode.ai/docs/go/ for pricing if the model was added there.

4. Determine vision capability:
   — If models.dev says "image" or "video" in input modalities → ✅ mark vision
   — If only "text" → ❌ text-only
   — If unsure, mark with ⚠️ and note the uncertainty.

5. Update the document:
   — Add new models to the correct section (Vision-Capable vs Text-Only).
   — Move any removed models to an "Archived" section at the bottom.
   — Update the "Last updated" date.
   — Update the Quick Vision Summary if any new vision models appeared.

6. Check the agent assignment table (last section):
   — If you changed any subagent model assignments in opencode.json, update the table.

7. Write a one-line summary of what changed in your response.
```

### Data Sources (in priority order):

1. **Live API:** `GET https://opencode.ai/zen/go/v1/models` — authoritative model list
2. **Official docs:** `https://opencode.ai/docs/go/` — pricing, usage caps, API format
3. **models.dev:** `https://models.dev` — parameter counts, context windows, modalities
4. **OpenRouter:** `https://openrouter.ai/models?q=<model>` — cross-check specs
5. **Provider blogs/papers:** for architecture details on closed-weight models

### Config location:

- User config: `~/.config/opencode/opencode.json` — `provider` block, `agent` block
- Roles config: `C:\Users\Van\AppData\Roaming\opencode\opencode.json` — local Ollama providers
- Project config: `./opencode.json` — project-level overrides

---

## Archive

_No removed models yet._
