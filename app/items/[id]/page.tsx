import { Counter } from '../../counter'

// ISR: no paths at build time, each new id is prerendered on its first request
// at runtime (Next's prerender path), then cached for an hour.
export const revalidate = 3600
export const dynamicParams = true

export function generateStaticParams() {
  return []
}

const ROWS = Array.from({ length: 1500 }, (_, i) => ({
  id: i,
  title: `Row ${i} ` + 'lorem ipsum dolor sit amet '.repeat(6),
}))

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <main>
      <h1>Item {id}</h1>
      <Counter label="clicks" />
      <ul>
        {ROWS.map((row) => (
          <li key={row.id}>{row.title}</li>
        ))}
      </ul>
    </main>
  )
}
