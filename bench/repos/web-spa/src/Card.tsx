export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded border p-4"><h2 className="font-medium">{title}</h2>{children}</section>
}
