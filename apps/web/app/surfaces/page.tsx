import { omittedSurfaces, shippedSurfaces } from '@/lib/product'

export default function SurfacesPage() {
  const shipped = shippedSurfaces()
  const omitted = omittedSurfaces()

  return (
    <>
      <section className="hero">
        <span className="eyebrow">surfaces</span>
        <h1>What ships, and what does not</h1>
        <p>
          One registry, one <code>Tool</code> interface. The CLI, the terminal bench, this app and the MCP
          server are transports over the same tools — never four implementations.
        </p>
      </section>

      <section aria-labelledby="shipped-heading">
        <h2 id="shipped-heading" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          Shipped
        </h2>
        {shipped.length === 0 ? (
          <p className="state" data-kind="empty">
            No surfaces registered yet.
          </p>
        ) : (
          <div className="grid">
            {shipped.map((surface) => (
              <article className="card" key={surface.id}>
                <span className="badge" data-tone="ok">
                  shipped
                </span>
                <h3>{surface.title}</h3>
                <p>{surface.summary}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="omitted-heading" style={{ marginTop: 'var(--space-7)' }}>
        <h2 id="omitted-heading" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          Deliberately omitted
        </h2>
        <div className="prose">
          <p>
            Omission is a design decision, and each one here is a real argument rather than a gap in the
            schedule.
          </p>
        </div>
        <div className="grid" style={{ marginTop: 'var(--space-4)' }}>
          {omitted.map((surface) => (
            <article className="card" key={surface.id}>
              <span className="badge">omitted</span>
              <h3>{surface.title}</h3>
              <p>{surface.summary}</p>
              {surface.why !== undefined ? (
                <p style={{ color: 'var(--fg-subtle)' }}>why: {surface.why}</p>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
