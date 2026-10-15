# ISR prerenders leak memory on Cloudflare Workers (Next.js + OpenNext)

Each runtime ISR prerender of an App Router page retains about **1.4 MB** in the
Worker isolate, for good. After roughly 80 renders an isolate passes the 128 MB
Workers limit and gets recycled.

The cause is three `ReadableStream`s that Next.js builds in its prerender path and
deliberately never closes, relying on garbage collection to clean them up. On
workerd the payload they carried stays reachable after the render ends; closing
them lets it be collected. (The number of live `ReadableStream` objects in the
snapshots stays constant, so what leaks is the data reachable from the pending
reads, not the stream objects themselves.)

Closing those streams (4 small edits in `patches/next@16.4.1.patch`) brings the
growth to zero.

## Versions

| | |
|---|---|
| next | 16.4.1 |
| @opennextjs/cloudflare | 1.20.12 |
| wrangler | 4.151.0 (workerd 1.20261012.1) |
| react | 19.3.0 |

## The app

- `app/items/[id]/page.tsx`: ISR page (`revalidate = 3600`, `generateStaticParams`
  returns `[]`), so every new id is prerendered at runtime on its first request.
  About 600 KB of HTML.
- `app/page.tsx`: the same content as a `force-dynamic` page, as a control.
- Default `open-next.config.ts` (`defineCloudflareConfig()`).

## Run it

```sh
pnpm install
pnpm build:worker            # next build + opennextjs-cloudflare build
node scripts/measure.mjs     # 20 batches of 50 renders of /items/<n>
ROUTE='/?r=' node scripts/measure.mjs   # the force-dynamic control
```

`scripts/measure.mjs` starts `wrangler dev`, renders a batch of pages, then takes a
V8 heap snapshot through the inspector after each batch. A snapshot runs a full
GC first, so the heap size it reports is what is really retained. (workerd does
not answer `HeapProfiler.collectGarbage`, so the script uses the snapshot instead.)

To run stock Next.js, remove the `patchedDependencies` entry from
`pnpm-workspace.yaml`, then run `pnpm install` and `pnpm build:worker` again.

## Results

Heap growth after GC, per render, in local workerd:

| Build | Route | Renders | Heap growth | Per render |
|---|---|---|---|---|
| stock | ISR `/items/<n>` | 300 | +401 MB, linear | ~1.37 MB |
| patched (4 edits) | ISR `/items/<n>` | 300 | +2.9 MB, flat | ~0 |
| only the `ReactServerResult` edit | ISR `/items/<n>` | 150 | +134 MB | ~0.91 MB |
| only the `collect-segment-data` edits | ISR `/items/<n>` | 150 | +72 MB | ~0.49 MB |
| stock | force-dynamic `/` | 1000 | +3.1 MB, flat | ~0 |

The two fixes add up (0.91 + 0.49 ≈ 1.4 MB), so both are needed.

Force-dynamic pages are not affected: `renderToStream` never creates these streams.
They are created only in `prerenderToStream`, which runs at build time and for
runtime ISR (on-demand generation and revalidation).

Raw output: `results-*.txt`.

## The three streams

| Where | What stays open |
|---|---|
| `createUnclosingStream`, in the compiled `app-page(-turbo).runtime.prod.js` (`ReactServerResult.asUnclosingStream()`) | `pull()` stops enqueuing after the last chunk but never calls `close()` |
| `createUnclosingPrefetchStream` in `server/app-render/collect-segment-data` | the wrapper copies the server stream, then returns without `close()` |
| the inline `pageDataStream` in `collectSegmentData` | `start()` enqueues the shell and then the rest, never `close()` |

Next.js comments say the streams are left open on purpose: Flight errors if a
stream closes while references are pending (dynamic holes), and "the remaining
memory will be GC'd when this object goes out of scope". The first reason only
applies with PPR or `cacheComponents`. Without those, closing after the last chunk
is safe. The patch does not touch the `-experimental` runtimes that those
features use.

Next.js already fixed the same pattern on the client:
[vercel/next.js#89610](https://github.com/vercel/next.js/pull/89610). There it
closes the stream and uses React's `unstable_allowPartialStream`, because Chrome
and Firefox also keep unclosed streams with pending reads alive.

## The patch

`patches/next@16.4.1.patch`, applied with pnpm `patchedDependencies`:

```diff
- async pull(r){t<e.length&&r.enqueue(e[t++])}
+ async pull(r){t<e.length?r.enqueue(e[t++]):r.close()}
```

That edit is in both `app-page.runtime.prod.js` and `app-page-turbo.runtime.prod.js`.
`dist/esm/server/app-render/collect-segment-data.js` gets one `controller.close()`
in each of its two streams.
