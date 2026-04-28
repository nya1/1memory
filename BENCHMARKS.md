# Benchmarks

This file is the source of truth for running benchmark suites locally and updating benchmark results.

## Quick start (LoCoMo)

Download dataset locally:

```bash
pnpm run benchmark:locomo:download
```

Run benchmark:

```bash
pnpm run benchmark:locomo -- --dataset benchmark/datasets/locomo10.json
```

Run with JSON output:

```bash
pnpm run benchmark:locomo -- --dataset benchmark/datasets/locomo10.json --json
```

Write LoCoMo results into `benchmark/realistic-benchmarks.json`:

```bash
pnpm run benchmark:locomo -- --dataset benchmark/datasets/locomo10.json --write-registry
```

## Reported metrics

- `accuracy` (defined as retrieval hit@1 on LoCoMo QA with evidence)
- `recall@1`, `recall@k`, `MRR`
- `latency p50/p95`
- `indexed_tokens_approx`, `query_tokens_approx`, `total_tokens_approx`

## Notes

- LoCoMo source: [snap-research/locomo](https://github.com/snap-research/locomo)
- The downloaded dataset is local-only and ignored by git.

## Quick start (LongMemEval_S)

Download dataset locally:

```bash
pnpm run benchmark:longmemeval:download
```

Run benchmark:

```bash
pnpm run benchmark:longmemeval -- --dataset benchmark/datasets/longmemeval_s_cleaned.json
```

Run with JSON output:

```bash
pnpm run benchmark:longmemeval -- --dataset benchmark/datasets/longmemeval_s_cleaned.json --json
```

Write LongMemEval_S results into `benchmark/realistic-benchmarks.json`:

```bash
pnpm run benchmark:longmemeval -- --dataset benchmark/datasets/longmemeval_s_cleaned.json --write-registry
```
