# Retriever adapters

Uniform adapters wrapping five different retrieval tools so the eval harness
can ask each one the same question — *"given this PR title, what files would
you touch?"* — and compare ranked top-K outputs.

Every adapter exports an object that satisfies the `Retriever` interface
declared in [`eval/types.ts`](../types.ts):

```ts
interface Retriever {
  name: string;
  query(question: string, repoPath: string, k: number):
    Promise<{ files: string[]; tokens: number; ms: number }>;
}
```

## Adapters

| Adapter     | File                          | Backend                                         | External setup        |
| ----------- | ----------------------------- | ----------------------------------------------- | --------------------- |
| `codemap`   | [`codemap.ts`](./codemap.ts)  | `bun src/index.ts query` (this repo)            | none (bundled)        |
| `gitnexus`  | [`gitnexus.ts`](./gitnexus.ts) | `gitnexus analyze` + `gitnexus query` CLI       | `npm i -g gitnexus`   |
| `aider`     | [`aider.ts`](./aider.ts)      | `aider --show-repo-map` CLI                     | `pip install aider-chat` |
| `embedding` | [`embedding.ts`](./embedding.ts) | Transformers.js (`Xenova/multilingual-e5-large`) | model download (≈1 GB) on first run |
| `grep`      | [`grep.ts`](./grep.ts)        | `ripgrep` over content + file-path keywords     | `brew install ripgrep` / `apt install ripgrep` |

## Setup

### `codemap`

No setup. The adapter shells out to the codemap CLI shipped in this repo
(`src/index.ts`) via Bun. The CLI builds and caches a `.codemap/graph.json`
inside the target repo on first call.

### `gitnexus`

```sh
npm install -g gitnexus
```

GitNexus then has to index each target repo once. The adapter calls
`gitnexus analyze --skip-embeddings` before every query — it's a no-op when
the index is already fresh, so the cost is paid only on cold repos. The
index is stored in `<repo>/.gitnexus/`.

> **License note — important.** GitNexus is distributed under
> [**PolyForm Noncommercial 1.0.0**](https://polyformproject.org/licenses/noncommercial/1.0.0/).
> That means it can sit in this evaluation harness for non-commercial research
> and reporting, but **cannot** be redistributed or used in a paid product
> without a commercial license from the upstream maintainers. Anyone
> reproducing the comparison should keep this constraint in mind.

If `npm i -g gitnexus` fails on macOS with a native build error from
`tree-sitter-c`, set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` before installing —
that skips the optional Dart/Proto grammars whose `node-gyp` build is flaky
on recent Node versions.

### `aider`

```sh
pip install aider-chat
```

The adapter only calls `aider --show-repo-map`, which reads the repo and
prints a PageRank-ordered text dump of files and symbols. No model API key is
required for this command — `aider` only needs a key when it's *generating*
code, not when it's emitting the repo map.

### `embedding`

The default backend is the **`Xenova/multilingual-e5-large`** sentence
embedding model loaded through `@huggingface/transformers` (already in
`package.json`). On first call the model weights (~1 GB) download to the
Transformers.js cache (`~/.cache/huggingface/` by default). Subsequent calls
reuse the cache and run fully locally — no API key.

To swap in a different backend:

```ts
import { createEmbeddingRetriever } from "./embedding";

// (a) Smaller local e5 variant
const small = createEmbeddingRetriever({ model: "Xenova/multilingual-e5-small" });

// (b) Remote API (voyage-3, OpenAI, etc.) — inject an embedder
const voyage = createEmbeddingRetriever({
  embedder: async (texts) => {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ model: "voyage-3", input: texts }),
    });
    const json = await res.json();
    return json.data.map((d: { embedding: number[] }) => d.embedding);
  },
});
```

Files are chunked at 1024 tokens (≈4096 characters by the 4-chars-per-token
heuristic), each chunk is embedded, and each file is ranked by the maximum
chunk-vs-query cosine similarity.

### `grep`

The adapter shells out to `rg` (ripgrep). Most dev machines already have it:

```sh
brew install ripgrep     # macOS
apt install ripgrep      # Debian/Ubuntu
cargo install ripgrep    # anywhere
```

Ranking: per-file content match count plus a 5× boost for each unique query
keyword that appears in the file's path.

## Smoke tests

[`tests/adapters.test.ts`](../../tests/adapters.test.ts) clones
`tests/fixtures/sample-project` into a temp directory, asks each adapter
*"user service"* on it, and asserts the returned `files` array is non-empty.
`gitnexus` and `aider` are skipped when their binaries are not on PATH.

```sh
bun test tests/adapters.test.ts
```
