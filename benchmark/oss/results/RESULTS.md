# Context Guardian OSS Benchmark Results

**Date:** 2026-04-08  
**Mode:** local  
**Repeats:** 3  
**Version:** 1.0.0  
**Scenarios:** 12  

## Claims

| Claim | Status | Evidence | Caveats |
|-------|--------|----------|---------|
| Context Guardian reduces cloud token usage on large contexts | **SUPPORTED** | 96.3% mean reduction [95.5%, 97.0%] 95% CI | On scenarios with >10K tokens of context; N=18, 3 repeats |
| Context Guardian preserves answer accuracy (within 5pp) | **SUPPORTED** | 0.0pp delta [0.0pp, 0.0pp] 95% CI | N=18; 3 repeats; 12 scenarios |
| Context Guardian has acceptable latency overhead (<3x) | **NOT_SUPPORTED** | 55.27x mean, CI upper 74.38x | -- |
| Context Guardian correctly passes through small/focused prompts (FPR < 20%) | **SUPPORTED** | 0.0% FPR [0.0%, 0.0%] 95% CI | 12 negative scenarios tested |
| Context Guardian activates reliably on large/noisy contexts (FNR < 10%) | **SUPPORTED** | 0.0% FNR [0.0%, 0.0%] 95% CI | 12 positive scenarios tested |

## Per-Scenario Results

| Scenario | Size | Expected | Tokens | Baseline Acc | CG Acc | Token Reduction | Intercepted |
|----------|------|----------|--------|-------------|--------|-----------------|-------------|
| Small clean bug fix request | small | should_not_help | 74 | 100.0% | 100.0% | -- | No |
| Small focused config question | small | should_not_help | 98 | 100.0% | 100.0% | -- | No |
| Single focused TypeScript file review | medium | should_not_help | 386 | 100.0% | 100.0% | -- | No |
| Adversarial: many error keywords but focused content | medium | should_not_help | 195 | 100.0% | 100.0% | -- | No |
| Medium auth timeout incident | medium | marginal | 3,617 | 100.0% | 100.0% | 66.8% | Yes |
| Medium memory leak triage | medium | marginal | 3,602 | 100.0% | 100.0% | 67.5% | Yes |
| Large: auth incident in 30K noise | large | should_help | 30,346 | 100.0% | 100.0% | 96.1% | Yes |
| Large: API migration spec in mixed artifacts | large | should_help | 23,822 | 100.0% | 100.0% | 95.0% | Yes |
| Large: data analysis across mixed artifacts | large | should_help | 19,512 | 100.0% | 100.0% | 94.0% | Yes |
| Huge: full repo dump architecture question | huge | should_help | 81,227 | 100.0% | 100.0% | 98.5% | Yes |
| Huge: CI pipeline failure with full build log | huge | should_help | 59,447 | 100.0% | 100.0% | 98.0% | Yes |
| Large: memory leak in deployment noise | large | should_help | 29,264 | 100.0% | 100.0% | 96.0% | Yes |

## Methodology

- **3 repeats** per scenario with fresh VectorStore per run
- **95% CI** computed via Student's t-distribution
- **Facts scattered** at random depths (not head/tail) to avoid primacy/recency bias
- **Noise is realistic**: mixed log formats, code, configs, k8s events, prose
- **Negative scenarios included**: 4 scenarios where CG should NOT rewrite
- **Ground truth is regex-checked**: no subjective scoring
- **Local mode**: uses mock LLM + real indexing/routing/rewriting pipeline
  - Measures routing correctness, information preservation, and token reduction
  - Does NOT measure cloud LLM reasoning quality (use `--mode cloud` for that)

## Known Limitations

- Synthetic scenarios authored by one team; no external corpus
- Single-turn only; no multi-turn conversation benchmarks
- Local mode uses mock embeddings, not real LLM embeddings
- Ground truth extraction uses regex, which can have false positives
