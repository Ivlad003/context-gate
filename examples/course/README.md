# Course examples

Two copies of the same small repository, one with English prompts (`en/`) and one with Ukrainian prompts (`uk/`). They
are the examples of the course in [`docs/COURSE.md`](../../docs/COURSE.md) and
[`docs/COURSE.uk.md`](../../docs/COURSE.uk.md). `test/course.test.ts` builds and renders both, so they stay valid.

```bash
cd examples/course/en
npx context-gate build
npx context-gate run --tier quick --profile docs --no-markers
npx context-gate run release --args "minor --dry" --no-markers
```
