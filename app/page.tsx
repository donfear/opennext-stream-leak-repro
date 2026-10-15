import { Counter } from './counter'

// Dynamic on every request, like the pages in opennextjs-cloudflare#1381.
export const dynamic = 'force-dynamic'

// About 300 KB of HTML: page weight is what drives the cliff in #1381.
const ROWS = Array.from({ length: 1500 }, (_, i) => ({
  id: i,
  title: `Row ${i} ` + 'lorem ipsum dolor sit amet '.repeat(6),
}))

export default async function Page({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams
  return (
    <main>
      <h1>Render {r ?? '-'}</h1>
      <Counter label="clicks" />
      <ul>
        {ROWS.map((row) => (
          <li key={row.id}>{row.title}</li>
        ))}
      </ul>
    </main>
  )
}
